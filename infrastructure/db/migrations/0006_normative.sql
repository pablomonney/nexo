-- 0006_normative.sql — motor normativo.
--
-- Las tablas normativas NO llevan company_id: la normativa es común a todo el
-- sistema. Lo que sí es por empresa es qué reglas le aplican, y eso se resuelve
-- por (jurisdicción, tipo de ente, marco, fecha).

CREATE TABLE norms (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  organismo       text NOT NULL CHECK (organismo IN (
                    'CONGRESO', 'PEN', 'ARCA', 'AFIP', 'IGJ', 'CNV', 'BCRA', 'INAES',
                    'FACPCE', 'CPCE_CABA', 'CPCE_PROVINCIAL', 'PROVINCIAL', 'MUNICIPAL')),
  tipo            text NOT NULL CHECK (tipo IN (
                    'CONSTITUCION', 'LEY', 'DECRETO', 'RG', 'RESOLUCION', 'DISPOSICION',
                    'RT', 'RES_JG', 'RES_MD', 'RES_CD', 'INTERPRETACION', 'MANUAL', 'PARAMETRO')),
  numero          text NOT NULL,
  anio            integer NOT NULL,
  titulo          text NOT NULL,
  jurisdiccion    text NOT NULL,
  -- P1 leyes y decretos · P2 organismos de control · P3 normas profesionales
  -- · P4 material explicativo. Ver OFFICIAL_SOURCES.md §1.
  hierarchy_level smallint NOT NULL CHECK (hierarchy_level BETWEEN 1 AND 4),
  estado          text NOT NULL DEFAULT 'VIGENTE'
                    CHECK (estado IN ('VIGENTE', 'DEROGADA', 'SUSTITUIDA')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organismo, tipo, numero, anio)
);

CREATE TABLE norm_versions (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  norm_id            uuid NOT NULL REFERENCES norms (id),
  version            integer NOT NULL CHECK (version > 0),
  fecha_emision      date NOT NULL,
  fecha_publicacion  date,
  fecha_vigencia     date,
  fecha_derogacion   date,
  texto              text,

  -- Eje de TIEMPO DE SISTEMA. Sin esto no se puede reproducir la decisión de
  -- ayer con el conocimiento que el sistema tenía ayer (NORMATIVE_ENGINE.md §3).
  recorded_from      timestamptz NOT NULL DEFAULT now(),
  recorded_to        timestamptz,

  -- Solo V1 habilita reglas activas. Ver OFFICIAL_SOURCES.md §0.
  verification_level text NOT NULL CHECK (verification_level IN ('V1', 'V2', 'V3', 'V4')),

  UNIQUE (norm_id, version),
  CHECK (fecha_derogacion IS NULL OR fecha_vigencia IS NULL OR fecha_derogacion >= fecha_vigencia)
);

CREATE INDEX norm_versions_validity_idx ON norm_versions (norm_id, fecha_vigencia, fecha_derogacion);

-- Documento original archivado. El hash es lo que permite demostrar, años
-- después, qué texto exacto usaba el sistema (§49 del pliego).
CREATE TABLE norm_documents (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  norm_version_id uuid NOT NULL REFERENCES norm_versions (id),
  url_oficial     text NOT NULL,
  storage_key     text NOT NULL,
  sha256          char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime            text NOT NULL,
  bytes           bigint NOT NULL CHECK (bytes > 0),
  fecha_descarga  timestamptz NOT NULL DEFAULT now(),
  captured_by     text NOT NULL,
  UNIQUE (norm_version_id, sha256)
);

CREATE TRIGGER norm_documents_no_delete BEFORE DELETE ON norm_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE norm_articles (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  norm_version_id uuid NOT NULL REFERENCES norm_versions (id),
  numero          text NOT NULL,
  titulo          text,
  texto           text NOT NULL,
  orden           integer NOT NULL,
  UNIQUE (norm_version_id, numero)
);

CREATE TABLE norm_modifications (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  modificadora_version_id uuid NOT NULL REFERENCES norm_versions (id),
  modificada_version_id   uuid NOT NULL REFERENCES norm_versions (id),
  tipo                   text NOT NULL CHECK (tipo IN ('SUSTITUYE', 'INCORPORA', 'DEROGA', 'RATIFICA')),
  articulos              jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK (modificadora_version_id <> modificada_version_id)
);

CREATE TABLE norm_references (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  from_version_id uuid NOT NULL REFERENCES norm_versions (id),
  to_version_id   uuid NOT NULL REFERENCES norm_versions (id),
  relation        text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Adopción jurisdiccional
-- ---------------------------------------------------------------------------
-- La tabla que el caso RT 54 obliga a tener. FACPCE fijó vigencia para ejercicios
-- iniciados desde el 01/07/2024; el CPCECABA la adoptó desde el 01/01/2025. No es
-- una contradicción: son dos hechos jurídicos distintos y ambos son verdaderos.
--
-- Fundamento oficial: el art. 226 del Anexo A de la RG IGJ 15/2024, sustituido por
-- la RG 9/2026, remite a las RT "adoptadas por el Consejo Profesional de Ciencias
-- Económicas de la Ciudad Autónoma de Buenos Aires".
CREATE TABLE norm_adoptions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  norm_version_id uuid NOT NULL REFERENCES norm_versions (id),
  jurisdiction    text NOT NULL,
  adopting_body   text NOT NULL,
  adoption_act    text NOT NULL,
  valid_from      date NOT NULL,
  valid_to        date,
  -- Algunos consejos admiten aplicación anticipada anclada al CIERRE del
  -- ejercicio y no a su inicio (CPCECABA: ejercicios finalizados desde 30/09/2024).
  early_from      date,
  early_anchor    text CHECK (early_anchor IN ('INICIO_EJERCICIO', 'CIERRE_EJERCICIO')),
  evidence_document_id uuid REFERENCES norm_documents (id),
  UNIQUE (norm_version_id, jurisdiction)
);

-- ---------------------------------------------------------------------------
-- Reglas
-- ---------------------------------------------------------------------------
CREATE TABLE accounting_rules (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  rule_key        text NOT NULL,
  version         integer NOT NULL CHECK (version > 0),

  -- NOT NULL: no existe regla sin norma. Es la implementación del ADR-005.
  norm_version_id uuid NOT NULL REFERENCES norm_versions (id),

  domain          text NOT NULL CHECK (domain IN ('accounting', 'tax', 'disclosure')),
  valid_from      date NOT NULL,
  valid_to        date,
  jurisdiction    text NOT NULL,
  entity_types    text[] NOT NULL DEFAULT '{}',
  frameworks      text[] NOT NULL DEFAULT '{}',
  priority        integer NOT NULL DEFAULT 100,

  -- AST declarativo evaluado por un intérprete cerrado. NUNCA código ejecutable:
  -- una regla no puede hacer red ni tocar el sistema de archivos.
  conditions      jsonb NOT NULL,
  action          jsonb NOT NULL,

  status          text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT', 'IN_REVIEW', 'ACTIVE', 'SUPERSEDED')),
  proposed_by     text,
  approved_by     text,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (rule_key, version),

  -- CANDADO — ninguna regla llega a ACTIVE sin firma. Es el §32 del pliego.
  CONSTRAINT rule_active_requires_approval
    CHECK (status <> 'ACTIVE' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),

  -- Separación de funciones: quien propone no puede ser quien aprueba.
  CONSTRAINT rule_segregation_of_duties
    CHECK (approved_by IS NULL OR proposed_by IS NULL OR approved_by <> proposed_by),

  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX accounting_rules_resolution_idx
  ON accounting_rules (domain, jurisdiction, valid_from, valid_to)
  WHERE status = 'ACTIVE';

-- CANDADO — una regla ACTIVE solo puede apoyarse en una norma nivel V1 con
-- documento archivado. Si la fuente no es verificable, la regla no se aplica:
-- el motor devuelve FUENTE NO ENCONTRADA (§30).
CREATE OR REPLACE FUNCTION assert_rule_source_verified() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  level text;
  doc_count integer;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT v.verification_level, count(d.id)
    INTO level, doc_count
    FROM norm_versions v
    LEFT JOIN norm_documents d ON d.norm_version_id = v.id
   WHERE v.id = NEW.norm_version_id
   GROUP BY v.verification_level;

  IF level IS DISTINCT FROM 'V1' THEN
    RAISE EXCEPTION 'La regla % no puede activarse: su norma está en nivel % (se requiere V1)',
      NEW.rule_key, COALESCE(level, 'inexistente')
      USING ERRCODE = 'check_violation';
  END IF;

  IF doc_count = 0 THEN
    RAISE EXCEPTION 'La regla % no puede activarse: la norma no tiene documento original archivado',
      NEW.rule_key
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rules_source_verified
  BEFORE INSERT OR UPDATE ON accounting_rules
  FOR EACH ROW EXECUTE FUNCTION assert_rule_source_verified();

CREATE TABLE rule_applications (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),
  rule_id      uuid NOT NULL REFERENCES accounting_rules (id),
  rule_version integer NOT NULL,
  target_type  text NOT NULL,
  target_id    uuid NOT NULL,
  entry_id     uuid REFERENCES journal_entries (id),
  inputs       jsonb NOT NULL,
  outputs      jsonb NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rule_applications_target_idx ON rule_applications (company_id, target_type, target_id);

CREATE TABLE normative_conflicts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  rule_a_id   uuid REFERENCES accounting_rules (id),
  rule_b_id   uuid REFERENCES accounting_rules (id),
  context     jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'ABIERTO' CHECK (status IN ('ABIERTO', 'RESUELTO', 'DESCARTADO')),
  resolution  text,
  resolved_by text
);

CREATE TABLE normative_updates (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  source      text NOT NULL,
  raw_ref     text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'DETECTADA' CHECK (status IN
                ('DETECTADA', 'DESCARGADA', 'ANALIZADA', 'EN_REVISION', 'APROBADA', 'RECHAZADA')),
  norm_version_id uuid REFERENCES norm_versions (id),
  impact      jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  UNIQUE (source, raw_ref)
);

-- Gaps declarados: el motor los expone en vez de fingir cobertura.
CREATE TABLE normative_gaps (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  topic       text NOT NULL UNIQUE,
  description text NOT NULL,
  blocks      text NOT NULL,
  status      text NOT NULL DEFAULT 'ABIERTO' CHECK (status IN ('ABIERTO', 'CERRADO')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

INSERT INTO normative_gaps (topic, description, blocks) VALUES
  ('adopcion_no_caba',
   'No están relevados los actos de adopción de las RT por consejos profesionales fuera de CABA',
   'Resolución normativa para empresas de otras jurisdicciones'),
  ('ajuste_por_inflacion',
   'Régimen de ajuste por inflación contable y fiscal no relevado con fuente oficial',
   'Reexpresión en moneda homogénea'),
  ('percepciones_retenciones',
   'Regímenes de percepciones y retenciones no relevados por régimen y jurisdicción',
   'Módulo de retenciones y percepciones'),
  ('ingresos_brutos',
   'Normativa provincial de IIBB y Convenio Multilateral no relevada',
   'Liquidación de IIBB'),
  ('rg_facturacion_to',
   'Textos ordenados de RG 1415, 3561, 4291 y 5198 no descargados',
   'Reglas finas de validación de comprobantes');
