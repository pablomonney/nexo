-- 0010_fix_period_guard.sql — corrige assert_period_open().
--
-- Bug detectado por tests/integration/journal-locks.test.ts al correr contra
-- PostgreSQL por primera vez:
--
--   error: el registro «new» no tiene un campo «kind»
--
-- La función es compartida por dos tablas. La condición del período BLOQUEADO
-- estaba escrita así:
--
--   IF period_row.status = 'BLOQUEADO'
--      AND TG_TABLE_NAME = 'journal_entries'
--      AND NEW.kind NOT IN ('AJUSTE', 'CIERRE') THEN
--
-- PL/pgSQL no cortocircuita esa expresión como lo haría un lenguaje imperativo:
-- la compila entera como una sola sentencia SQL y resuelve `NEW.kind` sin
-- importar el valor de TG_TABLE_NAME. Cuando el trigger corre sobre
-- journal_entry_lines —cuyo NEW no tiene `kind`— falla en tiempo de ejecución.
--
-- La corrección captura el `kind` en una variable dentro de la rama que ya
-- discrimina por tabla, y la condición pasa a leer solo variables locales.

CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_period uuid;
  target_date date;
  entry_kind text;
  period_row periods%ROWTYPE;
BEGIN
  -- El trigger corre BEFORE INSERT OR UPDATE, así que NEW siempre está asignado;
  -- OLD no lo está en INSERT y referenciarlo sería un error de ejecución.
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_period := NEW.period_id;
    target_date := NEW.entry_date;
    entry_kind := NEW.kind;
  ELSE
    SELECT e.period_id, e.entry_date, e.kind
      INTO target_period, target_date, entry_kind
      FROM journal_entries e
     WHERE e.id = NEW.entry_id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT * INTO period_row FROM periods WHERE id = target_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: período inexistente %', target_period
      USING ERRCODE = 'check_violation';
  END IF;

  IF period_row.status = 'CERRADO' THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: el período % está CERRADO. Registrá un ajuste en un período abierto o reabrí formalmente.',
      period_row.number
      USING ERRCODE = 'check_violation';
  END IF;

  -- BLOQUEADO admite solo asientos de cierre y ajuste. Ahora la condición usa
  -- únicamente variables locales.
  IF period_row.status = 'BLOQUEADO' AND entry_kind NOT IN ('AJUSTE', 'CIERRE') THEN
    RAISE EXCEPTION 'E_PERIOD_CLOSED: el período % está BLOQUEADO; solo admite asientos de AJUSTE o CIERRE',
      period_row.number
      USING ERRCODE = 'check_violation';
  END IF;

  IF target_date < period_row.start_date OR target_date > period_row.end_date THEN
    RAISE EXCEPTION 'E_DATE_OUT_OF_PERIOD: la fecha % cae fuera del período % (% a %)',
      target_date, period_row.number, period_row.start_date, period_row.end_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
