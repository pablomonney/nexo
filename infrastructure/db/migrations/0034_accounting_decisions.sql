-- 0034_accounting_decisions.sql — por qué existe un asiento.
--
-- ## Lo que ya había, y lo que faltaba
--
-- El puente no estaba ausente: estaba **incompleto y desconectado**.
-- `rule_applications` existe desde la 0006 con `rule_id`, `rule_version`,
-- `entry_id`, `inputs` y `outputs`, y el invariante A-4 ya la vigila. Tenía cero
-- filas porque ningún código la escribe.
--
-- Lo que no podía expresar es una decisión **sin regla**. Su `rule_id` es NOT
-- NULL, y el caso más frecuente hoy —"ninguna regla resolvió esto, va a
-- revisión"— es exactamente el que no entra. Una tabla de aplicaciones de regla
-- no puede registrar la ausencia de regla, y esa ausencia es información.
--
-- ## Los cuatro conceptos, separados
--
--   `ai_predictions`        — un modelo PROPUSO algo. Puede no haber modelo.
--   `accounting_decisions`  — se DECIDIÓ un tratamiento, con o sin regla, y se
--                             registró qué lo funda y qué falta.
--   `rule_applications`     — QUÉ REGLA se aplicó dentro de esa decisión. Cero,
--                             una o varias.
--   `journal_entries`       — el REGISTRO contable resultante.
--
-- Una decisión no es una predicción: la predicción es una de las formas de
-- llegar a ella, y la mayoría de las decisiones de este sistema no van a pasar
-- por un modelo. Por eso `origen` distingue `DETERMINISTICA`, `PROPUESTA_IA` y
-- `MANUAL`, y `ai_prediction_id` solo se completa en el segundo caso.
--
-- ## El hash se congela
--
-- `rule_applications` no guardaba el sha256: se derivaba en vivo por
-- `regla → norm_version → norm_documents`. Funciona hasta que un documento se
-- vuelve a archivar —una descarga corregida, un T.O. nuevo— y entonces un
-- asiento de hace dos años pasa a citar un texto que nadie usó para decidirlo.
--
-- Se congela en la aplicación. El invariante A-4 sigue comprobando que la
-- derivación exista; lo nuevo comprueba que **coincida con lo congelado**.
--
-- ## La dirección del enlace
--
-- `journal_entries.decision_id`, y no `accounting_decisions.entry_id`. La
-- pregunta que el sistema tiene que contestar barato es "¿por qué existe este
-- asiento?", y así se contesta con un solo join. Guardar las dos puntas habría
-- creado dos verdades que se desincronizan.

-- ---------------------------------------------------------------------------
-- La decisión
-- ---------------------------------------------------------------------------
CREATE TABLE accounting_decisions (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),

  -- Sobre qué se decidió. Puede no haber comprobante: un ajuste de cierre es una
  -- decisión contable y no nace de un papel de un tercero.
  tax_transaction_id  uuid REFERENCES tax_transactions (id),
  document_id         uuid REFERENCES documents (id),

  origen              text NOT NULL CHECK (origen IN
                        ('DETERMINISTICA', 'PROPUESTA_IA', 'MANUAL')),
  ai_prediction_id    uuid REFERENCES ai_predictions (id),

  resultado           text NOT NULL CHECK (resultado IN
                        ('PROPUESTA_DE_ASIENTO', 'REQUIERE_REVISION', 'SIN_EFECTO')),

  -- Por qué. Lista de `{motivo, detalle}`; vacía solo si el resultado no es
  -- REQUIERE_REVISION. Una revisión sin motivo no le sirve a nadie.
  motivos             jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Los hechos que se usaron, **cada uno con su origen**. No es una copia
  -- redundante del comprobante: es la foto de lo que se sabía al decidir, que es
  -- lo único que explica una decisión vieja.
  hechos              jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidencia           jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- PRUEBA permite citar reglas que no están activas. PRODUCTIVO no.
  ambiente            text NOT NULL DEFAULT 'PRODUCTIVO'
                        CHECK (ambiente IN ('PRODUCTIVO', 'PRUEBA')),

  estado              text NOT NULL DEFAULT 'EMITIDA'
                        CHECK (estado IN ('EMITIDA', 'APLICADA', 'SUPERSEDIDA')),

  requiere_aprobacion boolean NOT NULL DEFAULT true,
  aprobada_por        text,
  aprobada_at         timestamptz,

  decidida_por        text NOT NULL,
  decidida_at         timestamptz NOT NULL DEFAULT now(),

  -- Una corrección no edita: emite otra decisión que reemplaza a la anterior.
  supersedes_id       uuid REFERENCES accounting_decisions (id),

  -- Obligatoria cuando no hay regla que la funde. Es el equivalente de
  -- `manual_justification` en el asiento, un nivel más arriba.
  justificacion       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT decision_ia_requiere_prediccion
    CHECK (origen <> 'PROPUESTA_IA' OR ai_prediction_id IS NOT NULL),
  CONSTRAINT decision_prediccion_solo_si_ia
    CHECK (ai_prediction_id IS NULL OR origen = 'PROPUESTA_IA'),
  CONSTRAINT decision_aprobacion_completa
    CHECK ((aprobada_por IS NULL) = (aprobada_at IS NULL)),
  CONSTRAINT decision_revision_lleva_motivo
    CHECK (resultado <> 'REQUIERE_REVISION' OR jsonb_array_length(motivos) > 0)
);

CREATE INDEX accounting_decisions_comprobante_idx
  ON accounting_decisions (company_id, tax_transaction_id);

-- ---------------------------------------------------------------------------
-- La aplicación de regla, completada
-- ---------------------------------------------------------------------------
ALTER TABLE rule_applications
  ADD COLUMN decision_id uuid REFERENCES accounting_decisions (id),
  -- El sha256 del documento normativo **tal como estaba al decidir**.
  ADD COLUMN norm_document_sha256 text,
  -- En qué estado estaba la regla cuando se la aplicó. Guardarlo permite
  -- explicar una decisión vieja sin depender de en qué estado quedó la regla
  -- después: una regla superseded siguió fundando los asientos de su época.
  ADD COLUMN rule_status_at_application text;

CREATE INDEX rule_applications_decision_idx ON rule_applications (decision_id);

-- ---------------------------------------------------------------------------
-- El asiento apunta a su decisión
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entries
  ADD COLUMN decision_id uuid REFERENCES accounting_decisions (id);

CREATE INDEX journal_entries_decision_idx ON journal_entries (decision_id);

COMMENT ON COLUMN journal_entries.decision_id IS
  'Por qué existe este asiento. NULL en los manuales, que llevan '
  'manual_justification: un asiento manual NO inventa una decisión normativa.';

-- ---------------------------------------------------------------------------
-- Candado: una decisión productiva no se funda en una regla que no está activa
-- ---------------------------------------------------------------------------
-- Es el tercer filtro sobre las reglas DRAFT, y es el único que actúa **después**
-- de que la decisión existe. Los dos anteriores —el catálogo que arma la consulta
-- y el descarte de `resolve.ts`— impiden que una regla inactiva se resuelva. Este
-- impide que una decisión productiva la registre como fundamento aunque alguien
-- la escriba a mano.
CREATE OR REPLACE FUNCTION assert_rule_application_activa() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  amb    text;
  estado text;
  sha    text;
BEGIN
  SELECT d.ambiente INTO amb FROM accounting_decisions d WHERE d.id = NEW.decision_id;

  SELECT r.status INTO estado FROM accounting_rules r WHERE r.id = NEW.rule_id;
  IF estado IS NULL THEN
    RAISE EXCEPTION 'La regla % no existe', NEW.rule_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.rule_status_at_application := estado;

  IF coalesce(amb, 'PRODUCTIVO') = 'PRODUCTIVO' AND estado <> 'ACTIVE' THEN
    RAISE EXCEPTION
      'La regla % está en estado % y no puede fundar una decisión productiva. '
      'Una decisión de prueba sí puede citarla: marcá la decisión como ambiente = PRUEBA.',
      NEW.rule_id, estado
      USING ERRCODE = 'check_violation';
  END IF;

  -- El hash se congela acá, no lo elige quien inserta: si viniera de afuera,
  -- congelarlo mal sería tan fácil como congelarlo bien.
  SELECT d.sha256 INTO sha
    FROM accounting_rules r
    JOIN norm_documents d ON d.norm_version_id = r.norm_version_id
   WHERE r.id = NEW.rule_id
   LIMIT 1;

  IF sha IS NULL THEN
    RAISE EXCEPTION 'La regla % no tiene documento normativo archivado con hash', NEW.rule_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.norm_document_sha256 := sha;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rule_applications_regla_activa
  BEFORE INSERT OR UPDATE ON rule_applications
  FOR EACH ROW EXECUTE FUNCTION assert_rule_application_activa();

-- ---------------------------------------------------------------------------
-- Candado: un asiento manual no inventa una regla
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_decision_manual_sin_regla() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  con_reglas integer;
BEGIN
  SELECT count(*) INTO con_reglas FROM rule_applications WHERE decision_id = NEW.id;

  IF NEW.origen = 'MANUAL' THEN
    IF con_reglas > 0 THEN
      RAISE EXCEPTION 'Una decisión MANUAL no puede citar reglas: cita %', con_reglas
        USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(btrim(NEW.justificacion), '') = '' THEN
      RAISE EXCEPTION 'Una decisión MANUAL necesita justificación escrita'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Proponer un asiento sin fundamento ni justificación es lo que este modelo
  -- existe para impedir.
  IF NEW.resultado = 'PROPUESTA_DE_ASIENTO'
     AND con_reglas = 0
     AND coalesce(btrim(NEW.justificacion), '') = '' THEN
    RAISE EXCEPTION
      'Una propuesta de asiento sin regla aplicada necesita justificación: '
      'sin una ni otra, no hay por qué.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- Diferido: las aplicaciones de regla se insertan después de la decisión, así
-- que contarlas en el INSERT inmediato daría siempre cero.
CREATE CONSTRAINT TRIGGER accounting_decisions_manual_sin_regla
  AFTER INSERT OR UPDATE ON accounting_decisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_decision_manual_sin_regla();

-- ---------------------------------------------------------------------------
-- Candado: una decisión ya usada por un asiento no se modifica
-- ---------------------------------------------------------------------------
-- El asiento histórico tiene que conservar **exactamente** la decisión que lo
-- originó. Corregir se corrige emitiendo otra decisión con `supersedes_id`, no
-- editando la vieja: editarla reescribiría el pasado de todos los asientos que
-- ya la citaron.
CREATE OR REPLACE FUNCTION assert_decision_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  usada boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM journal_entries WHERE decision_id = OLD.id) INTO usada;
  IF NOT usada THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Lo único que puede cambiar en una decisión usada es su **estado**, y solo
  -- hacia adelante: EMITIDA → APLICADA → SUPERSEDIDA. El contenido —qué se
  -- decidió, con qué hechos y qué evidencia— quedó fijado cuando el asiento la
  -- citó, y es lo que ese asiento tiene que poder seguir mostrando.
  --
  -- La distinción apareció al escribir el test: marcar APLICADA después de
  -- registrar el asiento es el flujo normal, y la primera versión de este
  -- candado lo bloqueaba junto con las modificaciones de verdad.
  IF NEW.resultado = OLD.resultado
     AND NEW.hechos = OLD.hechos
     AND NEW.evidencia = OLD.evidencia
     AND NEW.motivos = OLD.motivos
     AND NEW.origen = OLD.origen
     AND NEW.ambiente = OLD.ambiente
     AND NEW.tax_transaction_id IS NOT DISTINCT FROM OLD.tax_transaction_id
     AND NEW.justificacion IS NOT DISTINCT FROM OLD.justificacion
     AND NEW.decidida_por = OLD.decidida_por
     AND (
       (OLD.estado = 'EMITIDA'  AND NEW.estado IN ('APLICADA', 'SUPERSEDIDA')) OR
       (OLD.estado = 'APLICADA' AND NEW.estado = 'SUPERSEDIDA')
     ) THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'La decisión % ya fundamenta un asiento y no se puede modificar. '
    'Para corregirla, emitá una decisión nueva con supersedes_id = %.',
    OLD.id, OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER accounting_decisions_inmutable
  BEFORE UPDATE ON accounting_decisions
  FOR EACH ROW EXECUTE FUNCTION assert_decision_inmutable();

CREATE TRIGGER accounting_decisions_no_delete
  BEFORE DELETE ON accounting_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER rule_applications_no_delete
  BEFORE DELETE ON rule_applications
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Candado: un asiento productivo no se funda en una decisión de prueba
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_entry_decision_coherente() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  amb   text;
  dueno uuid;
BEGIN
  IF NEW.decision_id IS NULL THEN RETURN NEW; END IF;

  SELECT ambiente, company_id INTO amb, dueno
    FROM accounting_decisions WHERE id = NEW.decision_id;

  IF dueno IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'La decisión % pertenece a otra empresa', NEW.decision_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF amb = 'PRUEBA' THEN
    RAISE EXCEPTION
      'La decisión % es de ambiente PRUEBA y no puede fundamentar un asiento',
      NEW.decision_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entries_decision_coherente
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_entry_decision_coherente();

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_accounting_decision() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_logs
    (company_id, actor_type, actor_id, action, object_type, object_id,
     old_value, new_value, motivo, prev_hash, hash)
  VALUES (
    NEW.company_id, 'USER', NEW.decidida_por,
    CASE TG_OP WHEN 'INSERT' THEN 'DECISION_EMITIDA' ELSE 'DECISION_CAMBIADA' END,
    'accounting_decisions', NEW.id,
    CASE WHEN TG_OP = 'UPDATE'
      THEN jsonb_build_object('estado', OLD.estado, 'resultado', OLD.resultado)
      ELSE NULL END,
    jsonb_build_object('estado', NEW.estado, 'resultado', NEW.resultado,
                       'origen', NEW.origen, 'ambiente', NEW.ambiente),
    NEW.justificacion, '', ''
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER accounting_decisions_audit
  AFTER INSERT OR UPDATE ON accounting_decisions
  FOR EACH ROW EXECUTE FUNCTION audit_accounting_decision();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE accounting_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_decisions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- `rule_applications` ya tiene RLS forzado y su política desde la 0009. No se
-- vuelve a crear, y no se da por hecho: se comprueba. Una política que alguien
-- supone puesta y no está es una fuga que nadie ve.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'rule_applications' AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'rule_applications no tiene RLS forzado, y esta migración lo daba por hecho';
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE ON accounting_decisions TO aai_app;
GRANT SELECT, INSERT ON rule_applications TO aai_app;

-- ---------------------------------------------------------------------------
-- El recorrido, en una vista
-- ---------------------------------------------------------------------------
-- "Este asiento existe porque…" resuelto en una consulta. `security_invoker`
-- porque toca tablas con RLS forzado — ver 0032.
CREATE VIEW decision_trace WITH (security_invoker = true) AS
SELECT e.id                       AS entry_id,
       e.company_id,
       e.entry_number,
       e.entry_date,
       e.status                   AS entry_status,
       e.manual_justification,
       d.id                       AS decision_id,
       d.origen,
       d.resultado,
       d.ambiente,
       d.decidida_por,
       d.decidida_at,
       d.hechos,
       d.evidencia,
       d.motivos,
       d.justificacion,
       ra.rule_id,
       ra.rule_version,
       ra.rule_status_at_application,
       ra.norm_document_sha256,
       r.rule_key,
       n.organismo,
       n.tipo                     AS norma_tipo,
       n.numero                   AS norma_numero,
       t.id                       AS tax_transaction_id,
       t.cbte_tipo,
       t.punto_venta,
       t.cbte_numero,
       t.cbte_fecha
  FROM journal_entries e
  LEFT JOIN accounting_decisions d ON d.id = e.decision_id
  LEFT JOIN rule_applications ra   ON ra.decision_id = d.id
  LEFT JOIN accounting_rules r     ON r.id = ra.rule_id
  LEFT JOIN norm_versions v        ON v.id = r.norm_version_id
  LEFT JOIN norms n                ON n.id = v.norm_id
  LEFT JOIN tax_transactions t     ON t.id = d.tax_transaction_id;

GRANT SELECT ON decision_trace TO aai_app;

COMMENT ON TABLE accounting_decisions IS
  'Por qué se registró —o no— un asiento. Existe con o sin regla, con o sin IA. '
  'Una predicción de un modelo es una forma de llegar a una decisión, no la decisión.';
