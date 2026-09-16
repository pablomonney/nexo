-- ---------------------------------------------------------------------------
-- La función exige contexto de empresa
-- ---------------------------------------------------------------------------
--
-- Corrige a la 0122, encontrado en su propia revisión de seguridad.
--
-- ## Lo que estaba mal
--
-- `empresas_de_la_organizacion` verificaba al que llama **solo cuando había
-- empresa en contexto**. La otra rama —«sin `app_company_id()`, contestá el
-- conteo real»— estaba pensada para el operador, que recorre todas las empresas
-- sin RLS.
--
-- El problema es que esa rama **también la alcanza `aai_app`**:
-- `withoutCompany` hace `SET LOCAL ROLE aai_app` y no fija `app.company_id`.
-- Medido en ese contexto exacto, sobre la base de pruebas:
--
--     companies visibles        : 0     ← RLS intacto
--     subscription_usage filas  : 0     ← la vista no devuelve nada
--     función, organización A   : 13
--     función, organización B   : 13    ← la ajena también
--
-- No era explotable: el único llamador es la vista, con un `organization_id`
-- que RLS ya limitó, y ninguna ruta le pasa un identificador del usuario. Pero
-- **es exactamente la forma del defecto que la 0108 existe para impedir** —una
-- función privilegiada alcanzable desde la aplicación que no comprueba al
-- actor— y quedaba esperando a que alguien agregara una ruta bajo
-- `withoutCompany`.
--
-- Un agujero que hoy no tiene camino sigue siendo un agujero: el que escriba
-- esa ruta dentro de seis meses no va a leer esta migración.
--
-- ## Por qué se saca la rama en vez de acotarla
--
-- Porque **nadie la necesita**, y eso se comprobó antes de tocar nada:
--
--     · el único consumidor de `subscription_status` es
--       `routes/suscripciones.ts`, siempre con `WHERE company_id = $1` dentro
--       de `withCompany`, o sea siempre con contexto;
--     · ningún proceso del operador lee `empresas`: ni el ciclo de
--       facturación, ni la bandeja de pagos, ni la bandeja de trabajo;
--     · en un contexto sin empresa, `subscription_usage` devuelve **cero
--       filas** de todos modos, porque su `FROM companies` lo filtra el RLS.
--
-- Acotar la rama —«que la use solo un rol que no sea `aai_app`»— habría dejado
-- una condición que hay que volver a razonar cada vez que alguien la lea.
-- Sacarla deja una sola regla, y es la que se puede decir en una línea: **esta
-- función contesta sobre la organización de la empresa en contexto, y sobre
-- ninguna otra.**
--
-- ## Lo que no cambia
--
-- `SECURITY DEFINER`, `STABLE`, `search_path = public, pg_temp` con `pg_temp`
-- explícito y último, `EXECUTE` solo para `aai_app`, `PUBLIC` sin permiso, y el
-- valor de retorno sigue siendo un entero: nunca filas. El RLS no se toca.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION empresas_de_la_organizacion(org uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
           -- Una sola condición, y exige contexto: la empresa que está
           -- preguntando tiene que pertenecer a la organización por la que
           -- pregunta. Sin `app.company_id` el `EXISTS` es falso y se cae al
           -- `ELSE`, que es lo que se quería.
           WHEN EXISTS (SELECT 1 FROM companies yo
                         WHERE yo.id = app_company_id()
                           AND yo.organization_id = org)
           THEN (SELECT count(*)::int FROM companies c WHERE c.organization_id = org)
           -- Sin contexto, o preguntando por una organización ajena, o por una
           -- que no existe: las tres contestan lo mismo. Que sean
           -- indistinguibles es a propósito — si la inexistente contestara algo
           -- distinto, la función sería un oráculo para averiguar qué
           -- organizaciones hay.
           ELSE NULL
         END
$$;

COMMENT ON FUNCTION empresas_de_la_organizacion(uuid) IS
  'Cuántas empresas tiene la organización de la empresa en contexto. '
  'SECURITY DEFINER porque companies tiene RLS forzado y una empresa solo se ve '
  'a sí misma. EXIGE contexto: sin app.company_id devuelve NULL, igual que '
  'sobre una organización ajena o inexistente. Devuelve un número, nunca datos.';
