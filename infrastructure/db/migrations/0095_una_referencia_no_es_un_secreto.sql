-- ============================================================================
-- 0095 — Una referencia no es un secreto
-- ============================================================================
--
-- NEXO guarda material sensible en tres lugares, y cada uno se resolvió por su
-- cuenta:
--
--   `company_arca_credentials.private_key_encrypted`  sobre local, con una
--       referencia de envoltura (`local:` / `kms:`) que se niega a operar en
--       producción. **Es el diseño correcto**, y es el que esta migración
--       generaliza.
--   `users.mfa_secret_encrypted`                      sobre local, sin
--       referencia, y en producción **exige** una KEK del entorno.
--   `company_integrations.access_token_encrypted`     columnas que nadie
--       escribe: el flujo de OAuth no está construido.
--
-- Los dos primeros protegen material equivalente contra la misma amenaza —un
-- volcado de la base— y llegaron a decisiones opuestas sobre si una KEK en una
-- variable de entorno alcanza. Esta tabla es el lugar donde esa decisión se toma
-- una vez.
--
-- ## Qué guarda, y qué no
--
-- **No guarda el valor. No hay columna donde ponerlo.** No es una regla que
-- alguien pueda olvidarse de aplicar: es que no existe el lugar. Es el mismo
-- criterio del schema del agente de clasificación, que no tiene dónde escribir
-- un importe.
--
-- Guarda **la referencia**: dónde está el secreto en el gestor que lo tiene. Un
-- ARN, una ruta de Vault, el nombre de una variable de entorno. Esa cadena no es
-- sensible —conocerla no da acceso— y es lo que permite cambiar de gestor sin
-- tocar el resto del sistema.
--
-- ## Las cuatro decisiones
--
-- **1. La identidad es `(empresa, scope, nombre, versión)`.** El valor nunca es
-- parte de la identidad: dos secretos con el mismo contenido siguen siendo dos.
-- Y `company_id` es nullable a propósito: hay secretos que son del despliegue
-- —el token del recolector de métricas— y no de ninguna empresa. Un `NOT NULL`
-- con una empresa «del sistema» inventada sería peor: esa fila aparecería en
-- cada listado por empresa.
--
-- **2. Rotar es agregar una versión, no editar una fila.** La anterior queda
-- `SUPERSEDIDO` y se puede revocar después. Esa ventana en la que las dos
-- existen es lo que permite rotar sin cortar el servicio: se declara la nueva,
-- se comprueba que funciona, y recién ahí se apaga la vieja. Editar en el lugar
-- obligaría a que el cambio fuera instantáneo y perfecto.
--
-- **3. No se borra.** Un secreto revocado sigue siendo la respuesta a «con qué
-- credencial se firmó esto en marzo». Borrarlo dejaría a `arca_query_log`
-- apuntando a una fila que no está.
--
-- **4. RLS por empresa, con `FORCE`.** El aislamiento no depende de que el
-- código pase el `company_id` correcto: la base no devuelve la fila. Y las del
-- despliegue —`company_id IS NULL`— no las ve ninguna empresa, que es lo
-- correcto: un cliente no tiene por qué saber qué integraciones tiene la
-- instalación.
-- ============================================================================

CREATE TABLE secret_refs (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),

  -- `NULL` = del despliegue, no de una empresa.
  company_id     uuid REFERENCES companies (id),
  -- Para qué integración: `ai`, `arca`, `pagos`. No un nombre de proveedor: el
  -- scope sobrevive a un cambio de proveedor y el nombre del proveedor no.
  scope          text NOT NULL CHECK (scope ~ '^[a-z][a-z0-9-]{1,30}$'),
  -- Cuál de esa integración: `api-key`, `clave-privada`.
  name           text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,60}$'),
  version        integer NOT NULL CHECK (version >= 1),

  -- Dónde está el secreto. **No es el secreto.**
  --
  -- El prefijo dice qué backend lo tiene, igual que `key_encryption_ref`:
  --   `env:AI_API_KEY`         una variable de entorno del proceso.
  --   `db:<uuid>`              una fila envuelta localmente. Solo desarrollo.
  --   `kms:<arn|ruta>`         un gestor externo. **Todavía no hay ninguno.**
  reference      text NOT NULL CHECK (reference ~ '^(env|db|kms|mem):.+$'),

  status         text NOT NULL DEFAULT 'ACTIVO'
                 CHECK (status IN ('ACTIVO', 'SUPERSEDIDO', 'REVOCADO')),

  -- Lo que el gestor informe. **No se inventa una vigencia**: sin dato, `NULL`,
  -- que es «no se puede afirmar» y no «no vence».
  expires_at     timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  motivo         text NOT NULL CHECK (length(btrim(motivo)) >= 5),
  revoked_at     timestamptz,
  revoked_by     text,
  motivo_revocacion text,

  CONSTRAINT secret_refs_version_unica UNIQUE NULLS NOT DISTINCT
    (company_id, scope, name, version),
  CONSTRAINT secret_refs_revocado_con_motivo
    CHECK (status <> 'REVOCADO' OR (revoked_at IS NOT NULL AND motivo_revocacion IS NOT NULL))
);

-- Una sola versión ACTIVA por secreto. Dos vigentes a la vez dejarían al
-- resolvedor eligiendo, y la elección sería por orden de inserción: es decir,
-- por azar.
CREATE UNIQUE INDEX secret_refs_una_activa
  ON secret_refs (company_id, scope, name)
  NULLS NOT DISTINCT
  WHERE status = 'ACTIVO';

CREATE INDEX secret_refs_por_empresa ON secret_refs (company_id, scope, created_at DESC);

ALTER TABLE secret_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_refs FORCE ROW LEVEL SECURITY;

-- Las del despliegue (`company_id IS NULL`) no las ve ninguna empresa: un
-- cliente no tiene por qué saber qué integraciones tiene la instalación.
CREATE POLICY secret_refs_por_empresa ON secret_refs
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON secret_refs TO aai_app;

COMMENT ON TABLE secret_refs IS
  'Dónde está cada secreto, nunca su valor: no hay columna donde ponerlo. '
  'Rotar es agregar una versión; la anterior queda SUPERSEDIDO y se revoca '
  'después, y esa ventana es lo que permite rotar sin cortar.';

COMMENT ON COLUMN secret_refs.reference IS
  'Referencia al secreto en el backend que lo tiene: env:VARIABLE, db:<uuid>, '
  'kms:<arn>. Conocerla no da acceso.';

-- ---------------------------------------------------------------------------
-- Permiso
-- ---------------------------------------------------------------------------
--
-- Administrar una referencia y **usar** la integración que la necesita son dos
-- cosas distintas. Quien puede emitir un comprobante usa el certificado de ARCA
-- sin poder tocarlo; quien administra las credenciales no necesariamente factura.
--
-- Se otorga solo a ADMINISTRADOR. CONTADOR queda afuera a propósito: rotar la
-- credencial de una integración no es un acto contable, y el permiso más chico
-- que funciona es el correcto.
INSERT INTO permissions (code, description) VALUES
  ('secret:manage', 'Declarar, rotar y revocar referencias de secretos de integraciones');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code = 'secret:manage';

-- Las acciones de gestión (0091: una acción sin registrar no se puede escribir).
-- Las tres exigen motivo: una credencial que cambió sin explicación, seis meses
-- después, es una pregunta sin respuesta en una auditoría.
INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('DECLARAR_REFERENCIA_DE_SECRETO', 'secretos', true),
  ('ROTAR_REFERENCIA_DE_SECRETO',    'secretos', true),
  ('REVOCAR_REFERENCIA_DE_SECRETO',  'secretos', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;

-- ---------------------------------------------------------------------------
-- La vista pública
-- ---------------------------------------------------------------------------
--
-- Existe por el mismo motivo que `company_arca_credentials_public`: para que
-- una ruta que lista no tenga que acordarse de excluir columnas. Acá no hay
-- ninguna sensible que excluir —la tabla no guarda el valor— pero la vista
-- documenta qué es lo que se puede mostrar, y `security_invoker` mantiene el
-- RLS del que consulta.
CREATE VIEW secret_refs_public WITH (security_invoker = true) AS
SELECT id, company_id, scope, name, version, status,
       -- El prefijo sí; el resto de la referencia no hace falta en una pantalla
       -- y un ARN completo dice de más sobre la infraestructura.
       split_part(reference, ':', 1) AS backend,
       expires_at, metadata, created_at, created_by, motivo,
       revoked_at, revoked_by,
       (expires_at IS NOT NULL AND expires_at <= now()) AS vencido
  FROM secret_refs;

GRANT SELECT ON secret_refs_public TO aai_app;

COMMENT ON VIEW secret_refs_public IS
  'Lo que se puede mostrar de un secreto: su identidad, su estado y su backend. '
  'Ni el valor —que no está en la tabla— ni la referencia completa, que dice de '
  'más sobre la infraestructura.';
