-- 0015_arca_integration.sql — credenciales, capacidades y tickets de ARCA.
--
-- El sistema NO es el contribuyente: cada empresa delega el servicio al CUIT que
-- opera el software, o aporta su propio certificado. Por eso todo acá es por
-- empresa y por ambiente.
--
-- SECURITY.md §5: la Clave Fiscal no se pide, no se guarda y no se usa nunca.
-- Lo único que se custodia es el certificado X.509 y su clave privada, cifrada.

CREATE TABLE company_arca_credentials (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  -- Homologación y producción usan certificados DISTINTOS y no intercambiables.
  environment         text NOT NULL CHECK (environment IN ('homologacion', 'produccion')),
  -- CUIT del contribuyente representado, que puede no ser el de la empresa
  -- cuando el estudio opera por delegación.
  cuit                text NOT NULL CHECK (cuit ~ '^[0-9]{11}$'),
  alias               text NOT NULL,
  certificate_pem     text NOT NULL,
  -- Cifrada con sobre: DEK por empresa envuelta con la KEK del KMS.
  private_key_encrypted text NOT NULL,
  key_encryption_ref  text NOT NULL,
  not_before          timestamptz NOT NULL,
  not_after           timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL,
  revoked_at          timestamptz,
  revoked_by          text,

  CHECK (not_after > not_before),
  CHECK (status <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);

-- Una sola credencial activa por empresa y ambiente: dos certificados vigentes
-- a la vez hacen impredecible con cuál se firmó cada consulta.
CREATE UNIQUE INDEX company_arca_credentials_active
  ON company_arca_credentials (company_id, environment)
  WHERE status = 'ACTIVE';

CREATE TRIGGER company_arca_credentials_no_delete
  BEFORE DELETE ON company_arca_credentials
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Capacidades por servicio
-- ---------------------------------------------------------------------------
-- El catálogo oficial advierte que ciertos servicios requieren "autorizaciones y
-- acuerdos especiales". Tener certificado no implica tener el servicio
-- habilitado: son dos trámites distintos, y la UI debe poder mostrar cuáles
-- están disponibles para cada empresa en vez de fallar sin explicación.
CREATE TABLE company_arca_capabilities (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),
  environment  text NOT NULL CHECK (environment IN ('homologacion', 'produccion')),
  service      text NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  -- Cuándo se comprobó por última vez que el servicio responde para este CUIT.
  verified_at  timestamptz,
  notes        text,
  UNIQUE (company_id, environment, service)
);

-- ---------------------------------------------------------------------------
-- Caché de tickets de acceso
-- ---------------------------------------------------------------------------
-- Los TA tienen vigencia acotada y pedirlos de más es motivo de bloqueo por
-- parte del organismo. La caché es por (cuit, servicio, ambiente) y no por
-- empresa: un mismo CUIT puede operar para varias.
CREATE TABLE arca_access_tickets (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  cuit            text NOT NULL,
  service         text NOT NULL,
  environment     text NOT NULL CHECK (environment IN ('homologacion', 'produccion')),
  token           text NOT NULL,
  sign            text NOT NULL,
  generation_time timestamptz NOT NULL,
  expiration_time timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cuit, service, environment)
);

CREATE INDEX arca_tickets_expiry ON arca_access_tickets (expiration_time);

-- ---------------------------------------------------------------------------
-- Bitácora de consultas
-- ---------------------------------------------------------------------------
-- Toda consulta al organismo queda registrada con su resultado. Sirve para
-- tres cosas: demostrar qué se preguntó y cuándo, diagnosticar degradaciones, y
-- no volver a preguntar lo mismo en un reintento.
CREATE TABLE arca_query_log (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  environment   text NOT NULL,
  service       text NOT NULL,
  operation     text NOT NULL,
  request_key   text NOT NULL,
  outcome       text NOT NULL
                  CHECK (outcome IN ('APROBADO', 'RECHAZADO', 'NO_VERIFICABLE')),
  reason        text,
  response_raw  jsonb,
  duration_ms   integer,
  queried_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX arca_query_log_lookup
  ON arca_query_log (company_id, service, request_key, queried_at DESC);

CREATE TRIGGER arca_query_log_no_delete BEFORE DELETE ON arca_query_log
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_arca_credentials', 'company_arca_capabilities', 'arca_query_log'
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
  company_arca_credentials, company_arca_capabilities, arca_query_log, arca_access_tickets
  TO aai_app;

-- La clave privada no se expone jamás por una vista de listado. Este es el
-- único lugar del que la aplicación debe leer credenciales para mostrarlas.
CREATE VIEW company_arca_credentials_public AS
SELECT id, company_id, environment, cuit, alias, not_before, not_after, status,
       created_at, created_by,
       (not_after < now()) AS vencido,
       greatest(0, extract(day FROM not_after - now())::int) AS dias_restantes
  FROM company_arca_credentials;

GRANT SELECT ON company_arca_credentials_public TO aai_app;
