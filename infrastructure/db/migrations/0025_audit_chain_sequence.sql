-- 0025_audit_chain_sequence.sql — la cadena de auditoría se encadena por orden
-- de inserción, no por hora de inicio de transacción.
--
-- CORRIGE UN DEFECTO DE LA FASE 1b, ENCONTRADO POR EL INVARIANTE A-5.
--
-- `audit_chain_link()` buscaba el eslabón anterior así:
--
--     SELECT hash FROM audit_logs
--      WHERE company_id = NEW.company_id
--      ORDER BY occurred_at DESC, id DESC
--      LIMIT 1;
--
-- `occurred_at` viene de `now()`, que en PostgreSQL es **la hora de inicio de la
-- transacción**, no la del INSERT. Con transacciones concurrentes sobre la misma
-- empresa, sus horas de inicio se intercalan con el orden real de inserción:
--
--     tx B  empieza .727 → inserta 1º → hash b496a010
--     tx A  empieza .568 → inserta 2º → lee el máximo occurred_at = B → prev=b496a010  ✔
--     tx C  empieza .693 → inserta 3º → el máximo occurred_at SIGUE siendo B (.727),
--                                       porque A quedó en .568 → prev=b496a010  ✘
--
-- Resultado: **la cadena se bifurca**. Tres entradas con el mismo `prev_hash`, y
-- ninguna alarma. En la base de desarrollo había 19 bifurcaciones sobre 204
-- entradas.
--
-- Por qué importa más que un bug común: una cadena de hashes existe para que
-- agregar, borrar o reordenar una entrada sea detectable. En una bifurcación esa
-- propiedad **se pierde en silencio** — dos ramas paralelas admiten que se borre
-- una entera sin que ningún eslabón quede colgando. El control que protege la
-- bitácora estaba roto justo en el caso en que hace falta: bajo carga.
--
-- El candado de serialización estaba bien (`pg_advisory_xact_lock`); lo que
-- estaba mal era la pregunta. Se ordenaba por "cuál empezó última" y había que
-- ordenar por "cuál entró última".

-- ---------------------------------------------------------------------------
-- Un número de orden real
-- ---------------------------------------------------------------------------
-- `bigserial` toma su valor en el INSERT, no al abrir la transacción. Es el único
-- dato de la fila que refleja el orden en que las entradas efectivamente
-- entraron.
--
-- La secuencia deja huecos cuando una transacción hace rollback, y está bien: la
-- cadena se verifica por hash, no por contigüidad de números. Un hueco en `seq`
-- no dice nada; un `prev_hash` que no coincide, sí.
ALTER TABLE audit_logs ADD COLUMN seq bigint;

-- Backfill en el orden que mejor aproxima la inserción real: el uuidv7 lleva el
-- timestamp de generación, que ocurre en el INSERT.
WITH ordenado AS (
  SELECT id, row_number() OVER (ORDER BY id) AS n FROM audit_logs
)
UPDATE audit_logs a SET seq = ordenado.n FROM ordenado WHERE a.id = ordenado.id;

CREATE SEQUENCE audit_logs_seq_sequence OWNED BY audit_logs.seq;
SELECT setval('audit_logs_seq_sequence', GREATEST(COALESCE(max(seq), 0), 1)) FROM audit_logs;

ALTER TABLE audit_logs
  ALTER COLUMN seq SET DEFAULT nextval('audit_logs_seq_sequence'),
  ALTER COLUMN seq SET NOT NULL;

-- El rol de aplicación tiene que poder pedir el siguiente número. Sin este
-- GRANT, cada INSERT en la bitácora falla — y como la bitácora se escribe dentro
-- de la transacción de cada operación, se cae la operación entera.
GRANT USAGE ON SEQUENCE audit_logs_seq_sequence TO aai_app;

CREATE UNIQUE INDEX audit_logs_seq_idx ON audit_logs (seq);
CREATE INDEX audit_logs_chain_idx ON audit_logs (company_id, seq DESC);

-- ---------------------------------------------------------------------------
-- El trigger, corregido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_chain_link() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous char(64);
  payload text;
BEGIN
  -- La cadena es por empresa y debe serializarse: sin el lock, dos inserciones
  -- concurrentes leerían el mismo prev_hash y bifurcarían la cadena.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.company_id::text));

  -- El número de orden se toma acá, con el lock ya tomado. Pedirlo antes dejaría
  -- que dos transacciones obtengan números en un orden y se serialicen en otro.
  NEW.seq := nextval('audit_logs_seq_sequence');

  -- Por `seq`, no por `occurred_at`: el primero es el orden en que las entradas
  -- entraron; el segundo, el orden en que sus transacciones empezaron. Son
  -- distintos, y usar el segundo bifurca la cadena.
  SELECT hash INTO previous
    FROM audit_logs
   WHERE company_id = NEW.company_id
   ORDER BY seq DESC
   LIMIT 1;

  NEW.prev_hash := COALESCE(previous, repeat('0', 64));

  -- `seq` entra al payload: así la posición de la entrada queda ligada a su
  -- hash, y reordenar la bitácora rompe la cadena en vez de pasar inadvertido.
  payload := concat_ws('|',
    NEW.prev_hash, NEW.seq::text, NEW.company_id::text, NEW.actor_type, NEW.actor_id, NEW.action,
    NEW.object_type, NEW.object_id,
    COALESCE(NEW.old_value::text, ''), COALESCE(NEW.new_value::text, ''),
    COALESCE(NEW.motivo, ''), NEW.occurred_at::text);

  NEW.hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- El verificador, con la misma fórmula
-- ---------------------------------------------------------------------------
-- `verify_audit_chain` recomputa cada hash y lo compara con el guardado. Tiene
-- que usar EXACTAMENTE el mismo orden y el mismo payload que el trigger: un
-- verificador que calcula distinto reporta rupturas donde no las hay, y —peor—
-- deja de reportar las que sí hay.
--
-- Mantener las dos fórmulas sincronizadas a mano es frágil. Se acepta acá porque
-- son diez líneas y viven en el mismo archivo; el día que la fórmula crezca, hay
-- que extraerla a una función y que las dos la llamen.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_company_id uuid)
RETURNS TABLE (broken_at uuid, expected char(64), found char(64))
LANGUAGE plpgsql STABLE
AS $verificador$
DECLARE
  row_record record;
  running char(64) := repeat('0', 64);
  payload text;
  computed char(64);
BEGIN
  FOR row_record IN
    SELECT * FROM audit_logs
     WHERE company_id = p_company_id
     ORDER BY seq ASC
  LOOP
    payload := concat_ws('|',
      running, row_record.seq::text, row_record.company_id::text, row_record.actor_type,
      row_record.actor_id, row_record.action, row_record.object_type, row_record.object_id,
      COALESCE(row_record.old_value::text, ''), COALESCE(row_record.new_value::text, ''),
      COALESCE(row_record.motivo, ''), row_record.occurred_at::text);
    computed := encode(digest(payload, 'sha256'), 'hex');

    IF row_record.prev_hash <> running OR row_record.hash <> computed THEN
      broken_at := row_record.id;
      expected := computed;
      found := row_record.hash;
      RETURN NEXT;
      RETURN;
    END IF;

    running := row_record.hash;
  END LOOP;
END;
$verificador$;

-- ---------------------------------------------------------------------------
-- A-3 hecho candado, no solo invariante
-- ---------------------------------------------------------------------------
-- El invariante A-3 dice que todo asiento aprobado tiene comprobante o
-- justificación firmada. El motor contable lo rechaza (E_NO_TRACEABILITY), pero
-- la base lo permitía: un `psql` manual o un bug de la aplicación podían dejar un
-- asiento aprobado sin origen demostrable.
--
-- Un invariante que solo se verifica después es un invariante que ya se violó
-- cuando se detecta. Este pasa a ser imposible.
ALTER TABLE journal_entries
  ADD CONSTRAINT je_trazabilidad_obligatoria
    CHECK (status NOT IN ('APROBADO', 'ANULADO')
           OR source_id IS NOT NULL
           OR length(btrim(coalesce(manual_justification, ''))) > 0);

COMMENT ON COLUMN audit_logs.seq IS
  'Orden de inserción real. La cadena se encadena por acá y NO por occurred_at, que es la hora de inicio de la transacción y se intercala con el orden real bajo concurrencia.';
