-- 0018_ai_classification.sql — lo que hace falta para que FASE 4 sea auditable.
--
-- La 0007 ya dejó puestas `ai_predictions`, `ai_reviews` y el candado que
-- importa: `journal_entries.je_ai_requires_human_approval`, que impide que un
-- asiento originado en una predicción llegue a estado aprobado sin `approved_by`.
--
-- Esta migración agrega tres cosas que faltaban para poder responder preguntas
-- que un auditor va a hacer:
--
--   1. ¿Con qué instrucciones exactas el sistema propuso esto?  → prompt_versions
--   2. ¿Qué propuestas se descartaron y por qué?                → ai_rejections
--   3. ¿Qué frenó esta propuesta?                               → triage en la predicción

-- ---------------------------------------------------------------------------
-- Prompts archivados
-- ---------------------------------------------------------------------------
-- `ai_predictions.prompt_hash` guardaba la huella de un texto que no estaba en
-- ningún lado. Un hash sin el original no prueba nada: no se puede recomputar ni
-- leer. Acá vive el texto, y la FK obliga a registrar el prompt antes de usarlo.
CREATE TABLE prompt_versions (
  hash          char(64) PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  name          text NOT NULL,
  version       text NOT NULL,
  texto         text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TRIGGER prompt_versions_no_delete BEFORE DELETE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Un prompt no se edita: se publica una versión nueva. Editarlo cambiaría
-- retroactivamente el significado de predicciones ya emitidas.
CREATE OR REPLACE FUNCTION forbid_prompt_text_change() RETURNS trigger AS $$
BEGIN
  IF NEW.texto IS DISTINCT FROM OLD.texto OR NEW.hash IS DISTINCT FROM OLD.hash THEN
    RAISE EXCEPTION
      'Un prompt archivado es inmutable. Publicá una versión nueva en lugar de editarlo.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prompt_versions_immutable
  BEFORE UPDATE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_prompt_text_change();

ALTER TABLE ai_predictions
  ADD CONSTRAINT ai_predictions_prompt_fk
  FOREIGN KEY (prompt_hash) REFERENCES prompt_versions (hash);

-- ---------------------------------------------------------------------------
-- Triage de la predicción
-- ---------------------------------------------------------------------------
-- La banda y los disparadores duros se guardan **con la predicción**, no se
-- recalculan al mostrarla. Los hechos que los originaron —ARCA caída, proveedor
-- nuevo— cambian con el tiempo, y la pregunta del auditor es qué sabía el
-- sistema cuando propuso, no qué sabe hoy.
ALTER TABLE ai_predictions
  ADD COLUMN document_id uuid REFERENCES documents (id),
  ADD COLUMN triage_band text CHECK (triage_band IN ('ALTA', 'MEDIA', 'BAJA')),
  ADD COLUMN hard_blocks text[] NOT NULL DEFAULT '{}',
  ADD COLUMN advertencias text[] NOT NULL DEFAULT '{}',
  ADD COLUMN passes integer NOT NULL DEFAULT 1;

-- Coherencia entre la banda y los disparadores: si hay un bloqueo duro, la banda
-- es BAJA. Sin esto, un bug en el código podría escribir "ALTA" con bloqueos y
-- la propuesta entraría al lote de aprobación.
ALTER TABLE ai_predictions
  ADD CONSTRAINT ai_predictions_triage_coherente
  CHECK (cardinality(hard_blocks) = 0 OR triage_band = 'BAJA');

CREATE INDEX ai_predictions_pendientes
  ON ai_predictions (company_id, triage_band, created_at DESC);

-- ---------------------------------------------------------------------------
-- Propuestas descartadas
-- ---------------------------------------------------------------------------
-- Lo que la Validation Layer tumbó nunca llega a `ai_predictions`. Sin esta
-- tabla, esas salidas se perderían — y son justamente las que hay que medir:
-- la tasa de alucinación detectada es la métrica de deriva del modelo.
CREATE TABLE ai_rejections (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  document_id    uuid REFERENCES documents (id),
  agent          text NOT NULL,
  model_provider text NOT NULL,
  model_id       text NOT NULL,
  prompt_hash    char(64) NOT NULL REFERENCES prompt_versions (hash),
  motivo         text NOT NULL CHECK (motivo IN (
                   'SCHEMA_INVALIDO', 'CUENTA_FUERA_DEL_PLAN', 'CUENTA_NO_IMPUTABLE',
                   'CITA_NO_RESOLUBLE', 'CONFIANZA_FUERA_DE_RANGO', 'PROVEEDOR_NO_DISPONIBLE')),
  -- Separa "inventó algo que no existe" de "se equivocó de criterio". No son la
  -- misma falla y no se corrigen igual.
  es_alucinacion boolean NOT NULL,
  detalle        text NOT NULL,
  raw_output     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_rejections_deriva
  ON ai_rejections (company_id, es_alucinacion, created_at DESC);

CREATE TRIGGER ai_rejections_no_delete BEFORE DELETE ON ai_rejections
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

ALTER TABLE ai_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_rejections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_rejections
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- ---------------------------------------------------------------------------
-- Preferencias: varias cuentas candidatas por señal
-- ---------------------------------------------------------------------------
-- La 0007 permitía una sola cuenta por señal. En la práctica compiten: el
-- contador cambia de criterio, o el mismo proveedor factura dos cosas distintas.
-- Guardar solo la ganadora borraba la evidencia de que hubo competencia, y hacía
-- que un único cambio de criterio pisara veinte confirmaciones anteriores.
ALTER TABLE classification_preferences
  DROP CONSTRAINT IF EXISTS classification_preferences_company_id_signal_key;

ALTER TABLE classification_preferences
  ADD CONSTRAINT classification_preferences_signal_cuenta_key
  UNIQUE (company_id, signal, suggested_account_id);

CREATE INDEX classification_preferences_lookup
  ON classification_preferences (company_id, signal, support_count DESC);

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('prediction:read',   'Ver las propuestas de clasificación y su fundamento'),
  ('prediction:run',    'Pedirle al sistema que clasifique un documento'),
  ('prediction:review', 'Aprobar, modificar o rechazar una propuesta');

-- Quién revisa: el contador. No el administrador.
--
-- Es la misma línea que la 0011 trazó con journal_entry:approve. Administrar el
-- sistema y decidir una imputación son responsabilidades distintas, y la segunda
-- es del profesional matriculado (§42).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code IN ('prediction:read', 'prediction:run', 'prediction:review');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code IN ('prediction:read');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'AUDITOR' AND p.code IN ('prediction:read');

GRANT SELECT, INSERT ON ai_rejections TO aai_app;
REVOKE UPDATE ON ai_rejections FROM aai_app;

GRANT SELECT ON prompt_versions TO aai_app;
-- El registro de prompts lo hace el arranque de la aplicación con credenciales
-- de migración, no un endpoint. Un prompt que se pudiera insertar por HTTP
-- dejaría de ser un artefacto versionado.
REVOKE INSERT, UPDATE ON prompt_versions FROM aai_app;

-- ---------------------------------------------------------------------------
-- Bandeja de revisión
-- ---------------------------------------------------------------------------
CREATE VIEW predictions_pendientes AS
SELECT p.id,
       p.company_id,
       p.document_id,
       p.agent,
       p.output,
       p.confidence,
       p.reason,
       p.normative_sources,
       p.triage_band,
       p.hard_blocks,
       p.advertencias,
       p.model_provider,
       p.model_id,
       p.prompt_hash,
       p.created_at,
       d.original_name AS documento_nombre
  FROM ai_predictions p
  LEFT JOIN documents d ON d.id = p.document_id
 WHERE NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.prediction_id = p.id);

GRANT SELECT ON predictions_pendientes TO aai_app;
