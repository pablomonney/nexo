-- 0005_journal.sql — Libro Diario. Los candados del §38 del pliego.
--
-- Este archivo es el corazón del sistema. Todo lo que sigue está pensado para que
-- el invariante "Debe = Haber" no dependa de que la aplicación esté libre de bugs:
-- un `psql` manual, un script de migración de datos o un ORM mal usado tampoco
-- pueden dejar un asiento descuadrado.

CREATE TABLE journal_entries (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  journal_code      text NOT NULL,
  period_id         uuid NOT NULL REFERENCES periods (id),
  fiscal_year_id    uuid NOT NULL REFERENCES fiscal_years (id),
  entry_number      integer NOT NULL CHECK (entry_number > 0),
  entry_date        date NOT NULL,
  description       text NOT NULL CHECK (length(btrim(description)) > 0),
  kind              text NOT NULL DEFAULT 'NORMAL'
                      CHECK (kind IN ('NORMAL', 'AJUSTE', 'APERTURA', 'CIERRE', 'REVERSION')),
  status            text NOT NULL DEFAULT 'BORRADOR'
                      CHECK (status IN ('BORRADOR', 'PROPUESTO', 'APROBADO', 'ANULADO')),
  currency          text NOT NULL DEFAULT 'ARS',
  total_debit       numeric(18, 2) NOT NULL CHECK (total_debit >= 0),
  total_credit      numeric(18, 2) NOT NULL CHECK (total_credit >= 0),
  source_type       text NOT NULL
                      CHECK (source_type IN ('INVOICE', 'RECEIPT', 'BANK', 'MANUAL', 'CLOSING')),
  source_id         uuid,
  reverses_entry_id uuid REFERENCES journal_entries (id),
  ai_prediction_id  uuid,
  manual_justification text,
  created_by        text NOT NULL,
  approved_by       text,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- CANDADO 1 — Debe = Haber en la cabecera. Se evalúa de inmediato.
  --
  -- PostgreSQL no admite CHECK diferido (solo UNIQUE, PK, FK y EXCLUDE pueden
  -- marcarse DEFERRABLE), y acá tampoco hace falta: los totales se conocen al
  -- insertar la cabecera. Lo que sí necesita diferirse es la coherencia entre
  -- estos totales y la suma real de las líneas, porque las líneas llegan después
  -- — y eso lo resuelve el CONSTRAINT TRIGGER `je_entry_consistent`, que sí puede
  -- ser DEFERRABLE. Los dos candados juntos cubren el invariante completo.
  CONSTRAINT je_balanced CHECK (total_debit = total_credit),

  -- Un asiento aprobado tiene aprobador y fecha de aprobación. Sin excepciones.
  CONSTRAINT je_approved_signed
    CHECK (status <> 'APROBADO' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),

  -- INVARIANTE A-6: ningún asiento creado por IA existe sin aprobación humana.
  -- Es la verificación mecánica de la promesa central del producto (ADR-001).
  CONSTRAINT je_ai_requires_human_approval
    CHECK (ai_prediction_id IS NULL OR status IN ('BORRADOR', 'PROPUESTO')
           OR approved_by IS NOT NULL),

  -- Una reversión referencia siempre al asiento que anula, y solo ella.
  CONSTRAINT je_reversal_target
    CHECK ((kind = 'REVERSION') = (reverses_entry_id IS NOT NULL)),

  UNIQUE (company_id, journal_code, fiscal_year_id, entry_number)
);

CREATE INDEX journal_entries_date_idx ON journal_entries (company_id, entry_date);
CREATE INDEX journal_entries_period_idx ON journal_entries (period_id);
CREATE INDEX journal_entries_source_idx ON journal_entries (company_id, source_type, source_id);

-- Un mismo comprobante no puede generar dos asientos vigentes (E_DUPLICATE_SOURCE).
CREATE UNIQUE INDEX journal_entries_unique_source
  ON journal_entries (company_id, source_type, source_id)
  WHERE source_id IS NOT NULL AND status IN ('PROPUESTO', 'APROBADO');

CREATE TABLE journal_entry_lines (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  entry_id            uuid NOT NULL REFERENCES journal_entries (id),
  line_no             integer NOT NULL CHECK (line_no > 0),
  account_id          uuid NOT NULL REFERENCES accounts (id),
  debit               numeric(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit              numeric(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency            text NOT NULL DEFAULT 'ARS',
  fx_rate             numeric(18, 6),
  fx_source           text,
  fx_date             date,
  cost_center_id      uuid REFERENCES cost_centers (id),
  party_id            uuid,
  description         text,
  tax_transaction_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- CANDADO 2 — una línea es débito o crédito. Ni ambos, ni ninguno.
  CONSTRAINT jel_one_side
    CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),

  -- E_MISSING_FX: si hay moneda extranjera, la cotización lleva fuente y fecha.
  -- La RG ARCA 5616/2024 exige consignar el tipo de cambio; sin fuente no es auditable.
  CONSTRAINT jel_fx_complete
    CHECK (currency = 'ARS' OR (fx_rate IS NOT NULL AND fx_source IS NOT NULL AND fx_date IS NOT NULL)),

  UNIQUE (entry_id, line_no)
);

CREATE INDEX jel_account_idx ON journal_entry_lines (company_id, account_id);
CREATE INDEX jel_entry_idx ON journal_entry_lines (entry_id);

-- ---------------------------------------------------------------------------
-- CANDADO 3 — mínimo dos líneas y totales que coinciden con la suma real
-- ---------------------------------------------------------------------------
-- Verifica al COMMIT que la cabecera no miente sobre sus propias líneas. Sin
-- esto, `total_debit = total_credit` se podría satisfacer con dos números
-- inventados y ninguna línea detrás.
CREATE OR REPLACE FUNCTION assert_entry_consistent() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
  entry journal_entries%ROWTYPE;
  line_count integer;
  sum_debit numeric(18, 2);
  sum_credit numeric(18, 2);
BEGIN
  -- El mismo trigger sirve para la cabecera y para las líneas; el campo que
  -- identifica al asiento no es el mismo en cada tabla.
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_id := NEW.id;
  ELSE
    target_id := NEW.entry_id;
  END IF;

  SELECT * INTO entry FROM journal_entries WHERE id = target_id;
  IF NOT FOUND THEN
    RETURN NULL;  -- el asiento ya no existe en esta transacción
  END IF;

  -- Un borrador todavía se está armando: se valida al proponerlo o aprobarlo.
  IF entry.status = 'BORRADOR' THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
    INTO line_count, sum_debit, sum_credit
    FROM journal_entry_lines
   WHERE entry_id = target_id;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'E_MIN_LINES: el asiento % tiene % línea(s); se requieren al menos 2',
      target_id, line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF sum_debit <> entry.total_debit OR sum_credit <> entry.total_credit THEN
    RAISE EXCEPTION 'E_UNBALANCED: la cabecera del asiento % declara (%, %) y sus líneas suman (%, %)',
      target_id, entry.total_debit, entry.total_credit, sum_debit, sum_credit
      USING ERRCODE = 'check_violation';
  END IF;

  IF sum_debit <> sum_credit THEN
    RAISE EXCEPTION 'E_UNBALANCED: el asiento % tiene Debe % y Haber %',
      target_id, sum_debit, sum_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER jel_entry_consistent
  AFTER INSERT OR UPDATE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_consistent();

CREATE CONSTRAINT TRIGGER je_entry_consistent
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_consistent();

-- ---------------------------------------------------------------------------
-- CANDADO 4 — período abierto y fecha dentro del período
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_period uuid;
  target_date date;
  period_row periods%ROWTYPE;
BEGIN
  -- El trigger corre BEFORE INSERT OR UPDATE, así que NEW siempre está asignado;
  -- OLD no lo está en INSERT y referenciarlo sería un error de ejecución.
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_period := NEW.period_id;
    target_date := NEW.entry_date;
  ELSE
    SELECT e.period_id, e.entry_date INTO target_period, target_date
      FROM journal_entries e
     WHERE e.id = NEW.entry_id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT * INTO period_row FROM periods WHERE id = target_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: período inexistente %', target_period
      USING ERRCODE = 'check_violation';
  END IF;

  IF period_row.status = 'CERRADO' THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: el período % está CERRADO. Registrá un ajuste en un período abierto o reabrí formalmente.',
      period_row.number
      USING ERRCODE = 'check_violation';
  END IF;

  -- BLOQUEADO admite solo asientos de cierre y ajuste.
  IF period_row.status = 'BLOQUEADO'
     AND TG_TABLE_NAME = 'journal_entries'
     AND NEW.kind NOT IN ('AJUSTE', 'CIERRE') THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: el período % está BLOQUEADO; solo admite asientos de AJUSTE o CIERRE',
      period_row.number
      USING ERRCODE = 'check_violation';
  END IF;

  IF target_date < period_row.start_date OR target_date > period_row.end_date THEN
    RAISE EXCEPTION 'E_DATE_OUT_OF_PERIOD: la fecha % cae fuera del período % (% a %)',
      target_date, period_row.number, period_row.start_date, period_row.end_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER je_period_guard
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

CREATE TRIGGER jel_period_guard
  BEFORE INSERT OR UPDATE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- ---------------------------------------------------------------------------
-- CANDADO 5 — un asiento aprobado es inmutable
-- ---------------------------------------------------------------------------
-- Se corrige por contraasiento (ADR-003), nunca reescribiendo la historia.
-- La única transición admitida desde APROBADO es a ANULADO, y exige que exista
-- la reversión.
CREATE OR REPLACE FUNCTION assert_approved_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'APROBADO' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'ANULADO' THEN
    IF NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = OLD.id) THEN
      RAISE EXCEPTION 'No se puede anular el asiento % sin su contraasiento', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Transición de estado inválida en el asiento %: % → %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.entry_date       IS DISTINCT FROM OLD.entry_date
  OR NEW.total_debit      IS DISTINCT FROM OLD.total_debit
  OR NEW.total_credit     IS DISTINCT FROM OLD.total_credit
  OR NEW.period_id        IS DISTINCT FROM OLD.period_id
  OR NEW.journal_code     IS DISTINCT FROM OLD.journal_code
  OR NEW.entry_number     IS DISTINCT FROM OLD.entry_number
  OR NEW.kind             IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'El asiento % está APROBADO: sus datos contables son inmutables. Usá un contraasiento.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER je_approved_immutable
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_approved_immutable();

-- Las líneas de un asiento aprobado no se tocan.
CREATE OR REPLACE FUNCTION assert_lines_mutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_status text;
BEGIN
  SELECT status INTO entry_status
    FROM journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);
  IF entry_status IN ('APROBADO', 'ANULADO') THEN
    RAISE EXCEPTION 'Las líneas del asiento % no se pueden modificar: está %',
      COALESCE(NEW.entry_id, OLD.entry_id), entry_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jel_immutable_when_approved
  BEFORE UPDATE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION assert_lines_mutable();

-- ---------------------------------------------------------------------------
-- CANDADO 6 — prohibido el borrado físico
-- ---------------------------------------------------------------------------
CREATE TRIGGER je_no_delete BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- En líneas se permite borrar solo mientras el asiento es BORRADOR.
CREATE OR REPLACE FUNCTION forbid_line_delete_unless_draft() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_status text;
BEGIN
  SELECT status INTO entry_status FROM journal_entries WHERE id = OLD.entry_id;
  IF entry_status IS DISTINCT FROM 'BORRADOR' THEN
    RAISE EXCEPTION 'Borrado prohibido: la línea pertenece a un asiento en estado %', entry_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER jel_no_delete BEFORE DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_line_delete_unless_draft();

-- ---------------------------------------------------------------------------
-- CANDADO 7 — la cuenta debe ser imputable y la dimensión obligatoria, presente
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_line_account_valid() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  acct accounts%ROWTYPE;
BEGIN
  SELECT * INTO acct FROM accounts WHERE id = NEW.account_id;

  IF acct.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'La cuenta % no pertenece a la empresa %', NEW.account_id, NEW.company_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT acct.is_postable OR acct.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'E_ACCOUNT_NOT_POSTABLE: la cuenta % (%) no admite imputación', acct.code, acct.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF acct.requires_cost_center AND NEW.cost_center_id IS NULL THEN
    RAISE EXCEPTION 'E_MISSING_DIMENSION: la cuenta % exige centro de costo', acct.code
      USING ERRCODE = 'check_violation';
  END IF;

  IF acct.requires_third_party AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION 'E_MISSING_DIMENSION: la cuenta % exige identificar el tercero', acct.code
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER jel_account_valid
  BEFORE INSERT OR UPDATE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_account_valid();

CREATE TRIGGER journal_entries_updated BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Mayor — proyección del Diario, reconstruible
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_movements (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  account_id    uuid NOT NULL REFERENCES accounts (id),
  period_id     uuid NOT NULL REFERENCES periods (id),
  entry_line_id uuid NOT NULL REFERENCES journal_entry_lines (id) UNIQUE,
  movement_date date NOT NULL,
  debit         numeric(18, 2) NOT NULL DEFAULT 0,
  credit        numeric(18, 2) NOT NULL DEFAULT 0
);

CREATE INDEX ledger_movements_account_idx
  ON ledger_movements (company_id, account_id, movement_date);

CREATE TABLE account_balances (
  company_id uuid NOT NULL REFERENCES companies (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  period_id  uuid NOT NULL REFERENCES periods (id),
  opening    numeric(18, 2) NOT NULL DEFAULT 0,
  debits     numeric(18, 2) NOT NULL DEFAULT 0,
  credits    numeric(18, 2) NOT NULL DEFAULT 0,
  closing    numeric(18, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period_id),
  -- El saldo final es una consecuencia aritmética, no un dato independiente.
  CONSTRAINT balance_arithmetic CHECK (closing = opening + debits - credits)
);

-- Balance de sumas y saldos: la prueba de vida del sistema.
CREATE VIEW trial_balance AS
SELECT b.company_id,
       b.period_id,
       b.account_id,
       a.code,
       a.name,
       a.type,
       b.opening,
       b.debits,
       b.credits,
       b.closing
  FROM account_balances b
  JOIN accounts a ON a.id = b.account_id;
