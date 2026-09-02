-- ============================================================================
-- 0067 — Lotes, vencimientos y recuento físico
-- ============================================================================
--
-- Tres cosas que faltaban en stock y que están relacionadas: sin lote no hay
-- trazabilidad de mercadería, sin vencimiento no hay aviso de pérdida, y sin
-- recuento no hay forma de que la existencia derivada vuelva a coincidir con la
-- realidad cuando se separaron.
--
-- ## El lote se declara por producto, como todo lo demás
--
-- `products.lleva_lote` es opt-in. Una ferretería no lleva lotes de tornillos y
-- obligarla a inventar uno por movimiento convertiría el campo en ruido. Una
-- distribuidora de alimentos lo declara, y desde ese momento **la base exige el
-- lote en cada movimiento**: un producto que lleva lotes y un movimiento sin
-- lote es una existencia que después no se puede rastrear.
--
-- ## El vencimiento entra con la mercadería, no con el producto
--
-- No es un atributo del producto: dos lotes del mismo artículo vencen en fechas
-- distintas, y esa es la razón entera por la que existen los lotes. Se declara
-- en el movimiento de entrada y se arrastra por lote.
--
-- ## El recuento no corrige: ajusta, y deja el rastro
--
-- Un recuento físico no reescribe la existencia — eso sería editar el libro. Al
-- cerrarlo, la diferencia contra lo derivado produce **movimientos de ajuste**
-- con su motivo citando el recuento. El libro sigue siendo append-only y la
-- historia queda: se contó, no coincidía, se ajustó, y está escrito quién.
--
-- ## Lo que NO hace, y es importante
--
-- **No valúa nada.** Un lote que vence es una pérdida, y cuánto vale esa pérdida
-- depende de la valuación de existencias —PPP, FIFO o costo de reposición— que
-- es una decisión contable con norma detrás y sigue sin tomarse. Así que todo
-- lo que este módulo informa son **cantidades**, y lo dice.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · Qué productos llevan lote
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN lleva_lote boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN products.lleva_lote IS
  'Opt-in. Una ferretería no lleva lotes de tornillos; obligarla a inventar uno '
  'por movimiento convertiría el campo en ruido. Declarado, la base lo exige.';

-- Un servicio no tiene existencias, así que tampoco tiene lotes.
ALTER TABLE products
  ADD CONSTRAINT products_lote_exige_stock
    CHECK (NOT lleva_lote OR tracks_stock);

-- ---------------------------------------------------------------------------
-- 2 · El lote y su vencimiento, en el movimiento
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movements
  ADD COLUMN lote text CHECK (lote IS NULL OR length(btrim(lote)) > 0),
  -- Nulo es válido y significa «no vence» o «nadie lo declaró». No se deduce de
  -- ninguna parte: el vencimiento viene impreso en la mercadería.
  ADD COLUMN fecha_vencimiento date;

COMMENT ON COLUMN stock_movements.fecha_vencimiento IS
  'Del lote, declarado al entrar. No es un atributo del producto: dos lotes del '
  'mismo artículo vencen en fechas distintas, y esa es la razón por la que '
  'existen los lotes.';

CREATE INDEX sm_por_lote ON stock_movements (company_id, product_id, lote)
  WHERE lote IS NOT NULL;

-- El producto que lleva lote lo exige en cada movimiento. El candado está en la
-- base y no en la ruta: un movimiento sin lote sobre un producto trazable es una
-- existencia que después no se puede rastrear, por el camino que sea.
CREATE FUNCTION assert_lote_declarado() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  exige boolean;
BEGIN
  SELECT p.lleva_lote INTO exige
    FROM products p WHERE p.id = NEW.product_id AND p.company_id = NEW.company_id;

  IF exige AND NEW.lote IS NULL THEN
    RAISE EXCEPTION
      'E_STOCK_SIN_LOTE: el producto lleva trazabilidad por lote y el movimiento no lo declara.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT exige AND NEW.lote IS NOT NULL THEN
    RAISE EXCEPTION
      'E_STOCK_LOTE_SIN_TRAZABILIDAD: el producto no lleva lotes y el movimiento declara uno.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER sm_lote_declarado
  AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_lote_declarado();

-- ---------------------------------------------------------------------------
-- 3 · La existencia por lote, derivada
-- ---------------------------------------------------------------------------
-- Misma forma que `stock_on_hand`: el signo sale del tipo de movimiento y no se
-- guarda ningún saldo.
CREATE VIEW stock_by_lot WITH (security_invoker = true) AS
SELECT m.company_id,
       m.product_id,
       p.code                                   AS producto_codigo,
       p.name                                   AS producto_nombre,
       m.warehouse_id,
       w.code                                   AS deposito_codigo,
       m.lote,
       -- El vencimiento del lote es el que se declaró al entrar. Se toma el
       -- máximo declarado: si dos entradas del mismo lote traen fechas
       -- distintas, alguien se equivocó, y quedarse con la más lejana no
       -- esconde el vencimiento más cercano — lo muestra la rama de la bandeja.
       max(m.fecha_vencimiento)                 AS fecha_vencimiento,
       sum(CASE
             WHEN m.tipo IN ('ENTRADA', 'AJUSTE_POSITIVO', 'TRANSFERENCIA_ENTRADA')
               THEN m.cantidad
             ELSE -m.cantidad
           END)                                 AS existencia,
       max(m.fecha)                             AS ultimo_movimiento
  FROM stock_movements m
  JOIN products p ON p.id = m.product_id AND p.company_id = m.company_id
  JOIN warehouses w ON w.id = m.warehouse_id AND w.company_id = m.company_id
 WHERE m.lote IS NOT NULL
 GROUP BY m.company_id, m.product_id, p.code, p.name, m.warehouse_id, w.code, m.lote
HAVING sum(CASE
             WHEN m.tipo IN ('ENTRADA', 'AJUSTE_POSITIVO', 'TRANSFERENCIA_ENTRADA')
               THEN m.cantidad
             ELSE -m.cantidad
           END) <> 0;

COMMENT ON VIEW stock_by_lot IS
  'Existencia por lote, derivada del libro. Solo cantidades: cuánto vale un '
  'lote depende de la valuación de existencias, que es una decisión contable '
  'sin tomar.';

-- ---------------------------------------------------------------------------
-- 4 · El recuento físico
-- ---------------------------------------------------------------------------
CREATE TABLE stock_counts (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  warehouse_id   uuid NOT NULL,

  fecha          date NOT NULL,
  status         text NOT NULL DEFAULT 'BORRADOR'
                   CHECK (status IN ('BORRADOR', 'CERRADO', 'ANULADO')),
  notas          text,
  motivo_anulacion text,

  closed_at      timestamptz,
  closed_by      text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT sc_cerrado_firmado
    CHECK (status <> 'CERRADO' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT sc_anulado_con_motivo
    CHECK (status <> 'ANULADO' OR length(btrim(coalesce(motivo_anulacion, ''))) > 2),
  CONSTRAINT sc_deposito_fk
    FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id),
  CONSTRAINT sc_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY sc_por_empresa ON stock_counts
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON stock_counts TO aai_app;

COMMENT ON TABLE stock_counts IS
  'Un recuento físico. Al cerrarlo, la diferencia contra la existencia derivada '
  'produce movimientos de ajuste: el libro no se reescribe, se le agrega la '
  'corrección con su motivo.';

CREATE TABLE stock_count_lines (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  count_id       uuid NOT NULL,
  product_id     uuid NOT NULL,
  lote           text,

  -- Lo que se contó. Cero es un valor válido y distinto de no haber contado:
  -- «no hay ninguno» es un hallazgo, «no lo miré» es otra cosa.
  cantidad       numeric(18, 4) NOT NULL CHECK (cantidad >= 0),

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scl_recuento_fk
    FOREIGN KEY (company_id, count_id) REFERENCES stock_counts (company_id, id)
    ON DELETE CASCADE,
  CONSTRAINT scl_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  -- Un producto —y un lote— se cuentan una sola vez por recuento. Dos filas
  -- para lo mismo dejarían la diferencia sin definir.
  CONSTRAINT scl_unico UNIQUE (company_id, count_id, product_id, lote)
);

ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY scl_por_empresa ON stock_count_lines
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON stock_count_lines TO aai_app;

-- Un recuento cerrado no se toca: sus diferencias ya produjeron ajustes en el
-- libro, y editarlo dejaría el ajuste sin respaldo.
CREATE FUNCTION assert_recuento_editable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  estado text;
BEGIN
  SELECT c.status INTO estado
    FROM stock_counts c
   WHERE c.id = coalesce(NEW.count_id, OLD.count_id)
     AND c.company_id = coalesce(NEW.company_id, OLD.company_id);

  IF estado <> 'BORRADOR' THEN
    RAISE EXCEPTION
      'E_RECUENTO_CERRADO: el recuento está en % y sus diferencias ya se ajustaron.', estado
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER scl_editable
  AFTER INSERT OR UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION assert_recuento_editable();

-- ---------------------------------------------------------------------------
-- 5 · La diferencia, derivada
-- ---------------------------------------------------------------------------
-- Lo contado contra lo que dice el libro, sin guardar ninguna de las dos.
CREATE VIEW stock_count_differences WITH (security_invoker = true) AS
SELECT l.company_id,
       l.count_id,
       c.warehouse_id,
       l.product_id,
       p.code                                          AS producto_codigo,
       p.name                                          AS producto_nombre,
       l.lote,
       l.cantidad                                      AS contado,
       coalesce(e.existencia, 0)                       AS segun_libro,
       l.cantidad - coalesce(e.existencia, 0)          AS diferencia
  FROM stock_count_lines l
  JOIN stock_counts c ON c.id = l.count_id AND c.company_id = l.company_id
  JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
  LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN l.lote IS NULL THEN
                   (SELECT s.existencia FROM stock_on_hand s
                     WHERE s.company_id = l.company_id
                       AND s.product_id = l.product_id
                       AND s.warehouse_id = c.warehouse_id)
                 ELSE
                   (SELECT b.existencia FROM stock_by_lot b
                     WHERE b.company_id = l.company_id
                       AND b.product_id = l.product_id
                       AND b.warehouse_id = c.warehouse_id
                       AND b.lote = l.lote)
               END AS existencia
       ) e ON true;

COMMENT ON VIEW stock_count_differences IS
  'Lo contado contra lo que dice el libro. Ninguna de las dos cifras se guarda: '
  'la contada está en el renglón y la del libro se deriva de los movimientos.';

-- ---------------------------------------------------------------------------
-- 6 · Las ramas nuevas de la bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_lotes WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Lote vencido con existencia. Es un hecho —la fecha pasó— y no necesita
--     umbral. No dice cuánto se perdió en plata: eso exige valuar existencias,
--     que es una decisión contable sin tomar.
SELECT b.company_id,
       'LOTE_VENCIDO'::text                          AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'products'::text                              AS entidad,
       b.product_id                                  AS entity_id,
       'VENCIDO'::text                               AS estado,
       'El lote ' || b.lote || ' de ' || b.producto_codigo ||
         ' venció el ' || b.fecha_vencimiento || ' y quedan ' || b.existencia ||
         ' en ' || b.deposito_codigo                 AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       b.ultimo_movimiento::timestamptz              AS creado_en,
       b.ultimo_movimiento::timestamptz              AS actualizado_en,
       b.fecha_vencimiento                           AS fecha_limite,
       '/products/' || b.product_id || '/stock'      AS traza_ref
  FROM stock_by_lot b
 WHERE b.existencia > 0
   AND b.fecha_vencimiento IS NOT NULL
   AND b.fecha_vencimiento < current_date

UNION ALL

-- 2 · Un recuento abierto hace más de lo razonable no existe como rama: sería
--     un umbral inventado. Lo que sí es un hecho: un recuento en borrador con
--     diferencias cargadas y sin cerrar — el ajuste está calculado y no aplicado.
SELECT c.company_id,
       'RECUENTO_SIN_CERRAR'::text                   AS rama,
       'REQUIERE_APROBACION'::text                   AS categoria,
       'stock_counts'::text                          AS entidad,
       c.id                                          AS entity_id,
       c.status                                      AS estado,
       'El recuento del ' || c.fecha || ' tiene ' || count(d.product_id) ||
         ' diferencia(s) contadas y sigue en borrador: el ajuste está calculado ' ||
         'y no aplicado'                             AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       c.created_at                                  AS creado_en,
       c.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/stock-counts/' || c.id                      AS traza_ref
  FROM stock_counts c
  JOIN stock_count_differences d
    ON d.count_id = c.id AND d.company_id = c.company_id AND d.diferencia <> 0
 WHERE c.status = 'BORRADOR'
 GROUP BY c.company_id, c.id, c.fecha, c.status, c.created_at

) q;

COMMENT ON VIEW work_queue_lotes IS
  'Ramas de lotes y recuento. Las dos son hechos: una fecha que pasó y un '
  'ajuste calculado que nadie aplicó. No hay «próximo a vencer» porque '
  '«próximo» sería un umbral que nadie declaró.';

-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la bandeja de una empresa aparecería en la de otra.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios
UNION ALL SELECT * FROM work_queue_cheques
UNION ALL SELECT * FROM work_queue_lotes;

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
-- Cerrar un recuento genera ajustes de existencia, que es lo que `stock:adjust`
-- ya protege. No se inventa un permiso nuevo para el mismo poder.
INSERT INTO permissions (code, description) VALUES
  ('stock:count', 'Cargar y cerrar recuentos físicos de existencias');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
   AND p.code = 'stock:count';

GRANT SELECT ON stock_by_lot TO aai_app;
GRANT SELECT ON stock_count_differences TO aai_app;
GRANT SELECT ON work_queue_lotes TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
