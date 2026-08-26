-- 0023_financial_statements.sql — ESP y ER con plantilla versionada.
--
-- El criterio de la FASE 10 es "dos empresas con marcos distintos generan
-- estructuras distintas SIN CAMBIAR CÓDIGO; todo renglón tiene lineage no nulo".
--
-- Las dos mitades están acá:
--
--   * `statement_templates.structure jsonb` — la estructura es un dato. Agregar
--     un marco es insertar una fila, no escribir un módulo.
--   * `financial_statement_lines.lineage jsonb NOT NULL` + un CHECK que exige que
--     sea un array — un renglón sin origen no se puede insertar.
--
-- Y una tercera que no está en el criterio y hace falta igual:
--
--   * `statement_templates.norm_version_id NOT NULL` — la estructura de un ESP
--     no es una decisión de producto. Sale de la Ley 19.550 arts. 63 y 64 (o de
--     la RT que corresponda), y la plantilla tiene que decir de cuál.

-- ---------------------------------------------------------------------------
-- Plantillas
-- ---------------------------------------------------------------------------
CREATE TABLE statement_templates (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  -- `NULL` = plantilla del sistema, disponible para todas las empresas. Una
  -- empresa puede tener la suya, y entonces esta columna la identifica.
  company_id      uuid REFERENCES companies (id),
  statement_kind  text NOT NULL CHECK (statement_kind IN ('ESP', 'ER', 'EEPN', 'EFE')),
  framework       text NOT NULL
                    CHECK (framework IN ('RT_FACPCE', 'NIIF', 'NIIF_PYMES', 'ENTE_PEQUENO')),
  -- Los mismos valores que `companies.entity_type`. Si esta lista fuera más
  -- corta, habría tipos de ente que la base admite y para los que no se podría
  -- cargar plantilla — y el motor respondería "no hay plantilla" para entes
  -- perfectamente normales.
  entity_type     text NOT NULL CHECK (entity_type IN (
                    'SA', 'SA_299', 'SRL', 'SAS', 'SOCIEDAD_SIMPLE',
                    'ASOC_CIVIL', 'FUNDACION', 'COOPERATIVA', 'MUTUAL',
                    'SUCURSAL_EXTRANJERA', 'UNIPERSONAL', 'FIDEICOMISO')),
  -- `companies.regulator` es nullable; acá el "sin organismo" es un valor.
  regulator       text NOT NULL
                    CHECK (regulator IN ('IGJ', 'CNV', 'BCRA', 'INAES', 'PROVINCIAL', 'NINGUNO')),
  version         integer NOT NULL CHECK (version > 0),
  valid_from      date NOT NULL,
  valid_to        date,
  -- El árbol de rubros, renglones y totales. Lo valida `validarPlantilla()`
  -- antes de cada uso: viene de la base y no se puede confiar en que esté bien
  -- formado, igual que las condiciones del motor normativo.
  structure       jsonb NOT NULL,
  -- De dónde sale la estructura. La columna es la razón por la que hoy esta
  -- tabla está vacía: la Ley 19.550 no está sembrada.
  norm_version_id uuid NOT NULL REFERENCES norm_versions (id),
  articulo        text NOT NULL CHECK (length(btrim(articulo)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,

  CONSTRAINT tpl_rango CHECK (valid_to IS NULL OR valid_from <= valid_to),
  -- Un `structure` que no sea un array de nodos no es un árbol.
  CONSTRAINT tpl_structure_es_array CHECK (jsonb_typeof(structure) = 'array')
);

-- Una sola versión por combinación. Dos plantillas vigentes para el mismo marco,
-- ente, regulador y tipo de estado son dos estructuras distintas para el mismo
-- balance, y el motor tendría que elegir.
CREATE UNIQUE INDEX statement_templates_version_unica
  ON statement_templates (
    COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    statement_kind, framework, entity_type, regulator, version
  );

-- Una plantilla publicada no se reescribe: se cierra con `valid_to` y se carga la
-- siguiente versión. Reescribirla cambiaría todos los estados ya emitidos con
-- ella — el §6 aplicado a la presentación.
CREATE OR REPLACE FUNCTION forbid_template_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.structure IS DISTINCT FROM OLD.structure
  OR NEW.version IS DISTINCT FROM OLD.version
  OR NEW.norm_version_id IS DISTINCT FROM OLD.norm_version_id THEN
    RAISE EXCEPTION 'Una plantilla publicada no se reescribe: cerrala con valid_to y cargá la versión siguiente. Reescribirla cambiaría los estados ya emitidos con ella.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER statement_templates_no_rewrite BEFORE UPDATE ON statement_templates
  FOR EACH ROW EXECUTE FUNCTION forbid_template_rewrite();

CREATE TRIGGER statement_templates_no_delete BEFORE DELETE ON statement_templates
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Estados emitidos
-- ---------------------------------------------------------------------------
CREATE TABLE financial_statements (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  fiscal_year_id      uuid NOT NULL REFERENCES fiscal_years (id),
  template_id         uuid NOT NULL REFERENCES statement_templates (id),
  statement_kind      text NOT NULL CHECK (statement_kind IN ('ESP', 'ER', 'EEPN', 'EFE')),
  comparative_year_id uuid REFERENCES fiscal_years (id),
  fecha_cierre        date NOT NULL,
  status              text NOT NULL DEFAULT 'BORRADOR'
                        CHECK (status IN ('BORRADOR', 'EMITIDO', 'ANULADO')),
  -- Resultado de los controles del motor. Se guarda entero, no un booleano: el
  -- detalle de qué falló es lo que sirve seis meses después.
  controles           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Hash del contenido canónico, igual que en `book_emissions`.
  content_sha256      char(64),
  issued_at           timestamptz,
  issued_by           text,
  anulado_motivo      text,

  -- Un estado contable EMITIDO afirma la situación patrimonial. Si los controles
  -- no pasan, la afirmación es falsa y no se emite.
  --
  -- Es la diferencia con el Libro Diario, que sí se emite con observaciones: el
  -- Diario registra lo que pasó y un hueco hay que poder verlo; el estado
  -- contable afirma, y una afirmación que no cierra no se firma.
  CONSTRAINT fs_emitido_firmado
    CHECK (status <> 'EMITIDO'
           OR (issued_by IS NOT NULL AND issued_at IS NOT NULL AND content_sha256 IS NOT NULL)),

  CONSTRAINT fs_anulado_justificado
    CHECK (status <> 'ANULADO' OR length(btrim(coalesce(anulado_motivo, ''))) > 0)
);

CREATE INDEX financial_statements_company_idx
  ON financial_statements (company_id, fiscal_year_id, statement_kind);

-- Un solo estado vigente por ejercicio y tipo. Los ANULADO quedan afuera del
-- índice: se acumulan, que es el punto —cada emisión corregida deja a la vista la
-- que reemplazó, igual que un contraasiento deja el asiento anulado.
CREATE UNIQUE INDEX financial_statements_vigente_unico
  ON financial_statements (company_id, fiscal_year_id, statement_kind)
  WHERE status <> 'ANULADO';

CREATE TRIGGER financial_statements_no_delete BEFORE DELETE ON financial_statements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE financial_statement_lines (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  statement_id       uuid NOT NULL REFERENCES financial_statements (id),
  orden              integer NOT NULL CHECK (orden > 0),
  line_code          text NOT NULL,
  label              text NOT NULL,
  line_type          text NOT NULL CHECK (line_type IN ('RUBRO', 'RENGLON', 'TOTAL')),
  nivel              integer NOT NULL CHECK (nivel BETWEEN 1 AND 6),
  amount             numeric(18, 2) NOT NULL,
  comparative_amount numeric(18, 2),
  note_ref           integer,
  fundamento         text,

  -- EL INVARIANTE DE LA FASE.
  --
  -- Las cuentas que formaron este renglón, con su aporte. Un array vacío es
  -- legítimo —un rubro sin cuentas existe y vale cero— pero tiene que estar: la
  -- diferencia entre "se preguntó y no hubo cuentas" y "alguien escribió un
  -- número" es exactamente lo que el §38 protege.
  --
  -- No es un `uuid` a una tabla de linaje sino el detalle embebido, porque el
  -- estado emitido tiene que poder reproducirse aunque el plan de cuentas cambie
  -- después. Un FK a `accounts` diría qué cuenta es hoy; esto dice cuál era.
  lineage            jsonb NOT NULL,

  UNIQUE (statement_id, line_code),
  CONSTRAINT fsl_lineage_es_array CHECK (jsonb_typeof(lineage) = 'array'),
  -- Un RENGLON con importe distinto de cero y linaje vacío es una cifra sin
  -- origen. Los RUBRO y TOTAL sí pueden tenerlo vacío: su importe sale de sus
  -- hijos, y el linaje se arma por unión.
  CONSTRAINT fsl_renglon_con_origen
    CHECK (line_type <> 'RENGLON' OR amount = 0 OR jsonb_array_length(lineage) > 0)
);

CREATE INDEX financial_statement_lines_statement_idx
  ON financial_statement_lines (statement_id, orden);

CREATE TRIGGER fsl_no_delete BEFORE DELETE ON financial_statement_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Un estado emitido es inmutable. Se corrige emitiendo otro, igual que un
-- asiento se corrige con un contraasiento.
CREATE OR REPLACE FUNCTION forbid_line_change_when_issued() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  estado text;
BEGIN
  SELECT status INTO estado
    FROM financial_statements WHERE id = COALESCE(NEW.statement_id, OLD.statement_id);
  IF estado = 'EMITIDO' THEN
    RAISE EXCEPTION 'El estado contable está EMITIDO: sus renglones son inmutables. Anulalo con motivo y emití otro.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fsl_immutable_when_issued
  BEFORE INSERT OR UPDATE ON financial_statement_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_line_change_when_issued();

-- ---------------------------------------------------------------------------
-- RLS y privilegios
-- ---------------------------------------------------------------------------
DO $rls$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY['financial_statements', 'financial_statement_lines'];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, scoped_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO aai_app', scoped_table);
  END LOOP;
END
$rls$;

-- Las plantillas del sistema son visibles para todas las empresas; las propias,
-- solo para la suya. Mismo patrón que `account_charts`.
ALTER TABLE statement_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statement_templates
  USING (company_id IS NULL OR company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- Cargar una plantilla del sistema exige credenciales de migración: es normativa
-- transcripta, como las alícuotas y las normas.
GRANT SELECT ON statement_templates TO aai_app;
REVOKE INSERT, UPDATE ON statement_templates FROM aai_app;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('statement:read', 'Ver los estados contables'),
  ('statement:issue', 'Emitir los estados contables del ejercicio');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code IN ('statement:read', 'statement:issue');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('AUDITOR', 'ADMINISTRADOR', 'CARGADOR') AND p.code = 'statement:read';

-- El mismo control que se agregó en la 0022: un INSERT ... SELECT que no
-- encuentra el rol inserta cero filas y aplica sin error.
DO $verificar$
DECLARE
  faltante text;
BEGIN
  SELECT string_agg(esperado.code, ', ')
    INTO faltante
    FROM (VALUES ('CONTADOR'), ('AUDITOR'), ('ADMINISTRADOR'), ('CARGADOR')) AS esperado(code)
   WHERE NOT EXISTS (
     SELECT 1 FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = esperado.code AND p.code = 'statement:read'
   );

  IF faltante IS NOT NULL THEN
    RAISE EXCEPTION 'Los roles % no recibieron statement:read.', faltante;
  END IF;
END
$verificar$;

-- ---------------------------------------------------------------------------
-- Trazabilidad: de la cifra del balance a la cuenta
-- ---------------------------------------------------------------------------
-- El punto 8 del MVP pide que cualquier cifra de los estados llegue al PDF
-- original. Esta vista es el primer tramo —renglón → cuenta—; de ahí en adelante
-- sigue `ledger_trace` de la 0019.
CREATE VIEW statement_trace AS
SELECT l.id            AS line_id,
       l.company_id,
       l.statement_id,
       l.line_code,
       l.label,
       l.amount,
       origen.value ->> 'accountId' AS account_id,
       origen.value ->> 'codigo'    AS account_code,
       origen.value ->> 'aporte'    AS aporte
  FROM financial_statement_lines l
  CROSS JOIN LATERAL jsonb_array_elements(l.lineage) AS origen(value);

GRANT SELECT ON statement_trace TO aai_app;

-- ---------------------------------------------------------------------------
-- Estado declarado
-- ---------------------------------------------------------------------------
-- `statement_templates` queda VACÍA. El motor y sus controles funcionan —hay 28
-- tests que lo prueban sobre plantillas de fixture— pero no se siembra ninguna
-- plantilla porque `norm_version_id` es NOT NULL y la Ley 19.550 no está
-- sembrada: su `fecha_emision` no surge del documento archivado, que solo da el
-- B.O. del Decreto 841/84 que ordenó el texto.
--
-- Es la misma regla que dejó afuera a otros 12 documentos en FASE 5b. Completar
-- la fecha con la de publicación sería afirmar un hecho que nadie verificó.
COMMENT ON TABLE statement_templates IS
  'Estructura de los estados contables, versionada y con su norma. VACÍA hasta sembrar la Ley 19.550: la estructura del ESP sale de sus arts. 63 y 64.';
