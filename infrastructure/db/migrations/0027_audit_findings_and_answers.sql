-- 0027_audit_findings_and_answers.sql — hallazgos de auditoría y respuestas del asistente.
--
-- Dos tablas con la misma forma y el mismo motivo: guardan **lo que el sistema
-- propuso decir**, con quién lo revisó y qué decidió. Ninguna de las dos toca la
-- contabilidad.
--
-- La segunda es la que importa vigilar. `ai_answers` guarda respuestas en lenguaje
-- natural sobre datos reales de una empresa — el artefacto más fácil de copiar a
-- un mail y mandar a un cliente. Por eso guarda también **el contexto exacto que
-- se le pasó al modelo** y el resultado de la verificación de cifras: sin eso, una
-- respuesta guardada es una frase sin forma de saber de dónde salió.

-- ---------------------------------------------------------------------------
-- Hallazgos de auditoría
-- ---------------------------------------------------------------------------
CREATE TABLE audit_findings (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  fiscal_year_id uuid REFERENCES fiscal_years (id),
  codigo        text NOT NULL
                  CHECK (codigo IN ('IMPORTE_ATIPICO', 'IMPORTE_REDONDO',
                                    'JUSTO_BAJO_UMBRAL', 'ASIENTO_TARDIO',
                                    'VARIACION_SIGNIFICATIVA')),
  entry_id      uuid REFERENCES journal_entries (id),
  account_id    uuid REFERENCES accounts (id),

  -- Las dos columnas que definen la tabla. `observado` es un hecho verificable;
  -- `que_mirar` es una pregunta. No hay una columna `conclusion` ni `severidad`:
  -- un hallazgo no concluye, y ponerle un puntaje de riesgo exigiría un número
  -- que el software no puede fundar.
  observado     text NOT NULL CHECK (length(btrim(observado)) > 0),
  que_mirar     text NOT NULL CHECK (length(btrim(que_mirar)) > 0),

  detectado_el  timestamptz NOT NULL DEFAULT now(),
  -- Qué decidió la persona que lo miró.
  estado        text NOT NULL DEFAULT 'ABIERTO'
                  CHECK (estado IN ('ABIERTO', 'REVISADO_SIN_ACCION', 'CORREGIDO')),
  revisado_por  text,
  revisado_el   timestamptz,
  comentario    text,

  -- Cerrar un hallazgo exige decir quién y por qué. Un hallazgo que se cierra sin
  -- explicación reaparece en la próxima corrida y nadie recuerda por qué se fue.
  CONSTRAINT finding_cierre_explicado
    CHECK (estado = 'ABIERTO'
           OR (revisado_por IS NOT NULL AND revisado_el IS NOT NULL
               AND length(btrim(coalesce(comentario, ''))) > 0))
);

CREATE INDEX audit_findings_company_idx ON audit_findings (company_id, estado, detectado_el DESC);
CREATE INDEX audit_findings_entry_idx ON audit_findings (entry_id);

CREATE TRIGGER audit_findings_no_delete BEFORE DELETE ON audit_findings
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

COMMENT ON TABLE audit_findings IS
  'Observaciones del motor de auditoría. Sin severidad ni conclusión: cada fila dice qué se observó y qué mirar.';

-- ---------------------------------------------------------------------------
-- Respuestas del asistente
-- ---------------------------------------------------------------------------
CREATE TABLE ai_answers (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  pregunta      text NOT NULL CHECK (length(btrim(pregunta)) > 0),

  -- El contexto EXACTO que se le pasó. Sin esto, una respuesta guardada es una
  -- frase sin forma de saber de dónde salió: no se puede reproducir la
  -- verificación de cifras ni explicar por qué dijo lo que dijo.
  contexto      jsonb NOT NULL,

  respuesta     text,
  abstencion    boolean NOT NULL DEFAULT false,

  -- Resultado de la verificación de cifras. Una respuesta rechazada se guarda
  -- igual: es el insumo de la métrica de alucinación, y borrarla haría que el
  -- indicador se vea mejor de lo que es.
  aceptada      boolean NOT NULL,
  rechazos      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Se cuentan aparte porque no se corrigen igual: inventar una cifra es un
  -- problema del modelo; citar una norma que no estaba en el contexto es un
  -- problema del armado del contexto.
  cifras_inventadas integer NOT NULL DEFAULT 0 CHECK (cifras_inventadas >= 0),

  model_provider text NOT NULL,
  model_id      text NOT NULL,
  prompt_hash   char(64) NOT NULL REFERENCES prompt_versions (hash),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,

  -- Una respuesta aceptada tiene texto; una rechazada tiene el motivo. Ninguna
  -- de las dos puede estar vacía de las dos cosas.
  CONSTRAINT answer_coherente
    CHECK ((aceptada AND (abstencion OR length(btrim(coalesce(respuesta, ''))) > 0))
           OR (NOT aceptada AND jsonb_array_length(rechazos) > 0)),

  -- Si hubo cifras inventadas, la respuesta no pudo aceptarse. Es el candado del
  -- control: no hay estado en el que una cifra inventada llegue al usuario.
  CONSTRAINT answer_sin_cifras_inventadas
    CHECK (NOT aceptada OR cifras_inventadas = 0)
);

CREATE INDEX ai_answers_company_idx ON ai_answers (company_id, created_at DESC);
CREATE INDEX ai_answers_rechazadas_idx ON ai_answers (company_id, aceptada, created_at DESC);

CREATE TRIGGER ai_answers_no_delete BEFORE DELETE ON ai_answers
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Una respuesta es un hecho pasado: no se edita. Si la pregunta se vuelve a
-- hacer, se genera otra.
CREATE OR REPLACE FUNCTION forbid_answer_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Una respuesta del asistente es un hecho registrado: no se edita. Volvé a preguntar y queda la nueva junto a la anterior.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ai_answers_immutable BEFORE UPDATE ON ai_answers
  FOR EACH ROW EXECUTE FUNCTION forbid_answer_change();

COMMENT ON TABLE ai_answers IS
  'Respuestas del asistente con el contexto exacto que se le pasó. Las rechazadas se guardan: son el insumo de la métrica de alucinación.';

-- ---------------------------------------------------------------------------
-- La métrica que importa
-- ---------------------------------------------------------------------------
-- Separa alucinación de error, igual que `ai_rejections` en FASE 4. Mezclarlas en
-- un solo porcentaje hace invisible a la primera, que es la única que no se
-- corrige con más contexto.
CREATE VIEW ai_answer_metrics AS
SELECT company_id,
       count(*)::int                                              AS total,
       count(*) FILTER (WHERE aceptada)::int                      AS aceptadas,
       count(*) FILTER (WHERE abstencion)::int                    AS abstenciones,
       count(*) FILTER (WHERE cifras_inventadas > 0)::int         AS con_cifra_inventada,
       count(*) FILTER (WHERE NOT aceptada AND cifras_inventadas = 0)::int AS otros_rechazos,
       max(created_at)                                            AS ultima
  FROM ai_answers
 GROUP BY company_id;

GRANT SELECT ON ai_answer_metrics TO aai_app;

-- ---------------------------------------------------------------------------
-- RLS y permisos
-- ---------------------------------------------------------------------------
DO $rls$
DECLARE
  scoped_table text;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY['audit_findings', 'ai_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, scoped_table);
  END LOOP;
END
$rls$;

GRANT SELECT, INSERT, UPDATE ON audit_findings TO aai_app;
GRANT SELECT, INSERT ON ai_answers TO aai_app;
-- Sin UPDATE: el trigger ya lo impide, y el REVOKE es el segundo candado.
REVOKE UPDATE ON ai_answers FROM aai_app;

INSERT INTO permissions (code, description) VALUES
  ('audit_finding:read',   'Ver los hallazgos de auditoría'),
  ('audit_finding:review', 'Revisar y cerrar un hallazgo con comentario'),
  ('assistant:ask',        'Consultar al asistente sobre los datos de la empresa');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR'
  AND p.code IN ('audit_finding:read', 'audit_finding:review', 'assistant:ask');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'AUDITOR' AND p.code IN ('audit_finding:read', 'audit_finding:review');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code = 'audit_finding:read';

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
      WHERE r.code = esperado.code AND p.code = 'audit_finding:read'
   );
  IF faltante IS NOT NULL THEN
    RAISE EXCEPTION 'Los roles % no recibieron audit_finding:read.', faltante;
  END IF;
END
$verificar$;

-- El auditor NO recibe assistant:ask. No es una restricción de permisos por
-- prolijidad: un auditor que consulta al asistente sobre los datos que audita
-- introduce en su papel de trabajo una afirmación generada, y el §42 dice que eso
-- no es asesoramiento profesional. Que pregunte el contador y que el auditor lea
-- los libros.
