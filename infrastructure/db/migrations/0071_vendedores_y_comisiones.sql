-- ============================================================================
-- 0071 — Vendedores y comisiones
-- ============================================================================
--
-- El comprobante de venta sabe a quién se le vendió y no sabe **quién vendió**.
-- Es el dato que falta para dos preguntas que toda pyme con vendedores se hace
-- todos los meses: cuánto vendió cada uno, y cuánto hay que pagarle.
--
-- ## El esquema de comisión se declara, siempre
--
-- Un porcentaje de comisión es un **acuerdo entre dos personas**, no un dato
-- derivable de nada. NEXO no trae un porcentaje por defecto ni lo infiere de
-- las ventas: sin esquema vigente para la fecha del comprobante, la comisión de
-- ese comprobante es NULL y la bandeja dice de quién falta el acuerdo.
--
-- ## Y la base también, porque las tres bases dan números distintos
--
--   · `NETO_FACTURADO`  — sobre el neto. Es la venta de la empresa.
--   · `TOTAL_FACTURADO` — sobre el total, IVA incluido. Se usa, y hay que saber
--     lo que implica: se paga comisión sobre un impuesto que la empresa cobra
--     para ARCA y no es suyo.
--   · `TOTAL_COBRADO`   — sobre lo efectivamente imputado al comprobante
--     (0053). Devenga a medida que entra la plata.
--
-- Cuál corresponde no lo decide un sistema contable: lo dice el acuerdo. NEXO
-- ofrece las tres, calcula la declarada, y **escribe cuál usó** al lado de cada
-- cifra.
--
-- ## Devengar no es pagar
--
-- Esta migración calcula lo devengado y no escribe un peso en el Mayor. La
-- comisión a pagar es un pasivo, y ese asiento lo firma una persona por el
-- camino de siempre. Un módulo que lo asentara solo tendría dos orígenes para
-- el mismo saldo de «Comisiones a pagar».
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El vendedor
-- ---------------------------------------------------------------------------
CREATE TABLE salespeople (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),

  code         text NOT NULL CHECK (length(btrim(code)) > 0),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),

  -- Cuando el vendedor es externo y factura sus comisiones, es además un
  -- tercero. Nulo cuando es del equipo: NEXO no tiene legajos —RRHH está
  -- bloqueado (ADR-012 §8)— y crear un tercero para un empleado ensuciaría el
  -- maestro con alguien a quien no se le compra ni se le vende.
  party_id     uuid,

  status       text NOT NULL DEFAULT 'ACTIVO' CHECK (status IN ('ACTIVO', 'INACTIVO')),

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,

  CONSTRAINT sp_code_unico UNIQUE (company_id, code),
  CONSTRAINT sp_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT sp_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE salespeople ENABLE ROW LEVEL SECURITY;
ALTER TABLE salespeople FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_por_empresa ON salespeople
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON salespeople TO aai_app;

-- Un vendedor con ventas no se borra: se inactiva. Borrarlo dejaría
-- comprobantes citando a alguien que no existe, y las ventas del año pasado sin
-- dueño.
CREATE FUNCTION salespeople_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'E_VEND_NO_BORRA: un vendedor se inactiva, no se borra: sus ventas quedarían sin dueño.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER salespeople_no_delete BEFORE DELETE ON salespeople
  FOR EACH ROW EXECUTE FUNCTION salespeople_no_delete();

-- ---------------------------------------------------------------------------
-- 2 · Quién vendió cada comprobante
-- ---------------------------------------------------------------------------
-- Se agrega al comprobante y no a una tabla aparte: el vendedor es un atributo
-- de la operación, y una tabla puente permitiría que un comprobante tuviera dos
-- —o ninguno con el mismo derecho—, y ahí la comisión pasa a ser una opinión.
ALTER TABLE tax_transactions ADD COLUMN salesperson_id uuid;

ALTER TABLE tax_transactions ADD CONSTRAINT tt_vendedor_fk
  FOREIGN KEY (company_id, salesperson_id) REFERENCES salespeople (company_id, id);

CREATE INDEX tt_por_vendedor ON tax_transactions (company_id, salesperson_id, cbte_fecha);

COMMENT ON COLUMN tax_transactions.salesperson_id IS
  'Quién vendió. Nulo es válido —no toda venta tiene vendedor— pero si la '
  'empresa declaró vendedores, la bandeja avisa por los comprobantes que no lo '
  'dicen: sin esto, la comisión no se puede atribuir.';

-- ---------------------------------------------------------------------------
-- 3 · El esquema de comisión, declarado y con vigencia
-- ---------------------------------------------------------------------------
CREATE TABLE commission_schemes (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  salesperson_id uuid NOT NULL,

  porcentaje     numeric(5, 2) NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 100),
  base           text NOT NULL
                   CHECK (base IN ('NETO_FACTURADO', 'TOTAL_FACTURADO', 'TOTAL_COBRADO')),

  vigencia_desde date NOT NULL,
  vigencia_hasta date,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT cms_vigencia_coherente
    CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT cms_vendedor_fk
    FOREIGN KEY (company_id, salesperson_id) REFERENCES salespeople (company_id, id)
);

ALTER TABLE commission_schemes ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_schemes FORCE ROW LEVEL SECURITY;
CREATE POLICY cms_por_empresa ON commission_schemes
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON commission_schemes TO aai_app;

COMMENT ON COLUMN commission_schemes.base IS
  'Sobre qué se calcula. Las tres dan números distintos y la diferencia no es '
  'menor: TOTAL_FACTURADO paga comisión sobre el IVA, que la empresa cobra para '
  'ARCA y no es suyo. Cuál corresponde lo dice el acuerdo, no el sistema.';

-- Dos esquemas vigentes el mismo día para el mismo vendedor dejan al sistema
-- sin criterio, y elegir por orden de carga sería azar disfrazado de regla.
-- Mismo candado que las listas de precios (0061) y las tarifas (0070).
CREATE FUNCTION assert_un_esquema_por_fecha() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commission_schemes e
     WHERE e.company_id = NEW.company_id
       AND e.salesperson_id = NEW.salesperson_id
       AND e.id <> NEW.id
       AND daterange(e.vigencia_desde, e.vigencia_hasta, '[]')
           && daterange(NEW.vigencia_desde, NEW.vigencia_hasta, '[]')
  ) THEN
    RAISE EXCEPTION
      'E_COM_ESQUEMA_SUPERPUESTO: ese vendedor ya tiene un esquema vigente en esas fechas.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cms_uno_por_fecha
  AFTER INSERT OR UPDATE ON commission_schemes
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_un_esquema_por_fecha();

-- ---------------------------------------------------------------------------
-- 4 · Lo devengado, comprobante por comprobante
-- ---------------------------------------------------------------------------
CREATE VIEW commission_accruals WITH (security_invoker = true) AS
SELECT i.company_id,
       i.tax_transaction_id,
       i.cbte_fecha,
       i.cbte_tipo,
       i.punto_venta,
       i.cbte_numero,
       i.razon_social                              AS cliente,
       t.salesperson_id,
       s.code                                      AS vendedor_codigo,
       s.name                                      AS vendedor_nombre,
       t.neto,
       i.total,
       i.imputado                                  AS cobrado,
       e.porcentaje,
       e.base,
       -- La base efectiva, dicha en números: es la cifra sobre la que se aplicó
       -- el porcentaje, y sin ella nadie puede rehacer la cuenta a mano.
       CASE e.base
         WHEN 'NETO_FACTURADO'  THEN t.neto
         WHEN 'TOTAL_FACTURADO' THEN i.total
         WHEN 'TOTAL_COBRADO'   THEN i.imputado
       END                                         AS base_importe,
       -- NULL sin esquema vigente para la fecha del comprobante: cero diría que
       -- ese vendedor no ganó nada por esa venta, y lo que pasa es que nadie
       -- declaró cuánto gana.
       CASE WHEN e.porcentaje IS NULL THEN NULL
            ELSE round(
                   CASE e.base
                     WHEN 'NETO_FACTURADO'  THEN t.neto
                     WHEN 'TOTAL_FACTURADO' THEN i.total
                     WHEN 'TOTAL_COBRADO'   THEN i.imputado
                   END * e.porcentaje / 100, 2)
       END                                         AS comision
  FROM invoice_settlement i
  JOIN tax_transactions t
    ON t.id = i.tax_transaction_id AND t.company_id = i.company_id
  LEFT JOIN salespeople s
    ON s.id = t.salesperson_id AND s.company_id = t.company_id
  LEFT JOIN LATERAL (
        SELECT e.porcentaje, e.base
          FROM commission_schemes e
         WHERE e.company_id = t.company_id
           AND e.salesperson_id = t.salesperson_id
           AND e.vigencia_desde <= i.cbte_fecha
           AND (e.vigencia_hasta IS NULL OR e.vigencia_hasta >= i.cbte_fecha)
         LIMIT 1
       ) e ON true
 WHERE i.direction = 'VENTAS'
   AND t.salesperson_id IS NOT NULL;

COMMENT ON VIEW commission_accruals IS
  'Lo devengado por comprobante, con la base y el porcentaje que se usaron al '
  'lado de la cifra para que la cuenta se pueda rehacer a mano. El esquema es '
  'el vigente **a la fecha del comprobante**, no el de hoy. Comisión NULL '
  'significa que no hay esquema declarado para esa fecha.';

-- ---------------------------------------------------------------------------
-- 5 · Por vendedor: la capa de decisión (ADR-018)
-- ---------------------------------------------------------------------------
CREATE VIEW analytics_comisiones WITH (security_invoker = true) AS
SELECT s.company_id,
       s.id                                        AS salesperson_id,
       s.code                                      AS vendedor_codigo,
       s.name                                      AS vendedor_nombre,
       s.status,
       count(a.tax_transaction_id)::int            AS comprobantes,
       coalesce(sum(a.total), 0)                   AS facturado,
       coalesce(sum(a.cobrado), 0)                 AS cobrado,
       coalesce(sum(a.total - a.cobrado), 0)       AS pendiente_de_cobro,
       -- Solo lo que tiene esquema. Los comprobantes sin esquema se cuentan
       -- aparte en vez de sumar cero, que diría que no generaron comisión.
       coalesce(sum(a.comision), 0)                AS comision_devengada,
       count(*) FILTER (WHERE a.comision IS NULL)::int
                                                   AS comprobantes_sin_esquema,
       CASE
         WHEN count(*) FILTER (WHERE a.comision IS NULL) > 0
           THEN 'Hay comprobantes sin esquema declarado para su fecha: su comisión no se '
                'suma porque nadie declaró el acuerdo, no porque valga cero.'
         WHEN count(a.tax_transaction_id) = 0
           THEN 'Sin ventas atribuidas a este vendedor en el período consultado.'
         ELSE 'Cada comprobante por el porcentaje y la base declarados y vigentes el día '
              'de su emisión. Devengado, no pagado: la comisión a pagar es un asiento que '
              'firma una persona.'
       END::text                                   AS metodologia
  FROM salespeople s
  LEFT JOIN commission_accruals a
    ON a.salesperson_id = s.id AND a.company_id = s.company_id
 GROUP BY s.company_id, s.id, s.code, s.name, s.status;

COMMENT ON VIEW analytics_comisiones IS
  'Cuánto vendió cada uno y cuánto se le devengó. NO escribe en el Mayor: la '
  'comisión a pagar es un pasivo, y ese asiento lo firma una persona.';

-- ---------------------------------------------------------------------------
-- 6 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_comisiones WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Venta sin vendedor, y **solo en empresas que declararon vendedores**. En
--     una empresa sin vendedores no falta nada: no todas venden así. El aviso
--     aparece recién cuando existe alguien a quien atribuirle la venta.
SELECT t.company_id,
       'VENTA_SIN_VENDEDOR'::text                    AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'tax_transactions'::text                      AS entidad,
       t.id                                          AS entity_id,
       'SIN_VENDEDOR'::text                          AS estado,
       'El comprobante ' || t.punto_venta || '-' || t.cbte_numero ||
         ' del ' || t.cbte_fecha || ' no dice quién vendió: su comisión no se ' ||
         'puede atribuir'                            AS motivo,
       false                                         AS bloquea,
       ARRAY['VENDEDOR']::text[]                     AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       t.created_at                                  AS creado_en,
       t.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/tax-transactions/' || t.id                  AS traza_ref
  FROM tax_transactions t
 WHERE t.direction = 'VENTAS'
   AND t.salesperson_id IS NULL
   AND EXISTS (SELECT 1 FROM salespeople s
                WHERE s.company_id = t.company_id AND s.status = 'ACTIVO')

UNION ALL

-- 2 · El vendedor tiene ventas y no tiene acuerdo declarado para esas fechas.
--     Es lo que impide afirmar cuánto se le debe, y por vendedor —no por
--     comprobante— porque lo que falta es un acuerdo, no un dato de cada venta.
SELECT c.company_id,
       'COMISION_SIN_ESQUEMA'::text                  AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'salespeople'::text                           AS entidad,
       c.salesperson_id                              AS entity_id,
       c.status                                      AS estado,
       c.vendedor_nombre || ' tiene ' || c.comprobantes_sin_esquema ||
         ' comprobante(s) sin esquema de comisión declarado para su fecha'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['ESQUEMA_DE_COMISION']::text[]          AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/salespeople/' || c.salesperson_id           AS traza_ref
  FROM analytics_comisiones c
 WHERE c.comprobantes_sin_esquema > 0

) q;

COMMENT ON VIEW work_queue_comisiones IS
  'Ramas de comisiones. Las dos avisan de algo sin declarar: quién vendió, y '
  'cuánto se le paga. Ninguna inventa un porcentaje: un acuerdo entre dos '
  'personas no se deriva de las ventas.';

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
UNION ALL SELECT * FROM work_queue_lotes
UNION ALL SELECT * FROM work_queue_caja
UNION ALL SELECT * FROM work_queue_crm
UNION ALL SELECT * FROM work_queue_proyectos
UNION ALL SELECT * FROM work_queue_comisiones;

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
-- Cuánto gana cada vendedor es información sensible dentro de la empresa: no
-- sigue a `commercial:read` sino que se concede aparte.
INSERT INTO permissions (code, description) VALUES
  ('commission:read',  'Consultar vendedores, esquemas y comisiones devengadas'),
  ('commission:write', 'Dar de alta vendedores, declarar esquemas y atribuir ventas');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR')
   AND p.code = 'commission:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
   AND p.code = 'commission:write';

GRANT SELECT ON commission_accruals TO aai_app;
GRANT SELECT ON analytics_comisiones TO aai_app;
GRANT SELECT ON work_queue_comisiones TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
