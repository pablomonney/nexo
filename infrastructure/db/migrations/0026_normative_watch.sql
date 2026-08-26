-- 0026_normative_watch.sql — vigilancia normativa y relevamiento de habilitaciones.
--
-- La tabla que define esta migración es `norm_candidates`, y lo que importa de
-- ella es **lo que no tiene**: ninguna columna de texto normativo, ningún
-- `norm_version_id`, ninguna forma de que una fila de acá se convierta en una
-- norma citable sin que una persona archive el documento oficial.
--
-- Es la separación del §2 hecha esquema. `norms` y `norm_candidates` no se tocan:
-- no hay FK entre ellas, no hay trigger que promueva, no hay vista que las una.
-- El camino de candidato a norma pasa por el sistema de archivos —bajar el PDF,
-- calcular su sha256, escribir la fila en `registro-de-descargas.csv`— y por
-- `npm run norms:seed`. Un paso humano en el medio, deliberadamente.

-- ---------------------------------------------------------------------------
-- De dónde se mira
-- ---------------------------------------------------------------------------
CREATE TABLE norm_watch_sources (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  codigo       text NOT NULL UNIQUE,
  fuente       text NOT NULL
                 CHECK (fuente IN ('CKAN_DATOS_GOB_AR', 'BOLETIN_OFICIAL', 'SITIO_ORGANISMO')),
  organismo    text NOT NULL,
  url          text NOT NULL,
  -- `false` mientras nadie confirmó que la fuente sirve para lo que se espera.
  -- Una fuente activa sin verificar produce candidatos que nadie mira, y una
  -- bandeja de candidatos que nadie mira es peor que ninguna.
  activa       boolean NOT NULL DEFAULT false,
  ultima_corrida timestamptz,
  ultimo_resultado text,
  notas        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE norm_watch_sources IS
  'Fuentes que se miran para detectar normas nuevas. Detectar, no leer: el texto lo archiva una persona.';

-- ---------------------------------------------------------------------------
-- Qué apareció
-- ---------------------------------------------------------------------------
CREATE TABLE norm_candidates (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  source_id     uuid NOT NULL REFERENCES norm_watch_sources (id),
  -- Identificador que dio la fuente. NO es la clave: varias fuentes cambian sus
  -- ids entre corridas, y un id inestable como clave duplica candidatos.
  id_externo    text NOT NULL,
  titulo        text NOT NULL,
  url           text NOT NULL,
  publicado_el  date,
  -- Lo que la fuente devolvió, sin normalizar. Sin esto no se puede auditar por
  -- qué el sistema identificó —o no identificó— la norma que identificó.
  crudo         text NOT NULL,

  -- Identificación tentativa a partir del título. `NULL` cuando no se pudo, que
  -- es un resultado legítimo y frecuente.
  organismo     text,
  tipo          text,
  numero        text,
  anio          integer,

  estado        text NOT NULL DEFAULT 'NUEVO'
                  CHECK (estado IN ('NUEVO', 'YA_ARCHIVADO', 'DESCARTADO', 'NO_IDENTIFICABLE')),
  -- Quién lo descartó y por qué. Un candidato que desaparece sin explicación
  -- vuelve a aparecer en la próxima corrida y nadie recuerda por qué se fue.
  descartado_por text,
  descarte_motivo text,
  detectado_el  timestamptz NOT NULL DEFAULT now(),

  -- Un mismo ítem no se registra dos veces por fuente.
  UNIQUE (source_id, id_externo),

  CONSTRAINT candidato_descarte_justificado
    CHECK (estado <> 'DESCARTADO'
           OR (descartado_por IS NOT NULL AND length(btrim(coalesce(descarte_motivo, ''))) > 0)),

  -- La identificación viene entera o no viene. Media identificación —organismo
  -- sin número— no sirve para deduplicar ni para buscar.
  CONSTRAINT candidato_identificacion_completa
    CHECK ((organismo IS NULL AND tipo IS NULL AND numero IS NULL AND anio IS NULL)
           OR (organismo IS NOT NULL AND tipo IS NOT NULL AND numero IS NOT NULL AND anio IS NOT NULL))
);

CREATE INDEX norm_candidates_estado_idx ON norm_candidates (estado, detectado_el DESC);
CREATE INDEX norm_candidates_norma_idx ON norm_candidates (organismo, tipo, numero, anio);

CREATE TRIGGER norm_candidates_no_delete BEFORE DELETE ON norm_candidates
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

COMMENT ON TABLE norm_candidates IS
  'Normas detectadas y NO archivadas. No tiene norm_version_id ni texto: un candidato no se puede citar. El camino a norma pasa por archivar el documento con su hash.';

-- ---------------------------------------------------------------------------
-- El candado: un candidato no es una norma
-- ---------------------------------------------------------------------------
-- No hay FK ni trigger que promueva un candidato a norma. Este bloque lo deja
-- afirmado en el esquema para que quede en la migración y no solo en un
-- documento: si alguien agrega esa promoción, tiene que borrar este comentario y
-- explicar por qué.
--
-- La vista de abajo es de solo lectura y sirve para la bandeja de trabajo. Nota
-- que NO hace join con `norms`: el cruce se hace en el motor, sobre datos ya
-- cargados, y por eso `vigilar()` es una función pura.
CREATE VIEW norm_candidates_pendientes AS
SELECT c.id,
       s.codigo    AS fuente_codigo,
       s.organismo AS fuente_organismo,
       c.titulo,
       c.url,
       c.publicado_el,
       c.organismo,
       c.tipo,
       c.numero,
       c.anio,
       c.estado,
       c.detectado_el
  FROM norm_candidates c
  JOIN norm_watch_sources s ON s.id = c.source_id
 WHERE c.estado IN ('NUEVO', 'NO_IDENTIFICABLE')
 ORDER BY c.detectado_el DESC;

-- ---------------------------------------------------------------------------
-- Relevamiento de habilitaciones de ARCA
-- ---------------------------------------------------------------------------
-- `company_arca_capabilities` ya existía desde la 0015 con `enabled` y
-- `verified_at`. Lo que faltaba era impedir el error que este relevamiento puede
-- cometer: registrar como "no habilitado" un servicio que simplemente no
-- respondió.
--
-- `enabled = false` ahora exige `verified_at`: una negativa es una afirmación
-- sobre las delegaciones del CUIT y necesita la fecha en que se comprobó. Un
-- `NO_VERIFICABLE` no tiene fecha, así que no puede entrar por esta puerta.
ALTER TABLE company_arca_capabilities
  ADD CONSTRAINT capability_negativa_verificada
    CHECK (enabled OR verified_at IS NOT NULL);

-- Motivo de la última respuesta, para poder distinguir un rechazo de WSAA de una
-- caída sin volver a preguntar.
ALTER TABLE company_arca_capabilities
  ADD COLUMN last_probe_result text
    CHECK (last_probe_result IS NULL
           OR last_probe_result IN ('HABILITADO', 'NO_DELEGADO', 'NO_VERIFICABLE', 'SIN_CREDENCIAL'));

COMMENT ON CONSTRAINT capability_negativa_verificada ON company_arca_capabilities IS
  'Una negativa sin fecha sería una caída del organismo disfrazada de falta de delegación.';

-- ---------------------------------------------------------------------------
-- RLS y permisos
-- ---------------------------------------------------------------------------
-- `norm_watch_sources` y `norm_candidates` NO llevan company_id: la normativa es
-- del país, no de la empresa. Se leen desde cualquier contexto y se escriben con
-- credenciales de migración o por el script de vigilancia.
GRANT SELECT ON norm_watch_sources, norm_candidates, norm_candidates_pendientes TO aai_app;
REVOKE INSERT, UPDATE ON norm_watch_sources FROM aai_app;
-- El descarte de un candidato sí lo hace una persona desde la aplicación.
GRANT UPDATE (estado, descartado_por, descarte_motivo) ON norm_candidates TO aai_app;

INSERT INTO permissions (code, description) VALUES
  ('norm_watch:read',    'Ver la bandeja de normas detectadas'),
  ('norm_watch:dismiss', 'Descartar un candidato con motivo');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code IN ('norm_watch:read', 'norm_watch:dismiss');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('AUDITOR', 'ADMINISTRADOR') AND p.code = 'norm_watch:read';

DO $verificar$
DECLARE
  faltante text;
BEGIN
  SELECT string_agg(esperado.code, ', ')
    INTO faltante
    FROM (VALUES ('CONTADOR'), ('AUDITOR'), ('ADMINISTRADOR')) AS esperado(code)
   WHERE NOT EXISTS (
     SELECT 1 FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = esperado.code AND p.code = 'norm_watch:read'
   );
  IF faltante IS NOT NULL THEN
    RAISE EXCEPTION 'Los roles % no recibieron norm_watch:read.', faltante;
  END IF;
END
$verificar$;

-- ---------------------------------------------------------------------------
-- Estado declarado
-- ---------------------------------------------------------------------------
-- `norm_watch_sources` queda VACÍA. Cargar una fuente exige haber confirmado que
-- devuelve lo que se espera y con qué frecuencia; hacerlo desde una migración
-- sería activar un vigilante contra una URL que nadie miró.
--
-- El endpoint de CKAN de datos.gob.ar y el índice del Boletín Oficial están
-- documentados en OFFICIAL_SOURCES §7 como fuentes de actualización, con el
-- hallazgo de FASE 1 (R-22) de que el BO no es texto automatizable.
