-- 0001_bootstrap.sql — extensiones, roles y utilidades base.
--
-- Convenciones del esquema (DATABASE.md §1):
--   · identificadores uuid v7 (ordenables en el tiempo, sin hot spots de índice)
--   · timestamptz para eventos del sistema, date para fechas contables/fiscales
--   · numeric(18,2) para dinero; jamás float
--   · toda tabla de negocio lleva company_id y política RLS

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- uuid v7
-- ---------------------------------------------------------------------------
-- PostgreSQL 18 trae uuidv7() nativo. Para 16/17 se define acá con la misma
-- semántica: 48 bits de timestamp en milisegundos + versión 7 + variante RFC 4122.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') THEN
    CREATE FUNCTION uuidv7() RETURNS uuid
    LANGUAGE plpgsql VOLATILE PARALLEL SAFE
    AS $fn$
    DECLARE
      unix_ms bigint := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
      bytes bytea := gen_random_bytes(16);
    BEGIN
      -- 48 bits de timestamp big-endian en los primeros 6 bytes
      bytes := set_byte(bytes, 0, ((unix_ms >> 40) & 255)::int);
      bytes := set_byte(bytes, 1, ((unix_ms >> 32) & 255)::int);
      bytes := set_byte(bytes, 2, ((unix_ms >> 24) & 255)::int);
      bytes := set_byte(bytes, 3, ((unix_ms >> 16) & 255)::int);
      bytes := set_byte(bytes, 4, ((unix_ms >> 8) & 255)::int);
      bytes := set_byte(bytes, 5, (unix_ms & 255)::int);
      -- versión 7 en el nibble alto del byte 6
      bytes := set_byte(bytes, 6, ((get_byte(bytes, 6) & 15) | 112));
      -- variante RFC 4122 en los dos bits altos del byte 8
      bytes := set_byte(bytes, 8, ((get_byte(bytes, 8) & 63) | 128));
      RETURN encode(bytes, 'hex')::uuid;
    END;
    $fn$;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Contexto de sesión: empresa activa y actor
-- ---------------------------------------------------------------------------
-- La aplicación hace SET LOCAL app.company_id / app.actor_id por transacción.
-- Las políticas RLS y los triggers de auditoría leen de acá.

CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_actor_id() RETURNS text
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.actor_id', true), '') $$;

-- Falla ruidosamente si no hay empresa en contexto. Se usa en triggers donde
-- operar "sin empresa" sería un bug de tenancy, no un caso válido.
CREATE OR REPLACE FUNCTION require_company_id() RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  value uuid := app_company_id();
BEGIN
  IF value IS NULL THEN
    RAISE EXCEPTION 'Falta app.company_id en el contexto de la transacción'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN value;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rol de aplicación
-- ---------------------------------------------------------------------------
-- Sin BYPASSRLS y sin SUPERUSER: si la aplicación pudiera saltear RLS, el
-- aislamiento multiempresa sería una convención en vez de una garantía.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aai_app') THEN
    CREATE ROLE aai_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Prohibición genérica de borrado físico
-- ---------------------------------------------------------------------------
-- Se aplica a tablas contables, documentales y de auditoría (§38 del pliego).
-- Se eligió lanzar excepción en vez de `RULE ... DO INSTEAD NOTHING`: un borrado
-- silenciosamente ignorado deja a la aplicación creyendo que borró algo. Es peor
-- que el error.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Borrado físico prohibido en %. Usá anulación o baja lógica con trazabilidad.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
