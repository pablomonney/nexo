-- 0003_accounts.sql — plan de cuentas por empresa, centros de costo.
--
-- El plan del §8 del pliego es una PLANTILLA de arranque, no una imposición:
-- cada empresa tiene el suyo.

CREATE TABLE account_charts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id  uuid REFERENCES companies (id),
  name        text NOT NULL,
  is_template boolean NOT NULL DEFAULT false,
  version     integer NOT NULL DEFAULT 1,
  valid_from  date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Una plantilla no pertenece a ninguna empresa; un plan real siempre sí.
  CHECK ((is_template AND company_id IS NULL) OR (NOT is_template AND company_id IS NOT NULL))
);

CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id           uuid NOT NULL REFERENCES companies (id),
  chart_id             uuid NOT NULL REFERENCES account_charts (id),
  code                 text NOT NULL,
  name                 text NOT NULL,
  parent_id            uuid REFERENCES accounts (id),
  type                 text NOT NULL CHECK (type IN
                         ('ACTIVO', 'PASIVO', 'PN', 'INGRESO', 'COSTO', 'GASTO', 'ORDEN')),
  nature               text NOT NULL CHECK (nature IN ('DEUDORA', 'ACREEDORA')),
  is_postable          boolean NOT NULL DEFAULT true,
  currency             text NOT NULL DEFAULT 'ARS',
  requires_cost_center boolean NOT NULL DEFAULT false,
  requires_third_party boolean NOT NULL DEFAULT false,
  tax_role             text CHECK (tax_role IN
                         ('IVA_CF', 'IVA_DF', 'PERCEPCION', 'RETENCION', 'DIFERENCIA_CAMBIO')),
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, chart_id, code)
);

CREATE INDEX accounts_tree_idx ON accounts (company_id, parent_id);
CREATE INDEX accounts_postable_idx ON accounts (company_id, is_postable) WHERE status = 'ACTIVE';

-- Una cuenta con hijos no es imputable: imputar en un rubro y en sus cuentas
-- analíticas a la vez rompe el Mayor.
CREATE OR REPLACE FUNCTION assert_leaf_is_postable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    UPDATE accounts SET is_postable = false
    WHERE id = NEW.parent_id AND is_postable = true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_parent_not_postable AFTER INSERT OR UPDATE OF parent_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION assert_leaf_is_postable();

CREATE TABLE cost_centers (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  code       text NOT NULL,
  name       text NOT NULL,
  parent_id  uuid REFERENCES cost_centers (id),
  status     text NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code)
);

CREATE TABLE profit_centers (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  code       text NOT NULL,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (company_id, code)
);

CREATE TRIGGER accounts_updated BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Las cuentas no se borran: se archivan. Un código reutilizado con otro
-- significado rompe la comparabilidad entre ejercicios.
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
