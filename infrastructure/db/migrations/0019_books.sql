-- 0019_books.sql — Libro Diario y Libro Mayor como libros, no como reportes.
--
-- La diferencia importa. Un reporte se vuelve a correr y da otra cosa si los
-- datos cambiaron; un libro tiene que poder reproducirse idéntico años después
-- (CCyC art. 328: diez años desde el último asiento).
--
-- Fuente oficial de los controles de este archivo:
--   Ley 26.994 — Código Civil y Comercial de la Nación, arts. 320 a 331.
--   Archivada en docs/normative-sources/originals/SAIJ_CCyC_Ley_26994.pdf
--   con su sha256 en checksums.sha256.
--
-- Tres decisiones que este archivo fija:
--
--   1. El Mayor NO es una tabla que la aplicación escribe. Lo escribe un trigger
--      a partir del Diario, y a la aplicación se le revoca el INSERT. Una
--      proyección que se puede escribir a mano deja de ser una proyección.
--   2. Un movimiento del Mayor no se borra nunca, ni cuando el asiento se anula.
--      El contraasiento ya lo compensa; borrarlo además sería contarlo dos veces
--      —y borrar es exactamente lo que el art. 324 inc. c prohíbe.
--   3. Emitir un libro deja rastro con hash. Sin eso, "este es el Diario que
--      presenté en 2026" no es una afirmación verificable.

-- ---------------------------------------------------------------------------
-- El Mayor se escribe solo, desde el Diario
-- ---------------------------------------------------------------------------
-- Corre diferido al COMMIT por la misma razón que je_entry_consistent: cuando se
-- inserta la cabecera todavía no hay líneas.
--
-- SECURITY DEFINER porque abajo se le revoca a aai_app el INSERT sobre
-- ledger_movements. El trigger tiene que poder hacer lo que el llamador no.
CREATE OR REPLACE FUNCTION project_ledger_movements() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'APROBADO' THEN
    -- Un borrador o una propuesta no son contabilidad todavía. Y un asiento
    -- ANULADO conserva sus movimientos: lo compensa su contraasiento.
    RETURN NULL;
  END IF;

  INSERT INTO ledger_movements
    (company_id, account_id, period_id, entry_line_id, movement_date, debit, credit)
  SELECT l.company_id, l.account_id, NEW.period_id, l.id, NEW.entry_date, l.debit, l.credit
    FROM journal_entry_lines l
   WHERE l.entry_id = NEW.id
  ON CONFLICT (entry_line_id) DO NOTHING;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER je_project_ledger
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_ledger_movements();

-- ---------------------------------------------------------------------------
-- Backfill: los asientos que ya estaban aprobados antes de existir el trigger
-- ---------------------------------------------------------------------------
-- Una migración que crea una proyección y no la puebla deja la base en un estado
-- en el que el Mayor está incompleto y nada lo dice. El primer `ledger:verify`
-- lo encontraría como FALTA_EN_MAYOR, que es un hallazgo correcto pero
-- innecesario: el arreglo es acá y una sola vez.
--
-- Entran también los ANULADO. Un asiento anulado pasó por APROBADO, así que sus
-- movimientos existieron; lo que los compensa es el contraasiento (art. 324
-- inc. c), no su ausencia.
INSERT INTO ledger_movements
  (company_id, account_id, period_id, entry_line_id, movement_date, debit, credit)
SELECT l.company_id, l.account_id, e.period_id, l.id, e.entry_date, l.debit, l.credit
  FROM journal_entry_lines l
  JOIN journal_entries e ON e.id = l.entry_id
 WHERE e.status IN ('APROBADO', 'ANULADO')
ON CONFLICT (entry_line_id) DO NOTHING;

-- Nadie edita ni borra un movimiento del Mayor. Si el Diario cambió, el Mayor
-- cambia por el mismo camino por el que se escribió: un asiento nuevo.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'El Mayor es una proyección del Diario: no se edita ni se borra (% sobre ledger_movements). Corregí el asiento con un contraasiento.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_movements_immutable
  BEFORE UPDATE OR DELETE ON ledger_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

REVOKE INSERT, UPDATE ON ledger_movements FROM aai_app;
GRANT SELECT ON ledger_movements TO aai_app;

-- ---------------------------------------------------------------------------
-- Saldos por período: recalculados, nunca acumulados a mano
-- ---------------------------------------------------------------------------
-- El saldo inicial de un período es lo que la cuenta acumuló en todo lo
-- anterior. No hay una segunda fuente: el asiento de apertura del ejercicio está
-- en el Diario como cualquier otro, así que la primera vida de la empresa abre
-- en cero y todo lo demás se encadena.
--
-- Se recalcula entero en vez de mantenerse de a poco. Un acumulador que se
-- actualiza con cada asiento se desincroniza en silencio la primera vez que algo
-- falla a mitad de camino; recalcular es barato y no tiene ese modo de fallo.
CREATE OR REPLACE FUNCTION rebuild_account_balances(target_company uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
BEGIN
  DELETE FROM account_balances WHERE company_id = target_company;

  INSERT INTO account_balances (company_id, account_id, period_id, opening, debits, credits, closing)
  SELECT company_id, account_id, period_id, opening, debits, credits,
         opening + debits - credits
    FROM (
      SELECT m.company_id,
             m.account_id,
             m.period_id,
             COALESCE(sum(m.debit), 0)  AS debits,
             COALESCE(sum(m.credit), 0) AS credits,
             -- Saldo inicial = suma de todo lo movido en períodos anteriores.
             -- Se calcula como acumulado en vez de leer el período previo para
             -- que un período sin movimientos no corte la cadena.
             COALESCE((
               SELECT sum(prev.debit - prev.credit)
                 FROM ledger_movements prev
                 JOIN periods pp ON pp.id = prev.period_id
                WHERE prev.company_id = m.company_id
                  AND prev.account_id = m.account_id
                  AND pp.end_date < p.start_date
             ), 0) AS opening
        FROM ledger_movements m
        JOIN periods p ON p.id = m.period_id
       WHERE m.company_id = target_company
       GROUP BY m.company_id, m.account_id, m.period_id, p.start_date
    ) agrupado;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- account_balances lo escribe la función de arriba, no la aplicación.
REVOKE INSERT, UPDATE ON account_balances FROM aai_app;
GRANT SELECT ON account_balances TO aai_app;

-- ---------------------------------------------------------------------------
-- Verificaciones de reconstrucción
-- ---------------------------------------------------------------------------
-- El ACCOUNTING_ENGINE.md §7 promete que el Mayor se reconstruye desde el Diario
-- y se verifica que coincide. Esta tabla es donde esa promesa queda cumplida —o
-- incumplida— con fecha y nombre.
CREATE TABLE ledger_verifications (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  fiscal_year_id uuid REFERENCES fiscal_years (id),
  ran_at         timestamptz NOT NULL DEFAULT now(),
  ran_by         text NOT NULL,
  -- Cuántos movimientos comparó y cuántos no coincidieron.
  movimientos    integer NOT NULL CHECK (movimientos >= 0),
  discrepancias  integer NOT NULL CHECK (discrepancias >= 0),
  -- El detalle de cada discrepancia. Un contador en 3 no explica nada.
  detalle        jsonb NOT NULL DEFAULT '[]'::jsonb,
  resultado      text NOT NULL CHECK (resultado IN ('COINCIDE', 'DISCREPA')),

  CONSTRAINT lv_resultado_coherente
    CHECK ((resultado = 'COINCIDE') = (discrepancias = 0))
);

CREATE INDEX ledger_verifications_company_idx
  ON ledger_verifications (company_id, ran_at DESC);

CREATE TRIGGER ledger_verifications_no_delete BEFORE DELETE ON ledger_verifications
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Emisión de libros
-- ---------------------------------------------------------------------------
-- CCyC art. 329: llevar los libros por medios electrónicos requiere autorización
-- del Registro Público, y los medios alternativos deben ser equivalentes «en
-- cuanto a inviolabilidad, verosimilitud y completitud». El hash de lo emitido
-- es la parte de esa equivalencia que le toca al software.
--
-- Lo que NO hace esta tabla: afirmar que la empresa tiene esa autorización. Eso
-- es un hecho del expediente, no del sistema — por eso `autorizacion_registro`
-- es un dato que se carga, y su ausencia se imprime en el pie del libro.
CREATE TABLE book_emissions (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id            uuid NOT NULL REFERENCES companies (id),
  fiscal_year_id        uuid NOT NULL REFERENCES fiscal_years (id),
  book                  text NOT NULL CHECK (book IN ('DIARIO', 'MAYOR', 'SUMAS_Y_SALDOS')),
  -- Rango cubierto. Un libro sin rango explícito no se puede volver a pedir igual.
  desde                 date NOT NULL,
  hasta                 date NOT NULL,
  -- Hash del contenido canónico. Es lo que permite decir «este es el mismo
  -- Diario» sin comparar dos PDF hoja por hoja.
  content_sha256        char(64) NOT NULL,
  asientos              integer NOT NULL CHECK (asientos >= 0),
  -- Se guarda el resultado del control de forma, no solo el conteo: un Diario
  -- emitido con un hueco de numeración tiene que poder identificarse después.
  controles             jsonb NOT NULL DEFAULT '[]'::jsonb,
  cumple_formalidades   boolean NOT NULL,
  autorizacion_registro text,
  emitted_by            text NOT NULL,
  emitted_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT be_rango_valido CHECK (desde <= hasta)
);

CREATE INDEX book_emissions_company_idx
  ON book_emissions (company_id, book, emitted_at DESC);

-- Un libro emitido es un hecho pasado. No se corrige: se emite otro, y quedan
-- los dos.
CREATE OR REPLACE FUNCTION forbid_book_emission_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Una emisión de libro es un hecho registrado: no se modifica ni se borra. Emití de nuevo y quedan las dos.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER book_emissions_immutable
  BEFORE UPDATE OR DELETE ON book_emissions
  FOR EACH ROW EXECUTE FUNCTION forbid_book_emission_change();

ALTER TABLE ledger_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_verifications
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE book_emissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_emissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON book_emissions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT ON ledger_verifications TO aai_app;
REVOKE UPDATE ON ledger_verifications FROM aai_app;
GRANT SELECT, INSERT ON book_emissions TO aai_app;
REVOKE UPDATE ON book_emissions FROM aai_app;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('book:emit', 'Emitir el Libro Diario, el Mayor o el balance como libro firmado');

-- Emitir un libro es un acto del profesional, no de quien administra el sistema:
-- es él quien responde por lo que ese libro dice. Misma línea que trazó la 0011
-- con journal_entry:approve.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code = 'book:emit';

-- El auditor lee los libros emitidos (report:read, ya concedido) pero no emite.

-- ---------------------------------------------------------------------------
-- Vista de trazabilidad: del movimiento al documento, en un solo salto
-- ---------------------------------------------------------------------------
-- El punto 8 del MVP dice que cualquier número tiene que llegar al PDF original.
-- Esta vista es ese camino, escrito una vez, para que ninguna pantalla lo
-- reinvente con un JOIN propio y se le escape una punta.
CREATE VIEW ledger_trace AS
SELECT m.id                AS movement_id,
       m.company_id,
       m.account_id,
       a.code              AS account_code,
       a.name              AS account_name,
       m.movement_date,
       m.debit,
       m.credit,
       l.id                AS entry_line_id,
       l.line_no,
       l.description       AS line_description,
       e.id                AS entry_id,
       e.journal_code,
       e.entry_number,
       e.entry_date,
       e.description       AS entry_description,
       e.kind,
       e.status,
       e.source_type,
       e.source_id,
       e.ai_prediction_id,
       e.reverses_entry_id,
       d.id                AS document_id,
       d.original_name     AS document_name,
       d.sha256            AS document_sha256
  FROM ledger_movements m
  JOIN journal_entry_lines l ON l.id = m.entry_line_id
  JOIN journal_entries e     ON e.id = l.entry_id
  JOIN accounts a            ON a.id = m.account_id
  -- El JOIN se acota por source_type: un asiento MANUAL o de CIERRE no tiene
  -- documento detrás, y un `source_id` que coincidiera por casualidad con el id
  -- de un documento haría aparecer un respaldo que nunca existió.
  LEFT JOIN documents d      ON d.id = e.source_id
                            AND e.source_type IN ('INVOICE', 'RECEIPT', 'BANK');

GRANT SELECT ON ledger_trace TO aai_app;
