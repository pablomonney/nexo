-- 0052_recepcion_y_conciliacion_de_compras.sql — lo que se pidió, lo que llegó
-- y lo que facturaron.
--
-- ## El control que falta
--
-- La mitad de compras de `commercial_documents` ya existe: se puede emitir una
-- orden de compra. Lo que no existe es el hecho intermedio —**la mercadería
-- llegó**— y sin él no se puede hacer la comprobación que cualquier empresa que
-- compra necesita:
--
--   ORDEN DE COMPRA   ¿qué pedí?
--        ↓
--   RECEPCIÓN         ¿qué llegó?
--        ↓
--   FACTURA           ¿qué me cobraron?
--
-- Las tres cantidades tienen que coincidir. Cuando no coinciden hay algo que
-- resolver: llegó de menos, cobraron de más, o falta una de las tres piezas.
-- Es un control clásico y es exactamente la clase de pregunta que este sistema
-- sabe hacer: no compara contra un estado que alguien escribió, compara hechos.
--
-- ## La factura de compra NO se crea acá
--
-- En ventas, NEXO emite: el pedido **se convierte** en `tax_transaction`
-- (ADR-014). En compras es al revés — la factura la emite el proveedor y llega
-- como documento, se archiva y se registra por el camino que ya existe. Lo que
-- falta es **decir a qué orden corresponde**, y eso reutiliza la misma columna:
--
--   VENTAS   commercial_documents.tax_transaction_id ← se crea al facturar
--   COMPRAS  commercial_documents.tax_transaction_id ← se vincula a una que ya llegó
--
-- Una columna, dos maneras de llenarla según la dirección. No hacen falta dos.
--
-- ## Todavía no es stock
--
-- Una recepción registra que la mercadería llegó. No mueve existencias porque
-- no hay depósitos ni movimientos de stock: eso es otro módulo. Cuando exista,
-- la recepción va a ser su origen — y por eso se guarda la cantidad recibida,
-- que es el dato que ese módulo va a necesitar.

-- ---------------------------------------------------------------------------
-- 1 · El contador se reutiliza
-- ---------------------------------------------------------------------------
-- `commercial_counters` ya numera por empresa, dirección y tipo. Una recepción
-- es otro tipo, no otro mecanismo: una tabla de contadores nueva sería la misma
-- tabla con otro nombre.
ALTER TABLE commercial_counters DROP CONSTRAINT commercial_counters_kind_check;
ALTER TABLE commercial_counters ADD CONSTRAINT commercial_counters_kind_check
  CHECK (kind IN ('PRESUPUESTO', 'PEDIDO', 'RECEPCION'));

-- ---------------------------------------------------------------------------
-- 2 · La recepción
-- ---------------------------------------------------------------------------
CREATE TABLE goods_receipts (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id             uuid NOT NULL REFERENCES companies (id),
  number                 integer NOT NULL CHECK (number > 0),

  -- La orden que la origina. `NULL` es legítimo y frecuente: llega mercadería
  -- sin orden previa, y obligar a inventar una orden para poder registrar lo
  -- que ya está en el depósito invertiría la prioridad.
  commercial_document_id uuid,

  party_id               uuid NOT NULL,
  received_at            date NOT NULL,

  -- El remito del proveedor. Es la evidencia de la entrega y va tal cual viene.
  remito_numero          text,

  notes                  text,

  status                 text NOT NULL DEFAULT 'BORRADOR'
                           CHECK (status IN ('BORRADOR', 'CONFIRMADA', 'ANULADA')),
  motivo_anulacion       text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, number),

  CONSTRAINT gr_anulada_con_motivo
    CHECK (status <> 'ANULADA' OR length(btrim(coalesce(motivo_anulacion, ''))) > 2),

  CONSTRAINT gr_id_empresa UNIQUE (company_id, id),

  CONSTRAINT gr_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT gr_orden_fk
    FOREIGN KEY (company_id, commercial_document_id)
    REFERENCES commercial_documents (company_id, id)
);

CREATE INDEX gr_por_orden ON goods_receipts (company_id, commercial_document_id)
  WHERE commercial_document_id IS NOT NULL;
CREATE INDEX gr_por_proveedor ON goods_receipts (company_id, party_id, received_at DESC);

COMMENT ON TABLE goods_receipts IS
  'Qué mercadería llegó y cuándo. No mueve existencias: el módulo de stock no '
  'existe todavía. Cuando exista, esta es su fuente.';

CREATE TRIGGER goods_receipts_updated_at
  BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER goods_receipts_no_delete
  BEFORE DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE goods_receipt_lines (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  receipt_id    uuid NOT NULL,
  line_no       integer NOT NULL CHECK (line_no > 0),

  product_id    uuid,
  descripcion   text NOT NULL CHECK (length(btrim(descripcion)) > 0),

  cantidad      numeric(18, 4) NOT NULL CHECK (cantidad > 0),
  unidad        text NOT NULL DEFAULT 'UNIDAD',

  -- Lo que el depósito anotó al recibir: «dos cajas rotas», «faltan tres».
  -- Es texto libre a propósito: una lista cerrada de motivos obligaría a elegir
  -- el menos malo, y lo que se pierde es justo el detalle que sirve al reclamo.
  observaciones text,

  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (receipt_id, line_no),

  CONSTRAINT grl_recepcion_fk
    FOREIGN KEY (company_id, receipt_id) REFERENCES goods_receipts (company_id, id),
  CONSTRAINT grl_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id)
);

CREATE INDEX grl_recepcion_idx ON goods_receipt_lines (receipt_id, line_no);
CREATE INDEX grl_producto_idx ON goods_receipt_lines (company_id, product_id)
  WHERE product_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3 · Una recepción confirmada no se edita
-- ---------------------------------------------------------------------------
-- Confirmar es afirmar que eso fue lo que llegó. Si estaba mal, se anula con
-- motivo y se registra la correcta: el mismo criterio que el contraasiento.
CREATE OR REPLACE FUNCTION assert_recepcion_editable() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fila goods_receipt_lines%ROWTYPE;
  estado text;
BEGIN
  fila := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;

  SELECT r.status INTO estado
    FROM goods_receipts r
   WHERE r.id = fila.receipt_id AND r.company_id = fila.company_id;

  IF NOT FOUND THEN RETURN fila; END IF;

  IF estado <> 'BORRADOR' THEN
    RAISE EXCEPTION
      'La recepción % está en %: lo que se confirmó que llegó no se edita. Anulala y registrá la correcta.',
      fila.receipt_id, estado
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN fila;
END;
$$;

CREATE TRIGGER grl_editables
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION assert_recepcion_editable();

CREATE OR REPLACE FUNCTION assert_transicion_recepcion() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  -- BORRADOR → CONFIRMADA → ANULADA. ANULADA es terminal: una recepción anulada
  -- no revive, se registra otra.
  IF OLD.status = 'ANULADA'
     OR (OLD.status = 'BORRADOR' AND NEW.status NOT IN ('CONFIRMADA', 'ANULADA'))
     OR (OLD.status = 'CONFIRMADA' AND NEW.status <> 'ANULADA') THEN
    RAISE EXCEPTION 'Transición inválida: % → %.', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'CONFIRMADA'
     AND NOT EXISTS (SELECT 1 FROM goods_receipt_lines l WHERE l.receipt_id = NEW.id) THEN
    RAISE EXCEPTION 'No se confirma una recepción sin renglones: no habría llegado nada'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER goods_receipts_transicion
  BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_recepcion();

-- ---------------------------------------------------------------------------
-- 4 · La conciliación de tres puntas
-- ---------------------------------------------------------------------------
-- Por orden de compra y por producto: cuánto se pidió, cuánto llegó, cuánto
-- facturaron. Todo derivado; no hay ninguna columna que mantener al día.
--
-- El agrupamiento es por producto cuando lo hay y por descripción cuando no.
-- No es un capricho: un renglón sin producto del maestro es frecuente en
-- compras, y dejarlo afuera de la conciliación haría que el control mirara solo
-- la parte fácil.
CREATE VIEW purchase_match WITH (security_invoker = true) AS
WITH pedido AS (
  SELECT d.company_id,
         d.id                                       AS order_id,
         l.product_id,
         coalesce(p.code, l.descripcion)            AS item,
         sum(l.cantidad)                            AS pedido
    FROM commercial_documents d
    JOIN commercial_document_lines l
      ON l.document_id = d.id AND l.company_id = d.company_id
    LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE d.direction = 'COMPRAS' AND d.status <> 'ANULADO'
   GROUP BY d.company_id, d.id, l.product_id, coalesce(p.code, l.descripcion)
),
recibido AS (
  SELECT r.company_id,
         r.commercial_document_id                   AS order_id,
         l.product_id,
         coalesce(p.code, l.descripcion)            AS item,
         sum(l.cantidad)                            AS recibido
    FROM goods_receipts r
    JOIN goods_receipt_lines l
      ON l.receipt_id = r.id AND l.company_id = r.company_id
    LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE r.status = 'CONFIRMADA' AND r.commercial_document_id IS NOT NULL
   GROUP BY r.company_id, r.commercial_document_id, l.product_id,
            coalesce(p.code, l.descripcion)
),
facturado AS (
  SELECT d.company_id,
         d.id                                       AS order_id,
         l.product_id,
         coalesce(p.code, l.descripcion)            AS item,
         sum(l.cantidad)                            AS facturado
    FROM commercial_documents d
    JOIN tax_transaction_lines l
      ON l.tax_transaction_id = d.tax_transaction_id AND l.company_id = d.company_id
    LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE d.direction = 'COMPRAS' AND d.tax_transaction_id IS NOT NULL
   GROUP BY d.company_id, d.id, l.product_id, coalesce(p.code, l.descripcion)
)
SELECT coalesce(pe.company_id, re.company_id, fa.company_id) AS company_id,
       coalesce(pe.order_id, re.order_id, fa.order_id)       AS order_id,
       coalesce(pe.item, re.item, fa.item)                   AS item,
       coalesce(pe.product_id, re.product_id, fa.product_id) AS product_id,
       -- El casteo explícito no es decoración: sin él, un `coalesce(…, 0)` que
       -- cae en el cero devuelve el entero `0` y el mismo campo llega como
       -- "0" en un caso y "8.0000" en otro. Quien consuma la API tendría que
       -- adivinar el formato según los datos.
       coalesce(pe.pedido, 0)::numeric(18, 4)                AS pedido,
       coalesce(re.recibido, 0)::numeric(18, 4)              AS recibido,
       coalesce(fa.facturado, 0)::numeric(18, 4)             AS facturado,
       (coalesce(pe.pedido, 0) - coalesce(re.recibido, 0))::numeric(18, 4)
                                                             AS pendiente_de_recibir,
       (coalesce(re.recibido, 0) - coalesce(fa.facturado, 0))::numeric(18, 4)
                                                             AS recibido_sin_facturar,
       (coalesce(pe.pedido, 0) = coalesce(re.recibido, 0)
        AND coalesce(re.recibido, 0) = coalesce(fa.facturado, 0)) AS coincide
  FROM pedido pe
  FULL JOIN recibido re
    ON re.company_id = pe.company_id AND re.order_id = pe.order_id AND re.item = pe.item
  FULL JOIN facturado fa
    ON fa.company_id = coalesce(pe.company_id, re.company_id)
   AND fa.order_id = coalesce(pe.order_id, re.order_id)
   AND fa.item = coalesce(pe.item, re.item);

COMMENT ON VIEW purchase_match IS
  'Conciliación de tres puntas por orden de compra y por ítem: pedido, '
  'recibido y facturado. Derivada. Una fila con coincide = false es trabajo.';

-- ---------------------------------------------------------------------------
-- 5 · Las ramas de compras en la bandeja
-- ---------------------------------------------------------------------------
-- La 0051 hizo que agregar ramas sea agregar una vista y un renglón en la
-- unión. Esto es la primera vez que se cobra ese trabajo.
CREATE VIEW work_queue_compras WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 24 · Llegó mercadería de una orden y todavía no hay factura del proveedor.
--      Es deuda que existe y no está registrada: el pasivo está subvaluado
--      hasta que se cargue la factura.
SELECT d.company_id,
       'RECIBIDO_SIN_FACTURA'::text                 AS rama,
       'REQUIERE_EVIDENCIA'::text                   AS categoria,
       'commercial_documents'::text                 AS entidad,
       d.id                                         AS entity_id,
       d.status                                     AS estado,
       'La orden de compra ' || d.number || ' tiene mercadería recibida y ' ||
         'ninguna factura del proveedor vinculada'  AS motivo,
       false                                        AS bloquea,
       ARRAY['factura del proveedor']::text[]       AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       -- No se resuelve desde adentro: hace falta que el proveedor mande la
       -- factura. Es informativo hasta que llegue.
       'INFORMATIVO'::text                          AS disponibilidad,
       d.created_at                                 AS creado_en,
       d.updated_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/commercial-documents/' || d.id             AS traza_ref
  FROM commercial_documents d
 WHERE d.direction = 'COMPRAS'
   AND d.status <> 'ANULADO'
   AND d.tax_transaction_id IS NULL
   AND EXISTS (SELECT 1 FROM goods_receipts r
                WHERE r.commercial_document_id = d.id
                  AND r.company_id = d.company_id
                  AND r.status = 'CONFIRMADA')

UNION ALL

-- 25 · Las tres cantidades no coinciden.
--      Llegó de menos, cobraron de más, o falta registrar una recepción. Sea
--      cual sea, alguien tiene que mirarlo antes de pagar.
SELECT m.company_id,
       'COMPRA_NO_CONCILIA'::text                   AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       'commercial_documents'::text                 AS entidad,
       m.order_id                                   AS entity_id,
       'CONCILIACION'::text                         AS estado,
       'En ' || m.item || ': se pidieron ' || m.pedido || ', llegaron ' ||
         m.recibido || ' y facturaron ' || m.facturado AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       d.created_at                                 AS creado_en,
       d.updated_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/commercial-documents/' || m.order_id       AS traza_ref
  FROM purchase_match m
  JOIN commercial_documents d
    ON d.id = m.order_id AND d.company_id = m.company_id
 WHERE NOT m.coincide
   -- Solo cuando ya hay factura: antes de que llegue, la diferencia entre
   -- pedido y recibido es una entrega en curso, no un problema.
   AND d.tax_transaction_id IS NOT NULL

) q;

COMMENT ON VIEW work_queue_compras IS
  'Ramas del circuito de compras. Derivadas de la conciliación de tres puntas, '
  'no de estados que alguien tenga que escribir.';

DROP VIEW work_queue;
CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL
SELECT * FROM work_queue_comercial
UNION ALL
SELECT * FROM work_queue_compras;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

-- ---------------------------------------------------------------------------
-- 6 · Permisos
-- ---------------------------------------------------------------------------
-- Registrar lo que llegó al depósito no es un acto contable: lo hace quien
-- recibe. Confirmarlo tampoco — lo que sí es contable es facturarlo, y ese
-- permiso ya existe y es otro.
INSERT INTO permissions (code, description) VALUES
  ('receipt:read',  'Consultar recepciones de mercadería y su conciliación'),
  ('receipt:write', 'Registrar y confirmar la recepción de mercadería');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'receipt:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code = 'receipt:write';

-- ---------------------------------------------------------------------------
-- 7 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goods_receipts
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE goods_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goods_receipt_lines
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON goods_receipts TO aai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON goods_receipt_lines TO aai_app;
GRANT SELECT ON purchase_match TO aai_app;
GRANT SELECT ON work_queue_compras TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
