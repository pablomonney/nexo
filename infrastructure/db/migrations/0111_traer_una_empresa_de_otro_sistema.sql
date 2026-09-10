-- ============================================================================
-- 0111 — Traer una empresa de otro sistema
-- ============================================================================
--
-- Una empresa que llega a NEXO no llega vacía: llega con años de clientes,
-- productos, comprobantes y asientos en el sistema del que viene. Sin una forma
-- de traerlos, cambiar de sistema significa perder el historial o cargarlo a
-- mano, y las dos son razones suficientes para no cambiar.
--
-- ## Lo que este esquema no hace
--
-- **No es un segundo Integration Hub.** Ese ya existe (0056) y resuelve otra
-- cosa: la sincronización continua de hechos nuevos —una venta de Mercado
-- Libre, un movimiento del banco— que llegan de a uno y para siempre. Una
-- migración es lo contrario: pasa una vez, trae todo junto, y termina.
--
-- Lo que sí comparten es la regla, y por eso se repite acá: **nada de lo que
-- entra escribe directo en el motor contable**. Aterriza en estas tablas, una
-- persona lo revisa contra una vista previa, y recién ahí se escribe. Es la
-- misma forma que la ADR-001 le impuso a la IA.
--
-- ## Las cuatro tablas y por qué son cuatro
--
--   migrations        una migración: de dónde, quién, en qué estado
--   migration_tables  cada tabla del origen, con sus columnas y su mapeo
--   migration_rows    cada fila cruda, tal como vino, más su interpretación
--   migration_links   qué fila del origen se convirtió en qué fila de NEXO
--
-- La cuarta es la que hace posibles la idempotencia y el rollback. Sin ella,
-- «volver a correr la migración» significa duplicar todo, y «deshacerla»
-- significa adivinar qué filas eran suyas.
--
-- ## Por qué la fila cruda se guarda entera
--
-- Para poder contestar «¿de dónde salió este dato?». Un cliente importado sin
-- su fila de origen es un cliente que nadie puede auditar contra el sistema del
-- que vino, y esa trazabilidad es la mitad del valor de migrar con un sistema
-- en vez de con una planilla.
-- ============================================================================

-- ── La migración ───────────────────────────────────────────────────────────

CREATE TABLE migrations (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies(id),

  -- El código del adaptador, tal como lo declara el registro del motor. No hay
  -- catálogo en la base a propósito: el registro del código es la única fuente
  -- de verdad sobre qué adaptadores existen, y una tabla espejo se
  -- desincronizaría en cuanto alguien agregue uno.
  adaptador      text NOT NULL,
  titulo         text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 1 AND 200),

  estado         text NOT NULL DEFAULT 'CREADA' CHECK (estado IN (
                   'CREADA','CARGADA','ANALIZADA','MAPEADA','VALIDADA','LISTA',
                   'IMPORTANDO','COMPLETADA','COMPLETADA_CON_ADVERTENCIAS',
                   'FALLIDA','REVERTIDA')),

  -- Hasta qué fecha se trae historia. `null` es «todo lo que haya», y es
  -- distinto de una fecha: no es lo mismo no haber elegido que haber elegido
  -- traer todo.
  fecha_corte    date,
  estrategia     text NOT NULL DEFAULT 'HISTORICO_COMPLETO' CHECK (
                   estrategia IN ('HISTORICO_COMPLETO','APERTURA_Y_SELECTIVO','SOLO_SALDOS')),

  archivo_nombre text,
  archivo_hash   text,
  archivo_bytes  bigint CHECK (archivo_bytes IS NULL OR archivo_bytes >= 0),

  creada_el      timestamptz NOT NULL DEFAULT now(),
  creada_por     text NOT NULL,
  importada_el   timestamptz,
  revertida_el   timestamptz,
  error          text,

  -- Una migración terminada tiene que decir cuándo. Sin esto, el estado y la
  -- fecha se pueden contradecir y no hay forma de saber cuál miente.
  CONSTRAINT mig_terminada_con_fecha CHECK (
    estado NOT IN ('COMPLETADA','COMPLETADA_CON_ADVERTENCIAS') OR importada_el IS NOT NULL),
  CONSTRAINT mig_revertida_con_fecha CHECK (
    estado <> 'REVERTIDA' OR revertida_el IS NOT NULL),
  CONSTRAINT mig_fallida_con_motivo CHECK (
    estado <> 'FALLIDA' OR length(btrim(coalesce(error,''))) > 0)
);

CREATE INDEX migrations_company_idx ON migrations (company_id, creada_el DESC);

-- ── Las tablas del origen ──────────────────────────────────────────────────

CREATE TABLE migration_tables (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  migration_id  uuid NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,

  nombre        text NOT NULL,
  columnas      jsonb NOT NULL CHECK (jsonb_typeof(columnas) = 'array'),

  -- A qué entidad canónica corresponde. `null` mientras nadie lo haya decidido:
  -- la sugerencia automática no se guarda como si fuera una decisión.
  entidad       text CHECK (entidad IS NULL OR entidad IN (
                  'PARTY','PRODUCT','ACCOUNT','JOURNAL_ENTRY','STOCK_BALANCE',
                  'STOCK_MOVEMENT','SALES_DOCUMENT','PURCHASE_DOCUMENT','PAYMENT')),
  -- columna de origen → campo canónico.
  mapeo         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mapeo) = 'object'),
  -- Si esta tabla entra en la importación. Una exportación trae hojas que no
  -- interesan, y saltearlas es una decisión, no un descarte silencioso.
  incluida      boolean NOT NULL DEFAULT true,
  filas         integer NOT NULL DEFAULT 0 CHECK (filas >= 0),

  UNIQUE (migration_id, nombre)
);

CREATE INDEX migration_tables_mig_idx ON migration_tables (migration_id);

-- ── Las filas, tal como vinieron ───────────────────────────────────────────

CREATE TABLE migration_rows (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  migration_id  uuid NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL REFERENCES migration_tables(id) ON DELETE CASCADE,

  -- El número de fila dentro del origen. Es la mitad de la respuesta a «de
  -- dónde salió esto»; la otra mitad es el nombre de la tabla.
  numero        integer NOT NULL CHECK (numero >= 1),
  -- Los valores crudos, en el orden de las columnas. Inmutable: si el dato vino
  -- mal, se corrige en el origen y se vuelve a migrar. Corregirlo acá lo dejaría
  -- de ser prueba de lo que el sistema anterior efectivamente tenía.
  crudo         jsonb NOT NULL CHECK (jsonb_typeof(crudo) = 'array'),
  -- Lo que el normalizador entendió. `null` hasta que se normaliza.
  normalizado   jsonb,
  -- El identificador que traía el sistema de origen, si traía alguno.
  id_externo    text,
  hash          text NOT NULL,

  estado        text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                  'PENDIENTE','VALIDA','CON_ADVERTENCIA','RECHAZADA',
                  'IMPORTADA','YA_EXISTIA','OMITIDA')),

  UNIQUE (table_id, numero)
);

CREATE INDEX migration_rows_mig_idx ON migration_rows (migration_id, estado);
CREATE INDEX migration_rows_tabla_idx ON migration_rows (table_id, numero);

-- ── Los hallazgos de la validación ─────────────────────────────────────────

CREATE TABLE migration_findings (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  migration_id  uuid NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  row_id        uuid REFERENCES migration_rows(id) ON DELETE CASCADE,

  nivel         text NOT NULL CHECK (nivel IN ('ERROR','ADVERTENCIA','INFO')),
  codigo        text NOT NULL,
  mensaje       text NOT NULL,
  campo         text,
  fila          text NOT NULL
);

CREATE INDEX migration_findings_mig_idx ON migration_findings (migration_id, nivel);

-- ── El puente entre el origen y NEXO ───────────────────────────────────────

CREATE TABLE migration_links (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  migration_id  uuid NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  row_id        uuid REFERENCES migration_rows(id) ON DELETE SET NULL,

  entidad       text NOT NULL,
  -- La tabla y la fila de NEXO que se crearon. Sin esto no hay rollback: no
  -- habría forma de saber qué filas de `parties` vinieron de esta migración.
  tabla_destino text NOT NULL,
  id_destino    uuid NOT NULL,

  /**
   * La identidad con la que este registro se reconoce en la próxima corrida.
   *
   * Es `sistema:entidad:id_externo` y es UNIQUE por empresa: correr la misma
   * migración dos veces choca contra esta restricción en vez de duplicar. La
   * idempotencia vive en la base y no en el código a propósito — el código se
   * saltea llamando a otra ruta.
   */
  identidad     text NOT NULL,
  creado        boolean NOT NULL DEFAULT true,
  vinculado_el  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, identidad)
);

CREATE INDEX migration_links_mig_idx ON migration_links (migration_id);
CREATE INDEX migration_links_destino_idx ON migration_links (tabla_destino, id_destino);

-- ── Aislamiento ────────────────────────────────────────────────────────────
--
-- Las cinco tablas llevan `company_id` y RLS forzado. Una migración de una
-- empresa jamás puede ver ni tocar la de otra, y `FORCE` incluye al dueño de
-- la tabla: sin él, el rol que corre las migraciones vería todo.

ALTER TABLE migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE migrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migrations
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE migration_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_tables
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE migration_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_rows
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE migration_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_findings
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE migration_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_links
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- ── Permisos ───────────────────────────────────────────────────────────────
--
-- La 0009 concede escritura sobre toda tabla nueva con ALTER DEFAULT
-- PRIVILEGES, así que estas ya nacen escribibles. Lo que hace falta es quitar
-- el DELETE: una fila cruda no se borra, y un vínculo tampoco — revertir una
-- migración marca, no borra, porque el registro de que existió es parte de la
-- auditoría. La única excepción es el borrado en cascada al eliminar la
-- migración entera, que hace la clave foránea y no pasa por este permiso.

REVOKE DELETE ON migrations, migration_tables, migration_rows,
                 migration_findings, migration_links FROM aai_app;

CREATE OR REPLACE FUNCTION migration_rows_son_inmutables()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Lo crudo es prueba de lo que el sistema anterior tenía. Se le puede agregar
  -- la interpretación y cambiar el estado; lo que vino no se toca.
  IF NEW.crudo IS DISTINCT FROM OLD.crudo OR NEW.hash IS DISTINCT FROM OLD.hash THEN
    RAISE EXCEPTION 'La fila cruda de una migración no se modifica: se vuelve a migrar'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER migration_rows_inmutables
  BEFORE UPDATE ON migration_rows
  FOR EACH ROW EXECUTE FUNCTION migration_rows_son_inmutables();

-- ── Vocabulario de auditoría ───────────────────────────────────────────────
--
-- Pasa por `audit_logs`, que ya existe y ya encadena con hash. No se crea una
-- segunda bitácora: dos bitácoras es ninguna.

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('CREAR_MIGRACION',      'migracion', false),
  ('MAPEAR_MIGRACION',     'migracion', false),
  ('VALIDAR_MIGRACION',    'migracion', false),
  ('IMPORTAR_MIGRACION',   'migracion', false),
  -- Revertir deshace escrituras en la empresa. Sin motivo, seis meses después
  -- nadie sabe si fue un error de datos o una decisión.
  ('REVERTIR_MIGRACION',   'migracion', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;

-- ── Permisos de aplicación ─────────────────────────────────────────────────

INSERT INTO permissions (code, description) VALUES
  ('migration:read',   'Ver las migraciones de la empresa y sus reportes'),
  ('migration:write',  'Crear una migración, cargar el origen y mapear'),
  -- Importar escribe en la empresa: es un permiso aparte del de preparar, para
  -- que alguien pueda armar la migración sin poder ejecutarla.
  ('migration:import', 'Ejecutar la importación y revertirla')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.code IN ('migration:read','migration:write','migration:import')
   AND r.code IN ('ADMINISTRADOR','CONTADOR')
ON CONFLICT DO NOTHING;

-- El resto de los roles solo mira.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.code = 'migration:read'
   AND r.code IN ('AUDITOR')
ON CONFLICT DO NOTHING;
