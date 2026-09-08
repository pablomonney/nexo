-- ============================================================================
-- 0101 — Una decisión sin evidencia es una opinión
-- ============================================================================
--
-- El sistema ya sabe simular escenarios, compararlos, declarar cuál se aplicó y
-- medir después qué pasó (0087, 0093). Lo que no sabe es **qué se decidió y por
-- qué**, y sin eso las piezas anteriores son un tablero: informan y no dejan
-- rastro de ninguna decisión.
--
-- Esta migración agrega las dos filas que faltaban:
--
--     decision_records    el problema, la evidencia, las alternativas, la elegida
--     decision_reviews    qué pasó después, congelado al momento de mirarlo
--
-- ## La evidencia es obligatoria, y por eso hay un CHECK
--
-- `evidencia` no puede estar vacía. Una decisión sin evidencia es una opinión, y
-- una opinión registrada como decisión contamina para siempre cualquier medición
-- de aciertos: seis meses después nadie va a poder distinguir la que salió de
-- mirar los números de la que salió de una corazonada.
--
-- No se le exige forma —cada dominio cita lo suyo: una señal, un escenario, un
-- comprobante, un informe—, se le exige **existir**.
--
-- ## Lo recomendado y lo elegido son dos columnas distintas
--
-- Es la decisión de diseño más importante del archivo. Si el sistema guardara
-- solo «qué se hizo», nunca podría contestar si sus recomendaciones sirven: para
-- eso hace falta saber **cuándo se le hizo caso y cuándo no**, y cómo salió cada
-- vez.
--
-- Guardarlo tiene un costo y conviene decirlo: deja escrito, con nombre y fecha,
-- cada vez que una persona fue contra la recomendación. Eso solo es aceptable si
-- ir en contra es legítimo, y lo es — el sistema propone sobre lo que puede
-- medir, y quien decide sabe cosas que el sistema no. Por eso `motivo` es
-- obligatorio cuando difieren: lo que se registra no es la desobediencia, es el
-- argumento.
--
-- ## «No atribuible» es un veredicto, no un fracaso
--
-- Cuando se revisa una decisión, el resultado puede ser que **no se pueda
-- saber**: cambió el mercado, cambiaron los costos, hubo estacionalidad. Ese
-- caso tiene su propio veredicto y **queda afuera del porcentaje de aciertos**,
-- en vez de contarse como error.
--
-- Contarlo como error haría que el sistema pareciera peor de lo que es y, peor
-- todavía, empujaría a evitar las decisiones difíciles de medir — que suelen ser
-- las que más importan.
--
-- ## La revisión congela lo que midió
--
-- `medicion` guarda los números **tal como estaban** el día que se revisó. La
-- medición cambia con el tiempo: los mismos meses vuelven a calcularse cuando
-- entran comprobantes atrasados. Una revisión de marzo tiene que seguir diciendo
-- en diciembre lo que decía en marzo, porque de eso se trata revisar.
--
-- Es el ADR-021 aplicado a una decisión: el documento cita el hecho, no lo
-- genera.
--
-- ## Esto no es un modelo que aprende solo
--
-- La «calibración» es un porcentaje de aciertos sobre revisiones que escribió
-- una persona. No hay pesos, no hay reentrenamiento y no hay nada que cambie de
-- comportamiento por su cuenta: el §29 pide que el aprendizaje sea auditable, y
-- un número que sale de contar filas revisadas lo es. Un modelo que se ajustara
-- solo sería lo contrario.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- El registro de decisión
-- ---------------------------------------------------------------------------

CREATE TABLE decision_records (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),

  titulo         text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 5 AND 200),
  -- Qué problema se está resolviendo. Sin esto, dentro de seis meses la
  -- decisión se lee como una acción sin causa.
  problema       text NOT NULL CHECK (length(btrim(problema)) >= 20),

  -- En qué se basó. Un arreglo de citas: cada una con su tipo y su referencia.
  -- **No puede estar vacío.**
  evidencia      jsonb NOT NULL
                 CHECK (jsonb_typeof(evidencia) = 'array' AND jsonb_array_length(evidencia) >= 1),

  -- Las alternativas que se consideraron. Pueden ser escenarios guardados o
  -- descripciones libres; lo que importa es que **haya más de una**: registrar
  -- una sola alternativa no es haber decidido, es haber ejecutado.
  alternativas   jsonb NOT NULL
                 CHECK (jsonb_typeof(alternativas) = 'array' AND jsonb_array_length(alternativas) >= 2),

  -- Qué recomendó el sistema, si recomendó algo, y qué se eligió. Dos columnas
  -- distintas a propósito: sin la primera no se puede saber si las
  -- recomendaciones sirven.
  recomendada_id uuid REFERENCES analysis_scenarios (id),
  elegida_id     uuid REFERENCES analysis_scenarios (id),
  elegida_texto  text,

  nivel_de_riesgo text NOT NULL
                  CHECK (nivel_de_riesgo IN ('BAJO', 'MEDIO', 'ALTO', 'CRITICO')),

  estado         text NOT NULL DEFAULT 'PROPUESTA'
                 CHECK (estado IN ('PROPUESTA', 'APROBADA', 'EJECUTADA', 'DESCARTADA')),

  propuesta_por  text NOT NULL,
  propuesta_el   timestamptz NOT NULL DEFAULT now(),
  -- Por qué esta y no otra. Obligatorio cuando lo elegido difiere de lo
  -- recomendado: lo que se registra no es la desobediencia, es el argumento.
  motivo         text,

  aprobada_por   text,
  aprobada_el    timestamptz,
  ejecutada_el   date,
  descartada_motivo text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- Una decisión aprobada dice quién y cuándo.
  CONSTRAINT dr_aprobada_firmada
    CHECK (estado NOT IN ('APROBADA', 'EJECUTADA')
           OR (aprobada_por IS NOT NULL AND aprobada_el IS NOT NULL)),

  -- Separación de funciones en lo grave: quien propone no aprueba. Es la misma
  -- regla que la reapertura de período y la activación de una regla normativa
  -- (SECURITY.md §3), y por el mismo motivo.
  CONSTRAINT dr_riesgo_alto_con_segunda_firma
    CHECK (nivel_de_riesgo NOT IN ('ALTO', 'CRITICO')
           OR estado NOT IN ('APROBADA', 'EJECUTADA')
           OR aprobada_por IS DISTINCT FROM propuesta_por),

  -- Ejecutada dice qué se ejecutó y desde cuándo.
  CONSTRAINT dr_ejecutada_con_eleccion
    CHECK (estado <> 'EJECUTADA'
           OR (ejecutada_el IS NOT NULL
               AND (elegida_id IS NOT NULL OR length(btrim(coalesce(elegida_texto, ''))) > 0))),

  -- Ir contra la recomendación es legítimo; hacerlo sin argumento, no.
  CONSTRAINT dr_desvio_con_motivo
    CHECK (recomendada_id IS NULL
           OR elegida_id IS NULL
           OR recomendada_id = elegida_id
           OR length(btrim(coalesce(motivo, ''))) >= 10),

  CONSTRAINT dr_descartada_con_motivo
    CHECK (estado <> 'DESCARTADA' OR length(btrim(coalesce(descartada_motivo, ''))) >= 5)
);

CREATE INDEX decision_records_por_empresa ON decision_records (company_id, propuesta_el DESC);
CREATE INDEX decision_records_pendientes ON decision_records (company_id)
  WHERE estado IN ('PROPUESTA', 'APROBADA');

ALTER TABLE decision_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_records FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_records_por_empresa ON decision_records
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON decision_records TO aai_app;

COMMENT ON TABLE decision_records IS
  'Qué se decidió y por qué. La evidencia es obligatoria: una decisión sin '
  'evidencia es una opinión. Lo recomendado y lo elegido son dos columnas '
  'distintas, porque sin la primera no se puede saber si las recomendaciones '
  'sirven.';

COMMENT ON COLUMN decision_records.recomendada_id IS
  'Qué recomendó el sistema. Puede diferir de elegida_id, y cuando difiere el '
  'motivo es obligatorio: lo que se registra no es la desobediencia, es el '
  'argumento.';

-- ---------------------------------------------------------------------------
-- La revisión posterior
-- ---------------------------------------------------------------------------

CREATE TABLE decision_reviews (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  decision_id    uuid NOT NULL REFERENCES decision_records (id),

  ventana_desde  date NOT NULL,
  ventana_hasta  date NOT NULL,

  veredicto      text NOT NULL
                 CHECK (veredicto IN ('SUPERO', 'CUMPLIO', 'NO_CUMPLIO',
                                      'NO_ATRIBUIBLE', 'SIN_EVIDENCIA')),

  -- Los números tal como estaban el día de la revisión. La medición cambia con
  -- el tiempo —entran comprobantes atrasados—, y una revisión de marzo tiene
  -- que seguir diciendo en diciembre lo que decía en marzo.
  medicion       jsonb NOT NULL CHECK (jsonb_typeof(medicion) = 'object'),

  comentario     text NOT NULL CHECK (length(btrim(comentario)) >= 15),
  revisado_por   text NOT NULL,
  revisado_el    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT drv_ventana CHECK (ventana_hasta >= ventana_desde),
  -- Dos revisiones de la misma ventana son la misma revisión hecha dos veces, y
  -- la segunda cambiaría el porcentaje de aciertos sin que haya pasado nada.
  CONSTRAINT drv_una_por_ventana UNIQUE (decision_id, ventana_hasta)
);

CREATE INDEX decision_reviews_por_decision ON decision_reviews (decision_id, ventana_hasta DESC);

ALTER TABLE decision_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_reviews_por_empresa ON decision_reviews
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT ON decision_reviews TO aai_app;
-- No se actualiza: una revisión es lo que se pensó ese día. Cambiar de opinión
-- se registra revisando de nuevo, con otra ventana.
REVOKE UPDATE ON decision_reviews FROM aai_app;

COMMENT ON TABLE decision_reviews IS
  'Qué pasó después, congelado al momento de mirarlo. NO_ATRIBUIBLE es un '
  'veredicto y no un fracaso: queda afuera del porcentaje de aciertos en vez '
  'de contarse como error.';

-- ---------------------------------------------------------------------------
-- Calibración: qué tan bien viene decidiendo esta empresa
-- ---------------------------------------------------------------------------

CREATE VIEW decision_calibracion WITH (security_invoker = true) AS
SELECT
  d.company_id,
  count(*) FILTER (WHERE r.id IS NOT NULL)                          AS revisadas,
  count(*) FILTER (WHERE r.veredicto IN ('SUPERO', 'CUMPLIO'))      AS cumplieron,
  count(*) FILTER (WHERE r.veredicto = 'NO_CUMPLIO')                AS no_cumplieron,
  -- Las que no se pudieron atribuir van aparte y **no** entran en el
  -- denominador. Contarlas como error empujaría a evitar las decisiones
  -- difíciles de medir, que suelen ser las que más importan.
  count(*) FILTER (WHERE r.veredicto IN ('NO_ATRIBUIBLE', 'SIN_EVIDENCIA')) AS no_medibles,
  count(*) FILTER (WHERE r.id IS NULL AND d.estado = 'EJECUTADA')    AS ejecutadas_sin_revisar,
  -- `NULL` y no cero cuando no hay ninguna medible: cero por ciento de aciertos
  -- diría que nunca se acertó, y lo que pasa es que todavía no se midió.
  CASE
    WHEN count(*) FILTER (WHERE r.veredicto IN ('SUPERO', 'CUMPLIO', 'NO_CUMPLIO')) = 0
      THEN NULL
    ELSE round(
      count(*) FILTER (WHERE r.veredicto IN ('SUPERO', 'CUMPLIO'))::numeric * 100
      / count(*) FILTER (WHERE r.veredicto IN ('SUPERO', 'CUMPLIO', 'NO_CUMPLIO')), 2)
  END                                                               AS aciertos_pct,
  -- Cuántas veces se siguió la recomendación del sistema, y cuántas no. Es la
  -- otra mitad del aprendizaje: sin esto no se puede saber si conviene
  -- escucharlo.
  count(*) FILTER (WHERE d.recomendada_id IS NOT NULL
                     AND d.elegida_id = d.recomendada_id)           AS siguieron_recomendacion,
  count(*) FILTER (WHERE d.recomendada_id IS NOT NULL
                     AND d.elegida_id IS NOT NULL
                     AND d.elegida_id <> d.recomendada_id)          AS fueron_en_contra
FROM decision_records d
LEFT JOIN LATERAL (
  SELECT rv.id, rv.veredicto FROM decision_reviews rv
   WHERE rv.decision_id = d.id
   ORDER BY rv.ventana_hasta DESC LIMIT 1
) r ON true
GROUP BY d.company_id;

GRANT SELECT ON decision_calibracion TO aai_app;

COMMENT ON VIEW decision_calibracion IS
  'Porcentaje de aciertos sobre revisiones escritas por una persona. No es un '
  'modelo que aprende solo: no hay pesos ni reentrenamiento, y por eso se puede '
  'auditar. Sin revisiones medibles el porcentaje es NULL, no cero.';

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
--
-- Tres, y la separación importa: proponer una decisión, aprobarla y revisarla
-- después son actos distintos. Que aprobar sea un permiso aparte es lo que hace
-- posible la segunda firma del `CHECK` de arriba.

INSERT INTO permissions (code, description) VALUES
  ('decision:read',    'Ver el registro de decisiones y su revisión posterior'),
  ('decision:write',   'Registrar una decisión con su evidencia y sus alternativas'),
  ('decision:approve', 'Aprobar una decisión y declararla ejecutada')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR') AND p.code = 'decision:read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR') AND p.code = 'decision:write'
ON CONFLICT DO NOTHING;

-- Aprobar solo ADMINISTRADOR: si CONTADOR pudiera proponer y aprobar, la
-- segunda firma la daría la misma persona en dos momentos.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code = 'decision:approve'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Acciones auditadas
-- ---------------------------------------------------------------------------

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('REGISTRAR_DECISION', 'decisiones', false),
  ('APROBAR_DECISION',   'decisiones', false),
  ('EJECUTAR_DECISION',  'decisiones', false),
  ('DESCARTAR_DECISION', 'decisiones', true),
  ('REVISAR_DECISION',   'decisiones', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
