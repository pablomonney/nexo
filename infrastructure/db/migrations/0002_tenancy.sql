-- 0002_tenancy.sql — estudio, empresas, usuarios, roles y permisos.

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  tax_id      text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- entity_type y jurisdiction NO son decorativos: alimentan la resolución
-- normativa. Ver NORMATIVE_ENGINE.md §2 y el caso RT 54 / CPCECABA.
CREATE TABLE companies (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id  uuid NOT NULL REFERENCES organizations (id),
  legal_name       text NOT NULL,
  cuit             text NOT NULL CHECK (cuit ~ '^[0-9]{11}$'),
  entity_type      text NOT NULL CHECK (entity_type IN (
                     'SA', 'SA_299', 'SRL', 'SAS', 'SOCIEDAD_SIMPLE',
                     'ASOC_CIVIL', 'FUNDACION', 'COOPERATIVA', 'MUTUAL',
                     'SUCURSAL_EXTRANJERA', 'UNIPERSONAL', 'FIDEICOMISO')),
  -- ISO 3166-2:AR. 'AR' = nacional, 'AR-C' = CABA, 'AR-B' = Buenos Aires, etc.
  jurisdiction     text NOT NULL CHECK (jurisdiction ~ '^AR(-[A-Z])?$'),
  regulator        text CHECK (regulator IN ('IGJ', 'CNV', 'BCRA', 'INAES', 'PROVINCIAL')),
  activity_code    text,
  fiscal_year_end  text NOT NULL CHECK (fiscal_year_end ~ '^[0-9]{2}-[0-9]{2}$'),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, cuit)
);

CREATE INDEX companies_resolution_idx ON companies (jurisdiction, entity_type, regulator);

-- Materializa la OPCIÓN normativa del ente. La RG IGJ 9/2026 (art. 230 sustituido)
-- dice que las sociedades "podrán optar" por NIIF o NIIF para PyMES: la opción es
-- del ente y no puede inferirse del CUIT. Se registra con documento de respaldo.
CREATE TABLE company_reporting_frameworks (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id           uuid NOT NULL REFERENCES companies (id),
  framework            text NOT NULL CHECK (framework IN ('RT_FACPCE', 'NIIF', 'NIIF_PYMES')),
  valid_from           date NOT NULL,
  valid_to             date,
  decided_by           text NOT NULL,
  evidence_document_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX company_frameworks_idx ON company_reporting_frameworks (company_id, valid_from DESC);

-- Un ente no puede tener dos marcos contables simultáneos.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE company_reporting_frameworks
  ADD CONSTRAINT company_framework_no_overlap
  EXCLUDE USING gist (
    company_id WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  );

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         text NOT NULL,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Unicidad insensible a mayúsculas sin depender de la extensión citext.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE CHECK (code IN (
                'ADMINISTRADOR', 'CONTADOR', 'AUDITOR',
                'USUARIO_EMPRESA', 'CARGADOR', 'SOLO_LECTURA')),
  name        text NOT NULL,
  description text NOT NULL
);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles (id),
  permission_id uuid NOT NULL REFERENCES permissions (id),
  PRIMARY KEY (role_id, permission_id)
);

-- Un usuario puede tener rol distinto en cada empresa del estudio.
CREATE TABLE user_company_roles (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users (id),
  company_id uuid NOT NULL REFERENCES companies (id),
  role_id    uuid NOT NULL REFERENCES roles (id),
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to   date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id, role_id, valid_from)
);

CREATE INDEX user_company_roles_lookup ON user_company_roles (company_id, user_id);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users (id),
  ip         inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER organizations_updated BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER companies_updated BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Datos de referencia: los seis roles del §26 del pliego.
INSERT INTO roles (code, name, description) VALUES
  ('ADMINISTRADOR',   'Administrador',            'Configuración, usuarios y reapertura de períodos con segunda firma'),
  ('CONTADOR',        'Contador',                 'Aprueba, modifica, rechaza, reclasifica, cierra períodos y emite estados'),
  ('AUDITOR',         'Auditor',                  'Solo lectura total más acceso completo a la bitácora. No modifica nada'),
  ('USUARIO_EMPRESA', 'Usuario de empresa',       'Ve su empresa, carga documentación y consulta reportes autorizados'),
  ('CARGADOR',        'Cargador de documentación','Sube documentos y ve el estado de su procesamiento'),
  ('SOLO_LECTURA',    'Solo lectura',             'Consulta');
