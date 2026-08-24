-- 0004_periods.sql — ejercicios, períodos y libros/subdiarios.
--
-- El estado del período gobierna la mutabilidad de todo lo contable:
--   ABIERTO ──bloquear──► BLOQUEADO ──cerrar──► CERRADO
--      ▲                                            │
--      └──────── reapertura con doble firma ────────┘

CREATE TABLE fiscal_years (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  code       text NOT NULL,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  status     text NOT NULL DEFAULT 'ABIERTO' CHECK (status IN ('ABIERTO', 'EN_CIERRE', 'CERRADO')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  CHECK (end_date > start_date)
);

-- Dos ejercicios de la misma empresa no pueden solaparse.
ALTER TABLE fiscal_years
  ADD CONSTRAINT fiscal_years_no_overlap
  EXCLUDE USING gist (
    company_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

CREATE TABLE periods (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years (id),
  number         integer NOT NULL CHECK (number BETWEEN 1 AND 24),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'ABIERTO' CHECK (status IN ('ABIERTO', 'BLOQUEADO', 'CERRADO')),
  closed_at      timestamptz,
  closed_by      text,
  reopened_at    timestamptz,
  reopened_by    text,
  reopened_countersigned_by text,
  reopen_reason  text,
  UNIQUE (fiscal_year_id, number),
  CHECK (end_date >= start_date),
  -- Un período cerrado tiene que decir quién lo cerró y cuándo.
  CHECK (status <> 'CERRADO' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  -- Separación de funciones: la reapertura exige dos personas distintas y un motivo.
  CHECK (reopened_at IS NULL OR (
           reopened_by IS NOT NULL
       AND reopened_countersigned_by IS NOT NULL
       AND reopened_by <> reopened_countersigned_by
       AND reopen_reason IS NOT NULL))
);

CREATE INDEX periods_lookup ON periods (company_id, start_date, end_date);

ALTER TABLE periods
  ADD CONSTRAINT periods_no_overlap
  EXCLUDE USING gist (
    company_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

-- Libros y subdiarios. La numeración de asientos es por libro, no global.
CREATE TABLE journals (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  code       text NOT NULL CHECK (code IN
               ('GENERAL', 'COMPRAS', 'VENTAS', 'BANCOS', 'CAJA',
                'SUELDOS', 'AJUSTES', 'CIERRE', 'APERTURA')),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code)
);

-- Contador de numeración correlativa por (empresa, libro, ejercicio).
-- Se toma con SELECT ... FOR UPDATE dentro de la transacción del posteo: bajo
-- concurrencia produce una secuencia sin huecos, que es lo que exige un libro
-- rubricado. Una `sequence` de PostgreSQL no sirve acá porque deja huecos al
-- hacer rollback.
CREATE TABLE journal_counters (
  company_id     uuid NOT NULL REFERENCES companies (id),
  journal_code   text NOT NULL,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years (id),
  last_number    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, journal_code, fiscal_year_id)
);

CREATE OR REPLACE FUNCTION next_entry_number(
  p_company_id uuid,
  p_journal_code text,
  p_fiscal_year_id uuid
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  next_value integer;
BEGIN
  INSERT INTO journal_counters (company_id, journal_code, fiscal_year_id, last_number)
  VALUES (p_company_id, p_journal_code, p_fiscal_year_id, 0)
  ON CONFLICT DO NOTHING;

  UPDATE journal_counters
     SET last_number = last_number + 1
   WHERE company_id = p_company_id
     AND journal_code = p_journal_code
     AND fiscal_year_id = p_fiscal_year_id
  RETURNING last_number INTO next_value;

  RETURN next_value;
END;
$$;

CREATE TABLE accounting_closures (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years (id),
  checklist      jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'EN_CURSO'
                   CHECK (status IN ('EN_CURSO', 'COMPLETADO', 'ABORTADO')),
  performed_by   text NOT NULL,
  performed_at   timestamptz NOT NULL DEFAULT now()
);
