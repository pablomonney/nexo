-- ============================================================================
-- 0087 — Escenarios guardados: se guardan las preguntas, no las respuestas
-- ============================================================================
--
-- La simulación es una función pura de sus parámetros sobre cifras reales, y la
-- 0058 decidió **no guardarla**: almacenar el resultado sería almacenar un
-- número derivado, que es lo que el resto del sistema evita.
--
-- Eso sigue en pie. Lo que faltaba es otra cosa: poder volver a la misma
-- pregunta. «¿Qué pasaba si subía diez por ciento?» es una pregunta que se hace
-- en marzo, se vuelve a hacer en junio, y la respuesta **tiene que ser
-- distinta** — porque en el medio la empresa vendió.
--
-- ## Qué se guarda
--
-- Los parámetros y los supuestos que los acompañan. El resultado se recalcula
-- cada vez que se mira.
--
-- La diferencia no es sutil: un escenario guardado con su resultado congelado
-- diría en junio lo que era cierto en marzo, y nadie tendría cómo saber que
-- está mirando una foto vieja. Un escenario que guarda solo la pregunta no
-- puede envejecer.
--
-- Un test lo comprueba de la única forma que sirve: guarda un escenario, carga
-- una venta, y verifica que el mismo escenario ahora proyecte otra cosa.
--
-- ## Qué NO decide esta migración
--
-- No hay estado «aprobado» ni «ejecutado». Un escenario es una pregunta
-- guardada, no una decisión tomada: convertirlo en una decisión exige registrar
-- qué se hizo, quién lo autorizó y qué pasó después, y nada de eso existe
-- todavía. Inventarle esos estados ahora sería prometer un ciclo que no está.
-- ============================================================================

CREATE TABLE analysis_scenarios (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id           uuid NOT NULL REFERENCES companies (id),

  nombre               text NOT NULL CHECK (length(btrim(nombre)) >= 3),
  -- Para qué se guarda. Un escenario sin pregunta escrita, seis meses después,
  -- es una fila de porcentajes que nadie sabe por qué está ahí.
  pregunta             text NOT NULL CHECK (length(btrim(pregunta)) >= 5),

  meses                integer NOT NULL CHECK (meses BETWEEN 1 AND 36),
  variacion_precio     numeric(7, 2) NOT NULL DEFAULT 0
                       CHECK (variacion_precio BETWEEN -100 AND 1000),
  variacion_volumen    numeric(7, 2) NOT NULL DEFAULT 0
                       CHECK (variacion_volumen BETWEEN -100 AND 1000),
  variacion_costo      numeric(7, 2) NOT NULL DEFAULT 0
                       CHECK (variacion_costo BETWEEN -100 AND 1000),

  status               text NOT NULL DEFAULT 'ACTIVO'
                       CHECK (status IN ('ACTIVO', 'ARCHIVADO')),
  motivo_archivo       text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           text NOT NULL,

  -- Un escenario sin ningún cambio es la base: no es un escenario.
  CONSTRAINT sc_algo_cambia
    CHECK (variacion_precio <> 0 OR variacion_volumen <> 0 OR variacion_costo <> 0),
  CONSTRAINT sc_archivado_con_motivo
    CHECK (status <> 'ARCHIVADO' OR motivo_archivo IS NOT NULL),
  CONSTRAINT sc_nombre_unico UNIQUE (company_id, nombre)
);

ALTER TABLE analysis_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_scenarios FORCE ROW LEVEL SECURITY;
CREATE POLICY sc_por_empresa ON analysis_scenarios
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON analysis_scenarios TO aai_app;

CREATE INDEX sc_por_empresa_idx ON analysis_scenarios (company_id, status, created_at DESC);

COMMENT ON TABLE analysis_scenarios IS
  'La pregunta guardada, no la respuesta. El resultado se recalcula cada vez: '
  'un escenario con su resultado congelado diría hoy lo que era cierto cuando '
  'se guardó, y nadie tendría cómo saber que mira una foto vieja.';

-- Un escenario no se borra: se archiva con motivo. Borrarlo dejaría sin
-- explicación la comparación en la que aparecía.
CREATE FUNCTION assert_baja_de_escenario() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'E_ESC_NO_SE_BORRA: un escenario se archiva con motivo, no se borra';
END;
$$;

CREATE TRIGGER sc_no_delete
  BEFORE DELETE ON analysis_scenarios
  FOR EACH ROW EXECUTE FUNCTION assert_baja_de_escenario();

-- Los parámetros no se editan: cambiarlos convertiría al escenario en otro con
-- el mismo nombre, y la comparación de la semana pasada pasaría a hablar de
-- algo distinto sin avisar. Se archiva y se guarda uno nuevo.
CREATE FUNCTION assert_escenario_no_muta() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.meses IS DISTINCT FROM OLD.meses
     OR NEW.variacion_precio IS DISTINCT FROM OLD.variacion_precio
     OR NEW.variacion_volumen IS DISTINCT FROM OLD.variacion_volumen
     OR NEW.variacion_costo IS DISTINCT FROM OLD.variacion_costo
     OR NEW.pregunta IS DISTINCT FROM OLD.pregunta THEN
    RAISE EXCEPTION 'E_ESC_INMUTABLE: los parámetros de un escenario no se editan; archivalo y guardá otro';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sc_inmutable
  BEFORE UPDATE ON analysis_scenarios
  FOR EACH ROW EXECUTE FUNCTION assert_escenario_no_muta();
