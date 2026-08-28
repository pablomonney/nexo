-- 0040_notas_evidencia_y_versiones.sql — las notas, conectadas.
--
-- ## Lo que ya estaba y nadie usaba
--
-- La 0024 dejó el modelo casi completo y **sin un solo escritor**:
--
--   * `notes` y `note_figures`, con RLS forzado, `forbid_delete` y el permiso
--     `note:write`;
--   * el invariante A-2 hecho estructura: `note_figures.statement_line_id` es
--     `NOT NULL`, así que **no hay dónde escribir un número suelto**;
--   * `note_figures_match_line`, que rechaza una cifra que no coincida con su
--     renglón;
--   * la vista `note_trace`, de la cifra a las cuentas.
--
-- El motor puro (`notes.ts`) también estaba, con siete controles cruzados y
-- ningún llamador fuera de sus tests. Por eso A-2 venía declarado
-- VACUO_PERMITIDO: no había camino productivo que creara una nota.
--
-- Esta migración no rehace nada de eso. Agrega las tres cosas que faltaban para
-- que una nota se pueda emitir de verdad.
--
-- ## 1. En qué se apoya la nota, y cuánto
--
-- Una nota no es solo BORRADOR o APROBADA. Antes de eso está la pregunta de si
-- el sistema **puede** sostenerla:
--
--   VERIFIED               las cifras se derivan de renglones del estado y el
--                          texto sale de datos declarados. Nada que suponer.
--   REQUIRES_REVIEW        hay con qué proponerla, y lo que falta es el juicio
--                          profesional — no un dato.
--   INSUFFICIENT_EVIDENCE  el sistema no tiene la información. No se redacta
--                          texto, no se rellena con supuestos.
--
-- Son dos ejes distintos y no se colapsan: `status` es el trámite —quién la
-- firmó—, `evidencia` es qué la sostiene. Lo único que los liga es que **una
-- nota sin evidencia no se puede aprobar**: no hay nada detrás que firmar.
--
-- ## 2. Una nota aprobada no cambia: se reemplaza
--
-- Si mañana cambia un saldo, la nota aprobada que informaba el saldo viejo no se
-- corrige en silencio. Se emite otra versión, con motivo, y quedan las dos —
-- exactamente como un asiento se corrige con un contraasiento y una decisión con
-- otra que la supersede.
--
-- ## 3. El paquete
--
-- Un juego de estados contables son el ESP, el ER y sus notas. La vista
-- `statement_package` es ese conjunto en una consulta: sin ella, cada pantalla
-- que quiera saber si el paquete está completo lo rearma por su cuenta y se le
-- escapa una punta.

-- ---------------------------------------------------------------------------
-- 1. Tipo, evidencia y autoría
-- ---------------------------------------------------------------------------
ALTER TABLE notes
  -- Qué clase de nota es. No es una etiqueta libre: cada tipo tiene un generador
  -- determinístico o está declarado como no generable, y de eso depende qué
  -- evidencia se le exige.
  ADD COLUMN note_type text,
  ADD COLUMN evidencia text,
  ADD COLUMN created_by text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- La versión anterior de esta misma nota. Encadena las correcciones.
  ADD COLUMN supersedes_id uuid REFERENCES notes (id),
  ADD COLUMN motivo_version text;

-- Las notas que hubiera se completan con lo mínimo verdadero: no se les puede
-- inventar un tipo ni afirmar que su evidencia se verificó.
UPDATE notes
   SET note_type = COALESCE(note_type, 'OTRA'),
       evidencia = COALESCE(evidencia, 'REQUIRES_REVIEW'),
       created_by = COALESCE(created_by, 'migracion-0040')
 WHERE note_type IS NULL OR evidencia IS NULL OR created_by IS NULL;

ALTER TABLE notes
  ALTER COLUMN note_type SET NOT NULL,
  ALTER COLUMN evidencia SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL,
  ADD CONSTRAINT notes_tipo_conocido CHECK (note_type IN (
    'BASES_DE_PREPARACION',
    'COMPOSICION_DE_RUBRO',
    'RESULTADO_DEL_EJERCICIO',
    'OTRA'
  )),
  ADD CONSTRAINT notes_evidencia_conocida CHECK (evidencia IN (
    'VERIFIED', 'REQUIRES_REVIEW', 'INSUFFICIENT_EVIDENCE'
  )),
  -- El único puente entre los dos ejes. Aprobar es hacerse cargo de lo que la
  -- nota afirma; si el sistema no pudo reunir con qué sostenerla, no hay nada de
  -- qué hacerse cargo todavía.
  ADD CONSTRAINT notes_no_se_aprueba_sin_evidencia
    CHECK (status <> 'APROBADA' OR evidencia <> 'INSUFFICIENT_EVIDENCE'),
  -- Una versión posterior dice por qué reemplazó a la anterior. «Se actualizó»
  -- no es un motivo: la pregunta que hay que poder contestar es qué cambió en
  -- los datos.
  ADD CONSTRAINT notes_version_con_motivo
    CHECK (supersedes_id IS NULL OR length(btrim(coalesce(motivo_version, ''))) >= 10);

-- SUPERSEDIDA se suma a los dos estados que ya había.
ALTER TABLE notes DROP CONSTRAINT notes_status_check;
ALTER TABLE notes
  ADD CONSTRAINT notes_status_check
    CHECK (status IN ('BORRADOR', 'APROBADA', 'SUPERSEDIDA'));

-- El número identifica a la nota **vigente**. Las supersedidas conservan el
-- suyo: son la historia de esa misma nota, no notas distintas.
ALTER TABLE notes DROP CONSTRAINT notes_statement_id_numero_key;
CREATE UNIQUE INDEX notes_numero_vigente
  ON notes (statement_id, numero)
  WHERE status <> 'SUPERSEDIDA';

-- Una nota reemplaza como mucho a una anterior.
CREATE UNIQUE INDEX notes_una_sucesora
  ON notes (supersedes_id) WHERE supersedes_id IS NOT NULL;

COMMENT ON COLUMN notes.evidencia IS
  'Qué sostiene la nota, no quién la firmó. VERIFIED: se deriva de renglones del '
  'estado. REQUIRES_REVIEW: hay con qué proponerla y falta juicio profesional. '
  'INSUFFICIENT_EVIDENCE: el sistema no tiene la información y no la inventa.';

-- ---------------------------------------------------------------------------
-- 2. Inmutabilidad de lo aprobado
-- ---------------------------------------------------------------------------
-- Una nota aprobada es una afirmación profesional con fecha y firma. Lo único
-- que le puede pasar después es quedar supersedida por otra versión.
CREATE OR REPLACE FUNCTION assert_note_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'APROBADA' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'SUPERSEDIDA' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'La nota % está APROBADA: solo puede pasar a SUPERSEDIDA por una versión nueva.', OLD.numero
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.titulo      IS DISTINCT FROM OLD.titulo
  OR NEW.body_blocks IS DISTINCT FROM OLD.body_blocks
  OR NEW.note_type   IS DISTINCT FROM OLD.note_type
  OR NEW.evidencia   IS DISTINCT FROM OLD.evidencia
  OR NEW.numero      IS DISTINCT FROM OLD.numero
  OR NEW.statement_id IS DISTINCT FROM OLD.statement_id
  OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION
      'La nota % está APROBADA: su contenido es inmutable. Emití una versión nueva con su motivo y quedan las dos.',
      OLD.numero USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER notes_inmutable BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION assert_note_inmutable();

CREATE TRIGGER notes_updated BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Las cifras de una nota aprobada tampoco. `note_figures_match_line` verifica
-- que el importe coincida con el renglón; esto impide que se agregue, se saque o
-- se cambie una cifra después de la firma.
CREATE OR REPLACE FUNCTION assert_note_figures_mutables() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  estado_nota text;
BEGIN
  SELECT status INTO estado_nota FROM notes WHERE id = COALESCE(NEW.note_id, OLD.note_id);
  IF estado_nota IN ('APROBADA', 'SUPERSEDIDA') THEN
    RAISE EXCEPTION
      'Las cifras de una nota % no se modifican. Emití una versión nueva.', estado_nota
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER note_figures_inmutables
  BEFORE INSERT OR UPDATE ON note_figures
  FOR EACH ROW EXECUTE FUNCTION assert_note_figures_mutables();

-- ---------------------------------------------------------------------------
-- 3. La dirección es CONTABILIDAD → NOTA, nunca al revés
-- ---------------------------------------------------------------------------
-- Que una nota no pueda alterar contabilidad no se logra revisando el código de
-- cada endpoint: se logra no dándole a `aai_app` por dónde. La nota vive en dos
-- tablas que nada más referencia, y su única llave hacia afuera —
-- `statement_line_id`— apunta a un renglón ya emitido.
--
-- Este comentario no es decorativo: deja escrito por qué NO hay una columna
-- `journal_entry_id`, `decision_id` ni `account_id` en `notes`. Una nota que
-- pudiera nombrar un asiento invitaría, tarde o temprano, a que alguien lo
-- modificara desde acá.
COMMENT ON TABLE notes IS
  'Notas complementarias (Ley 19.550 art. 65). Capa de explicación sobre datos '
  'ya registrados: la dirección es CONTABILIDAD → NOTA. Una nota no funda un '
  'asiento, ni una decisión, ni una regla, y no tiene ninguna llave con la que '
  'pudiera hacerlo.';

-- ---------------------------------------------------------------------------
-- 4. El paquete de emisión
-- ---------------------------------------------------------------------------
-- ESP + ER + notas, con lo necesario para contestar si está completo. Es la
-- misma decisión que `ledger_trace`: el camino se escribe una vez.
CREATE VIEW statement_package AS
SELECT s.id                AS statement_id,
       s.company_id,
       s.fiscal_year_id,
       s.statement_kind,
       s.status            AS statement_status,
       s.fecha_cierre,
       s.content_sha256,
       s.issued_by,
       s.issued_at,
       count(n.id) FILTER (WHERE n.status <> 'SUPERSEDIDA')                    AS notas,
       count(n.id) FILTER (WHERE n.status = 'APROBADA')                        AS notas_aprobadas,
       count(n.id) FILTER (WHERE n.status <> 'SUPERSEDIDA'
                             AND n.evidencia = 'REQUIRES_REVIEW')              AS notas_a_revisar,
       count(n.id) FILTER (WHERE n.status <> 'SUPERSEDIDA'
                             AND n.evidencia = 'INSUFFICIENT_EVIDENCE')        AS notas_sin_evidencia,
       count(f.id)                                                             AS cifras
  FROM financial_statements s
  LEFT JOIN notes n ON n.statement_id = s.id
  LEFT JOIN note_figures f ON f.note_id = n.id AND n.status <> 'SUPERSEDIDA'
 GROUP BY s.id, s.company_id, s.fiscal_year_id, s.statement_kind, s.status,
          s.fecha_cierre, s.content_sha256, s.issued_by, s.issued_at;

-- `security_invoker`: sin esto la vista se evalúa con los permisos de quien la
-- creó y saltea el RLS de las tablas de abajo. Es el estándar que fijó la 0032 y
-- que `tests/security/vistas-rls.test.ts` verifica sobre el catálogo entero, así
-- que una vista nueva sin esto rompe el build.
ALTER VIEW statement_package SET (security_invoker = true);
GRANT SELECT ON statement_package TO aai_app;
