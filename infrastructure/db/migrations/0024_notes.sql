-- 0024_notes.sql — notas complementarias.
--
-- Fuente: Ley 19.550 (T.O. 1984) art. 65 — las notas y cuadros "se considerarán
-- parte" de los estados contables.
--
-- El criterio de la FASE 11 es el invariante A-2 de AUDIT_TRAIL.md: *no existe
-- cifra en nota sin respaldo*. La forma de garantizarlo no es validarlo al
-- guardar sino **no tener dónde escribir un número suelto**:
--
--   note_figures.statement_line_id  uuid NOT NULL REFERENCES financial_statement_lines
--
-- Una cifra de nota no lleva su propio importe: apunta al renglón del estado, y
-- de ahí salen el importe y el linaje. La columna `amount` existe para poder
-- reproducir la nota tal como se emitió, y un trigger verifica que coincida con
-- el renglón mientras el estado siga en borrador.

CREATE TABLE notes (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  statement_id   uuid NOT NULL REFERENCES financial_statements (id),
  numero         integer NOT NULL CHECK (numero > 0),
  titulo         text NOT NULL CHECK (length(btrim(titulo)) > 0),
  -- Bloques de texto y cuadros. El texto es una afirmación profesional; el
  -- sistema arma la estructura y pega las cifras.
  body_blocks    jsonb NOT NULL DEFAULT '[]'::jsonb,
  fundamento     text NOT NULL DEFAULT 'Ley 19.550 (T.O. 1984), art. 65',
  -- Quién escribió el texto. `AI` es un borrador: no puede llegar a un estado
  -- emitido sin que una persona lo haga suyo (§42).
  generated_by   text NOT NULL DEFAULT 'HUMAN' CHECK (generated_by IN ('RULE', 'AI', 'HUMAN')),
  status         text NOT NULL DEFAULT 'BORRADOR'
                   CHECK (status IN ('BORRADOR', 'APROBADA')),
  approved_by    text,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (statement_id, numero),

  CONSTRAINT notes_aprobada_firmada
    CHECK (status <> 'APROBADA' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),

  -- §42: una nota redactada por IA no queda aprobada sin firma humana. Es el
  -- mismo candado que `je_ai_requires_human_approval` en el Diario.
  CONSTRAINT notes_ai_requires_human
    CHECK (generated_by <> 'AI' OR status = 'BORRADOR' OR approved_by IS NOT NULL)
);

CREATE INDEX notes_statement_idx ON notes (statement_id, numero);

CREATE TRIGGER notes_no_delete BEFORE DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Las cifras: el invariante A-2
-- ---------------------------------------------------------------------------
CREATE TABLE note_figures (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  note_id           uuid NOT NULL REFERENCES notes (id),
  orden             integer NOT NULL CHECK (orden > 0),
  label             text NOT NULL,

  -- EL INVARIANTE. Una cifra de nota apunta a un renglón del estado; no existe
  -- forma de que lleve un importe suyo sin respaldo detrás.
  statement_line_id uuid NOT NULL REFERENCES financial_statement_lines (id),

  -- Copia del importe al momento de emitir, para reproducir la nota. El trigger
  -- de abajo verifica que coincida mientras el estado sea borrador.
  amount            numeric(18, 2) NOT NULL,
  comparative_amount numeric(18, 2),

  -- El linaje heredado del renglón. Redundante con el del renglón a propósito:
  -- una nota emitida tiene que poder leerse sin depender de que el estado siga
  -- existiendo con la misma estructura.
  lineage           jsonb NOT NULL,

  UNIQUE (note_id, orden),
  CONSTRAINT nf_lineage_es_array CHECK (jsonb_typeof(lineage) = 'array'),
  CONSTRAINT nf_con_origen CHECK (amount = 0 OR jsonb_array_length(lineage) > 0)
);

CREATE INDEX note_figures_note_idx ON note_figures (note_id, orden);
CREATE INDEX note_figures_line_idx ON note_figures (statement_line_id);

CREATE TRIGGER note_figures_no_delete BEFORE DELETE ON note_figures
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- El importe de la cifra tiene que ser el del renglón. No se copia y se olvida:
-- una nota que dice un número distinto del estado del que sale es peor que una
-- nota sin cifras.
CREATE OR REPLACE FUNCTION assert_note_figure_matches_line() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linea financial_statement_lines%ROWTYPE;
BEGIN
  SELECT * INTO linea FROM financial_statement_lines WHERE id = NEW.statement_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cifra apunta a un renglón que no existe' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.amount <> linea.amount THEN
    RAISE EXCEPTION 'La nota dice % y el renglón % dice %. Una nota que informa un número distinto del estado del que sale es peor que una nota sin cifras.',
      NEW.amount, linea.line_code, linea.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER note_figures_match_line
  BEFORE INSERT OR UPDATE ON note_figures
  FOR EACH ROW EXECUTE FUNCTION assert_note_figure_matches_line();

-- ---------------------------------------------------------------------------
-- RLS y permisos
-- ---------------------------------------------------------------------------
DO $rls$
DECLARE
  scoped_table text;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY['notes', 'note_figures'] LOOP
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

INSERT INTO permissions (code, description) VALUES
  ('note:write', 'Redactar y aprobar notas complementarias');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code = 'note:write';

DO $verificar$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r.code = 'CONTADOR' AND p.code = 'note:write'
  ) THEN
    RAISE EXCEPTION 'El rol CONTADOR no recibió note:write.';
  END IF;
END
$verificar$;

-- ---------------------------------------------------------------------------
-- Trazabilidad: de la cifra de la nota a las cuentas
-- ---------------------------------------------------------------------------
CREATE VIEW note_trace AS
SELECT f.id              AS figure_id,
       f.company_id,
       n.id              AS note_id,
       n.numero          AS nota,
       n.titulo,
       f.label,
       f.amount,
       l.id              AS statement_line_id,
       l.line_code,
       l.label           AS renglon,
       origen.value ->> 'accountId' AS account_id,
       origen.value ->> 'codigo'    AS account_code,
       origen.value ->> 'aporte'    AS aporte
  FROM note_figures f
  JOIN notes n ON n.id = f.note_id
  JOIN financial_statement_lines l ON l.id = f.statement_line_id
  CROSS JOIN LATERAL jsonb_array_elements(f.lineage) AS origen(value);

GRANT SELECT ON note_trace TO aai_app;
