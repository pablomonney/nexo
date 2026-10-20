-- ---------------------------------------------------------------------------
-- Puestos propios de cada empresa, y agregar o quitar módulos y funciones a cada persona — sólo el dueño del estudio
-- ---------------------------------------------------------------------------
--
-- Los 26 puestos predeterminados (0143) cubren los trabajos más comunes, pero cada empresa se organiza a su manera. Esta migración deja que el
-- **dueño del estudio** (organization_members.level = 'OWNER'):
--
--   1. cree **puestos propios** de una empresa —un nombre, una explicación y las funciones que incluye—, y los dé a las personas;
--   2. **agregue o quite** funciones a una persona puntual, por encima de su puesto, con un motivo escrito.
--
-- ## Por qué sólo el dueño, y por qué con funciones del servidor
--
-- Decidir qué puede hacer cada persona es el acto más sensible del sistema: un permiso de más es acceso regalado. Por eso **nadie de la empresa**
-- (ni el Administrador) puede hacerlo: sólo el dueño del estudio, y la comprobación vive en la base (funciones `SECURITY DEFINER` que verifican
-- al llamador antes de actuar, como `create_company` y `grant_company_role`), no en la pantalla. Las tablas nuevas sólo se leen desde la aplicación.
--
-- ## Lo que ningún puesto propio ni ajuste puede dar (`permisos_reservados`)
--
-- Firmar y cerrar la contabilidad (aprobar o revertir asientos, períodos, estados, libros emitidos), administrar el sistema (usuarios, secretos,
-- ARCA, suscripción, migraciones, conectar integraciones) y reglas normativas siguen siendo de los roles Contador y Administrador. Así un puesto a
-- medida **no se salta la separación de funciones** que el sistema defiende en todos lados: administrar el sistema no es firmar la contabilidad.
--
-- ## Quien arma no aprueba
--
-- Un puesto propio —o una persona con sus ajustes— no puede tener a la vez armar y aprobar en pagos, compras ni decisiones.
--
-- ## Cómo se resuelve lo que puede hacer una persona
--
--   `user_permissions` = (permisos de sus roles ∪ de sus puestos propios ∪ lo que se le agregó) − lo que se le quitó.
--
-- Es la única función que consulta la aplicación para autorizar (`requireCompany`): nada más cambia.
-- ---------------------------------------------------------------------------

-- Las funciones que un puesto propio o un ajuste no pueden dar, con el motivo. Datos de referencia: no los escribe la aplicación.
CREATE TABLE permisos_reservados (
  permission_id uuid PRIMARY KEY REFERENCES permissions (id),
  motivo        text NOT NULL CHECK (length(btrim(motivo)) >= 10)
);
GRANT SELECT ON permisos_reservados TO aai_app;
REVOKE INSERT, UPDATE, DELETE ON permisos_reservados FROM aai_app;
COMMENT ON TABLE permisos_reservados IS
  'Funciones que sólo dan los roles fijos (Contador, Administrador): ningún puesto propio ni ajuste por persona puede darlas. Datos de referencia.';

INSERT INTO permisos_reservados (permission_id, motivo)
SELECT p.id, m.motivo
  FROM permissions p
  JOIN (VALUES
    ('journal_entry:approve',   'Firmar la contabilidad es del Contador'),
    ('journal_entry:reverse',   'Firmar la contabilidad es del Contador'),
    ('period:write',            'Abrir, bloquear y cerrar períodos es del Contador'),
    ('period:block',            'Abrir, bloquear y cerrar períodos es del Contador'),
    ('period:close',            'Abrir, bloquear y cerrar períodos es del Contador'),
    ('period:reopen',           'Reabrir un período exige la segunda firma del Contador'),
    ('fiscal_year:close',       'Cerrar el ejercicio es del Contador'),
    ('statement:issue',         'Emitir estados contables es del Contador'),
    ('book:emit',               'Emitir libros firmados es del Contador'),
    ('note:write',              'Las notas a los estados son del Contador'),
    ('account:write',           'El plan de cuentas lo modifica el Contador'),
    ('decision:supersede',      'Corregir una decisión contable es del Contador'),
    ('rule:activate',           'Activar una regla normativa es del Contador'),
    ('user:manage',             'Administrar personas y roles es del Administrador'),
    ('secret:manage',           'Los secretos de integraciones son del Administrador'),
    ('arca_credential:manage',  'Los certificados de ARCA son del Administrador'),
    ('company:write',           'Modificar los datos de la empresa es del Administrador'),
    ('company:create',          'Dar de alta empresas es del Administrador'),
    ('company:export',          'Exportar todos los datos de la empresa es del Administrador'),
    ('subscription:write',      'Cambiar el plan de la empresa es del Administrador'),
    ('migration:import',        'Importar datos de otro sistema es del Administrador'),
    ('migration:write',         'Importar datos de otro sistema es del Administrador'),
    ('migration:read',          'Importar datos de otro sistema es del Administrador'),
    ('integration:connect',     'Conectar integraciones externas es del Administrador')
  ) AS m(code, motivo) ON m.code = p.code;

-- ---------------------------------------------------------------------------
-- Los puestos propios y sus funciones
-- ---------------------------------------------------------------------------
CREATE TABLE puestos_propios (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),
  nombre       text NOT NULL CHECK (length(btrim(nombre)) BETWEEN 3 AND 80),
  descripcion  text NOT NULL CHECK (length(btrim(descripcion)) >= 10),
  creado_por   uuid NOT NULL REFERENCES users (id),
  creado_el    timestamptz NOT NULL DEFAULT now(),
  archivado_el timestamptz,
  UNIQUE (company_id, id)
);
-- Dos puestos vivos de la misma empresa no se llaman igual (uno archivado libera el nombre).
CREATE UNIQUE INDEX puestos_propios_nombre_vivo ON puestos_propios (company_id, lower(btrim(nombre))) WHERE archivado_el IS NULL;

CREATE TABLE puesto_propio_permisos (
  company_id    uuid NOT NULL,
  puesto_id     uuid NOT NULL,
  permission_id uuid NOT NULL REFERENCES permissions (id),
  PRIMARY KEY (puesto_id, permission_id),
  FOREIGN KEY (company_id, puesto_id) REFERENCES puestos_propios (company_id, id)
);

CREATE TABLE asignaciones_de_puesto_propio (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users (id),
  puesto_id    uuid NOT NULL,
  asignado_por uuid NOT NULL REFERENCES users (id),
  asignado_el  timestamptz NOT NULL DEFAULT now(),
  valid_to     date,
  UNIQUE (puesto_id, user_id),
  FOREIGN KEY (company_id, puesto_id) REFERENCES puestos_propios (company_id, id)
);

-- Lo que se le agrega o se le quita a UNA persona, por encima de su puesto. Una fila por permiso: o se agrega o se quita, no las dos.
CREATE TABLE ajustes_de_permisos (
  company_id    uuid NOT NULL REFERENCES companies (id),
  user_id       uuid NOT NULL REFERENCES users (id),
  permission_id uuid NOT NULL REFERENCES permissions (id),
  efecto        text NOT NULL CHECK (efecto IN ('AGREGA', 'QUITA')),
  motivo        text NOT NULL CHECK (length(btrim(motivo)) >= 10),
  declarado_por uuid NOT NULL REFERENCES users (id),
  declarado_el  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, permission_id)
);

DO $$
DECLARE tabla text;
BEGIN
  FOREACH tabla IN ARRAY ARRAY['puestos_propios', 'puesto_propio_permisos', 'asignaciones_de_puesto_propio', 'ajustes_de_permisos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tabla);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tabla);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, tabla);
    -- La aplicación sólo LEE: escribir es de las funciones de abajo, que verifican que quien llama es el dueño del estudio.
    EXECUTE format('GRANT SELECT ON %I TO aai_app', tabla);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM aai_app', tabla);
  END LOOP;
END
$$;

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('CREAR_PUESTO_PROPIO',        'puestos', true),
  ('MODIFICAR_PUESTO_PROPIO',    'puestos', true),
  ('ARCHIVAR_PUESTO_PROPIO',     'puestos', true),
  ('ASIGNAR_PUESTO_PROPIO',      'puestos', true),
  ('QUITAR_PUESTO_PROPIO',       'puestos', true),
  ('AJUSTAR_PERMISOS_DE_PERSONA','puestos', true);

-- ---------------------------------------------------------------------------
-- Lo que puede hacer una persona: roles + puestos propios ± ajustes
-- ---------------------------------------------------------------------------

-- Lo que le dan sus roles y sus puestos propios, SIN los ajustes: es la base contra la que se ven los ajustes.
CREATE OR REPLACE FUNCTION permisos_base_de_persona(p_user_id uuid, p_company_id uuid)
RETURNS TABLE(code text)
LANGUAGE sql STABLE
AS $$
  SELECT p.code
    FROM user_company_roles ucr
    JOIN role_permissions rp ON rp.role_id = ucr.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE ucr.user_id = p_user_id AND ucr.company_id = p_company_id
     AND ucr.valid_from <= CURRENT_DATE AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)
  UNION
  SELECT p.code
    FROM asignaciones_de_puesto_propio a
    JOIN puestos_propios pp ON pp.id = a.puesto_id AND pp.archivado_el IS NULL
    JOIN puesto_propio_permisos x ON x.puesto_id = pp.id
    JOIN permissions p ON p.id = x.permission_id
   WHERE a.user_id = p_user_id AND a.company_id = p_company_id
     AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE);
$$;

CREATE OR REPLACE FUNCTION user_permissions(p_user_id uuid, p_company_id uuid)
RETURNS TABLE(code text)
LANGUAGE sql STABLE
AS $$
  SELECT b.code
    FROM permisos_base_de_persona(p_user_id, p_company_id) b
   WHERE NOT EXISTS (
           SELECT 1 FROM ajustes_de_permisos a JOIN permissions p ON p.id = a.permission_id
            WHERE a.user_id = p_user_id AND a.company_id = p_company_id AND a.efecto = 'QUITA' AND p.code = b.code)
  UNION
  SELECT p.code
    FROM ajustes_de_permisos a JOIN permissions p ON p.id = a.permission_id
   WHERE a.user_id = p_user_id AND a.company_id = p_company_id AND a.efecto = 'AGREGA';
$$;

-- ---------------------------------------------------------------------------
-- Las comprobaciones, en la base
-- ---------------------------------------------------------------------------

-- Quien arma no aprueba: devuelve el motivo si el conjunto junta armar y aprobar, o NULL.
CREATE OR REPLACE FUNCTION conflicto_de_funciones(p_codigos text[]) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT string_agg(d.mensaje, '; ')
    FROM (VALUES
      ('payment_order',   'armar y aprobar órdenes de pago'),
      ('purchase_request','armar y aprobar pedidos de compra'),
      ('decision',        'registrar y aprobar decisiones')
    ) AS d(dominio, mensaje)
   WHERE d.dominio || ':write' = ANY (p_codigos) AND d.dominio || ':approve' = ANY (p_codigos);
$$;

-- Que cada código exista y no sea reservado. Un puesto propio o un ajuste nunca da lo que sólo dan los roles fijos.
CREATE OR REPLACE FUNCTION validar_permisos_propios(p_codigos text[]) RETURNS void
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_desconocidos text;
  v_reservados   text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_desconocidos
    FROM unnest(p_codigos) AS c WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = c);
  IF v_desconocidos IS NOT NULL THEN
    RAISE EXCEPTION 'Funciones inexistentes: %', v_desconocidos USING ERRCODE = 'check_violation';
  END IF;

  SELECT string_agg(c, ', ') INTO v_reservados
    FROM unnest(p_codigos) AS c
    JOIN permissions p ON p.code = c
    JOIN permisos_reservados r ON r.permission_id = p.id;
  IF v_reservados IS NOT NULL THEN
    RAISE EXCEPTION 'Estas funciones sólo las dan los roles de Contador y Administrador, no un puesto propio ni un ajuste: %', v_reservados
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Toda decisión sobre permisos lleva un motivo escrito: dentro de un año alguien va a preguntar por qué.
CREATE OR REPLACE FUNCTION exigir_motivo(p_motivo text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF length(btrim(coalesce(p_motivo, ''))) < 10 THEN
    RAISE EXCEPTION 'Esto exige un motivo escrito (10 caracteres o más)' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- ¿El actor es el dueño del estudio al que pertenece la empresa? Interna: la usan las funciones de abajo.
CREATE OR REPLACE FUNCTION exigir_dueno_del_estudio(p_actor uuid, p_company uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_actor IS NULL OR company_organization(p_company) IS NULL
     OR organization_level(p_actor, company_organization(p_company)) IS DISTINCT FROM 'OWNER' THEN
    RAISE EXCEPTION 'Sólo el dueño del estudio puede definir puestos y permisos' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION exigir_dueno_del_estudio(uuid, uuid) FROM PUBLIC;

-- Deja constancia en la bitácora encadenada, en la MISMA transacción que el cambio: no se puede cambiar lo que alguien puede hacer sin que quede escrito.
CREATE OR REPLACE FUNCTION constancia_de_permisos(p_company uuid, p_actor uuid, p_accion text, p_objeto text, p_objeto_id text, p_nuevo jsonb, p_motivo text) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id, old_value, new_value, motivo, ip, user_agent, prev_hash, hash)
  VALUES (p_company, 'USER', 'user:' || p_actor::text, p_accion, p_objeto, p_objeto_id, NULL, p_nuevo, p_motivo, NULL, NULL, '', '');
$$;
REVOKE EXECUTE ON FUNCTION constancia_de_permisos(uuid, uuid, text, text, text, jsonb, text) FROM PUBLIC;

-- Crear un puesto propio.
CREATE OR REPLACE FUNCTION crear_puesto_propio(p_actor uuid, p_company uuid, p_nombre text, p_descripcion text, p_permisos text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_codigos  text[] := ARRAY(SELECT DISTINCT c FROM unnest(p_permisos || ARRAY['company:read']) AS c);
  v_conflicto text;
  v_id uuid;
BEGIN
  PERFORM exigir_dueno_del_estudio(p_actor, p_company);
  PERFORM validar_permisos_propios(v_codigos);
  v_conflicto := conflicto_de_funciones(v_codigos);
  IF v_conflicto IS NOT NULL THEN
    RAISE EXCEPTION 'Un puesto no puede juntar %: quien arma no aprueba', v_conflicto USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO puestos_propios (company_id, nombre, descripcion, creado_por)
  VALUES (p_company, btrim(p_nombre), btrim(p_descripcion), p_actor) RETURNING id INTO v_id;
  INSERT INTO puesto_propio_permisos (company_id, puesto_id, permission_id)
  SELECT p_company, v_id, p.id FROM permissions p WHERE p.code = ANY (v_codigos);
  PERFORM constancia_de_permisos(p_company, p_actor, 'CREAR_PUESTO_PROPIO', 'puestos_propios', v_id::text,
                                 jsonb_build_object('nombre', btrim(p_nombre), 'permisos', to_jsonb(v_codigos)), btrim(p_descripcion));
  RETURN v_id;
END
$$;

-- Cambiar el nombre, la explicación y las funciones de un puesto propio. Lo que ya tenían las personas con ese puesto cambia en el acto.
CREATE OR REPLACE FUNCTION cambiar_puesto_propio(p_actor uuid, p_company uuid, p_puesto uuid, p_nombre text, p_descripcion text, p_permisos text[], p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_codigos  text[] := ARRAY(SELECT DISTINCT c FROM unnest(p_permisos || ARRAY['company:read']) AS c);
  v_conflicto text;
BEGIN
  PERFORM exigir_dueno_del_estudio(p_actor, p_company);
  PERFORM exigir_motivo(p_motivo);
  PERFORM 1 FROM puestos_propios WHERE id = p_puesto AND company_id = p_company AND archivado_el IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe ese puesto en esta empresa' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM validar_permisos_propios(v_codigos);
  v_conflicto := conflicto_de_funciones(v_codigos);
  IF v_conflicto IS NOT NULL THEN
    RAISE EXCEPTION 'Un puesto no puede juntar %: quien arma no aprueba', v_conflicto USING ERRCODE = 'check_violation';
  END IF;

  UPDATE puestos_propios SET nombre = btrim(p_nombre), descripcion = btrim(p_descripcion) WHERE id = p_puesto;
  DELETE FROM puesto_propio_permisos WHERE puesto_id = p_puesto;
  INSERT INTO puesto_propio_permisos (company_id, puesto_id, permission_id)
  SELECT p_company, p_puesto, p.id FROM permissions p WHERE p.code = ANY (v_codigos);
  PERFORM constancia_de_permisos(p_company, p_actor, 'MODIFICAR_PUESTO_PROPIO', 'puestos_propios', p_puesto::text,
                                 jsonb_build_object('nombre', btrim(p_nombre), 'permisos', to_jsonb(v_codigos)), btrim(p_motivo));
END
$$;

-- Archivar un puesto propio: deja de dar permisos (las asignaciones quedan, inactivas). No se borra: la bitácora lo cita.
CREATE OR REPLACE FUNCTION archivar_puesto_propio(p_actor uuid, p_company uuid, p_puesto uuid, p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM exigir_dueno_del_estudio(p_actor, p_company);
  PERFORM exigir_motivo(p_motivo);
  UPDATE puestos_propios SET archivado_el = now() WHERE id = p_puesto AND company_id = p_company AND archivado_el IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe ese puesto en esta empresa' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM constancia_de_permisos(p_company, p_actor, 'ARCHIVAR_PUESTO_PROPIO', 'puestos_propios', p_puesto::text, '{}'::jsonb, btrim(p_motivo));
END
$$;

-- Dar un puesto propio a una persona del estudio.
CREATE OR REPLACE FUNCTION dar_puesto_propio(p_actor uuid, p_company uuid, p_target uuid, p_puesto uuid, p_motivo text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM exigir_dueno_del_estudio(p_actor, p_company);
  PERFORM exigir_motivo(p_motivo);
  IF organization_level(p_target, company_organization(p_company)) IS NULL THEN
    RAISE EXCEPTION 'El usuario destinatario no pertenece al estudio' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM puestos_propios WHERE id = p_puesto AND company_id = p_company AND archivado_el IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe ese puesto en esta empresa' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO asignaciones_de_puesto_propio (company_id, user_id, puesto_id, asignado_por)
  VALUES (p_company, p_target, p_puesto, p_actor)
  ON CONFLICT (puesto_id, user_id) DO UPDATE SET valid_to = NULL, asignado_por = EXCLUDED.asignado_por, asignado_el = now()
  RETURNING id INTO v_id;
  PERFORM constancia_de_permisos(p_company, p_actor, 'ASIGNAR_PUESTO_PROPIO', 'asignaciones_de_puesto_propio', v_id::text,
                                 jsonb_build_object('persona', p_target, 'puesto', p_puesto), btrim(p_motivo));
  RETURN v_id;
END
$$;

-- Sacarle un puesto propio a una persona.
CREATE OR REPLACE FUNCTION quitar_puesto_propio(p_actor uuid, p_company uuid, p_target uuid, p_puesto uuid, p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM exigir_dueno_del_estudio(p_actor, p_company);
  PERFORM exigir_motivo(p_motivo);
  DELETE FROM asignaciones_de_puesto_propio WHERE company_id = p_company AND user_id = p_target AND puesto_id = p_puesto;
  PERFORM constancia_de_permisos(p_company, p_actor, 'QUITAR_PUESTO_PROPIO', 'asignaciones_de_puesto_propio', p_puesto::text,
                                 jsonb_build_object('persona', p_target, 'puesto', p_puesto), btrim(p_motivo));
END
$$;

-- Fijar lo que se le AGREGA y lo que se le QUITA a una persona (reemplaza los ajustes anteriores). Con el resultado se comprueba que no
-- quede nada reservado ni se junte armar y aprobar.
CREATE OR REPLACE FUNCTION ajustar_permisos_de_persona(p_actor uuid, p_company uuid, p_target uuid, p_agrega text[], p_quita text[], p_motivo text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_efectivos text[];
  v_conflicto text;
BEGIN
  PERFORM exigir_dueno_del_estudio(p_actor, p_company);
  IF organization_level(p_target, company_organization(p_company)) IS NULL THEN
    RAISE EXCEPTION 'El usuario destinatario no pertenece al estudio' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM exigir_motivo(p_motivo);
  IF p_agrega && p_quita THEN
    RAISE EXCEPTION 'Una función no se puede agregar y quitar a la vez' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM validar_permisos_propios(coalesce(p_agrega, '{}'));
  -- Quitar cualquier función es válido (reduce acceso); pero tiene que existir.
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_quita, '{}')) c WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = c)) THEN
    RAISE EXCEPTION 'Funciones inexistentes en lo que se quita' USING ERRCODE = 'check_violation';
  END IF;

  v_efectivos := ARRAY(
    SELECT c FROM (
      SELECT b.code AS c FROM permisos_base_de_persona(p_target, p_company) b
      UNION SELECT unnest(coalesce(p_agrega, '{}'))
    ) u WHERE NOT (u.c = ANY (coalesce(p_quita, '{}'))));
  v_conflicto := conflicto_de_funciones(v_efectivos);
  IF v_conflicto IS NOT NULL THEN
    RAISE EXCEPTION 'La persona quedaría con %: quien arma no aprueba', v_conflicto USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM ajustes_de_permisos WHERE company_id = p_company AND user_id = p_target;
  INSERT INTO ajustes_de_permisos (company_id, user_id, permission_id, efecto, motivo, declarado_por)
  SELECT p_company, p_target, p.id, 'AGREGA', btrim(p_motivo), p_actor FROM permissions p WHERE p.code = ANY (coalesce(p_agrega, '{}'))
  UNION ALL
  SELECT p_company, p_target, p.id, 'QUITA', btrim(p_motivo), p_actor FROM permissions p WHERE p.code = ANY (coalesce(p_quita, '{}'));
  PERFORM constancia_de_permisos(p_company, p_actor, 'AJUSTAR_PERMISOS_DE_PERSONA', 'ajustes_de_permisos', p_target::text,
                                 jsonb_build_object('persona', p_target, 'agrega', to_jsonb(coalesce(p_agrega, '{}')), 'quita', to_jsonb(coalesce(p_quita, '{}'))),
                                 btrim(p_motivo));
END
$$;

GRANT EXECUTE ON FUNCTION permisos_base_de_persona(uuid, uuid) TO aai_app;
GRANT EXECUTE ON FUNCTION crear_puesto_propio(uuid, uuid, text, text, text[]) TO aai_app;
GRANT EXECUTE ON FUNCTION cambiar_puesto_propio(uuid, uuid, uuid, text, text, text[], text) TO aai_app;
GRANT EXECUTE ON FUNCTION archivar_puesto_propio(uuid, uuid, uuid, text) TO aai_app;
GRANT EXECUTE ON FUNCTION dar_puesto_propio(uuid, uuid, uuid, uuid, text) TO aai_app;
GRANT EXECUTE ON FUNCTION quitar_puesto_propio(uuid, uuid, uuid, uuid, text) TO aai_app;
GRANT EXECUTE ON FUNCTION ajustar_permisos_de_persona(uuid, uuid, uuid, text[], text[], text) TO aai_app;
REVOKE EXECUTE ON FUNCTION crear_puesto_propio(uuid, uuid, text, text, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cambiar_puesto_propio(uuid, uuid, uuid, text, text, text[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION archivar_puesto_propio(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION dar_puesto_propio(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION quitar_puesto_propio(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ajustar_permisos_de_persona(uuid, uuid, uuid, text[], text[], text) FROM PUBLIC;

-- Las comprobaciones de apoyo las llaman las funciones de arriba (que corren con los privilegios de su dueño): la aplicación no las necesita.
REVOKE EXECUTE ON FUNCTION conflicto_de_funciones(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validar_permisos_propios(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION exigir_motivo(text) FROM PUBLIC;

COMMENT ON TABLE puestos_propios IS 'Puestos que el dueño del estudio arma para una empresa: un nombre, una explicación y las funciones que incluye. Sólo se escriben con las funciones crear_/cambiar_/archivar_puesto_propio.';
COMMENT ON TABLE ajustes_de_permisos IS 'Lo que el dueño del estudio le agrega o le quita a UNA persona, por encima de su puesto, con motivo. Sólo se escribe con ajustar_permisos_de_persona.';
