-- 0001_marca_de_sandbox.sql — la prueba de que esta base es un sandbox.
--
-- Este archivo **no está en `infrastructure/db/migrations/`**, y esa ubicación es
-- el diseño entero.
--
-- El runner de migraciones aplica todo lo que encuentra en ese directorio, contra
-- la base que diga `DATABASE_URL`. Si la marca viviera ahí, producción la
-- recibiría en el próximo deploy y quedaría, para siempre, indistinguible de un
-- sandbox. El control se habría autodestruido sin que nadie escribiera una línea
-- de más.
--
-- Vive aparte y la aplica solamente `npm run sandbox:create`, sobre la base que
-- ese comando acaba de crear. Es el único camino por el que una base puede probar
-- que es un sandbox.
--
-- ## Qué prueba y qué no
--
-- No prueba que la base esté vacía de datos reales: alguien puede copiar un dump
-- de producción a un sandbox, y eso es un problema de manejo de datos personales,
-- no de este archivo. Lo que prueba es la dirección contraria, que es la que
-- importa acá: **que una simulación no escriba en producción**.

CREATE TABLE sandbox_marker (
  -- Una sola fila, siempre. Un marcador con dos filas contradiciéndose no sería
  -- una prueba de nada.
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),

  -- El valor exacto que `verificarAislamiento` exige. No es un secreto y no
  -- cumple ninguna función criptográfica: la marca vale porque está en la base
  -- correcta, no porque su contenido sea difícil de adivinar. Está para que una
  -- tabla creada a mano, vacía o a medias, no cuente.
  sello           text NOT NULL CHECK (sello = 'AAI_SANDBOX_V1'),

  -- Hasta qué migración de producción se construyó. Un sandbox rezagado sigue
  -- siendo un sandbox válido, pero deja de reflejar el sistema — y eso es lo
  -- único que un sandbox tiene que hacer bien.
  migracion_tope  text NOT NULL,

  creado_el       timestamptz NOT NULL DEFAULT now(),
  creado_por      text NOT NULL CHECK (length(btrim(creado_por)) > 0),

  -- Se escribe una vez y se lee muchas.
  CONSTRAINT marca_unica CHECK (id)
);

COMMENT ON TABLE sandbox_marker IS
  'Prueba de que esta base es un sandbox. Las migraciones de producción NUNCA la crean: por eso su ausencia es un rechazo y no una duda.';

-- Una base que dejó de ser sandbox no existe: o lo es, o hay que borrarla. Borrar
-- la marca para "ascender" una base a producción dejaría una base con esquema de
-- sandbox y datos de prueba haciéndose pasar por otra cosa.
CREATE OR REPLACE FUNCTION forbid_unmark() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'La marca de sandbox no se borra ni se edita. Si esta base ya no debe ser un sandbox, borrá la base.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER sandbox_marker_inmutable
  BEFORE UPDATE OR DELETE ON sandbox_marker
  FOR EACH ROW EXECUTE FUNCTION forbid_unmark();

-- La aplicación puede leerla —para poner el sello en la interfaz— y nada más.
GRANT SELECT ON sandbox_marker TO aai_app;
