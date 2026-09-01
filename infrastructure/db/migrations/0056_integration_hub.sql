-- 0056_integration_hub.sql — dónde aterriza lo que viene de afuera.
--
-- ## La decisión que gobierna todo el módulo
--
-- **Un conector nunca escribe en el motor contable.** Deja lo que trajo en una
-- zona de aterrizaje, y convertir eso en una entidad de NEXO es un acto
-- explícito, con permiso y con firma.
--
-- Es la misma forma que ADR-001 le impuso a la IA, y por el mismo motivo: un
-- sistema externo que escribe directo en el Diario es un sistema externo
-- decidiendo la contabilidad de la empresa. Que el que escribe sea un modelo o
-- la API de una tienda no cambia el problema.
--
--   TIENDA / BANCO / PLATAFORMA
--            ↓  (el conector solo deposita)
--   external_records          ← evidencia de lo que dijo el proveedor
--            ↓  (una persona resuelve)
--   parties · products · tax_transactions · commercial_documents
--            ↓
--   el circuito de siempre
--
-- ## El payload es evidencia, y no se edita
--
-- Lo que mandó el proveedor se guarda tal cual y es inmutable, igual que un
-- comprobante. Si el dato está mal, el registro se descarta con motivo y se
-- pide de nuevo — no se corrige por debajo, porque entonces dejaría de ser
-- prueba de lo que la plataforma efectivamente informó.
--
-- ## Idempotencia
--
-- El mismo pedido puede llegar tres veces: por la sincronización inicial, por
-- un webhook y por un reintento. `UNIQUE (empresa, integración, tipo,
-- external_id)` hace que las tres sean una sola fila. Sin eso, una venta
-- entraría triplicada y el error aparecería en el balance.
--
-- ## Qué se puede conectar hoy y qué no
--
-- El catálogo distingue **DISPONIBLE** de **PLANIFICADO**, y solo lo primero se
-- puede conectar. No es burocracia: listar Tiendanube como si funcionara sería
-- exactamente la clase de promesa que este sistema no hace.
--
-- Hoy hay un proveedor disponible —`IMPORTACION_MANUAL`— y no es un placeholder:
-- es el camino real por el que una empresa sube hoy la exportación de su tienda
-- o el resumen de su banco. Todos los conectores por API que vengan después
-- aterrizan en estas mismas vías, ya recorridas y probadas.

-- ---------------------------------------------------------------------------
-- 1 · El catálogo de proveedores
-- ---------------------------------------------------------------------------
CREATE TABLE integration_providers (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  categoria   text NOT NULL
                CHECK (categoria IN ('COMERCIO', 'PAGOS', 'MARKETING', 'BANCOS',
                                     'FISCAL', 'COMUNICACION', 'LOGISTICA', 'GENERICO')),
  -- DISPONIBLE: hay un camino que funciona hoy y está probado.
  -- PLANIFICADO: la arquitectura lo contempla y todavía no se puede conectar.
  estado      text NOT NULL DEFAULT 'PLANIFICADO'
                CHECK (estado IN ('DISPONIBLE', 'PLANIFICADO')),
  -- Cómo llegan los datos. Los conectores por API vendrán con OAUTH o API_KEY.
  autenticacion text NOT NULL DEFAULT 'NINGUNA'
                CHECK (autenticacion IN ('NINGUNA', 'API_KEY', 'OAUTH2')),
  notas       text
);

COMMENT ON TABLE integration_providers IS
  'Catálogo de integraciones. DISPONIBLE significa que hay un camino probado; '
  'PLANIFICADO que la arquitectura lo contempla y todavía no se puede conectar.';

INSERT INTO integration_providers (code, name, categoria, estado, autenticacion, notas) VALUES
  ('IMPORTACION_MANUAL', 'Importación manual', 'GENERICO', 'DISPONIBLE', 'NINGUNA',
   'Los registros se depositan por API desde una exportación de la plataforma de origen. '
   'Es el camino que recorre hoy la empresa y el que reutilizan los conectores automáticos.'),
  ('TIENDANUBE',   'Tiendanube',   'COMERCIO',     'PLANIFICADO', 'OAUTH2', NULL),
  ('MERCADO_LIBRE','Mercado Libre','COMERCIO',     'PLANIFICADO', 'OAUTH2', NULL),
  ('SHOPIFY',      'Shopify',      'COMERCIO',     'PLANIFICADO', 'OAUTH2', NULL),
  ('WOOCOMMERCE',  'WooCommerce',  'COMERCIO',     'PLANIFICADO', 'API_KEY', NULL),
  ('MERCADO_PAGO', 'Mercado Pago', 'PAGOS',        'PLANIFICADO', 'OAUTH2', NULL),
  ('META_ADS',     'Meta Ads',     'MARKETING',    'PLANIFICADO', 'OAUTH2', NULL),
  ('GOOGLE_ADS',   'Google Ads',   'MARKETING',    'PLANIFICADO', 'OAUTH2', NULL),
  ('BANCO',        'Banco',        'BANCOS',       'PLANIFICADO', 'API_KEY', NULL);

-- ---------------------------------------------------------------------------
-- 2 · La integración de una empresa con un proveedor
-- ---------------------------------------------------------------------------
CREATE TABLE company_integrations (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id              uuid NOT NULL REFERENCES companies (id),
  provider                text NOT NULL REFERENCES integration_providers (code),

  -- La cuenta en el proveedor. Una empresa puede tener dos tiendas.
  external_account_id     text NOT NULL,
  alias                   text NOT NULL CHECK (length(btrim(alias)) > 0),

  status                  text NOT NULL DEFAULT 'CONECTADA'
                            CHECK (status IN ('CONECTADA', 'AUTORIZACION_REQUERIDA',
                                              'ERROR', 'LIMITADA', 'DESCONECTADA')),

  -- Credenciales con el MISMO sobre que las de ARCA: DEK envuelta con la KEK,
  -- y `key_encryption_ref` diciendo quién la envolvió (`local:` / `kms:`). No
  -- se inventa un segundo esquema de cifrado (§70), y el existente ya se niega
  -- a desenvolver en producción lo que se envolvió con una llave de entorno.
  --
  -- Nulas para los proveedores sin autenticación. Nunca se guarda la contraseña
  -- del servicio externo: o hay token, o no hay nada.
  access_token_encrypted  text,
  refresh_token_encrypted text,
  key_encryption_ref      text,
  token_expires_at        timestamptz,
  scopes                  text[],

  last_sync_at            timestamptz,
  last_error              text,
  last_error_at           timestamptz,

  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              text NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  disconnected_at         timestamptz,
  disconnected_by         text,

  -- Una cuenta externa se conecta una sola vez por empresa. Dos integraciones
  -- a la misma tienda traerían cada pedido dos veces con external_id distinto
  -- por integración, y la idempotencia no lo vería.
  UNIQUE (company_id, provider, external_account_id),

  -- Si hay token, hay que decir con qué se lo envolvió. Un secreto cifrado sin
  -- referencia de envoltura es un secreto que nadie va a poder abrir.
  CONSTRAINT ci_token_con_sobre
    CHECK (access_token_encrypted IS NULL OR key_encryption_ref IS NOT NULL),

  CONSTRAINT ci_desconexion_firmada
    CHECK (status <> 'DESCONECTADA'
        OR (disconnected_at IS NOT NULL AND disconnected_by IS NOT NULL)),

  CONSTRAINT ci_error_con_texto
    CHECK (status <> 'ERROR' OR length(btrim(coalesce(last_error, ''))) > 2),

  CONSTRAINT ci_id_empresa UNIQUE (company_id, id)
);

CREATE INDEX ci_por_estado ON company_integrations (company_id, status);

COMMENT ON TABLE company_integrations IS
  'Conexión de una empresa con una cuenta de un proveedor. Los tokens van con '
  'el mismo sobre que las credenciales de ARCA. Nunca se guarda la contraseña '
  'del servicio externo.';

CREATE TRIGGER company_integrations_updated_at
  BEFORE UPDATE ON company_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Se desconecta, no se borra: el historial de lo que entró por esa integración
-- tiene que seguir explicándose.
CREATE TRIGGER company_integrations_no_delete
  BEFORE DELETE ON company_integrations
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 3 · Cada corrida de sincronización
-- ---------------------------------------------------------------------------
CREATE TABLE integration_sync_runs (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  integration_id      uuid NOT NULL,

  kind                text NOT NULL CHECK (kind IN ('INICIAL', 'INCREMENTAL', 'WEBHOOK')),
  status              text NOT NULL DEFAULT 'EN_CURSO'
                        CHECK (status IN ('EN_CURSO', 'COMPLETADA', 'FALLIDA', 'LIMITADA')),

  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,

  records_received    integer NOT NULL DEFAULT 0 CHECK (records_received >= 0),
  records_new         integer NOT NULL DEFAULT 0 CHECK (records_new >= 0),
  records_duplicados  integer NOT NULL DEFAULT 0 CHECK (records_duplicados >= 0),

  -- La marca de agua de la sincronización incremental: hasta dónde se leyó.
  cursor              text,
  error               text,

  created_by          text NOT NULL,

  CONSTRAINT isr_terminada_con_fecha
    CHECK (status = 'EN_CURSO' OR finished_at IS NOT NULL),
  CONSTRAINT isr_fallida_con_error
    CHECK (status <> 'FALLIDA' OR length(btrim(coalesce(error, ''))) > 2),
  -- Lo recibido es lo nuevo más lo duplicado. Sin esto los contadores podrían
  -- decir cualquier cosa y el informe de salud mentiría en silencio.
  CONSTRAINT isr_cuentas_cierran
    CHECK (records_received = records_new + records_duplicados),

  CONSTRAINT isr_integracion_fk
    FOREIGN KEY (company_id, integration_id)
    REFERENCES company_integrations (company_id, id),

  CONSTRAINT isr_id_empresa UNIQUE (company_id, id)
);

CREATE INDEX isr_por_integracion
  ON integration_sync_runs (company_id, integration_id, started_at DESC);

CREATE TRIGGER integration_sync_runs_no_delete
  BEFORE DELETE ON integration_sync_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 4 · La zona de aterrizaje
-- ---------------------------------------------------------------------------
CREATE TABLE external_records (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id             uuid NOT NULL REFERENCES companies (id),
  integration_id         uuid NOT NULL,
  sync_run_id            uuid,

  kind                   text NOT NULL
                           CHECK (kind IN ('CLIENTE', 'PROVEEDOR', 'PRODUCTO', 'ORDEN',
                                           'PAGO', 'MOVIMIENTO_BANCARIO', 'CAMPANIA')),
  external_id            text NOT NULL CHECK (length(btrim(external_id)) > 0),
  occurred_at            timestamptz,

  -- Lo que dijo el proveedor, tal cual. Es evidencia: inmutable.
  payload                jsonb NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),

  status                 text NOT NULL DEFAULT 'SIN_RESOLVER'
                           CHECK (status IN ('SIN_RESOLVER', 'RESUELTO', 'DESCARTADO')),
  motivo_descarte        text,

  -- A qué entidad de NEXO se resolvió. Columnas tipadas y no una referencia
  -- polimórfica: una columna `entidad_id` suelta no la puede validar ninguna
  -- clave foránea, y sería otro uuid apuntando a nada —el defecto que encontró
  -- la auditoría en la 0005—.
  party_id               uuid,
  product_id             uuid,
  tax_transaction_id     uuid,
  commercial_document_id uuid,

  resolved_at            timestamptz,
  resolved_by            text,

  -- Idempotencia: el mismo pedido por sincronización inicial, por webhook y por
  -- reintento es UNA fila.
  UNIQUE (company_id, integration_id, kind, external_id),

  CONSTRAINT er_descarte_con_motivo
    CHECK (status <> 'DESCARTADO' OR length(btrim(coalesce(motivo_descarte, ''))) > 2),

  -- RESUELTO exige exactamente una entidad y su firma. Las dos mitades: sin la
  -- primera quedaría «resuelto» sin decir a qué; sin la segunda, sin saber quién.
  CONSTRAINT er_resuelto_con_entidad
    CHECK ((status = 'RESUELTO') = (
      (party_id IS NOT NULL)::int + (product_id IS NOT NULL)::int
    + (tax_transaction_id IS NOT NULL)::int + (commercial_document_id IS NOT NULL)::int = 1)),
  CONSTRAINT er_resuelto_firmado
    CHECK (status <> 'RESUELTO' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),

  CONSTRAINT er_integracion_fk
    FOREIGN KEY (company_id, integration_id)
    REFERENCES company_integrations (company_id, id),
  CONSTRAINT er_run_fk
    FOREIGN KEY (company_id, sync_run_id)
    REFERENCES integration_sync_runs (company_id, id),
  CONSTRAINT er_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT er_product_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT er_tt_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id),
  CONSTRAINT er_cd_fk
    FOREIGN KEY (company_id, commercial_document_id)
    REFERENCES commercial_documents (company_id, id)
);

CREATE INDEX er_pendientes ON external_records (company_id, status, kind)
  WHERE status = 'SIN_RESOLVER';
CREATE INDEX er_por_integracion ON external_records (company_id, integration_id, received_at DESC);

COMMENT ON TABLE external_records IS
  'Zona de aterrizaje: lo que trajo un conector, antes de ser nada de NEXO. El '
  'payload es evidencia y no se edita. Convertirlo en una entidad es un acto '
  'explícito y firmado.';

CREATE TRIGGER external_records_no_delete
  BEFORE DELETE ON external_records
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- El payload y la identidad externa no se tocan. Lo único que puede cambiar es
-- la resolución: si el dato llegó mal, se descarta y se vuelve a pedir.
CREATE OR REPLACE FUNCTION assert_payload_externo_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.integration_id IS DISTINCT FROM OLD.integration_id THEN
    RAISE EXCEPTION
      'E_EXT_INMUTABLE: lo que informó el proveedor es evidencia y no se edita. Descartalo con motivo y volvé a pedirlo.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER external_records_payload_inmutable
  BEFORE UPDATE ON external_records
  FOR EACH ROW EXECUTE FUNCTION assert_payload_externo_inmutable();

-- ---------------------------------------------------------------------------
-- 5 · Solo se conecta lo que está disponible
-- ---------------------------------------------------------------------------
-- Sin esto, la tabla aceptaría una integración a Tiendanube y la pantalla
-- diría CONECTADA sobre algo que no tiene conector. La distinción entre lo que
-- existe y lo que está planificado deja de ser documentación y pasa a ser un
-- candado.
CREATE OR REPLACE FUNCTION assert_proveedor_disponible() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  estado_proveedor text;
BEGIN
  SELECT p.estado INTO estado_proveedor
    FROM integration_providers p WHERE p.code = NEW.provider;

  IF estado_proveedor <> 'DISPONIBLE' THEN
    RAISE EXCEPTION
      'E_INT_NO_DISPONIBLE: el proveedor % está %, todavía no se puede conectar.',
      NEW.provider, estado_proveedor
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER company_integrations_proveedor_disponible
  BEFORE INSERT ON company_integrations
  FOR EACH ROW EXECUTE FUNCTION assert_proveedor_disponible();

-- ---------------------------------------------------------------------------
-- 6 · La salud de cada integración, derivada
-- ---------------------------------------------------------------------------
CREATE VIEW integration_health WITH (security_invoker = true) AS
SELECT i.company_id,
       i.id                                        AS integration_id,
       i.provider,
       p.name                                      AS proveedor_nombre,
       p.categoria,
       i.alias,
       i.external_account_id,
       i.status,
       i.last_sync_at,
       i.last_error,
       i.last_error_at,
       -- El token vencido es un hecho de la fecha, no un estado que alguien
       -- tenga que acordarse de escribir.
       (i.token_expires_at IS NOT NULL AND i.token_expires_at < now()) AS token_vencido,
       coalesce(r.pendientes, 0)                   AS registros_sin_resolver,
       coalesce(r.resueltos, 0)                    AS registros_resueltos,
       coalesce(r.descartados, 0)                  AS registros_descartados,
       s.ultima_corrida,
       s.ultimo_estado
  FROM company_integrations i
  JOIN integration_providers p ON p.code = i.provider
  LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE e.status = 'SIN_RESOLVER')::int AS pendientes,
               count(*) FILTER (WHERE e.status = 'RESUELTO')::int     AS resueltos,
               count(*) FILTER (WHERE e.status = 'DESCARTADO')::int   AS descartados
          FROM external_records e
         WHERE e.integration_id = i.id AND e.company_id = i.company_id
       ) r ON true
  LEFT JOIN LATERAL (
        SELECT sr.started_at AS ultima_corrida, sr.status AS ultimo_estado
          FROM integration_sync_runs sr
         WHERE sr.integration_id = i.id AND sr.company_id = i.company_id
         ORDER BY sr.started_at DESC
         LIMIT 1
       ) s ON true;

COMMENT ON VIEW integration_health IS
  'Estado de cada integración con sus contadores derivados. token_vencido se '
  'calcula de la fecha: no es un estado que alguien tenga que escribir.';

-- ---------------------------------------------------------------------------
-- 7 · Las ramas de integraciones en la bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_integraciones WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 32 · Llegó algo de afuera y nadie dijo qué es.
--      Es el trabajo que el diseño crea a propósito: el conector deposita, una
--      persona resuelve. Mientras no se resuelva, no es nada de NEXO.
SELECT e.company_id,
       'EXTERNO_SIN_RESOLVER'::text                 AS rama,
       'REQUIERE_DECLARACION'::text                 AS categoria,
       'external_records'::text                     AS entidad,
       e.id                                         AS entity_id,
       e.status                                     AS estado,
       'Llegó ' || lower(e.kind) || ' ' || e.external_id || ' de ' || i.alias ||
         ' y todavía no se resolvió contra ninguna entidad' AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       e.received_at                                AS creado_en,
       e.received_at                                AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/external-records/' || e.id                 AS traza_ref
  FROM external_records e
  JOIN company_integrations i ON i.id = e.integration_id AND i.company_id = e.company_id
 WHERE e.status = 'SIN_RESOLVER'

UNION ALL

-- 33 · La integración dejó de poder traer datos.
--      No se resuelve desde adentro: hay que volver a autorizar en el
--      proveedor, o esperar a que el límite se libere. Es informativo.
SELECT i.company_id,
       'INTEGRACION_INTERRUMPIDA'::text             AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text              AS categoria,
       'company_integrations'::text                 AS entidad,
       i.id                                         AS entity_id,
       i.status                                     AS estado,
       i.alias || ' está en ' || i.status ||
         coalesce(': ' || i.last_error, '')         AS motivo,
       false                                        AS bloquea,
       ARRAY['autorización del proveedor']::text[]  AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'INFORMATIVO'::text                          AS disponibilidad,
       i.created_at                                 AS creado_en,
       i.updated_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/integrations/' || i.id                     AS traza_ref
  FROM company_integrations i
 WHERE i.status IN ('AUTORIZACION_REQUERIDA', 'ERROR', 'LIMITADA')

) q;

COMMENT ON VIEW work_queue_integraciones IS
  'Ramas del hub. EXTERNO_SIN_RESOLVER es trabajo que el diseño crea a '
  'propósito: nada de afuera se convierte en entidad de NEXO sin que alguien lo diga.';

DROP VIEW work_queue;
CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

-- ---------------------------------------------------------------------------
-- 8 · Permisos
-- ---------------------------------------------------------------------------
-- Conectar una integración le da a un sistema externo una puerta a los datos de
-- la empresa. Es una decisión de administración, no de operación.
INSERT INTO permissions (code, description) VALUES
  ('integration:read',    'Consultar integraciones, su salud y lo que trajeron'),
  ('integration:connect', 'Conectar y desconectar integraciones con proveedores externos'),
  ('integration:ingest',  'Depositar registros externos en la zona de aterrizaje'),
  ('integration:resolve', 'Resolver un registro externo contra una entidad de NEXO');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'integration:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code = 'integration:connect';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code IN ('integration:ingest', 'integration:resolve');

-- ---------------------------------------------------------------------------
-- 9 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE company_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_integrations
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE integration_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_sync_runs
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE external_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON external_records
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- El catálogo de proveedores es común a todas las empresas y no lleva RLS: no
-- tiene `company_id` y no dice nada de nadie.
GRANT SELECT ON integration_providers TO aai_app;
GRANT SELECT, INSERT, UPDATE ON company_integrations TO aai_app;
GRANT SELECT, INSERT, UPDATE ON integration_sync_runs TO aai_app;
GRANT SELECT, INSERT, UPDATE ON external_records TO aai_app;
GRANT SELECT ON integration_health TO aai_app;
GRANT SELECT ON work_queue_integraciones TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
