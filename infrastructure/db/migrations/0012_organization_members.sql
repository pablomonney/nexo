-- 0012_organization_members.sql — pertenencia al estudio.
--
-- Hueco del modelo detectado al implementar FASE 2: `user_company_roles` ata los
-- roles a EMPRESAS, y por lo tanto no hay forma de expresar "administrador del
-- estudio". Sin eso, nadie puede crear la primera empresa: para tener permiso
-- sobre una empresa hay que tener rol en una empresa que todavía no existe.
--
-- Son dos niveles distintos y hacían falta los dos:
--   · organization_members → quién administra el ESTUDIO (alta de empresas y usuarios)
--   · user_company_roles   → qué puede hacer cada quien DENTRO de cada empresa

CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  -- OWNER puede todo en el estudio; MEMBER solo lo que le concedan sus roles por empresa.
  level           text NOT NULL CHECK (level IN ('OWNER', 'ADMIN', 'MEMBER')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX organization_members_user_idx ON organization_members (user_id);

-- Un estudio sin dueño quedaría sin nadie que pueda administrarlo.
CREATE OR REPLACE FUNCTION assert_organization_keeps_owner() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.level = 'OWNER' AND NEW.level <> 'OWNER' THEN
    IF NOT EXISTS (
      SELECT 1 FROM organization_members
       WHERE organization_id = OLD.organization_id AND level = 'OWNER' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'El estudio debe conservar al menos un OWNER'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organization_members_keep_owner
  BEFORE UPDATE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION assert_organization_keeps_owner();

GRANT SELECT, INSERT, UPDATE ON organization_members TO aai_app;
GRANT SELECT, INSERT, UPDATE ON organizations TO aai_app;

-- Nivel efectivo de un usuario en un estudio. NULL = no pertenece.
CREATE OR REPLACE FUNCTION organization_level(p_user_id uuid, p_organization_id uuid)
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT level FROM organization_members
   WHERE user_id = p_user_id AND organization_id = p_organization_id;
$$;

-- El estudio al que pertenece una empresa, para poder autorizar sin abrir el
-- contexto de empresa (que es justamente lo que todavía no existe al crearla).
CREATE OR REPLACE FUNCTION company_organization(p_company_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM companies WHERE id = p_company_id;
$$;

GRANT EXECUTE ON FUNCTION organization_level(uuid, uuid) TO aai_app;
GRANT EXECUTE ON FUNCTION company_organization(uuid) TO aai_app;
