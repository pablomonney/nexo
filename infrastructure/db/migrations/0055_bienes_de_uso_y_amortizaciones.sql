-- 0055_bienes_de_uso_y_amortizaciones.sql — el último módulo contable de fondo.
--
-- ## Qué se declara y qué se calcula
--
-- La amortización de un bien es de las pocas cifras contables que son una
-- **función pura** de datos declarados: costo, vida útil, método y fecha de
-- alta. Dados esos cuatro, el importe de cada ejercicio no admite opinión.
--
-- Por eso acá no se guarda ninguna cuota. El plan de amortización es una vista
-- que se calcula. Una tabla `cuotas_de_amortizacion` precalculada quedaría
-- desactualizada el día que se registre una mejora que cambia la base — y esa
-- es exactamente la clase de error que nadie nota hasta el balance.
--
-- Lo que sí se declara, porque no se deduce:
--
--   * **la vida útil**. Depende del bien y del uso que le dé la empresa. Un
--     valor por defecto sería inventar una decisión profesional;
--   * **el método**. Ver abajo;
--   * **el valor residual** estimado;
--   * **las cuentas** donde impacta.
--
-- ## Un solo método, y a propósito
--
-- El CHECK admite `LINEAL` y nada más. No es una limitación olvidada: cada
-- método adicional —creciente, decreciente, por unidades de producción— tiene
-- consecuencias sobre la RT que lo admite y sobre el impuesto, y agregarlo sin
-- esa fundamentación sería ofrecer una opción que el sistema no puede
-- justificar (§30). Sumar uno es una migración deliberada, no una casilla.
--
-- ## El asiento lo firma una persona
--
-- NEXO **calcula** la amortización del ejercicio y **no la asienta solo**. El
-- profesional registra el asiento por el camino de siempre y después lo vincula
-- acá; al vincularlo se comprueba que el importe del asiento sea exactamente el
-- calculado. Es el mismo esquema que la factura de compra (0052): el sistema no
-- escribe en el Diario, pero tampoco deja pasar un importe que no cierra.

-- ---------------------------------------------------------------------------
-- 0 · El asiento pasa a ser referenciable con su empresa
-- ---------------------------------------------------------------------------
-- Mismo argumento que en la 0047 para `parties` y en la 0053 para las líneas:
-- una FK simple a `journal_entries (id)` dejaría vincular la amortización de una
-- empresa al asiento de otra. RLS no lo impide, porque las restricciones
-- foráneas se verifican con privilegios del sistema.
ALTER TABLE journal_entries ADD CONSTRAINT je_id_empresa UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 1 · El bien
-- ---------------------------------------------------------------------------
CREATE TABLE fixed_assets (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id             uuid NOT NULL REFERENCES companies (id),

  code                   text NOT NULL CHECK (length(btrim(code)) > 0),
  name                   text NOT NULL CHECK (length(btrim(name)) > 0),
  description            text,

  -- Costo de incorporación. Sin signo y sin IVA: el crédito fiscal, si
  -- corresponde, va por su propio camino y no forma parte del costo del bien.
  costo                  numeric(18, 2) NOT NULL CHECK (costo > 0),
  fecha_alta             date NOT NULL,

  -- Vida útil en meses. Se declara: no hay tabla de vidas útiles «correctas»,
  -- hay una decisión profesional sobre el uso que la empresa le va a dar.
  vida_util_meses        integer NOT NULL CHECK (vida_util_meses > 0),

  metodo                 text NOT NULL DEFAULT 'LINEAL' CHECK (metodo = 'LINEAL'),

  valor_residual         numeric(18, 2) NOT NULL DEFAULT 0 CHECK (valor_residual >= 0),

  -- De dónde salió. `NULL` es legítimo: un bien puede venir de un aporte o de
  -- un ejercicio anterior a NEXO.
  tax_transaction_id     uuid,

  -- Dónde impacta contablemente. Las tres cuentas se declaran porque el plan de
  -- cuentas es de cada empresa: no hay códigos universales que suponer.
  account_id             uuid NOT NULL,
  accumulated_account_id uuid NOT NULL,
  expense_account_id     uuid NOT NULL,

  status                 text NOT NULL DEFAULT 'EN_USO'
                           CHECK (status IN ('EN_USO', 'BAJA')),
  fecha_baja             date,
  motivo_baja            text,
  valor_de_venta         numeric(18, 2) CHECK (valor_de_venta IS NULL OR valor_de_venta >= 0),

  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             text NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- El residual no puede comerse el costo: si fueran iguales no habría nada que
  -- amortizar, y el plan daría cero todos los ejercicios sin decir por qué.
  CONSTRAINT fa_residual_menor_al_costo CHECK (valor_residual < costo),

  -- Una baja dice cuándo y por qué. Las dos mitades: sin la segunda quedaría un
  -- bien dado de baja sin explicación en el expediente.
  CONSTRAINT fa_baja_completa
    CHECK ((status = 'BAJA') = (fecha_baja IS NOT NULL)),
  CONSTRAINT fa_baja_con_motivo
    CHECK (status <> 'BAJA' OR length(btrim(coalesce(motivo_baja, ''))) > 2),
  CONSTRAINT fa_baja_posterior_al_alta
    CHECK (fecha_baja IS NULL OR fecha_baja >= fecha_alta),

  CONSTRAINT fa_id_empresa UNIQUE (company_id, id),

  CONSTRAINT fa_cuenta_fk
    FOREIGN KEY (company_id, account_id) REFERENCES accounts (company_id, id),
  CONSTRAINT fa_cuenta_acumulada_fk
    FOREIGN KEY (company_id, accumulated_account_id) REFERENCES accounts (company_id, id),
  CONSTRAINT fa_cuenta_gasto_fk
    FOREIGN KEY (company_id, expense_account_id) REFERENCES accounts (company_id, id),
  CONSTRAINT fa_comprobante_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id)
);

CREATE UNIQUE INDEX fixed_assets_code_unico ON fixed_assets (company_id, lower(code));
CREATE INDEX fixed_assets_status_idx ON fixed_assets (company_id, status);

COMMENT ON TABLE fixed_assets IS
  'Bienes de uso. Vida útil, método y valor residual son declaraciones '
  'profesionales; la amortización de cada ejercicio se calcula y no se guarda.';
COMMENT ON COLUMN fixed_assets.vida_util_meses IS
  'Declarada. No hay una tabla de vidas útiles correctas: hay una decisión '
  'sobre el uso que la empresa le va a dar al bien.';

CREATE TRIGGER fixed_assets_updated_at
  BEFORE UPDATE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER fixed_assets_no_delete
  BEFORE DELETE ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 2 · Las cuentas tienen que servir
-- ---------------------------------------------------------------------------
-- Que existan y sean de la empresa no alcanza. Una cuenta de gasto que no sea
-- imputable hace fallar el asiento recién al armarlo, en el cierre, cuando el
-- ejercicio ya está en curso de cerrarse.
CREATE OR REPLACE FUNCTION assert_cuentas_del_bien() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imputable boolean;
  tipo text;
BEGIN
  SELECT a.is_postable, a.type INTO imputable, tipo
    FROM accounts a WHERE a.id = NEW.account_id;
  IF NOT imputable OR tipo <> 'ACTIVO' THEN
    RAISE EXCEPTION 'E_BIEN_CUENTA_ACTIVO: la cuenta del bien tiene que ser de ACTIVO e imputable'
      USING ERRCODE = 'check_violation';
  END IF;

  -- La amortización acumulada es una regularizadora del activo: vive en ACTIVO
  -- con saldo acreedor. Exigirla en PASIVO sería el error clásico.
  SELECT a.is_postable, a.type INTO imputable, tipo
    FROM accounts a WHERE a.id = NEW.accumulated_account_id;
  IF NOT imputable OR tipo <> 'ACTIVO' THEN
    RAISE EXCEPTION
      'E_BIEN_CUENTA_ACUMULADA: la amortización acumulada es regularizadora del activo: cuenta de ACTIVO e imputable'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.is_postable, a.type INTO imputable, tipo
    FROM accounts a WHERE a.id = NEW.expense_account_id;
  IF NOT imputable OR tipo NOT IN ('GASTO', 'COSTO') THEN
    RAISE EXCEPTION 'E_BIEN_CUENTA_GASTO: la cuenta de amortización del ejercicio va a GASTO o COSTO'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.account_id = NEW.accumulated_account_id THEN
    RAISE EXCEPTION 'E_BIEN_CUENTAS_IGUALES: el bien y su amortización acumulada no comparten cuenta'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER fixed_assets_cuentas_validas
  BEFORE INSERT OR UPDATE OF account_id, accumulated_account_id, expense_account_id
  ON fixed_assets
  FOR EACH ROW EXECUTE FUNCTION assert_cuentas_del_bien();

-- ---------------------------------------------------------------------------
-- 3 · Las mejoras
-- ---------------------------------------------------------------------------
-- Una mejora aumenta la base a amortizar desde su fecha. Va en su propia tabla
-- y no sumada al costo del bien porque **el costo original no cambia**: es un
-- hecho de la incorporación, y pisarlo borraría de dónde salió el número.
CREATE TABLE fixed_asset_improvements (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  fixed_asset_id     uuid NOT NULL,

  descripcion        text NOT NULL CHECK (length(btrim(descripcion)) > 0),
  importe            numeric(18, 2) NOT NULL CHECK (importe > 0),
  fecha              date NOT NULL,
  tax_transaction_id uuid,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,

  CONSTRAINT fai_bien_fk
    FOREIGN KEY (company_id, fixed_asset_id) REFERENCES fixed_assets (company_id, id),
  CONSTRAINT fai_comprobante_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id)
);

CREATE INDEX fai_por_bien ON fixed_asset_improvements (company_id, fixed_asset_id);

CREATE TRIGGER fixed_asset_improvements_no_delete
  BEFORE DELETE ON fixed_asset_improvements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 4 · Lo que se asentó
-- ---------------------------------------------------------------------------
-- No guarda el importe: lo tiene el asiento, y guardarlo acá sería la segunda
-- verdad de siempre. Guarda **qué ejercicio ya se amortizó y con qué asiento**,
-- que es lo que no se puede deducir.
CREATE TABLE fixed_asset_depreciations (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  fixed_asset_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years (id),
  entry_id       uuid NOT NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  -- Un bien se amortiza una vez por ejercicio. Dos asientos por el mismo año
  -- duplicarían el cargo, y el error no se ve hasta el estado de resultados.
  UNIQUE (fixed_asset_id, fiscal_year_id),

  CONSTRAINT fad_bien_fk
    FOREIGN KEY (company_id, fixed_asset_id) REFERENCES fixed_assets (company_id, id),
  CONSTRAINT fad_asiento_fk
    FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries (company_id, id)
);

CREATE INDEX fad_por_ejercicio ON fixed_asset_depreciations (company_id, fiscal_year_id);

COMMENT ON TABLE fixed_asset_depreciations IS
  'Qué ejercicio de qué bien ya se amortizó, y con qué asiento. No guarda el '
  'importe: lo tiene el asiento.';

CREATE TRIGGER fixed_asset_depreciations_no_delete
  BEFORE DELETE ON fixed_asset_depreciations
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 5 · El plan de amortización, calculado
-- ---------------------------------------------------------------------------
-- Método lineal sobre base amortizable = costo + mejoras hasta el cierre del
-- ejercicio − valor residual, prorrateado por los meses en que el bien estuvo
-- en uso dentro del ejercicio.
--
-- El prorrateo mensual es una convención explícita y no la única posible: hay
-- empresas que amortizan el año completo de alta y otras que no amortizan el de
-- baja. Se eligió la proporcional a los meses porque es la que no requiere una
-- decisión adicional para ser correcta, y queda dicho acá para que quien
-- necesite otra sepa que está cambiando una convención, no arreglando un error.
-- ## El límite superior lleva un día de más, y los otros dos no
--
-- Un ejercicio del 1/1 al 31/12 son **doce** meses de uso, y `age('2026-12-31',
-- '2026-01-01')` da once meses y treinta días. La fecha de cierre y la de baja
-- son **inclusivas** —ese día el bien todavía estuvo en uso— y por eso entran
-- al cálculo con un día más. La vida útil no: `fecha_alta + vida_util` es el
-- instante en que el bien terminó de amortizarse, y sumarle un día regalaría un
-- mes de amortización que no corresponde.
--
-- Los tres límites se calculan una sola vez en un LATERAL. Repetir la expresión
-- en cada columna funcionaba y era la forma segura de que algún día una copia
-- quedara distinta de las otras.
CREATE VIEW asset_depreciation_schedule WITH (security_invoker = true) AS
SELECT a.company_id,
       a.id                                   AS fixed_asset_id,
       a.code                                 AS bien_codigo,
       a.name                                 AS bien_nombre,
       fy.id                                  AS fiscal_year_id,
       fy.code                                AS ejercicio,
       fy.start_date,
       fy.end_date,
       a.costo,
       a.valor_residual,

       -- Base al cierre del ejercicio: costo más las mejoras ya incorporadas.
       (a.costo + coalesce(m.mejoras, 0))::numeric(18, 2)  AS base,
       p.meses,

       (round((a.costo + coalesce(m.mejoras, 0) - a.valor_residual)
              / a.vida_util_meses * p.meses, 2))::numeric(18, 2) AS amortizacion,

       d.id                                   AS depreciation_id,
       d.entry_id
  FROM fixed_assets a
  JOIN fiscal_years fy
    ON fy.company_id = a.company_id
   AND fy.end_date >= a.fecha_alta
  LEFT JOIN LATERAL (
        SELECT sum(i.importe) AS mejoras
          FROM fixed_asset_improvements i
         WHERE i.fixed_asset_id = a.id
           AND i.company_id = a.company_id
           AND i.fecha <= fy.end_date
       ) m ON true
  CROSS JOIN LATERAL (
        SELECT greatest(fy.start_date, a.fecha_alta)::timestamp AS inicio,
               least(
                 (fy.end_date + 1)::timestamp,
                 coalesce((a.fecha_baja + 1)::timestamp, 'infinity'::timestamp),
                 a.fecha_alta + (a.vida_util_meses || ' months')::interval
               ) AS fin
       ) r
  CROSS JOIN LATERAL (
        -- `greatest(0, …)` porque un ejercicio anterior al alta da negativo, y
        -- eso significa cero meses de uso, no una amortización al revés.
        SELECT greatest(0,
                 extract(year  FROM age(r.fin, r.inicio)) * 12
               + extract(month FROM age(r.fin, r.inicio)))::int AS meses
       ) p
  LEFT JOIN fixed_asset_depreciations d
    ON d.fixed_asset_id = a.id
   AND d.fiscal_year_id = fy.id
   AND d.company_id = a.company_id;

COMMENT ON VIEW asset_depreciation_schedule IS
  'Plan de amortización calculado por ejercicio. No hay cuotas almacenadas: '
  'una mejora cambia la base y el plan se recalcula solo.';

-- El valor de libros: costo más mejoras menos lo amortizado asentado.
CREATE VIEW asset_book_value WITH (security_invoker = true) AS
SELECT s.company_id,
       s.fixed_asset_id,
       s.bien_codigo,
       s.bien_nombre,
       max(s.base)                                              AS base,
       coalesce(sum(s.amortizacion) FILTER (WHERE s.entry_id IS NOT NULL), 0)::numeric(18, 2)
                                                                AS amortizado,
       (max(s.base) - coalesce(sum(s.amortizacion) FILTER (WHERE s.entry_id IS NOT NULL), 0))::numeric(18, 2)
                                                                AS valor_de_libros,
       count(*) FILTER (WHERE s.entry_id IS NULL AND s.amortizacion > 0)::int
                                                                AS ejercicios_pendientes
  FROM asset_depreciation_schedule s
 GROUP BY s.company_id, s.fixed_asset_id, s.bien_codigo, s.bien_nombre;

COMMENT ON VIEW asset_book_value IS
  'Valor de libros: base menos lo efectivamente asentado. Lo calculado y no '
  'asentado NO se descuenta — el balance dice lo que dice el Diario.';

-- ---------------------------------------------------------------------------
-- 6 · La rama de bienes de uso en la bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_activos WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 31 · Ejercicio en cierre con amortización sin asentar.
--      Aparece solo cuando el ejercicio entra en cierre: antes de eso la
--      amortización no está atrasada, todavía no llegó su momento.
SELECT s.company_id,
       'AMORTIZACION_PENDIENTE'::text               AS rama,
       'REQUIERE_APROBACION'::text                  AS categoria,
       'fixed_assets'::text                         AS entidad,
       s.fixed_asset_id                             AS entity_id,
       'SIN_ASENTAR'::text                          AS estado,
       s.bien_codigo || ': falta asentar la amortización de ' || s.ejercicio ||
         ' por ' || s.amortizacion                  AS motivo,
       -- Bloquea: cerrar un ejercicio sin amortizar sobrevalúa el activo y
       -- subvalúa el resultado del período.
       true                                         AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       s.start_date::timestamptz                    AS creado_en,
       s.end_date::timestamptz                      AS actualizado_en,
       s.end_date                                   AS fecha_limite,
       '/fixed-assets/' || s.fixed_asset_id         AS traza_ref
  FROM asset_depreciation_schedule s
  JOIN fiscal_years fy ON fy.id = s.fiscal_year_id AND fy.company_id = s.company_id
 WHERE s.entry_id IS NULL
   AND s.amortizacion > 0
   AND fy.status = 'EN_CIERRE'

) q;

COMMENT ON VIEW work_queue_activos IS
  'Amortizaciones sin asentar de ejercicios en cierre. Bloquea: cerrar sin '
  'amortizar sobrevalúa el activo y subvalúa el resultado.';

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
SELECT * FROM work_queue_stock
UNION ALL
SELECT * FROM work_queue_activos;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
-- Dar de alta un bien fija la vida útil y las cuentas: decide cuánto resultado
-- va a cargar cada ejercicio por los próximos diez años. Es contable.
INSERT INTO permissions (code, description) VALUES
  ('asset:read',  'Consultar bienes de uso, su plan de amortización y su valor de libros'),
  ('asset:write', 'Dar de alta bienes de uso, registrar mejoras y bajas'),
  ('asset:depreciate', 'Vincular el asiento que amortiza un ejercicio');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'asset:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR') AND p.code = 'asset:write';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code = 'asset:depreciate';

-- ---------------------------------------------------------------------------
-- 8 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_assets
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE fixed_asset_improvements ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_improvements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_asset_improvements
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE fixed_asset_depreciations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_depreciations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_asset_depreciations
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON fixed_assets TO aai_app;
GRANT SELECT, INSERT ON fixed_asset_improvements TO aai_app;
GRANT SELECT, INSERT ON fixed_asset_depreciations TO aai_app;
GRANT SELECT ON asset_depreciation_schedule TO aai_app;
GRANT SELECT ON asset_book_value TO aai_app;
GRANT SELECT ON work_queue_activos TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
