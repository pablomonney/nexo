-- 0016_documents.sql — documentos, extracción y duplicados (§9, §10).
--
-- Tres invariantes de este esquema, que no dependen de que la aplicación se
-- porte bien:
--
--   1. Un documento no se borra nunca (§38). Se anula con estado y motivo.
--   2. Una lectura extraída no se sobrescribe. La corrección del contador
--      **inserta** una fila con method = 'MANUAL'; la lectura original queda.
--   3. `raw_value`, `parsed_value`, `confidence` y `method` son columnas
--      separadas, no un jsonb. Son la exigencia del §10 y se consultan.

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  storage_key   text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes         bigint NOT NULL CHECK (bytes > 0),
  mime          text NOT NULL,
  content_type  text NOT NULL
                  CHECK (content_type IN ('PDF','JPEG','PNG','XML','CSV','XLSX')),
  original_name text NOT NULL,
  source        text NOT NULL CHECK (source IN ('UPLOAD','EMAIL','FOLDER','API')),
  status        text NOT NULL DEFAULT 'RECIBIDO'
                  CHECK (status IN ('RECIBIDO','EXTRAIDO','IMPUTADO','ANULADO','RECHAZADO')),
  -- Hallazgos del análisis del archivo: PDF con acciones, adjuntos embebidos.
  risk_flags    jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   text NOT NULL,
  voided_at     timestamptz,
  voided_by     text,
  void_reason   text,

  CHECK (status <> 'ANULADO' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);

-- El mismo archivo, subido dos veces, es un solo documento.
--
-- El índice es por empresa, no global: dos empresas pueden tener el mismo
-- comprobante —el mismo proveedor le factura a las dos— y unificarlos filtraría
-- información de un tercero. Se paga el duplicado en disco a cambio de eso.
CREATE UNIQUE INDEX documents_sha_por_empresa ON documents (company_id, sha256);

CREATE INDEX documents_recientes ON documents (company_id, received_at DESC);
CREATE INDEX documents_por_estado ON documents (company_id, status);

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Versiones
-- ---------------------------------------------------------------------------
-- Un documento reemplazado —el proveedor manda la factura corregida— conserva
-- las versiones anteriores. La vigente es la de mayor `version`.
CREATE TABLE document_versions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id  uuid NOT NULL REFERENCES companies (id),
  document_id uuid NOT NULL REFERENCES documents (id),
  version     integer NOT NULL CHECK (version >= 1),
  storage_key text NOT NULL,
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       bigint NOT NULL CHECK (bytes > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,
  motivo      text NOT NULL,

  UNIQUE (document_id, version)
);

CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Extracciones
-- ---------------------------------------------------------------------------
-- Un documento puede tener varias extracciones: la del motor de OCR, la de un
-- reproceso con otro motor, la del contador corrigiendo a mano. Ninguna pisa a
-- la anterior — comparar dos extracciones del mismo documento es cómo se mide
-- si un cambio de motor mejoró o empeoró.
CREATE TABLE document_extractions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  document_id    uuid NOT NULL REFERENCES documents (id),
  engine         text NOT NULL,
  engine_version text NOT NULL,
  -- `false` cuando no se pudo extraer. El motivo se guarda al lado: un
  -- documento sin campos por falta de motor no es un documento sin datos.
  available      boolean NOT NULL,
  unavailable_reason text
                  CHECK (unavailable_reason IS NULL OR unavailable_reason IN
                    ('SIN_MOTOR_OCR','TIPO_NO_SOPORTADO','MOTOR_FALLO','DOCUMENTO_ILEGIBLE')),
  overall_confidence numeric(5,4) CHECK (overall_confidence BETWEEN 0 AND 1),
  raw_payload    jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  created_by     text NOT NULL,

  -- No se puede declarar una extracción disponible sin decir con qué confianza,
  -- ni una no disponible sin decir por qué.
  CHECK (
    (available AND overall_confidence IS NOT NULL AND unavailable_reason IS NULL)
    OR (NOT available AND unavailable_reason IS NOT NULL)
  )
);

CREATE INDEX document_extractions_por_documento
  ON document_extractions (document_id, started_at DESC);

CREATE TRIGGER document_extractions_no_delete BEFORE DELETE ON document_extractions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Campos extraídos — las cuatro dimensiones del §10
-- ---------------------------------------------------------------------------
CREATE TABLE document_extraction_fields (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  extraction_id uuid NOT NULL REFERENCES document_extractions (id),
  field_path    text NOT NULL,

  -- (1) Lo que decía el documento, literal. NULL solo si el campo no apareció.
  raw_value     text,
  -- (2) Cómo lo interpretó el sistema. NULL cuando no se pudo interpretar:
  --     el `raw_value` se conserva igual, junto con la nota que explica por qué.
  parsed_value  jsonb,
  -- (3) Cuánto vale esa lectura, ya acotada por el techo del método.
  confidence    numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- (4) Quién la produjo.
  method        text NOT NULL CHECK (method IN ('OCR','XML','REGEX','LLM','MANUAL')),

  page          integer CHECK (page IS NULL OR page >= 1),
  bbox          jsonb,
  nota          text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Un campo interpretado sin valor leído no puede existir: algo se leyó.
  CHECK (parsed_value IS NULL OR raw_value IS NOT NULL),
  -- Sin lectura no hay confianza que reportar.
  CHECK (raw_value IS NOT NULL OR confidence = 0),
  -- Solo un dato estructurado o una corrección humana llegan a 1.
  CHECK (confidence < 1 OR method IN ('XML','MANUAL')),

  UNIQUE (extraction_id, field_path, method)
);

CREATE INDEX document_extraction_fields_por_extraccion
  ON document_extraction_fields (extraction_id, field_path);

-- Para buscar comprobantes por lo que se leyó, sin abrir el archivo.
CREATE INDEX document_extraction_fields_por_valor
  ON document_extraction_fields (company_id, field_path, raw_value);

CREATE TRIGGER document_extraction_fields_no_delete
  BEFORE DELETE ON document_extraction_fields
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Una lectura no se corrige: se agrega la corrección.
--
-- Sin esto, un UPDATE dejaría el sistema diciendo que el OCR leyó lo que en
-- realidad escribió una persona a mano — y la métrica de calidad de extracción
-- mediría, sin que nadie lo note, el trabajo del contador.
CREATE OR REPLACE FUNCTION forbid_update_extraction_field() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Las lecturas extraídas son inmutables. Para corregir un campo, insertá una fila con method = MANUAL.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_extraction_fields_no_update
  BEFORE UPDATE ON document_extraction_fields
  FOR EACH ROW EXECUTE FUNCTION forbid_update_extraction_field();

-- ---------------------------------------------------------------------------
-- Hallazgos de coherencia
-- ---------------------------------------------------------------------------
CREATE TABLE document_findings (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  extraction_id uuid NOT NULL REFERENCES document_extractions (id),
  codigo        text NOT NULL,
  severidad     text NOT NULL CHECK (severidad IN ('ERROR','ADVERTENCIA','INFO')),
  mensaje       text NOT NULL,
  campos        text[] NOT NULL DEFAULT '{}',
  bloquea       boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_findings_bloqueantes
  ON document_findings (company_id, bloquea, created_at DESC);

-- ---------------------------------------------------------------------------
-- Duplicados
-- ---------------------------------------------------------------------------
-- El vínculo se registra; ningún documento se descarta. Que el sistema haya
-- detectado un duplicado es información que el contador necesita ver, y que un
-- auditor puede pedir.
CREATE TABLE document_duplicates (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  document_id      uuid NOT NULL REFERENCES documents (id),
  duplicate_of_id  uuid NOT NULL REFERENCES documents (id),
  nivel            text NOT NULL
                     CHECK (nivel IN ('ARCHIVO_IDENTICO','COMPROBANTE_REPETIDO','POSIBLE_DUPLICADO')),
  explicacion      text NOT NULL,
  bloquea          boolean NOT NULL,
  -- Qué decidió la persona. Mientras sea NULL, el documento no se imputa solo.
  resolucion       text CHECK (resolucion IN ('ES_DUPLICADO','NO_ES_DUPLICADO')),
  resuelto_por     text,
  resuelto_en      timestamptz,
  motivo           text,
  detected_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (document_id <> duplicate_of_id),
  CHECK (resolucion IS NULL OR (resuelto_por IS NOT NULL AND motivo IS NOT NULL)),
  UNIQUE (document_id, duplicate_of_id, nivel)
);

CREATE INDEX document_duplicates_pendientes
  ON document_duplicates (company_id, bloquea) WHERE resolucion IS NULL;

CREATE TRIGGER document_duplicates_no_delete BEFORE DELETE ON document_duplicates
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Catálogo de tipos de comprobante
-- ---------------------------------------------------------------------------
-- Hallazgo de FASE 3b: ARCA no publica esta tabla como constante. Publica el
-- método para pedirla (`FEParamGetTiposCbte`, `ComprobantesTipoConsultar`) y
-- cada entrada trae `FchDesde` y `FchHasta`.
--
-- O sea: es normativa versionada en el tiempo. Por eso vive en una tabla con
-- vigencias y no en un `Record` del código: un comprobante de 2019 tiene que
-- interpretarse con la tabla de 2019 (§6).
--
-- No lleva `company_id`: es un catálogo del organismo, igual para todos.
CREATE TABLE arca_comprobante_types (
  codigo        integer PRIMARY KEY,
  descripcion   text NOT NULL,
  letra         text CHECK (letra IS NULL OR letra IN ('A','B','C','E','M')),
  clase         text,
  valid_from    date,
  valid_to      date,
  -- De dónde salió esta fila: documento archivado o sincronización del servicio.
  fuente        text NOT NULL,
  verification_level text NOT NULL DEFAULT 'V1'
                  CHECK (verification_level IN ('V1','V2','V3','V4')),
  -- `false` mientras la vigencia por fecha no se haya resuelto contra el
  -- organismo. La semilla transcripta del manual entra así.
  vigencia_verificada boolean NOT NULL DEFAULT false,
  synced_at     timestamptz,

  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'documents', 'document_versions', 'document_extractions',
    'document_extraction_fields', 'document_findings', 'document_duplicates'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON
  documents, document_versions, document_extractions, document_findings, document_duplicates
  TO aai_app;

-- Sin UPDATE: el trigger ya lo prohíbe, pero el permiso tampoco se otorga.
GRANT SELECT, INSERT ON document_extraction_fields TO aai_app;

GRANT SELECT ON arca_comprobante_types TO aai_app;

-- ---------------------------------------------------------------------------
-- Vista de trabajo del contador
-- ---------------------------------------------------------------------------
-- Un documento con su última extracción y si hay algo que lo frena. Es la
-- consulta que hace la bandeja de revisión, y se resuelve en una sola pasada.
CREATE VIEW documents_pendientes AS
SELECT d.id,
       d.company_id,
       d.original_name,
       d.content_type,
       d.status,
       d.received_at,
       e.id            AS extraction_id,
       e.engine,
       e.available     AS extraccion_disponible,
       e.unavailable_reason,
       e.overall_confidence,
       EXISTS (
         SELECT 1 FROM document_findings f
          WHERE f.extraction_id = e.id AND f.bloquea
       ) AS tiene_hallazgo_bloqueante,
       EXISTS (
         SELECT 1 FROM document_duplicates dup
          WHERE dup.document_id = d.id AND dup.bloquea AND dup.resolucion IS NULL
       ) AS tiene_duplicado_sin_resolver
  FROM documents d
  LEFT JOIN LATERAL (
    SELECT * FROM document_extractions e2
     WHERE e2.document_id = d.id
     ORDER BY e2.started_at DESC
     LIMIT 1
  ) e ON true
 WHERE d.status NOT IN ('ANULADO', 'IMPUTADO');

GRANT SELECT ON documents_pendientes TO aai_app;
