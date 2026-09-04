-- ============================================================================
-- 0093 — Qué se esperaba, y qué pasó
-- ============================================================================
--
-- El ciclo de decisión estaba cortado en el mismo lugar desde el principio:
--
--     qué pasó ✔   por qué ✔   qué pasa si ✔   cuál contra cuál ✔
--     qué conviene ✗   aprobar ✗   ejecutar ✔(el ERP)   medir ✗   aprender ✗
--
-- «Medir» necesita las dos puntas y las dos existían. La predicción es un
-- escenario guardado; el resultado real lo tiene el ERP. Lo que faltaba era el
-- **puente**: la declaración de que este escenario se aplicó, y con qué acto.
--
-- Sin esa declaración, comparar un escenario contra lo que pasó después
-- atribuiría a una decisión un resultado que pudo venir de cualquier otra cosa.
--
-- ## Qué decide esta migración, y qué no
--
-- **No decide qué significa aplicar un escenario.** Esa sigue siendo una
-- pregunta de producto y está anotada en `NEXO_ROADMAP.md`. Lo que hace es dar
-- el lugar donde **una persona lo declara**, citando el acto: es el mismo
-- criterio del ADR-021 —un documento cita el hecho, no lo genera— y el mismo
-- que usa toda la contabilidad de este sistema. NEXO no infiere que un cambio
-- de precios ejecuta un escenario; alguien lo afirma y queda su nombre.
--
-- Lo que queda abierto, y no se inventa acá: si NEXO debería alguna vez
-- **deducir** la aplicación en vez de esperar que se la declaren.
--
-- ## La cita tiene que ser verificable
--
-- `audit_log_id` apunta a una fila de la bitácora, no a un texto que describa
-- lo que se hizo. La bitácora está encadenada por hash y es append-only, así
-- que el acto citado existió, tiene actor, fecha y objeto, y no se puede
-- reescribir después para que encaje con el resultado.
--
-- ## Por qué acá SÍ se congela la predicción
--
-- La 0087 decidió lo contrario para el escenario: se guarda la pregunta y no la
-- respuesta, porque una respuesta congelada diría hoy lo que era cierto cuando
-- se guardó. Ese argumento sigue en pie y no se toca.
--
-- Pero esto es otra cosa. **La predicción del día en que se aplicó es un hecho
-- histórico**: es lo que se esperaba cuando se tomó la decisión, y es
-- exactamente lo que se va a poner a prueba. Recalcularla después contra la base
-- de hoy contestaría otra pregunta —«¿qué proyectaría hoy?»— y no quedaría nada
-- contra qué medir. Un pronóstico que se actualiza solo nunca se equivoca.
--
-- Por eso se guardan también los parámetros: si mañana alguien edita el
-- escenario —hoy no se puede, pero por si acaso—, la medición sigue sabiendo
-- sobre qué pregunta se hizo.
--
-- ## Lo que esta tabla no afirma
--
-- Que la diferencia entre lo esperado y lo real la **causó** la decisión.
-- Atribuirla exigiría que nada más hubiera cambiado en el período, y eso es
-- falso en general: cambió el mercado, cambiaron los costos, cambió el mes.
-- La respuesta informa las dos cifras y su diferencia, y dice esto mismo.
-- ============================================================================

-- La acción que registra la declaración. Va acá y no puesta a mano en una base:
-- desde la 0091 una acción sin registrar no se puede escribir, así que cada
-- migración que agrega una capacidad registra lo que esa capacidad emite.
-- `ON CONFLICT` y no un INSERT a secas: la 0091 siembra como `historico` toda
-- acción que ya esté escrita en la bitácora de esa base, así que en una base
-- restaurada de un volcado este nombre puede existir ya con el dominio
-- equivocado. La migración tiene que dejarlo correcto, no fallar.
INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('DECLARAR_ESCENARIO_APLICADO', 'analisis', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;

CREATE TABLE scenario_applications (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  scenario_id        uuid NOT NULL REFERENCES analysis_scenarios (id),

  -- El acto. Una fila de la bitácora, no una descripción.
  audit_log_id       uuid NOT NULL REFERENCES audit_logs (id),

  -- Desde cuándo se espera el efecto. No es la fecha de la declaración: una
  -- lista de precios puede firmarse hoy y regir desde el mes que viene, y medir
  -- desde la firma contaría semanas en las que todavía no pasaba nada.
  aplicado_desde     date NOT NULL,

  -- Por qué este acto aplica este escenario. Es lo único que conecta las dos
  -- cosas, y sin eso la fila sería un vínculo sin argumento.
  motivo             text NOT NULL CHECK (length(btrim(motivo)) >= 10),

  -- La predicción congelada: lo que se esperaba el día que se aplicó.
  base_neto          numeric(18, 2) NOT NULL,
  -- **Cuántos meses de datos tenía esa base.** No es lo mismo que `meses`: la
  -- ventana es lo que se pidió mirar y esto es lo que había. Una empresa de dos
  -- meses de vida proyecta sobre dos meses aunque el escenario pida doce.
  --
  -- La distinción decide la medición entera. El ritmo esperado por mes sale de
  -- dividir la proyección por los meses que la base cubrió; dividirla por la
  -- ventana pedida daría un esperado doce veces más chico que lo real y el
  -- sistema informaría que la decisión superó el pronóstico siempre. Lo
  -- encontró el test del loop, con el signo al revés.
  base_meses         integer NOT NULL CHECK (base_meses >= 1),
  esperado_neto      numeric(18, 2) NOT NULL,
  -- El margen puede no ser afirmable —ventas sin costo computable—, y entonces
  -- es NULL con su motivo. Un cero diría que no se esperaba ganancia.
  esperado_margen    numeric(18, 2),
  motivo_sin_margen  text,

  -- La pregunta sobre la que se hizo la predicción, por si el escenario cambia.
  meses              integer NOT NULL,
  variacion_precio   numeric(7, 2) NOT NULL,
  variacion_volumen  numeric(7, 2) NOT NULL,
  variacion_costo    numeric(7, 2) NOT NULL,

  declarado_por      text NOT NULL,
  declarado_at       timestamptz NOT NULL DEFAULT now(),

  -- Un escenario se aplica una vez. Aplicarlo dos veces con actos distintos
  -- dejaría dos predicciones compitiendo por el mismo resultado.
  CONSTRAINT sa_una_por_escenario UNIQUE (company_id, scenario_id),
  -- Un margen que no se puede afirmar tiene que decir por qué.
  CONSTRAINT sa_margen_o_motivo
    CHECK (esperado_margen IS NOT NULL OR motivo_sin_margen IS NOT NULL)
);

ALTER TABLE scenario_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY sa_por_empresa ON scenario_applications
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT ON scenario_applications TO aai_app;

CREATE INDEX sa_por_empresa_idx ON scenario_applications (company_id, aplicado_desde DESC);

COMMENT ON TABLE scenario_applications IS
  'La declaración de que un escenario se aplicó, con el acto citado por su fila '
  'de bitácora y la predicción congelada de ese día. No afirma que la diferencia '
  'entre lo esperado y lo real la haya causado la decisión.';

-- No se borra ni se edita: es la mitad "qué se esperaba" de una medición, y una
-- predicción que se puede retocar después no mide nada.
CREATE TRIGGER scenario_applications_no_delete
  BEFORE DELETE ON scenario_applications
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TRIGGER scenario_applications_no_update
  BEFORE UPDATE ON scenario_applications
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
