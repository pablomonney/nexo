-- 0007_ai.sql — predicciones de IA y revisión humana.
--
-- ADR-001: la IA no escribe en la contabilidad. Escribe acá y nada más.
-- Nótese la DIRECCIÓN de la clave foránea: journal_entries → ai_predictions.
-- No existe una FK en sentido inverso, y esa asimetría es deliberada: una
-- predicción no puede "crear" un asiento porque no tiene dónde apuntar.

CREATE TABLE ai_predictions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  agent             text NOT NULL CHECK (agent IN (
                      'DOCUMENT', 'CLASSIFICATION', 'TAX', 'NORMATIVE_RESEARCH',
                      'RECONCILIATION', 'FINANCIAL_ANALYSIS', 'NOTES', 'AUDIT')),
  model_provider    text NOT NULL,
  model_id          text NOT NULL,
  prompt_hash       char(64) NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  input_ref         text NOT NULL,
  output            jsonb NOT NULL,
  confidence        numeric(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason            text NOT NULL,
  -- Cada fuente citada se resuelve contra norm_versions. Si un id no existe, la
  -- propuesta se rechaza automáticamente y se loguea como alucinación detectada.
  normative_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  latency_ms        integer,
  cost_micros       bigint,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_predictions_company_idx ON ai_predictions (company_id, created_at DESC);
CREATE INDEX ai_predictions_agent_idx ON ai_predictions (company_id, agent, confidence);

CREATE TABLE ai_reviews (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  prediction_id    uuid NOT NULL REFERENCES ai_predictions (id),
  reviewer_id      text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('APROBADA', 'MODIFICADA', 'RECHAZADA')),
  corrected_output jsonb,
  motivo           text,
  reviewed_at      timestamptz NOT NULL DEFAULT now(),
  -- Si se modificó, tiene que constar en qué. Un "MODIFICADA" sin diferencia no
  -- sirve para entrenar nada ni para auditar nada.
  CHECK (decision <> 'MODIFICADA' OR corrected_output IS NOT NULL),
  CHECK (decision <> 'RECHAZADA' OR motivo IS NOT NULL)
);

CREATE INDEX ai_reviews_prediction_idx ON ai_reviews (prediction_id);

-- Ahora sí, la referencia desde el asiento hacia la predicción que lo originó.
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_ai_prediction_fk
  FOREIGN KEY (ai_prediction_id) REFERENCES ai_predictions (id);

-- ---------------------------------------------------------------------------
-- Aprendizaje por empresa (§14)
-- ---------------------------------------------------------------------------
-- Solo mueve la sugerencia y la confianza. No hay —ni puede haber— ruta de
-- escritura desde acá hacia accounting_rules o norm_versions (ADR-007).
-- El aprendizaje es POR EMPRESA: no se comparte entre clientes del estudio,
-- porque la contabilidad de cada uno es secreto profesional.
CREATE TABLE classification_preferences (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id           uuid NOT NULL REFERENCES companies (id),
  signal               text NOT NULL,
  suggested_account_id uuid NOT NULL REFERENCES accounts (id),
  support_count        integer NOT NULL DEFAULT 0 CHECK (support_count >= 0),
  last_confirmed_at    timestamptz,
  UNIQUE (company_id, signal)
);

CREATE TABLE confidence_policies (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  agent            text NOT NULL,
  auto_threshold   numeric(5, 4) NOT NULL CHECK (auto_threshold BETWEEN 0 AND 1),
  review_threshold numeric(5, 4) NOT NULL CHECK (review_threshold BETWEEN 0 AND 1),
  updated_by       text NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, agent),
  CHECK (auto_threshold >= review_threshold)
);
