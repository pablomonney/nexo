-- 0042_bloqueado_admite_la_refundicion.sql — el candado se quedó viejo.
--
-- `je_period_guard` viene de la 0010 y dice: un período BLOQUEADO admite
-- `AJUSTE` y `CIERRE`. Correcto cuando se escribió, porque en ese momento esas
-- eran todas las clases de asiento del cierre.
--
-- La 0038 agregó `REFUNDICION` —el asiento que lleva las cuentas de resultado a
-- la cuenta de resultado del ejercicio, antes del asiento de cierre— y actualizó
-- el guard del EJERCICIO (`je_fiscal_year_guard`, que admite AJUSTE, REFUNDICION
-- y CIERRE durante EN_CIERRE). No actualizó el guard del PERÍODO.
--
-- La consecuencia es exactamente al revés de lo que el estado significa:
--
--     bloquear un período hacía IMPOSIBLE cerrar el ejercicio
--
-- La refundición se rechazaba con `E_PERIOD_CLOSED` y el cierre moría con un 500.
-- BLOQUEADO existe para que entren los ajustes de cierre sin que entre operación
-- corriente; que no dejara entrar la refundición lo convertía en un CERRADO con
-- otro nombre.
--
-- Nadie lo notó por la razón de siempre en este repositorio: **el estado era
-- inalcanzable**. No había permiso ni endpoint que llevara un período a
-- BLOQUEADO, así que el desacuerdo entre los dos guards vivió sin tocarse desde
-- la 0038. Apareció el mismo día en que el fixture conductual bloqueó un período
-- por primera vez.
--
-- La lección, que ya es la de esta fase entera: un candado sobre un estado al
-- que nadie puede llegar no está probado, está solamente escrito.
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

  -- La lista que cambia: REFUNDICION entra. Es un asiento del cierre por
  -- definición —la 0038 lo creó para eso— y dejarlo afuera hacía que bloquear un
  -- período impidiera cerrar el ejercicio.
  --
  -- APERTURA sigue afuera, y a propósito: pertenece al ejercicio siguiente, que
  -- está ABIERTO. Un período bloqueado no es donde se abre nada.
  IF period_row.status = 'BLOQUEADO'
     AND entry_kind NOT IN ('AJUSTE', 'REFUNDICION', 'CIERRE') THEN
    RAISE EXCEPTION
      'E_PERIOD_CLOSED: el período % está BLOQUEADO; solo admite asientos de AJUSTE, REFUNDICION o CIERRE',
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
