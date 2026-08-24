-- 0011_auth_and_permissions.sql — sesiones, MFA y permisos granulares.

-- ---------------------------------------------------------------------------
-- Sesiones
-- ---------------------------------------------------------------------------
-- El token nunca se guarda en claro: se guarda su SHA-256. Si alguien lee la
-- tabla, no puede suplantar a nadie. Es el mismo criterio que con las
-- contraseñas, y por el mismo motivo.
ALTER TABLE sessions
  ADD COLUMN token_hash char(64) NOT NULL,
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Expiración absoluta además de la de inactividad: una sesión no puede vivir
  -- para siempre por más que se la use.
  ADD COLUMN absolute_expires_at timestamptz NOT NULL,
  ADD COLUMN mfa_satisfied boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX sessions_token_hash_idx ON sessions (token_hash);

-- ---------------------------------------------------------------------------
-- MFA
-- ---------------------------------------------------------------------------
ALTER TABLE users
  -- Cifrado por sobre con la KEK del gestor de secretos. La base guarda el
  -- ciphertext; la aplicación nunca lo persiste descifrado.
  ADD COLUMN mfa_secret_encrypted text,
  ADD COLUMN mfa_confirmed_at timestamptz,
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();

-- No se puede declarar MFA habilitado sin secreto confirmado.
ALTER TABLE users
  ADD CONSTRAINT users_mfa_consistent
  CHECK (NOT mfa_enabled OR (mfa_secret_encrypted IS NOT NULL AND mfa_confirmed_at IS NOT NULL));

-- Códigos de recuperación de un solo uso, guardados hasheados.
CREATE TABLE mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users (id),
  code_hash  char(64) NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('company:read',            'Ver datos de la empresa'),
  ('company:write',           'Modificar datos de la empresa'),
  ('company:create',          'Dar de alta empresas en el estudio'),
  ('user:read',               'Ver usuarios y sus roles'),
  ('user:manage',             'Alta, baja y asignación de roles'),
  ('account:read',            'Ver el plan de cuentas'),
  ('account:write',           'Modificar el plan de cuentas'),
  ('cost_center:read',        'Ver centros de costo'),
  ('cost_center:write',       'Modificar centros de costo'),
  ('period:read',             'Ver ejercicios y períodos'),
  ('period:write',            'Crear ejercicios y períodos'),
  ('period:close',            'Cerrar un período'),
  ('period:reopen',           'Reabrir un período cerrado (requiere segunda firma)'),
  ('journal_entry:read',      'Ver asientos'),
  ('journal_entry:create',    'Crear asientos en borrador'),
  ('journal_entry:approve',   'Aprobar asientos'),
  ('journal_entry:reverse',   'Anular asientos por contraasiento'),
  ('document:read',           'Ver documentos'),
  ('document:upload',         'Subir documentos'),
  ('document:download',       'Descargar el documento original'),
  ('rule:read',               'Ver reglas normativas y sus citas'),
  ('rule:activate',           'Activar una regla normativa'),
  ('audit:read',              'Ver la bitácora y los reportes de auditoría'),
  ('report:read',             'Ver reportes y estados contables'),
  ('alert:read',              'Ver alertas'),
  ('alert:acknowledge',       'Reconocer alertas');

-- Asignación rol → permisos (§26).
--
-- Nota deliberada: el Administrador NO tiene journal_entry:approve. Administrar
-- el sistema y aprobar contabilidad son responsabilidades distintas, y la
-- segunda es del profesional matriculado (§42).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code IN (
  'company:read', 'company:write', 'company:create',
  'user:read', 'user:manage',
  'account:read', 'account:write', 'cost_center:read', 'cost_center:write',
  'period:read', 'period:write', 'period:reopen',
  'journal_entry:read', 'document:read', 'rule:read',
  'audit:read', 'report:read', 'alert:read', 'alert:acknowledge');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code IN (
  'company:read',
  'user:read',
  'account:read', 'account:write', 'cost_center:read', 'cost_center:write',
  'period:read', 'period:write', 'period:close', 'period:reopen',
  'journal_entry:read', 'journal_entry:create', 'journal_entry:approve', 'journal_entry:reverse',
  'document:read', 'document:upload', 'document:download',
  'rule:read', 'audit:read', 'report:read', 'alert:read', 'alert:acknowledge');

-- El Auditor ve todo y no toca nada. Que la lista sea solo de lectura no es una
-- omisión: es el rol.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'AUDITOR' AND p.code IN (
  'company:read', 'user:read', 'account:read', 'cost_center:read', 'period:read',
  'journal_entry:read', 'document:read', 'document:download',
  'rule:read', 'audit:read', 'report:read', 'alert:read');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'USUARIO_EMPRESA' AND p.code IN (
  'company:read', 'account:read', 'period:read',
  'document:read', 'document:upload', 'report:read', 'alert:read');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CARGADOR' AND p.code IN (
  'company:read', 'document:read', 'document:upload');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'SOLO_LECTURA' AND p.code IN (
  'company:read', 'account:read', 'cost_center:read', 'period:read',
  'journal_entry:read', 'document:read', 'report:read', 'alert:read');

-- ---------------------------------------------------------------------------
-- Resolución de permisos efectivos
-- ---------------------------------------------------------------------------
-- Deny by default: lo que no está concedido, no existe. La vigencia del rol se
-- evalúa a la fecha actual porque una asignación puede haber caducado.
CREATE OR REPLACE FUNCTION user_permissions(p_user_id uuid, p_company_id uuid)
RETURNS TABLE (code text)
LANGUAGE sql STABLE
AS $$
  SELECT DISTINCT p.code
    FROM user_company_roles ucr
    JOIN role_permissions rp ON rp.role_id = ucr.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE ucr.user_id = p_user_id
     AND ucr.company_id = p_company_id
     AND ucr.valid_from <= CURRENT_DATE
     AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE);
$$;

-- Las tablas de identidad no llevan company_id: un usuario existe a nivel del
-- estudio y puede tener rol distinto en cada empresa. El aislamiento sobre ellas
-- lo hace la capa de aplicación filtrando por organización.
GRANT SELECT ON permissions, roles, role_permissions TO aai_app;
GRANT SELECT, INSERT, UPDATE ON users, sessions, mfa_recovery_codes TO aai_app;
