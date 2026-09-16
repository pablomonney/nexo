-- ---------------------------------------------------------------------------
-- Un tope que nadie mide no es un tope
-- ---------------------------------------------------------------------------
--
-- Antes de cargar la configuración comercial definitiva había que arreglar dos
-- cosas que la auditoría del 2026-09-15 dejó escritas, porque declarar topes
-- sobre un modelo que no los mide es escribir números que no hacen nada.
--
-- ## 1 · `EMPRESAS` se podía declarar y no se medía
--
-- El `CHECK` de `plan_limits` acepta `EMPRESAS` desde la 0073 y
-- `subscription_usage` **nunca lo contó**: mide usuarios, comprobantes,
-- documentos e integraciones. Declarar «este plan admite 20 empresas» guardaba
-- un número que ninguna vista evaluaba y que jamás producía un exceso.
--
-- Importa ahora porque es **la diferencia comercial entre cuatro de los cinco
-- planes**: Contable y Gestión admiten una empresa, Estudio veinte, Empresa
-- cinco. Sin medirlo, esa diferencia no existe en el sistema.
--
-- ### Por qué hace falta una función privilegiada
--
-- `companies` tiene RLS **forzado** con la política `id = app_company_id()`:
-- desde la aplicación, una empresa se ve **solo a sí misma**. Un
-- `count(*) FROM companies` dentro de una vista `security_invoker` devuelve 1
-- siempre, para todos. No es un descuido de la vista: es el aislamiento
-- funcionando, y no se toca.
--
-- La pregunta comercial —«¿cuántas empresas tiene mi estudio?»— es legítima y
-- la respuesta es **un número sobre la propia organización**, no los datos de
-- nadie. Eso es exactamente lo que `SECURITY DEFINER` existe para resolver.
--
-- ### Y por qué esta función sí puede ejecutarla la aplicación
--
-- La 0108 encontró tres funciones privilegiadas que **recibían un identificador
-- de empresa y no comprobaban al que llama**, y les revocó el `EXECUTE`. La
-- lección no fue «ninguna función privilegiada», fue «ninguna sin verificar al
-- actor». S-32 lo formalizó: la aplicación ejecuta las declaradas, y cada una
-- tiene que decir por qué es segura.
--
-- Esta verifica, y la verificación es la primera línea del cuerpo:
--
--     · sin empresa en contexto (el operador) → contesta el conteo real;
--     · con empresa en contexto → contesta **solo si esa empresa pertenece a la
--       organización preguntada**;
--     · preguntando por una organización ajena → `NULL`.
--
-- `NULL` es «no se puede afirmar», no cero. Un cero acá diría «tu estudio no
-- tiene empresas», que es falso y además haría que ningún tope se excediera
-- nunca.
--
-- ## 2 · «Ilimitado» no se podía declarar
--
-- La 0073 fue explícita: la ausencia de una fila significa **sin tope
-- declarado**, «no "ilimitado", que sería afirmar una política comercial que
-- nadie escribió». Esa regla sigue en pie y es correcta.
--
-- Lo que faltaba era el otro lado: una forma de decir **«lo decidimos
-- ilimitado»**, que es una declaración, no un silencio. Sin ella, un plan que
-- se vende con integraciones ilimitadas se muestra como «sin declarar», y el
-- cliente ve un hueco donde hay una promesa.
--
-- Ahora son cuatro estados y cada uno dice algo distinto:
--
--     sin fila               nadie lo escribió        SIN_TOPE_DECLARADO
--     tope = N               hasta N                  DENTRO_DEL_TOPE / EXCEDIDO
--     ilimitado = true       decidido sin tope        SIN_TOPE
--
-- Un ilimitado **no cuenta como sin declarar** —está declarado— y **no puede
-- excederse**. Las dos cosas se ven en los contadores de más abajo.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · El tope ilimitado, declarado
-- ---------------------------------------------------------------------------

ALTER TABLE plan_limits ALTER COLUMN tope DROP NOT NULL;
ALTER TABLE plan_limits ADD COLUMN ilimitado boolean NOT NULL DEFAULT false;

-- O hay número, o hay ilimitado. Nunca los dos, nunca ninguno: una fila sin
-- número y sin ilimitado sería una fila que no dice nada, indistinguible de no
-- haberla escrito salvo porque ocupa lugar.
ALTER TABLE plan_limits ADD CONSTRAINT plan_limits_numero_o_ilimitado CHECK (
  (ilimitado AND tope IS NULL) OR (NOT ilimitado AND tope IS NOT NULL)
);

COMMENT ON COLUMN plan_limits.ilimitado IS
  'Este plan declara el recurso SIN TOPE. Es una decisión escrita, distinta de '
  'no tener fila: la ausencia de fila es «nadie lo declaró». Un ilimitado no '
  'cuenta como sin declarar y no se puede exceder.';

-- ---------------------------------------------------------------------------
-- 2 · Cuántas empresas tiene una organización
-- ---------------------------------------------------------------------------

CREATE FUNCTION empresas_de_la_organizacion(org uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
           -- Sin empresa en contexto es el operador: el ciclo de facturación y
           -- la bandeja, que ya recorren todas las empresas sin RLS.
           WHEN app_company_id() IS NULL
             OR EXISTS (SELECT 1 FROM companies yo
                         WHERE yo.id = app_company_id()
                           AND yo.organization_id = org)
           THEN (SELECT count(*)::int FROM companies c WHERE c.organization_id = org)
           -- Preguntando por una organización ajena. NULL, no cero.
           ELSE NULL
         END
$$;

-- `PUBLIC` lo tiene por defecto y hay que sacárselo explícitamente: revocarle a
-- `aai_app` no alcanza (S-32 lo comprueba).
REVOKE EXECUTE ON FUNCTION empresas_de_la_organizacion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION empresas_de_la_organizacion(uuid) TO aai_app;

COMMENT ON FUNCTION empresas_de_la_organizacion(uuid) IS
  'Cuántas empresas tiene una organización. SECURITY DEFINER porque companies '
  'tiene RLS forzado y una empresa solo se ve a sí misma. Verifica al que '
  'llama: contesta solo sobre la organización a la que pertenece la empresa en '
  'contexto, y NULL sobre cualquier otra. Devuelve un número, nunca datos.';

-- ---------------------------------------------------------------------------
-- 3 · El uso, con las empresas adentro
-- ---------------------------------------------------------------------------
--
-- `CREATE OR REPLACE VIEW` solo deja agregar columnas **al final**, así que
-- `empresas` va última aunque conceptualmente sea la primera.

CREATE OR REPLACE VIEW subscription_usage WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,
       (SELECT count(DISTINCT ucr.user_id)::int
          FROM user_company_roles ucr
         WHERE ucr.company_id = c.id
           AND ucr.valid_from <= current_date
           AND (ucr.valid_to IS NULL OR ucr.valid_to >= current_date))
                                                   AS usuarios,
       (SELECT count(*)::int FROM tax_transactions t
         WHERE t.company_id = c.id
           AND t.cbte_fecha >= date_trunc('month', current_date)::date)
                                                   AS comprobantes_mes,
       (SELECT count(*)::int FROM documents d
         WHERE d.company_id = c.id
           AND d.received_at >= date_trunc('month', current_date))
                                                   AS documentos_mes,
       (SELECT count(*)::int FROM company_integrations i
         WHERE i.company_id = c.id AND i.status = 'CONECTADA')
                                                   AS integraciones,
       empresas_de_la_organizacion(c.organization_id)
                                                   AS empresas
  FROM companies c;

COMMENT ON VIEW subscription_usage IS
  'Cuánto usa cada empresa, contado en el momento. No hay contadores '
  'guardados: un contador que se desincroniza dice algo distinto de lo que hay '
  'y nadie se entera. `empresas` cuenta las de la organización y sale de una '
  'función privilegiada porque companies tiene RLS forzado.';

-- ---------------------------------------------------------------------------
-- 4 · El estado, con el cuarto caso
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW subscription_status WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,
       s.id                                        AS subscription_id,
       p.code                                      AS plan_codigo,
       p.name                                      AS plan_nombre,
       s.estado,
       s.vigencia_desde,
       s.vigencia_hasta,
       s.motivo,
       u.usuarios,
       u.comprobantes_mes,
       u.documentos_mes,
       u.integraciones,
       lu.tope                                     AS tope_usuarios,
       lc.tope                                     AS tope_comprobantes_mes,
       ld.tope                                     AS tope_documentos_mes,
       li.tope                                     AS tope_integraciones,
       -- Un ilimitado no se puede exceder, así que no entra. `tope IS NOT NULL`
       -- ya lo excluye: el CHECK de arriba garantiza que un ilimitado tiene
       -- `tope` en NULL.
       (CASE WHEN lu.tope IS NOT NULL AND u.usuarios > lu.tope THEN 1 ELSE 0 END
      + CASE WHEN lc.tope IS NOT NULL AND u.comprobantes_mes > lc.tope THEN 1 ELSE 0 END
      + CASE WHEN ld.tope IS NOT NULL AND u.documentos_mes > ld.tope THEN 1 ELSE 0 END
      + CASE WHEN li.tope IS NOT NULL AND u.integraciones > li.tope THEN 1 ELSE 0 END
      + CASE WHEN le.tope IS NOT NULL AND u.empresas IS NOT NULL
                  AND u.empresas > le.tope THEN 1 ELSE 0 END)
                                                   AS topes_excedidos,
       -- Sin declarar es **no tener fila**. Un ilimitado está declarado: tiene
       -- fila, dice algo, y no cuenta acá.
       (CASE WHEN lu.plan_id IS NULL THEN 1 ELSE 0 END
      + CASE WHEN lc.plan_id IS NULL THEN 1 ELSE 0 END
      + CASE WHEN ld.plan_id IS NULL THEN 1 ELSE 0 END
      + CASE WHEN li.plan_id IS NULL THEN 1 ELSE 0 END
      + CASE WHEN le.plan_id IS NULL THEN 1 ELSE 0 END)
                                                   AS topes_sin_declarar,
       u.empresas                                  AS empresas,
       le.tope                                     AS tope_empresas,
       -- Qué recursos se declararon ilimitados, por nombre. Un arreglo y no
       -- cinco booleanos: la ruta pregunta por pertenencia y no hay que
       -- agregar una columna cada vez que aparezca un recurso nuevo.
       ARRAY(
         SELECT r FROM (VALUES
           ('USUARIOS',         coalesce(lu.ilimitado, false)),
           ('COMPROBANTES_MES', coalesce(lc.ilimitado, false)),
           ('DOCUMENTOS_MES',   coalesce(ld.ilimitado, false)),
           ('INTEGRACIONES',    coalesce(li.ilimitado, false)),
           ('EMPRESAS',         coalesce(le.ilimitado, false))
         ) AS t(r, si) WHERE t.si
       )                                           AS topes_ilimitados
  FROM companies c
  JOIN subscription_usage u ON u.company_id = c.id
  LEFT JOIN LATERAL (
        SELECT s.*
          FROM company_subscriptions s
         WHERE s.company_id = c.id
           AND s.estado <> 'CANCELADA'
           AND s.vigencia_desde <= current_date
           AND (s.vigencia_hasta IS NULL OR s.vigencia_hasta >= current_date)
         ORDER BY s.vigencia_desde DESC
         LIMIT 1
       ) s ON true
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
  LEFT JOIN plan_limits lu ON lu.plan_id = s.plan_id AND lu.recurso = 'USUARIOS'
  LEFT JOIN plan_limits lc ON lc.plan_id = s.plan_id AND lc.recurso = 'COMPROBANTES_MES'
  LEFT JOIN plan_limits ld ON ld.plan_id = s.plan_id AND ld.recurso = 'DOCUMENTOS_MES'
  LEFT JOIN plan_limits li ON li.plan_id = s.plan_id AND li.recurso = 'INTEGRACIONES'
  LEFT JOIN plan_limits le ON le.plan_id = s.plan_id AND le.recurso = 'EMPRESAS';

COMMENT ON VIEW subscription_status IS
  'Plan vigente, uso del mes y topes declarados. Exceder un tope NO impide '
  'registrar nada. Cuatro estados por recurso: sin fila es «nadie lo '
  'declaró»; con número es un tope; con ilimitado es «decidido sin tope», que '
  'ni se excede ni cuenta como sin declarar.';
