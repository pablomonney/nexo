-- 0054_deposito_y_existencias.sql — de movimiento facturado a existencia contada.
--
-- ## Lo que hay y lo que falta
--
-- `product_movements` (0049) dice cuánto se compró y cuánto se vendió de cada
-- producto. **No es stock** y la propia API lo aclara en cada respuesta: es
-- movimiento facturado. Faltan las dos cosas que separan una cifra de venta de
-- una existencia:
--
--   1. **el depósito**. Un comprobante no dice de dónde salió la mercadería, y
--      una empresa con tres depósitos necesita saberlo;
--   2. **lo que no pasa por un comprobante**: ajustes por recuento, roturas,
--      transferencias internas. Esos movimientos existen y no facturan.
--
-- ## El diseño: un libro de movimientos, existencias derivadas
--
-- Mismo esquema que el Mayor. `stock_movements` es un libro que **solo crece**:
-- no se edita ni se borra, y una corrección es un movimiento nuevo —igual que
-- un contraasiento (ADR-003)—. La existencia no se guarda en ninguna columna:
-- se suma del libro.
--
-- Un `productos.stock_actual` que la aplicación mantuviera al día sería la
-- segunda verdad de siempre, con el agravante de que las dos cifras conviven
-- muchísimo tiempo antes de que alguien note la diferencia.
--
-- ## Las cantidades no llevan signo
--
-- El signo lo pone el **tipo** de movimiento, igual que en `tax_transactions`
-- el signo del subdiario lo pone la clase del comprobante. Guardar cantidades
-- negativas obligaría a saber el sentido al insertar, que es justo el dato que
-- el tipo ya expresa — y haría posible una entrada negativa, que no significa
-- nada.
--
-- ## La entrada por recepción la escribe un trigger
--
-- Es el precedente de `ledger_movements` (A-7): **el libro lo escribe la base,
-- no la aplicación**. Si lo escribiera una ruta, bastaría una segunda ruta que
-- confirmara recepciones sin acordarse de mover stock para que el libro quedara
-- corto y nadie se enterara.
--
-- ## Lo que NO se hace automáticamente: la salida por venta
--
-- Facturar no descuenta stock solo. Podría parecer una omisión y es una
-- decisión: **el comprobante no sabe de qué depósito salió la mercadería**, y
-- elegir uno por defecto sería inventar el dato más importante del movimiento.
--
-- Lo que sí se hace es hacerlo visible: una venta de productos con stock que no
-- tiene salida registrada aparece en la bandeja. El hueco se ve en vez de
-- taparse con una suposición.

-- ---------------------------------------------------------------------------
-- 1 · Los depósitos
-- ---------------------------------------------------------------------------
CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id  uuid NOT NULL REFERENCES companies (id),
  code        text NOT NULL CHECK (length(btrim(code)) > 0),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  direccion   text,
  status      text NOT NULL DEFAULT 'ACTIVO' CHECK (status IN ('ACTIVO', 'ARCHIVADO')),

  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wh_id_empresa UNIQUE (company_id, id)
);

CREATE UNIQUE INDEX warehouses_code_unico ON warehouses (company_id, lower(code));

COMMENT ON TABLE warehouses IS
  'Depósitos de la empresa. Un movimiento de stock siempre dice en cuál pasó: '
  'sin eso la existencia es un número sin lugar.';

CREATE TRIGGER warehouses_updated_at
  BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER warehouses_no_delete
  BEFORE DELETE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 2 · El mínimo, declarado
-- ---------------------------------------------------------------------------
-- Mismo criterio que `parties.dias_de_pago` (0053): el sistema avisa que el
-- stock está bajo **solo si alguien dijo cuál es el mínimo**. Sin eso no hay
-- umbral que comparar, y un aviso sobre un umbral inventado sería ruido con
-- apariencia de dato.
ALTER TABLE products ADD COLUMN stock_minimo numeric(18, 4)
  CHECK (stock_minimo IS NULL OR stock_minimo >= 0);

COMMENT ON COLUMN products.stock_minimo IS
  'Existencia mínima declarada. NULL significa que no se declaró: el sistema '
  'entonces no avisa que este producto esté bajo mínimo.';

-- ---------------------------------------------------------------------------
-- 3 · El depósito de la recepción
-- ---------------------------------------------------------------------------
ALTER TABLE goods_receipts ADD COLUMN warehouse_id uuid;

ALTER TABLE goods_receipts
  ADD CONSTRAINT gr_warehouse_fk
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id);

COMMENT ON COLUMN goods_receipts.warehouse_id IS
  'Dónde entró la mercadería. Obligatorio para confirmar si algún renglón lleva '
  'un producto con stock: sin depósito no hay movimiento posible.';

-- ---------------------------------------------------------------------------
-- 4 · El libro de movimientos
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),
  product_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,

  tipo         text NOT NULL
                 CHECK (tipo IN ('ENTRADA', 'SALIDA',
                                 'AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO',
                                 'TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SALIDA')),

  -- Sin signo. Lo pone el tipo, igual que en `tax_transactions` el signo del
  -- subdiario lo pone la clase del comprobante.
  cantidad     numeric(18, 4) NOT NULL CHECK (cantidad > 0),

  fecha        date NOT NULL,

  -- De dónde viene. `RECEPCION` y `VENTA` citan la fila que lo funda; `AJUSTE`
  -- y `TRANSFERENCIA` no tienen una afuera y por eso exigen motivo.
  origen_tipo  text NOT NULL
                 CHECK (origen_tipo IN ('RECEPCION', 'VENTA', 'AJUSTE', 'TRANSFERENCIA')),
  origen_id    uuid,

  motivo       text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,

  -- Un ajuste sin explicación es una existencia que cambió porque sí. §24: un
  -- movimiento sin origen demostrable no se registra.
  CONSTRAINT sm_ajuste_con_motivo
    CHECK (origen_tipo <> 'AJUSTE' OR length(btrim(coalesce(motivo, ''))) > 2),

  -- Lo que viene de un hecho registrado tiene que decir de cuál.
  CONSTRAINT sm_origen_citado
    CHECK (origen_tipo NOT IN ('RECEPCION', 'VENTA') OR origen_id IS NOT NULL),

  -- El tipo y el origen no pueden contradecirse.
  CONSTRAINT sm_tipo_coherente
    CHECK ((origen_tipo = 'RECEPCION'    AND tipo = 'ENTRADA')
        OR (origen_tipo = 'VENTA'        AND tipo = 'SALIDA')
        OR (origen_tipo = 'AJUSTE'       AND tipo IN ('AJUSTE_POSITIVO', 'AJUSTE_NEGATIVO'))
        OR (origen_tipo = 'TRANSFERENCIA' AND tipo IN ('TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SALIDA'))),

  CONSTRAINT sm_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT sm_deposito_fk
    FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id)
);

CREATE INDEX sm_existencia ON stock_movements (company_id, product_id, warehouse_id);
CREATE INDEX sm_por_origen ON stock_movements (company_id, origen_tipo, origen_id)
  WHERE origen_id IS NOT NULL;
CREATE INDEX sm_por_fecha ON stock_movements (company_id, fecha DESC, id DESC);

COMMENT ON TABLE stock_movements IS
  'Libro de movimientos de stock. Solo crece: no se edita ni se borra, y una '
  'corrección es un movimiento nuevo. Las existencias se derivan de acá; no hay '
  'ninguna columna que las guarde.';

-- El libro no se edita ni se borra. Mismo candado que `ledger_movements`.
CREATE OR REPLACE FUNCTION forbid_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'E_LIBRO_INMUTABLE: % solo admite altas. Corregí con un movimiento nuevo.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER stock_movements_inmutable
  BEFORE UPDATE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

CREATE TRIGGER stock_movements_no_delete
  BEFORE DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 5 · Solo se mueve lo que lleva stock
-- ---------------------------------------------------------------------------
-- Un servicio no ocupa lugar en ningún depósito. El CHECK
-- `products_servicio_sin_stock` (0048) ya impide marcarlo, y esto impide
-- moverlo: son dos preguntas distintas y las dos tienen que estar cerradas.
CREATE OR REPLACE FUNCTION assert_producto_con_stock() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lleva boolean;
  estado text;
BEGIN
  SELECT p.tracks_stock, p.status INTO lleva, estado
    FROM products p
   WHERE p.id = NEW.product_id AND p.company_id = NEW.company_id;

  IF NOT lleva THEN
    RAISE EXCEPTION 'E_STOCK_PRODUCTO_SIN_STOCK: el producto no lleva existencias'
      USING ERRCODE = 'check_violation';
  END IF;

  IF estado = 'ARCHIVADO' THEN
    RAISE EXCEPTION 'E_STOCK_PRODUCTO_ARCHIVADO: el producto está archivado'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movements_producto_valido
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION assert_producto_con_stock();

-- ---------------------------------------------------------------------------
-- 6 · La entrada por recepción la escribe la base
-- ---------------------------------------------------------------------------
-- A-7 aplicado al stock: si esto lo hiciera una ruta, bastaría una segunda ruta
-- que confirmara recepciones sin mover stock para que el libro quedara corto.
CREATE OR REPLACE FUNCTION proyectar_recepcion_a_stock() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  con_stock integer;
BEGIN
  IF NEW.status <> 'CONFIRMADA' OR OLD.status = 'CONFIRMADA' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO con_stock
    FROM goods_receipt_lines l
    JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE l.receipt_id = NEW.id AND p.tracks_stock;

  IF con_stock = 0 THEN RETURN NEW; END IF;

  -- El depósito es obligatorio recién acá y no en el alta: al crear el borrador
  -- puede no saberse todavía dónde se va a descargar.
  IF NEW.warehouse_id IS NULL THEN
    RAISE EXCEPTION
      'E_STOCK_SIN_DEPOSITO: la recepción tiene productos con stock y no dice en qué depósito entraron.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO stock_movements
    (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
     origen_tipo, origen_id, created_by)
  SELECT NEW.company_id, l.product_id, NEW.warehouse_id, 'ENTRADA', l.cantidad,
         NEW.received_at, 'RECEPCION', NEW.id,
         coalesce(nullif(current_setting('app.actor_id', true), ''), current_user)
    FROM goods_receipt_lines l
    JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE l.receipt_id = NEW.id AND p.tracks_stock;

  RETURN NEW;
END;
$$;

CREATE TRIGGER goods_receipts_proyecta_stock
  AFTER UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION proyectar_recepcion_a_stock();

-- Anular una recepción confirmada no borra su entrada —el libro solo crece—:
-- escribe el movimiento contrario, que es la forma correcta de deshacer.
CREATE OR REPLACE FUNCTION revertir_recepcion_en_stock() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'ANULADA' OR OLD.status <> 'CONFIRMADA' THEN
    RETURN NEW;
  END IF;

  INSERT INTO stock_movements
    (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
     origen_tipo, origen_id, motivo, created_by)
  SELECT m.company_id, m.product_id, m.warehouse_id, 'AJUSTE_NEGATIVO', m.cantidad,
         current_date, 'AJUSTE', NULL,
         'Reversión de la recepción anulada: ' || coalesce(NEW.motivo_anulacion, 'sin motivo'),
         coalesce(nullif(current_setting('app.actor_id', true), ''), current_user)
    FROM stock_movements m
   WHERE m.origen_tipo = 'RECEPCION' AND m.origen_id = NEW.id AND m.tipo = 'ENTRADA';

  RETURN NEW;
END;
$$;

CREATE TRIGGER goods_receipts_revierte_stock
  AFTER UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION revertir_recepcion_en_stock();

-- ---------------------------------------------------------------------------
-- 7 · Las existencias, derivadas
-- ---------------------------------------------------------------------------
CREATE VIEW stock_on_hand WITH (security_invoker = true) AS
SELECT m.company_id,
       m.product_id,
       p.code                       AS producto_codigo,
       p.name                       AS producto_nombre,
       p.unit                       AS unidad,
       p.stock_minimo,
       m.warehouse_id,
       w.code                       AS deposito_codigo,
       w.name                       AS deposito_nombre,
       sum(CASE m.tipo
             WHEN 'ENTRADA'               THEN  m.cantidad
             WHEN 'TRANSFERENCIA_ENTRADA' THEN  m.cantidad
             WHEN 'AJUSTE_POSITIVO'       THEN  m.cantidad
             ELSE -m.cantidad
           END)::numeric(18, 4)     AS existencia,
       count(*)::int                AS movimientos,
       max(m.fecha)                 AS ultimo_movimiento
  FROM stock_movements m
  JOIN products p   ON p.id = m.product_id   AND p.company_id = m.company_id
  JOIN warehouses w ON w.id = m.warehouse_id AND w.company_id = m.company_id
 GROUP BY m.company_id, m.product_id, p.code, p.name, p.unit, p.stock_minimo,
          m.warehouse_id, w.code, w.name;

COMMENT ON VIEW stock_on_hand IS
  'Existencias por producto y depósito, derivadas del libro de movimientos. '
  'No hay ninguna columna que las almacene.';

-- El total del producto en toda la empresa, con el mínimo al lado.
CREATE VIEW stock_by_product WITH (security_invoker = true) AS
SELECT s.company_id,
       s.product_id,
       s.producto_codigo,
       s.producto_nombre,
       s.unidad,
       s.stock_minimo,
       sum(s.existencia)::numeric(18, 4) AS existencia,
       count(*)::int                     AS depositos,
       max(s.ultimo_movimiento)          AS ultimo_movimiento,
       -- Solo se afirma que falta stock si alguien declaró cuánto es el mínimo.
       (s.stock_minimo IS NOT NULL
        AND sum(s.existencia) < s.stock_minimo)  AS bajo_minimo
  FROM stock_on_hand s
 GROUP BY s.company_id, s.product_id, s.producto_codigo, s.producto_nombre,
          s.unidad, s.stock_minimo;

COMMENT ON VIEW stock_by_product IS
  'Existencia total por producto. `bajo_minimo` es false cuando no hay mínimo '
  'declarado: el sistema no inventa el umbral.';

-- ---------------------------------------------------------------------------
-- 8 · Las ramas de stock en la bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_stock WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 28 · Existencia negativa.
--      Se vendió o se ajustó más de lo que había. No bloquea la contabilidad,
--      pero es un dato imposible: en algún lado falta un movimiento.
SELECT s.company_id,
       'EXISTENCIA_NEGATIVA'::text                  AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       'products'::text                             AS entidad,
       s.product_id                                 AS entity_id,
       'NEGATIVA'::text                             AS estado,
       s.producto_codigo || ' tiene existencia ' || s.existencia ||
         ': falta registrar un movimiento'          AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       now()                                        AS creado_en,
       now()                                        AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/products/' || s.product_id                 AS traza_ref
  FROM stock_by_product s
 WHERE s.existencia < 0

UNION ALL

-- 29 · Stock bajo el mínimo declarado.
--      Solo con mínimo declarado. Sin eso no hay umbral que comparar y el aviso
--      sería ruido con apariencia de dato.
SELECT s.company_id,
       'STOCK_BAJO_MINIMO'::text                    AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       'products'::text                             AS entidad,
       s.product_id                                 AS entity_id,
       'BAJO_MINIMO'::text                          AS estado,
       s.producto_codigo || ': quedan ' || s.existencia || ' y el mínimo es ' ||
         s.stock_minimo                             AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       -- No se resuelve desde la bandeja: hay que comprar. Es informativo.
       'INFORMATIVO'::text                          AS disponibilidad,
       now()                                        AS creado_en,
       now()                                        AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/products/' || s.product_id                 AS traza_ref
  FROM stock_by_product s
 WHERE s.bajo_minimo AND s.existencia >= 0

UNION ALL

-- 30 · Venta facturada de productos con stock, sin salida registrada.
--      El hueco que deja no descontar automáticamente al facturar. Se hace
--      visible en vez de taparse eligiendo un depósito por defecto, que sería
--      inventar el dato más importante del movimiento.
SELECT t.company_id,
       'VENTA_SIN_SALIDA_DE_STOCK'::text            AS rama,
       'REQUIERE_DECLARACION'::text                 AS categoria,
       'tax_transactions'::text                     AS entidad,
       t.id                                         AS entity_id,
       'SIN_SALIDA'::text                           AS estado,
       'El comprobante ' || t.punto_venta || '-' || t.cbte_numero ||
         ' facturó productos con stock y no tiene salida registrada' AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       t.created_at                                 AS creado_en,
       t.created_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/tax-transactions/' || t.id                 AS traza_ref
  FROM tax_transactions t
 WHERE t.direction = 'VENTAS'
   AND EXISTS (SELECT 1
                 FROM tax_transaction_lines l
                 JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
                WHERE l.tax_transaction_id = t.id AND p.tracks_stock)
   AND NOT EXISTS (SELECT 1 FROM stock_movements m
                    WHERE m.origen_tipo = 'VENTA' AND m.origen_id = t.id)

) q;

COMMENT ON VIEW work_queue_stock IS
  'Ramas de stock. STOCK_BAJO_MINIMO solo aparece con mínimo declarado; '
  'VENTA_SIN_SALIDA_DE_STOCK es el hueco de no descontar automáticamente, '
  'hecho visible a propósito.';

DROP VIEW work_queue;
CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL
SELECT * FROM work_queue_comercial
UNION ALL
SELECT * FROM work_queue_compras
UNION ALL
SELECT * FROM work_queue_cobranzas
UNION ALL
SELECT * FROM work_queue_stock;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

-- ---------------------------------------------------------------------------
-- 9 · Permisos
-- ---------------------------------------------------------------------------
-- Mover mercadería lo hace el depósito, no la contaduría. Pero un ajuste
-- cambia la existencia sin que entre ni salga nada del mundo real, y eso
-- impacta en la valuación: por eso `stock:adjust` va aparte.
INSERT INTO permissions (code, description) VALUES
  ('stock:read',   'Consultar existencias y movimientos de stock'),
  ('stock:write',  'Registrar salidas y transferencias, y administrar depósitos'),
  ('stock:adjust', 'Ajustar existencias por recuento, rotura o diferencia');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'stock:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code = 'stock:write';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
  AND p.code = 'stock:adjust';

-- ---------------------------------------------------------------------------
-- 10 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouses
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_movements
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON warehouses TO aai_app;
GRANT SELECT, INSERT ON stock_movements TO aai_app;
GRANT SELECT ON stock_on_hand TO aai_app;
GRANT SELECT ON stock_by_product TO aai_app;
GRANT SELECT ON work_queue_stock TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
