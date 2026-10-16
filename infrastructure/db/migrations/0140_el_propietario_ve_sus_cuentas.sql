-- ---------------------------------------------------------------------------
-- La empresa PROPIETARIA ve cuántas cuentas entran y cuántas suscripciones pagan — y ninguna otra
-- ---------------------------------------------------------------------------
--
-- «NEXO se maneja con NEXO»: hay una empresa —la propietaria— que administra a las demás. Esta migración le da a esa empresa, y
-- **sólo a ella**, el conteo exacto de lo que entra: cuentas, empresas, suscripciones y cuáles de ellas pagan.
--
-- ## Por qué no es una consulta común
--
-- Contar todas las empresas atraviesa el aislamiento entre ellas (RLS). La única forma de atravesarlo con garantías es una función
-- `SECURITY DEFINER` que **comprueba quién la llama antes de actuar** (la misma propiedad que exige S-32): contesta si y sólo si
-- la empresa en contexto (`app_company_id()`) es la designada en `platform_owner`. Para cualquier otra, `42501`. Y devuelve
-- **números** —conteos, agregados por mes, y una lista mínima para poder cobrarle a cada cliente—, nunca el contenido contable de
-- nadie.
--
-- ## Cómo se designa la propietaria
--
-- `platform_owner` tiene **una sola fila** y `aai_app` no puede leerla ni escribirla: la designa el operador con
-- `scripts/designar-propietaria.mjs`, con motivo escrito. Una empresa cliente no puede designarse a sí misma.
--
-- ## Qué significa «paga»
--
-- Una suscripción **paga** si está `ACTIVA` y tiene **al menos un cargo `PAGADO`**: un pago registrado, por transferencia o por la
-- pasarela. No alcanza con el estado: la cuenta de prueba de producción está `ACTIVA` hasta 2099 **sin cobro**, y contarla como que
-- paga inflaría el número justo donde el titular necesita el exacto. Esas se informan aparte, como `activas_sin_cobro`.
-- ---------------------------------------------------------------------------

CREATE TABLE platform_owner (
  singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  empresa_propietaria_id uuid NOT NULL REFERENCES companies (id),
  designada_el           timestamptz NOT NULL DEFAULT now(),
  designada_por          text NOT NULL,
  motivo                 text NOT NULL CHECK (length(btrim(motivo)) >= 5)
);

COMMENT ON TABLE platform_owner IS
  'La empresa que administra a las demás (NEXO propietario). Una sola fila. La aplicación no la lee ni la escribe: la designa el '
  'operador (scripts/designar-propietaria.mjs) y sólo la leen las funciones que comprueban quién llama.';

-- La 0009 concede SELECT/INSERT/UPDATE sobre todo objeto nuevo: acá se lo quitamos explícitamente.
REVOKE ALL ON platform_owner FROM aai_app;
REVOKE ALL ON platform_owner FROM PUBLIC;

-- ¿Esta empresa es la propietaria? Devuelve un booleano sobre la empresa EN CONTEXTO: no recibe identificadores ajenos.
CREATE OR REPLACE FUNCTION es_empresa_propietaria() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_owner WHERE empresa_propietaria_id = app_company_id()
  );
$$;

REVOKE EXECUTE ON FUNCTION es_empresa_propietaria() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION es_empresa_propietaria() TO aai_app;

COMMENT ON FUNCTION es_empresa_propietaria() IS
  'Sin parámetros: contesta sobre la empresa en contexto. Es lo que decide si la consola muestra «Mis clientes».';

CREATE OR REPLACE FUNCTION resumen_de_cuentas_del_propietario() RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_propietaria uuid;
  v_hoy         date := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
  v_resultado   jsonb;
BEGIN
  SELECT empresa_propietaria_id INTO v_propietaria FROM platform_owner;

  -- Sin propietaria designada, o llamada desde cualquier otra empresa: no hay nada que mostrar, y no se dice por qué.
  IF v_propietaria IS NULL OR v_propietaria IS DISTINCT FROM app_company_id() THEN
    RAISE EXCEPTION 'No disponible' USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH
  clientes AS (
    SELECT c.id, c.legal_name, c.cuit, c.created_at
      FROM companies c
     WHERE c.id <> v_propietaria
  ),
  suscripcion AS (
    -- La suscripción más reciente de cada empresa.
    SELECT DISTINCT ON (s.company_id)
           s.company_id, s.estado, s.vigencia_desde, s.vigencia_hasta, s.plan_id
      FROM company_subscriptions s
      JOIN clientes cl ON cl.id = s.company_id
     ORDER BY s.company_id, s.created_at DESC
  ),
  cobros AS (
    SELECT d.company_id,
           count(*)           AS cargos_pagados,
           max(d.pagado_el)   AS ultimo_pago
      FROM billing_documents d
      JOIN clientes cl ON cl.id = d.company_id
     WHERE d.estado = 'PAGADO' AND d.tipo = 'CARGO'
     GROUP BY d.company_id
  ),
  usuarios_ajenos AS (
    -- Los usuarios que no son de la empresa propietaria.
    SELECT u.id, u.status, u.created_at
      FROM users u
     WHERE NOT EXISTS (
             SELECT 1 FROM user_company_roles r WHERE r.user_id = u.id AND r.company_id = v_propietaria)
  ),
  meses AS (
    SELECT (date_trunc('month', v_hoy::timestamp) - (n || ' months')::interval)::date AS mes
      FROM generate_series(0, 11) AS n
  )
  SELECT jsonb_build_object(
    'generadoEl', to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD"T"HH24:MI:SS'),
    'hoy', v_hoy,

    'usuarios', jsonb_build_object(
      'registrados',          (SELECT count(*) FROM usuarios_ajenos),
      'conCorreoVerificado',  (SELECT count(*) FROM usuarios_ajenos WHERE status = 'ACTIVE'),
      'pendientesDeVerificar',(SELECT count(*) FROM usuarios_ajenos WHERE status = 'PENDIENTE'),
      'nuevos7Dias',          (SELECT count(*) FROM usuarios_ajenos WHERE created_at >= v_hoy - 7),
      'nuevos30Dias',         (SELECT count(*) FROM usuarios_ajenos WHERE created_at >= v_hoy - 30)
    ),

    'empresas', jsonb_build_object(
      'total',       (SELECT count(*) FROM clientes),
      'nuevas7Dias', (SELECT count(*) FROM clientes WHERE created_at >= v_hoy - 7),
      'nuevas30Dias',(SELECT count(*) FROM clientes WHERE created_at >= v_hoy - 30),
      'sinSuscripcion', (SELECT count(*) FROM clientes cl WHERE NOT EXISTS (SELECT 1 FROM suscripcion s WHERE s.company_id = cl.id)),
      'porMes', (
        SELECT jsonb_agg(jsonb_build_object(
                 'mes', to_char(m.mes, 'YYYY-MM'),
                 'nuevas', (SELECT count(*) FROM clientes cl
                             WHERE date_trunc('month', cl.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date = m.mes))
               ORDER BY m.mes)
          FROM meses m)
    ),

    'suscripciones', jsonb_build_object(
      'prueba',     (SELECT count(*) FROM suscripcion WHERE estado = 'PRUEBA'),
      'activa',     (SELECT count(*) FROM suscripcion WHERE estado = 'ACTIVA'),
      'morosa',     (SELECT count(*) FROM suscripcion WHERE estado = 'MOROSA'),
      'suspendida', (SELECT count(*) FROM suscripcion WHERE estado = 'SUSPENDIDA'),
      'cancelada',  (SELECT count(*) FROM suscripcion WHERE estado = 'CANCELADA'),
      'pruebasQueVencenEn7Dias',
        (SELECT count(*) FROM suscripcion WHERE estado = 'PRUEBA' AND vigencia_hasta BETWEEN v_hoy AND v_hoy + 7),
      'pruebasVencidasSinConvertir',
        (SELECT count(*) FROM suscripcion WHERE estado = 'PRUEBA' AND vigencia_hasta < v_hoy)
    ),

    'pagan', jsonb_build_object(
      'suscripcionesQuePagan',
        (SELECT count(*) FROM suscripcion s JOIN cobros c ON c.company_id = s.company_id WHERE s.estado = 'ACTIVA'),
      'activasSinCobro',
        (SELECT count(*) FROM suscripcion s WHERE s.estado = 'ACTIVA' AND NOT EXISTS (SELECT 1 FROM cobros c WHERE c.company_id = s.company_id)),
      'conPagoEnLosUltimos35Dias',
        (SELECT count(*) FROM suscripcion s JOIN cobros c ON c.company_id = s.company_id
          WHERE s.estado = 'ACTIVA' AND c.ultimo_pago >= v_hoy - 35),
      'cobradoPorMoneda', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('moneda', x.moneda, 'importe', x.importe::text) ORDER BY x.moneda)
          FROM (SELECT d.moneda, sum(d.importe_total) AS importe
                  FROM billing_documents d JOIN clientes cl ON cl.id = d.company_id
                 WHERE d.estado = 'PAGADO' AND d.tipo = 'CARGO'
                 GROUP BY d.moneda) x), '[]'::jsonb),
      'porPlan', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('plan', coalesce(p.code, 'sin plan'), 'pagan', x.n) ORDER BY p.code)
          FROM (SELECT s.plan_id, count(*) AS n
                  FROM suscripcion s JOIN cobros c ON c.company_id = s.company_id
                 WHERE s.estado = 'ACTIVA' GROUP BY s.plan_id) x
          LEFT JOIN subscription_plans p ON p.id = x.plan_id), '[]'::jsonb)
    ),

    -- Lo mínimo para poder cobrarle y escribirle a cada cliente: nada del contenido de su empresa.
    'clientes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'empresa', cl.legal_name,
               'cuit', cl.cuit,
               'alta', to_char(cl.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
               'plan', coalesce(p.code, 'sin plan'),
               'estado', coalesce(s.estado, 'SIN SUSCRIPCIÓN'),
               'pruebaHasta', CASE WHEN s.estado = 'PRUEBA' THEN to_char(s.vigencia_hasta, 'YYYY-MM-DD') END,
               'paga', (co.company_id IS NOT NULL AND s.estado = 'ACTIVA'),
               'ultimoPago', to_char(co.ultimo_pago, 'YYYY-MM-DD')
             ) ORDER BY cl.created_at DESC)
        FROM (SELECT * FROM clientes ORDER BY created_at DESC LIMIT 500) cl
        LEFT JOIN suscripcion s ON s.company_id = cl.id
        LEFT JOIN subscription_plans p ON p.id = s.plan_id
        LEFT JOIN cobros co ON co.company_id = cl.id), '[]'::jsonb)
  ) INTO v_resultado;

  RETURN v_resultado;
END;
$$;

REVOKE EXECUTE ON FUNCTION resumen_de_cuentas_del_propietario() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resumen_de_cuentas_del_propietario() TO aai_app;

COMMENT ON FUNCTION resumen_de_cuentas_del_propietario() IS
  'Conteos de cuentas, empresas y suscripciones (y cuáles pagan) de TODAS las empresas clientes. Contesta sólo si la empresa en '
  'contexto es la designada en platform_owner; para cualquier otra, 42501. Sin parámetros.';
