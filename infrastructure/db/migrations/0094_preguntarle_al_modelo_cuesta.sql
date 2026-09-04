-- ============================================================================
-- 0094 — Preguntarle al modelo cuesta
-- ============================================================================
--
-- Hasta acá, cualquier usuario que pudiera leer analítica podía disparar una
-- llamada a un proveedor externo: `POST /intelligence/preguntar` filtra el
-- catálogo por permisos, y con eso alcanzaba. Mientras el proveedor fue `none`
-- daba lo mismo. Con un proveedor real deja de dar lo mismo por tres motivos
-- distintos, y conviene no confundirlos:
--
--   1. **Sale plata.** Cada pregunta es una llamada facturable.
--   2. **Salen datos.** El contexto que se manda lleva cifras de la empresa.
--   3. **Se puede abusar.** Un bucle de preguntas es un ataque barato.
--
-- Esta migración pone las tres piezas que faltaban, y ninguna inventa una
-- política de negocio.
--
-- ## 1. `intelligence:ask` — preguntar es otra cosa que leer
--
-- Leer la analítica y **hacer que el sistema le pregunte a un tercero** no son
-- el mismo acto, y hasta ahora los gobernaba el mismo permiso. Se separan.
--
-- Se otorga a ADMINISTRADOR, CONTADOR y AUDITOR: los mismos que ya pueden ver
-- las propuestas de IA (`prediction:read`). **SOLO_LECTURA queda afuera**, y no
-- pierde nada del sistema determinístico: las veinte preguntas del catálogo se
-- calculan con el mismo motor que cada pantalla de módulo, y esas pantallas las
-- sigue viendo enteras.
--
-- Qué roles deberían poder preguntar es, en el fondo, una decisión de la
-- empresa; esta lista es la que se deduce de los permisos que ya existen, y
-- cambiarla es un `INSERT` en `role_permissions`.
--
-- ## 2. `ai_quotas` — el cupo lo declara la empresa
--
-- **No hay un límite por defecto, y es a propósito.** Cuántas preguntas por día
-- puede hacer una empresa depende de su plan, de su tamaño y de lo que esté
-- dispuesta a gastar: inventar un número acá sería poner una política comercial
-- en una migración. Sin fila declarada no hay tope, y la respuesta de la API lo
-- dice con esas palabras en vez de dejarlo implícito.
--
-- El consumo **no se contabiliza en un contador**: se cuenta de `ai_answers`,
-- que ya registra cada llamada —aceptada, rechazada o abstenida—. Un contador
-- aparte sería un segundo número sobre el mismo hecho, y el día que se
-- desincronizara no habría forma de saber cuál miente (ADR-022).
--
-- Por eso el cupo tampoco se puede saltear cambiando de usuario: se cuenta por
-- empresa, que es lo que paga.
--
-- ## 3. `ai_pricing` — el costo se calcula, no se estima
--
-- `ai_predictions.cost_micros` existe desde la 0007 y nunca lo escribió nadie,
-- porque no había de dónde sacar el precio. Ahora hay dónde declararlo, por
-- proveedor y modelo.
--
-- **Sin precio declarado, `cost_micros` queda en `NULL`.** No es cero: es que no
-- se puede afirmar. Un costo estimado con precios inventados se vería igual que
-- uno real y se sumaría igual en un informe.
-- ============================================================================

INSERT INTO permissions (code, description) VALUES
  ('intelligence:ask', 'Preguntarle a NEXO Intelligence, que puede implicar una llamada a un proveedor de modelo');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR')
  AND p.code = 'intelligence:ask';

-- ---------------------------------------------------------------------------
-- Cupo por empresa
-- ---------------------------------------------------------------------------

CREATE TABLE ai_quotas (
  company_id       uuid PRIMARY KEY REFERENCES companies (id),
  -- Preguntas por día. `NULL` no es válido: para «sin tope» no se declara fila.
  -- Un `NULL` acá obligaría a distinguir «declaró que no hay tope» de «no
  -- declaró nada», y las dos cosas se comportan igual.
  llamadas_por_dia integer NOT NULL CHECK (llamadas_por_dia >= 0),
  motivo           text NOT NULL CHECK (length(btrim(motivo)) >= 5),
  declarado_por    text NOT NULL,
  declarado_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_quotas_por_empresa ON ai_quotas
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON ai_quotas TO aai_app;

COMMENT ON TABLE ai_quotas IS
  'Cupo diario de llamadas a un proveedor de modelo, por empresa. Sin fila no '
  'hay tope: cuántas preguntas entran en un día es una decisión comercial y no '
  'se inventa en una migración. El consumo se cuenta de ai_answers.';

-- ---------------------------------------------------------------------------
-- Precios
-- ---------------------------------------------------------------------------

CREATE TABLE ai_pricing (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  model_provider         text NOT NULL,
  model_id               text NOT NULL,
  -- Micros de la moneda del proveedor por cada mil tokens. Enteros: un precio
  -- en punto flotante multiplicado por millones de tokens acumula error, y este
  -- número termina en un informe de costos.
  input_micros_por_mil   bigint NOT NULL CHECK (input_micros_por_mil >= 0),
  output_micros_por_mil  bigint NOT NULL CHECK (output_micros_por_mil >= 0),
  moneda                 text NOT NULL DEFAULT 'USD' CHECK (length(moneda) = 3),
  vigente_desde          date NOT NULL,
  vigente_hasta          date,
  declarado_por          text NOT NULL,
  declarado_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_pricing_vigencia CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde)
);

-- Un precio es del proveedor, no de una empresa: no lleva RLS por inquilino.
-- Se lee para calcular un costo y no contiene datos de nadie.
CREATE UNIQUE INDEX ai_pricing_vigente_idx
  ON ai_pricing (model_provider, model_id, vigente_desde);

GRANT SELECT ON ai_pricing TO aai_app;

COMMENT ON TABLE ai_pricing IS
  'Precio por mil tokens, por proveedor y modelo, con vigencia. Sin fila '
  'aplicable, ai_predictions.cost_micros queda en NULL: no se puede afirmar. '
  'Un costo con precios inventados se ve igual que uno real y se suma igual.';

-- La acción que registra la declaración de un cupo (0091: una acción sin
-- registrar no se puede escribir).
INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('DECLARAR_CUPO_DE_IA', 'intelligence', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
