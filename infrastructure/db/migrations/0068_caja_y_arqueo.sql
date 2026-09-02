-- ============================================================================
-- 0068 — Caja, arqueo, y el saldo desde el que arranca el flujo
-- ============================================================================
--
-- Tesorería tenía bancos y no tenía caja. En una pyme argentina el efectivo no
-- es un detalle: se cobra en mostrador, se paga un flete, se abre y se cierra
-- todos los días, y la diferencia de arqueo es de las primeras cosas que un
-- dueño quiere ver.
--
-- ## El saldo teórico no se guarda
--
-- Una sesión de caja tiene un saldo inicial **declarado** y movimientos. El
-- saldo teórico es la suma, y se deriva: guardarlo sería una segunda verdad que
-- puede contradecir a los movimientos, que es exactamente lo que este esquema
-- evita en stock, en cheques y en la cuenta corriente.
--
-- Lo que sí se declara es el **contado**: cuánto había de verdad al cerrar. Esa
-- es la única cifra que el sistema no puede derivar, porque sale de contar
-- billetes.
--
-- ## La diferencia es un hecho, no un umbral
--
-- `contado - teórico` distinto de cero es un hecho y va a la bandeja sin
-- necesidad de que nadie declare cuánto es mucho. Es la diferencia con las
-- señales (0058): ahí se compara contra un criterio de negocio; acá se compara
-- contra la aritmética.
--
-- ## Y el flujo de fondos gana su punto de partida
--
-- `analytics_flujo_de_fondos` (0066) dice qué entra y qué sale. Sin saber desde
-- cuánto se arranca, no contesta «¿llego a fin de mes?»: entra 100 y sale 80 no
-- dice nada si no se sabe que había 5. `analytics_disponible` es esa base —
-- efectivo en cajas abiertas más saldo contable de las cuentas bancarias— y es
-- lo que ADR-018 pide de este módulo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La caja
-- ---------------------------------------------------------------------------
CREATE TABLE cash_boxes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),

  code         text NOT NULL CHECK (length(btrim(code)) > 0),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  currency     text NOT NULL DEFAULT 'ARS',

  -- La cuenta contable de esa caja. Es lo que permite comparar el efectivo real
  -- contra el Mayor sin que este módulo escriba un asiento.
  account_id   uuid,

  status       text NOT NULL DEFAULT 'ACTIVA'
                 CHECK (status IN ('ACTIVA', 'ARCHIVADA')),

  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,

  CONSTRAINT cb_cuenta_fk
    FOREIGN KEY (company_id, account_id) REFERENCES accounts (company_id, id),
  CONSTRAINT cb_code_unico UNIQUE (company_id, code),
  CONSTRAINT cb_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE cash_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_boxes FORCE ROW LEVEL SECURITY;
CREATE POLICY cb_por_empresa ON cash_boxes
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON cash_boxes TO aai_app;

-- ---------------------------------------------------------------------------
-- 2 · La sesión: de la apertura al arqueo
-- ---------------------------------------------------------------------------
CREATE TABLE cash_sessions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  cash_box_id       uuid NOT NULL,

  abierta_el        date NOT NULL,
  -- Declarado: cuánto había al abrir. No se arrastra del cierre anterior a
  -- propósito — arrastrarlo haría que un error de conteo se propague sin que
  -- nadie lo vuelva a mirar.
  saldo_inicial     numeric(18, 2) NOT NULL CHECK (saldo_inicial >= 0),

  cerrada_el        date,
  -- Lo único que el sistema no puede derivar: sale de contar billetes.
  saldo_contado     numeric(18, 2) CHECK (saldo_contado IS NULL OR saldo_contado >= 0),
  motivo_diferencia text,

  status            text NOT NULL DEFAULT 'ABIERTA'
                      CHECK (status IN ('ABIERTA', 'CERRADA')),

  -- El asiento que registró el movimiento de caja del período, si ya se hizo.
  -- Este módulo no lo escribe: lo cita.
  journal_entry_id  uuid,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  closed_by         text,

  CONSTRAINT cs_cerrada_completa
    CHECK (status <> 'CERRADA'
           OR (cerrada_el IS NOT NULL AND saldo_contado IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT cs_cierre_no_anterior
    CHECK (cerrada_el IS NULL OR cerrada_el >= abierta_el),
  CONSTRAINT cs_caja_fk
    FOREIGN KEY (company_id, cash_box_id) REFERENCES cash_boxes (company_id, id),
  CONSTRAINT cs_asiento_fk
    FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries (company_id, id),
  CONSTRAINT cs_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_por_empresa ON cash_sessions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON cash_sessions TO aai_app;

-- Una caja no puede tener dos sesiones abiertas. Con dos, un movimiento no
-- sabría a cuál pertenece y el arqueo dejaría de significar algo.
CREATE UNIQUE INDEX cs_una_abierta_por_caja
  ON cash_sessions (company_id, cash_box_id)
  WHERE status = 'ABIERTA';

COMMENT ON COLUMN cash_sessions.saldo_inicial IS
  'Declarado al abrir. No se arrastra del cierre anterior: arrastrarlo haría '
  'que un error de conteo se propague sin que nadie lo vuelva a mirar.';

-- ---------------------------------------------------------------------------
-- 3 · Los movimientos
-- ---------------------------------------------------------------------------
CREATE TABLE cash_movements (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  session_id    uuid NOT NULL,

  tipo          text NOT NULL CHECK (tipo IN ('INGRESO', 'EGRESO')),
  importe       numeric(18, 2) NOT NULL CHECK (importe > 0),
  fecha         date NOT NULL,
  concepto      text NOT NULL CHECK (length(btrim(concepto)) > 2),

  -- De quién o a quién, cuando se sabe. Nulo es válido: una venta de mostrador
  -- puede no tener tercero identificado, y para eso está el `SIN_IDENTIFICAR`
  -- de la 0047 cuando corresponde nombrarlo.
  party_id      uuid,

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,

  CONSTRAINT cmv_sesion_fk
    FOREIGN KEY (company_id, session_id) REFERENCES cash_sessions (company_id, id),
  CONSTRAINT cmv_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id)
);

ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY cmv_por_empresa ON cash_movements
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON cash_movements TO aai_app;

CREATE INDEX cmv_por_sesion ON cash_movements (company_id, session_id, fecha);

-- Append-only, como el resto de los libros del sistema.
CREATE TRIGGER cmv_no_update BEFORE UPDATE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER cmv_no_delete BEFORE DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Una sesión cerrada ya fue arqueada: agregarle un movimiento cambiaría el
-- saldo teórico contra el que se contó, y dejaría la diferencia sin sentido.
CREATE FUNCTION assert_sesion_abierta() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  estado text;
BEGIN
  SELECT s.status INTO estado
    FROM cash_sessions s
   WHERE s.id = NEW.session_id AND s.company_id = NEW.company_id;

  IF estado <> 'ABIERTA' THEN
    RAISE EXCEPTION
      'E_CAJA_CERRADA: la sesión está % y ya fue arqueada.', estado
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cmv_sesion_abierta
  AFTER INSERT ON cash_movements
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_sesion_abierta();

-- ---------------------------------------------------------------------------
-- 4 · El arqueo, derivado
-- ---------------------------------------------------------------------------
CREATE VIEW cash_session_status WITH (security_invoker = true) AS
SELECT s.company_id,
       s.id                                        AS session_id,
       s.cash_box_id,
       b.code                                      AS caja_codigo,
       b.name                                      AS caja_nombre,
       b.currency                                  AS moneda,
       s.status,
       s.abierta_el,
       s.cerrada_el,
       s.saldo_inicial,
       coalesce(m.ingresos, 0)                     AS ingresos,
       coalesce(m.egresos, 0)                      AS egresos,
       -- El saldo teórico se deriva. No hay columna que mantener, así que no
       -- puede quedar desactualizada ni contradecir a los movimientos.
       s.saldo_inicial + coalesce(m.ingresos, 0)
                       - coalesce(m.egresos, 0)    AS saldo_teorico,
       s.saldo_contado,
       -- NULL mientras no se contó: distinto de cero, que sería afirmar que
       -- coincidía.
       CASE WHEN s.saldo_contado IS NULL THEN NULL
            ELSE s.saldo_contado
                 - (s.saldo_inicial + coalesce(m.ingresos, 0) - coalesce(m.egresos, 0))
       END                                         AS diferencia,
       s.motivo_diferencia,
       s.journal_entry_id,
       coalesce(m.cantidad, 0)                     AS movimientos
  FROM cash_sessions s
  JOIN cash_boxes b ON b.id = s.cash_box_id AND b.company_id = s.company_id
  LEFT JOIN LATERAL (
        SELECT sum(v.importe) FILTER (WHERE v.tipo = 'INGRESO') AS ingresos,
               sum(v.importe) FILTER (WHERE v.tipo = 'EGRESO')  AS egresos,
               count(*)::int                                    AS cantidad
          FROM cash_movements v
         WHERE v.session_id = s.id AND v.company_id = s.company_id
       ) m ON true;

COMMENT ON VIEW cash_session_status IS
  'El arqueo de cada sesión. El saldo teórico se deriva de los movimientos; el '
  'contado es lo único declarado, porque sale de contar billetes. La '
  'diferencia es NULL mientras no se contó: distinto de cero, que sería '
  'afirmar que coincidía.';

-- ---------------------------------------------------------------------------
-- 5 · Lo disponible hoy: el punto de partida del flujo
-- ---------------------------------------------------------------------------
-- `analytics_flujo_de_fondos` dice qué entra y qué sale. Sin saber desde cuánto
-- se arranca no contesta «¿llego a fin de mes?»: entra 100 y sale 80 no dice
-- nada si no se sabe que había 5.
CREATE VIEW analytics_disponible WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,
       'CAJA'::text                                AS fuente,
       coalesce(sum(s.saldo_teorico), 0)           AS saldo,
       count(s.session_id)::int                    AS partidas,
       'Saldo teórico de las cajas abiertas: lo declarado al abrir más los '
       'ingresos menos los egresos. Es lo que debería haber, no lo contado.'::text
                                                   AS metodologia
  FROM companies c
  LEFT JOIN cash_session_status s
    ON s.company_id = c.id AND s.status = 'ABIERTA'
 GROUP BY c.id

UNION ALL

SELECT c.id,
       'BANCOS'::text,
       coalesce(sum(l.debit - l.credit), 0),
       count(DISTINCT ba.id)::int,
       'Saldo contable de las cuentas bancarias, sumado del Mayor. Es lo que '
       'dicen los libros, no lo que dice el banco: la diferencia entre los dos '
       'es justamente lo que resuelve la conciliación.'::text
  FROM companies c
  LEFT JOIN bank_accounts ba ON ba.company_id = c.id
  LEFT JOIN ledger_movements l
    ON l.account_id = ba.account_id AND l.company_id = ba.company_id
 GROUP BY c.id;

COMMENT ON VIEW analytics_disponible IS
  'Desde cuánta plata se arranca, por fuente. Caja es el saldo teórico de las '
  'sesiones abiertas; bancos es el saldo del Mayor y NO el del extracto — la '
  'diferencia entre los dos la resuelve la conciliación, no esta vista.';

-- ---------------------------------------------------------------------------
-- 6 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_caja WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Se arqueó y no coincidió. Es un hecho —la resta da distinto de cero— y no
--     necesita umbral: acá no se compara contra un criterio de negocio sino
--     contra la aritmética.
SELECT s.company_id,
       'ARQUEO_CON_DIFERENCIA'::text                 AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'cash_sessions'::text                         AS entidad,
       s.session_id                                  AS entity_id,
       s.status                                      AS estado,
       'La caja ' || s.caja_codigo || ' cerró el ' || s.cerrada_el ||
         ' con una diferencia de ' || s.diferencia ||
         coalesce(': ' || s.motivo_diferencia, ' y nadie explicó por qué')
                                                     AS motivo,
       false                                         AS bloquea,
       CASE WHEN s.motivo_diferencia IS NULL
            THEN ARRAY['EXPLICACION']::text[] END    AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.cerrada_el::timestamptz                     AS creado_en,
       s.cerrada_el::timestamptz                     AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/cash-sessions/' || s.session_id             AS traza_ref
  FROM cash_session_status s
 WHERE s.status = 'CERRADA' AND s.diferencia IS NOT NULL AND s.diferencia <> 0

UNION ALL

-- 2 · Sigue abierta y se abrió antes de hoy. Es una comparación de fechas, no
--     un umbral: una caja que quedó abierta de ayer no se arqueó, y su
--     diferencia ya no se puede reconstruir contando.
SELECT s.company_id,
       'CAJA_SIN_CERRAR'::text                       AS rama,
       'REQUIERE_APROBACION'::text                   AS categoria,
       'cash_sessions'::text                         AS entidad,
       s.session_id                                  AS entity_id,
       s.status                                      AS estado,
       'La caja ' || s.caja_codigo || ' se abrió el ' || s.abierta_el ||
         ' y sigue sin arquear'                      AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.abierta_el::timestamptz                     AS creado_en,
       s.abierta_el::timestamptz                     AS actualizado_en,
       s.abierta_el                                  AS fecha_limite,
       '/cash-sessions/' || s.session_id             AS traza_ref
  FROM cash_session_status s
 WHERE s.status = 'ABIERTA' AND s.abierta_el < current_date

) q;

COMMENT ON VIEW work_queue_caja IS
  'Ramas de caja. Las dos son hechos: una resta que no dio cero y una fecha '
  'que pasó. Ninguna necesita un umbral declarado.';

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
UNION ALL SELECT * FROM work_queue_caja;

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('cash:read',  'Consultar cajas, sesiones y arqueos'),
  ('cash:write', 'Abrir y cerrar cajas y registrar sus movimientos');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
   AND p.code = 'cash:read';

-- Escribir en caja es operación de mostrador, no contabilidad: sigue a
-- `stock:write` y no a `allocation:write`.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA', 'CARGADOR')
   AND p.code = 'cash:write';

GRANT SELECT ON cash_session_status TO aai_app;
GRANT SELECT ON analytics_disponible TO aai_app;
GRANT SELECT ON work_queue_caja TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
