-- ---------------------------------------------------------------------------
-- El asistente de IA es parte de cada plan, con un tope diario de tokens por plan
-- ---------------------------------------------------------------------------
--
-- El titular decidió (2026-10-19) que **todos los planes tengan IA**.
--
-- ## Lo que había
--
-- El asistente (0136) cuelga de las rutas `/asistente/...`, y ninguna funcionalidad del catálogo cubría el dominio `asistente`. La
-- puerta comercial **falla abierta** por lo que no sabe (alcance.ts): un dominio fuera del catálogo se deja pasar. O sea que, sin
-- hacer nada, el asistente ya alcanzaba a cualquier empresa de cualquier plan —incluso a una suspendida o morosa— y, peor, **sin
-- ningún tope de gasto**: el cupo de tokens (0141) lo declara cada empresa y, si no declaró nada, no hay tope.
--
-- ## Qué hace esta migración
--
-- 1. `asistente` pasa a ser una **funcionalidad del catálogo** (dominio `asistente`), incluida en **todos** los planes. Así la
--    mora y la suspensión lo cortan como a cualquier módulo que no sostiene una obligación con plazo (`sobrevive_la_mora = false`),
--    y la matriz de planes lo muestra como lo que es: algo que el plan incluye.
-- 2. `plan_ai_quotas`: el **tope diario de tokens por plan**. Es el valor que rige cuando la empresa no declaró uno propio
--    (`ai_quotas`, 0141): el de la empresa gana, el del plan es el piso de seguridad. Los números los declara el script comercial
--    (`scripts/sembrar-comercial-b1.mjs`), no esta migración: cuántos tokens entran en un plan es una decisión comercial.
-- 3. La descripción de `documentos` decía «OCR» y hoy sólo se leen solos los XML de ARCA: se corrige.
-- ---------------------------------------------------------------------------

INSERT INTO product_features (code, nombre, descripcion, dominios, orden, esencial)
VALUES ('asistente', 'Asistente de IA',
        'Chat con un modelo de lenguaje que consulta los datos de la empresa con los permisos de quien escribe, lee fotos y PDFs adjuntos y propone altas; no calcula ni guarda nada por sí solo',
        '{asistente}', 20, false);

-- Lo que no sostiene una obligación con plazo se apaga con la mora (0125).
UPDATE product_features SET sobrevive_la_mora = false WHERE code = 'asistente';

INSERT INTO plan_features (plan_id, feature_code, declarado_por, motivo)
SELECT p.id, 'asistente', 'comercial-2026-10',
       'El titular decidió el 2026-10-19 que todos los planes incluyen el asistente de IA.'
  FROM subscription_plans p
ON CONFLICT DO NOTHING;

UPDATE product_features
   SET descripcion = 'Archivo de documentos con huella digital, lectura automática de los XML de ARCA, versiones y detección de duplicados'
 WHERE code = 'documentos';

CREATE TABLE plan_ai_quotas (
  plan_id        uuid PRIMARY KEY REFERENCES subscription_plans (id),
  -- Tokens (entrada + salida) por día y por empresa. 0 es un tope válido (apaga el asistente para ese plan).
  tokens_por_dia bigint NOT NULL CHECK (tokens_por_dia >= 0),
  declarado_por  text NOT NULL,
  declarado_el   timestamptz NOT NULL DEFAULT now(),
  motivo         text NOT NULL CHECK (length(btrim(motivo)) >= 10)
);

GRANT SELECT ON plan_ai_quotas TO aai_app;
REVOKE INSERT, UPDATE, DELETE ON plan_ai_quotas FROM aai_app;

COMMENT ON TABLE plan_ai_quotas IS
  'Tope diario de tokens del asistente, por plan. Rige cuando la empresa no declaró uno propio (ai_quotas.tokens_por_dia). La ausencia '
  'de fila significa que el plan no declaró tope. Lo escribe el script comercial, nunca la aplicación.';
