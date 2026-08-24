-- 0014_fix_grant_company_role.sql — corrige una ambigüedad de nombres.
--
-- Detectado por tests/security/endpoint-isolation.test.ts:
--
--   error: la referencia a la columna «role_id» es ambigua
--
-- La función declaraba una variable `role_id` y el INSERT referenciaba la columna
-- `role_id` de user_company_roles. PL/pgSQL no puede desambiguar y falla en
-- ejecución, no al crear la función: sin un test que la invoque, el bug queda
-- latente hasta el primer alta de rol en producción.
--
-- Se prefija con `v_` toda variable local que comparta nombre con una columna.

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
  v_org_id uuid := company_organization(p_company_id);
  v_actor_level text;
  v_role_id uuid;
  v_new_id uuid;
BEGIN
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Empresa inexistente' USING ERRCODE = 'check_violation';
  END IF;

  v_actor_level := organization_level(p_actor_user_id, v_org_id);
  IF v_actor_level IS NULL OR v_actor_level NOT IN ('OWNER', 'ADMIN') THEN
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
  IF organization_level(p_target_user_id, v_org_id) IS NULL THEN
    RAISE EXCEPTION 'El usuario destinatario no pertenece al estudio'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT r.id INTO v_role_id FROM roles r WHERE r.code = p_role_code;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Rol inexistente: %', p_role_code USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO user_company_roles (user_id, company_id, role_id)
  VALUES (p_target_user_id, p_company_id, v_role_id)
  ON CONFLICT (user_id, company_id, role_id, valid_from) DO UPDATE SET valid_to = NULL
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;
