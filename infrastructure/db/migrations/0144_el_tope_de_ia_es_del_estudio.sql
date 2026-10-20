-- ---------------------------------------------------------------------------
-- El tope de IA del plan es TOTAL: lo comparten todas las empresas del estudio
-- ---------------------------------------------------------------------------
--
-- La 0142 dejó el tope diario de tokens **por empresa**: cada empresa tenía el suyo. Un estudio con 50 empresas podía, en teoría, gastar 50 veces el
-- presupuesto de IA de su plan. El titular decidió (2026-10-20) que el tope sea **del contrato**: «si lo usás en una empresa, se gastan para todas».
--
-- Esta función suma los tokens que gastaron **todas las empresas del estudio** de la empresa en contexto, y dice cuál es el tope del plan que
-- ese estudio tiene contratado. Es `SECURITY DEFINER` porque `assistant_messages` está bajo RLS por empresa: desde una empresa sólo se ven sus
-- mensajes, y sumar las de las hermanas exige atravesarlo. Devuelve **dos números** —no filas, no contenido de ninguna empresa— y sólo del estudio
-- de la empresa en contexto (`app_company_id()`): sin empresa en contexto no devuelve nada.
--
-- ## Qué plan rige
--
-- La suscripción más reciente, vigente (`PRUEBA`, `ACTIVA` o `MOROSA`), de cualquiera de las empresas del estudio. Un estudio que da de alta
-- empresas nuevas dentro de su organización no les abre una suscripción por empresa: rige la del estudio. Sin ninguna suscripción en todo el
-- estudio rige el **más bajo** de los topes de plan (no «sin tope»): ninguna empresa se queda sin límite de gasto.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION consumo_de_ia_del_estudio()
RETURNS TABLE (tokens_usados_hoy bigint, tope_del_plan bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH empresas AS (
    SELECT c.id
      FROM companies c
     WHERE c.organization_id = (SELECT organization_id FROM companies WHERE id = app_company_id())
  ),
  usados AS (
    SELECT COALESCE(SUM(COALESCE(m.tokens_entrada, 0) + COALESCE(m.tokens_salida, 0)), 0)::bigint AS n
      FROM assistant_messages m
      JOIN empresas e ON e.id = m.company_id
     WHERE m.rol = 'asistente' AND m.created_at >= date_trunc('day', now())
  ),
  contratado AS (
    SELECT pq.tokens_por_dia
      FROM company_subscriptions s
      JOIN empresas e ON e.id = s.company_id
      JOIN plan_ai_quotas pq ON pq.plan_id = s.plan_id
     WHERE s.estado IN ('PRUEBA', 'ACTIVA', 'MOROSA')
     ORDER BY s.created_at DESC
     LIMIT 1
  )
  SELECT (SELECT n FROM usados),
         COALESCE((SELECT tokens_por_dia FROM contratado), (SELECT min(tokens_por_dia) FROM plan_ai_quotas))::bigint
   WHERE app_company_id() IS NOT NULL;
$$;

REVOKE EXECUTE ON FUNCTION consumo_de_ia_del_estudio() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consumo_de_ia_del_estudio() TO aai_app;

COMMENT ON FUNCTION consumo_de_ia_del_estudio() IS
  'Sin parámetros: contesta sobre el estudio de la empresa en contexto. Devuelve los tokens de IA que gastaron todas sus empresas hoy y el tope diario '
  'del plan contratado (compartido). Dos números, nunca contenido de una empresa.';

COMMENT ON TABLE plan_ai_quotas IS
  'Tope diario de tokens del asistente, por plan, TOTAL: lo comparten todas las empresas del estudio (consumo_de_ia_del_estudio). La ausencia '
  'de fila significa que el plan no declaró tope. Lo escribe el script comercial, nunca la aplicación.';
