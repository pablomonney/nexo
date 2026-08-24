-- 0013_privileged_entrypoints.sql — altas que RLS no puede permitir.
--
-- La política de `companies` exige `id = app_company_id()`. Al crear una empresa
-- todavía no hay contexto —el id no existe— así que ningún INSERT del rol de
-- aplicación puede satisfacerla.
--
-- La tentación es aflojar la política con algo como
-- `app_company_id() IS NULL OR id = app_company_id()`. Eso abriría un agujero:
-- cualquier consulta que olvidara fijar el contexto pasaría a ver y escribir
-- TODAS las empresas, que es exactamente la falla que RLS existe para impedir.
--
-- En cambio se definen puntos de entrada nominados, SECURITY DEFINER, que hacen
-- la verificación de autorización adentro. La superficie privilegiada queda
-- explícita, chica y auditable, en vez de difusa.

CREATE OR REPLACE FUNCTION create_organization(
  p_name text,
  p_tax_id text,
  p_owner_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_owner_user_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'El usuario % no existe o no está activo', p_owner_user_id
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO organizations (name, tax_id) VALUES (p_name, p_tax_id) RETURNING id INTO new_id;
  INSERT INTO organization_members (organization_id, user_id, level)
  VALUES (new_id, p_owner_user_id, 'OWNER');

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION create_company(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_legal_name text,
  p_cuit text,
  p_entity_type text,
  p_jurisdiction text,
  p_regulator text,
  p_fiscal_year_end text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_level text;
  new_id uuid;
BEGIN
  -- La autorización se verifica ACÁ: la función es privilegiada, así que no puede
  -- delegar la comprobación en quien la llama.
  actor_level := organization_level(p_actor_user_id, p_organization_id);
  IF actor_level IS NULL OR actor_level NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'El usuario no administra el estudio %', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO companies
    (organization_id, legal_name, cuit, entity_type, jurisdiction, regulator, fiscal_year_end)
  VALUES
    (p_organization_id, p_legal_name, p_cuit, p_entity_type, p_jurisdiction,
     nullif(p_regulator, ''), p_fiscal_year_end)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

/**
 * Asignación de rol dentro de una empresa.
 *
 * También es privilegiada porque `user_company_roles` está bajo RLS por
 * company_id, y quien administra el estudio no necesariamente tiene rol previo
 * en esa empresa — de hecho, al crearla, seguro que no.
 */
CREATE OR REPLACE FUNCTION grant_company_role(
  p_actor_user_id uuid,
  p_company_id uuid,
  p_target_user_id uuid,
  p_role_code text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org_id uuid := company_organization(p_company_id);
  actor_level text;
  role_id uuid;
  new_id uuid;
BEGIN
  IF org_id IS NULL THEN
    RAISE EXCEPTION 'Empresa inexistente' USING ERRCODE = 'check_violation';
  END IF;

  actor_level := organization_level(p_actor_user_id, org_id);
  IF actor_level IS NULL OR actor_level NOT IN ('OWNER', 'ADMIN') THEN
    -- Alternativa: ser ADMINISTRADOR dentro de esa misma empresa.
    IF NOT EXISTS (
      SELECT 1 FROM user_company_roles ucr
        JOIN roles r ON r.id = ucr.role_id
       WHERE ucr.user_id = p_actor_user_id
         AND ucr.company_id = p_company_id
         AND r.code = 'ADMINISTRADOR'
         AND ucr.valid_from <= CURRENT_DATE
         AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)
    ) THEN
      RAISE EXCEPTION 'No autorizado a asignar roles en esta empresa'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- El destinatario tiene que pertenecer al mismo estudio: no se le puede dar
  -- acceso a la contabilidad de un cliente a alguien ajeno a la organización.
  IF organization_level(p_target_user_id, org_id) IS NULL THEN
    RAISE EXCEPTION 'El usuario destinatario no pertenece al estudio'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO role_id FROM roles WHERE code = p_role_code;
  IF role_id IS NULL THEN
    RAISE EXCEPTION 'Rol inexistente: %', p_role_code USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO user_company_roles (user_id, company_id, role_id)
  VALUES (p_target_user_id, p_company_id, role_id)
  ON CONFLICT (user_id, company_id, role_id, valid_from) DO UPDATE SET valid_to = NULL
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Solo estas tres funciones son privilegiadas, y ninguna acepta un "hacé lo que
-- te digo" genérico: cada una hace una cosa y verifica su propia autorización.
GRANT EXECUTE ON FUNCTION create_organization(text, text, uuid) TO aai_app;
GRANT EXECUTE ON FUNCTION create_company(uuid, uuid, text, text, text, text, text, text) TO aai_app;
GRANT EXECUTE ON FUNCTION grant_company_role(uuid, uuid, uuid, text) TO aai_app;
