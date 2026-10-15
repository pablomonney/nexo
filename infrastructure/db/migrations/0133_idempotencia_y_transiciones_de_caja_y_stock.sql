-- ---------------------------------------------------------------------------
-- Idempotencia de caja y stock, y transiciones que resisten la concurrencia
-- ---------------------------------------------------------------------------
--
-- Diseño: docs/DISENO_IDEMPOTENCIA.md. Todo es ADITIVO y compatible hacia atrás: la
-- versión anterior de la aplicación no conoce las columnas nuevas, sigue insertando con
-- `NULL` y los índices únicos son parciales. Volver atrás el código no requiere tocar la base.
--
-- ## 1 · La clave de idempotencia vive en la propia fila
--
-- Un cliente de red puede reintentar una petición que el servidor YA procesó (la respuesta se
-- perdió, el navegador cortó por tiempo). Hoy cada intento crea un movimiento nuevo. La
-- garantía «una misma operación no puede generar dos movimientos» se pone donde no se puede
-- saltear: una restricción única de la tabla. El `INSERT … ON CONFLICT` es el árbitro; no hay
-- una tabla aparte de claves ni un estado intermedio que pueda quedar colgado.
--
--   idempotency_key   la que manda el cliente (encabezado `Idempotency-Key`), de 16 a 128
--                     caracteres `[A-Za-z0-9_-]`. NULL en las filas existentes y en las que
--                     escriben los guiones o la base (el trigger de recepciones).
--   idempotency_part  distingue las filas de UNA MISMA operación: una transferencia crea dos
--                     (0 = salida, 1 = entrada) y la salida de un comprobante, una por línea.
--   request_hash      SHA-256 de la operación y sus datos: distingue un reintento (mismo hash)
--                     de un error de uso (la misma clave con otros datos).

-- Movimientos de caja
ALTER TABLE cash_movements
  ADD COLUMN idempotency_key  text,
  ADD COLUMN idempotency_part smallint NOT NULL DEFAULT 0,
  ADD COLUMN request_hash     char(64),
  ADD CONSTRAINT cmv_clave_valida
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  ADD CONSTRAINT cmv_huella_valida
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT cmv_clave_con_huella
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));

CREATE UNIQUE INDEX cmv_clave_unica
  ON cash_movements (company_id, idempotency_key, idempotency_part)
  WHERE idempotency_key IS NOT NULL;

-- Movimientos de stock
ALTER TABLE stock_movements
  ADD COLUMN idempotency_key  text,
  ADD COLUMN idempotency_part smallint NOT NULL DEFAULT 0,
  ADD COLUMN request_hash     char(64),
  ADD CONSTRAINT sm_clave_valida
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  ADD CONSTRAINT sm_huella_valida
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT sm_clave_con_huella
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));

CREATE UNIQUE INDEX sm_clave_unica
  ON stock_movements (company_id, idempotency_key, idempotency_part)
  WHERE idempotency_key IS NOT NULL;

-- Apertura de sesión de caja
ALTER TABLE cash_sessions
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash    char(64),
  ADD CONSTRAINT cs_clave_valida
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  ADD CONSTRAINT cs_huella_valida
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT cs_clave_con_huella
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL));

CREATE UNIQUE INDEX cs_clave_unica
  ON cash_sessions (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2 · Un arqueo de caja ocurre una vez (I1)
-- ---------------------------------------------------------------------------
--
-- El cierre leía el estado con un `SELECT` suelto y después hacía un `UPDATE` sin mirar el
-- estado: dos cierres simultáneos pasaban los dos y el segundo PISABA el arqueo (saldo
-- contado, quién cerró, cuándo) y duplicaba la bitácora. Una sesión cerrada ya fue arqueada:
-- no cambia más, por ningún camino. El segundo `UPDATE` espera el candado de fila del primero,
-- relee la fila ya cerrada y acá se rechaza.

CREATE FUNCTION assert_transicion_de_sesion_de_caja() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CERRADA' THEN
    RAISE EXCEPTION
      'E_CAJA_YA_ARQUEADA: la sesión ya fue arqueada y no se modifica: se arquea una sola vez.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cs_transicion
  BEFORE UPDATE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_de_sesion_de_caja();

-- ---------------------------------------------------------------------------
-- 3 · Una sesión cerrada no recibe movimientos, aunque se crucen (I2)
-- ---------------------------------------------------------------------------
--
-- El disparador de la 0068 lee el estado de la sesión con un `SELECT` sin candado. Si el
-- cierre y el movimiento se cruzan, cada uno ve el estado ANTERIOR del otro (ninguno se
-- confirmó todavía) y el movimiento entra a una sesión que termina cerrada: cambia el saldo
-- teórico contra el que se contó. Con `FOR SHARE` el movimiento retiene la fila hasta que
-- confirma, y el cierre —que necesita el candado exclusivo— espera; y si el cierre llegó
-- primero, el movimiento espera, relee, ve CERRADA y se rechaza.

CREATE OR REPLACE FUNCTION assert_sesion_abierta() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  estado text;
BEGIN
  SELECT s.status INTO estado
    FROM cash_sessions s
   WHERE s.id = NEW.session_id AND s.company_id = NEW.company_id
     FOR SHARE;

  IF estado <> 'ABIERTA' THEN
    RAISE EXCEPTION
      'E_CAJA_CERRADA: la sesión está % y ya fue arqueada.', estado
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4 · Un recuento de stock se cierra una vez (I3)
-- ---------------------------------------------------------------------------
--
-- El cierre vuelca las diferencias al libro de movimientos (`INSERT … SELECT`) y después
-- cambia el estado, y nada en la base impedía que dos cierres simultáneos pasaran los dos:
-- los ajustes se duplicaban, y el libro es append-only, así que un ajuste duplicado no se
-- deshace, se compensa. Medido el 2026-10-15: seis cierres simultáneos dieron seis 200.
-- El segundo `UPDATE` espera el candado de fila, relee el recuento ya cerrado y se rechaza,
-- y con él se revierte su `INSERT … SELECT` (es la misma transacción).

CREATE FUNCTION assert_transicion_de_recuento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'BORRADOR' THEN
    RAISE EXCEPTION
      'E_RECUENTO_CERRADO: el recuento está en % y sus diferencias ya se ajustaron.', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sc_transicion
  BEFORE UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_de_recuento();

-- ---------------------------------------------------------------------------
-- 5 · Los movimientos de un cheque se serializan (I5)
-- ---------------------------------------------------------------------------
--
-- La máquina de estados del cheque (0064) mira el movimiento ANTERIOR con un `SELECT` sin
-- candado: dos movimientos simultáneos (por ejemplo, dos «DEPOSITADO») ven el mismo anterior,
-- pasan los dos y el cheque queda depositado dos veces. Se serializan los movimientos de UN
-- cheque antes de mirar: el segundo espera, ve el movimiento del primero y se valida contra él.
--
-- El candado es de AVISO (`pg_advisory_xact_lock`) y no `FOR UPDATE` sobre la fila del cheque,
-- y la diferencia importa: el disparador es AFTER INSERT, o sea que la clave foránea de
-- `check_movements.check_id` ya tomó `FOR KEY SHARE` sobre esa fila. Dos inserciones
-- simultáneas tienen entonces cada una un KEY SHARE y piden FOR UPDATE, que choca con el KEY
-- SHARE de la otra: un deadlock (medido el 2026-10-15: 2 de 6 depósitos simultáneos
-- terminaban en 500). Un candado de aviso no conflictúa con los de fila, así que no hay ciclo.

CREATE OR REPLACE FUNCTION assert_movimiento_de_cheque() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cheque_tipo  text;
  anterior     text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cheque:' || NEW.company_id::text || ':' || NEW.check_id::text, 0));

  SELECT c.tipo INTO cheque_tipo
    FROM checks c WHERE c.id = NEW.check_id AND c.company_id = NEW.company_id;

  SELECT m.tipo INTO anterior
    FROM check_movements m
   WHERE m.check_id = NEW.check_id AND m.company_id = NEW.company_id
     AND m.id <> NEW.id
   ORDER BY m.fecha DESC, m.id DESC
   LIMIT 1;

  -- El primer movimiento tiene que ser el que corresponde al tipo de cheque.
  IF anterior IS NULL THEN
    IF cheque_tipo = 'RECIBIDO' AND NEW.tipo <> 'RECIBIDO' THEN
      RAISE EXCEPTION
        'E_CHEQUE_PRIMER_MOVIMIENTO: un cheque de tercero entra a la cartera con RECIBIDO, y este es %.',
        NEW.tipo USING ERRCODE = 'check_violation';
    END IF;
    IF cheque_tipo = 'EMITIDO' AND NEW.tipo NOT IN ('ENTREGADO', 'ANULADO') THEN
      RAISE EXCEPTION
        'E_CHEQUE_PRIMER_MOVIMIENTO: un cheque propio empieza por ENTREGADO o ANULADO, y este es %.',
        NEW.tipo USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- Lo que ya terminó no vuelve a moverse. Un cheque acreditado se cobró; uno
  -- endosado ya no es de esta empresa.
  IF anterior IN ('ACREDITADO', 'ENDOSADO', 'ANULADO') THEN
    RAISE EXCEPTION
      'E_CHEQUE_CERRADO: el cheque está en % y no admite más movimientos.', anterior
      USING ERRCODE = 'check_violation';
  END IF;

  -- Las transiciones que sí existen.
  IF NOT (
       (anterior = 'RECIBIDO'   AND NEW.tipo IN ('DEPOSITADO', 'ENDOSADO', 'RECHAZADO'))
    OR (anterior = 'ENTREGADO'  AND NEW.tipo IN ('ACREDITADO', 'RECHAZADO'))
    OR (anterior = 'DEPOSITADO' AND NEW.tipo IN ('ACREDITADO', 'RECHAZADO'))
    -- Un rechazado vuelve a la cartera: se reclama y se puede volver a
    -- depositar, o se endosa. Lo que no hace es acreditarse solo.
    OR (anterior = 'RECHAZADO'  AND NEW.tipo IN ('DEPOSITADO', 'ENDOSADO'))
  ) THEN
    RAISE EXCEPTION
      'E_CHEQUE_TRANSICION: de % no se pasa a %.', anterior, NEW.tipo
      USING ERRCODE = 'check_violation';
  END IF;

  -- El destino tiene que corresponder al hecho.
  IF NEW.tipo = 'DEPOSITADO' AND NEW.bank_account_id IS NULL THEN
    RAISE EXCEPTION
      'E_CHEQUE_SIN_CUENTA: depositar exige decir en qué cuenta.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tipo = 'ENDOSADO' AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION
      'E_CHEQUE_SIN_DESTINATARIO: endosar exige decir a quién.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6 · La firma de una orden de pago no se reescribe (I6)
-- ---------------------------------------------------------------------------
--
-- La máquina de estados de la 0082 deja pasar `PAGADA → PAGADA` (y `APROBADA → APROBADA`,
-- `ANULADA → ANULADA`) sin mirar qué cambió, así que repetir «pagar» con otro asiento PISABA
-- el asiento del pago, y repetir «aprobar» pisaba quién y cuándo aprobó. Una orden pagada
-- nombra el asiento del pago y esa referencia no cambia. Se agrega a la rama de «mismo
-- estado» la prohibición de tocar la firma de la transición; el resto de la función es el
-- de la 0082, sin cambios.

CREATE OR REPLACE FUNCTION assert_transicion_de_orden() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  renglones   integer;
  sin_imputar integer;
BEGIN
  IF NEW.status = OLD.status THEN
    -- Cambios de contenido: solo mientras es borrador. Cambiarle el proveedor
    -- o la fecha a una orden aprobada sería aprobar una cosa y tener otra.
    IF OLD.status <> 'BORRADOR'
       AND (NEW.party_id <> OLD.party_id OR NEW.fecha <> OLD.fecha) THEN
      RAISE EXCEPTION 'E_OP_NO_EDITABLE: la orden está % y su encabezado ya no se modifica',
        OLD.status;
    END IF;

    -- Lo que firmó la transición no se reescribe: quién y cuándo aprobó, el asiento del pago y
    -- el motivo de la anulación son hechos, y repetir la operación no los cambia.
    IF OLD.status <> 'BORRADOR'
       AND (NEW.aprobada_at      IS DISTINCT FROM OLD.aprobada_at
         OR NEW.aprobada_por     IS DISTINCT FROM OLD.aprobada_por
         OR NEW.entry_id         IS DISTINCT FROM OLD.entry_id
         OR NEW.pagada_at        IS DISTINCT FROM OLD.pagada_at
         OR NEW.motivo_anulacion IS DISTINCT FROM OLD.motivo_anulacion) THEN
      RAISE EXCEPTION
        'E_OP_YA_FIRMADA: la orden ya está % y lo que firmó esa transición no se reescribe.', OLD.status;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('PAGADA', 'ANULADA') THEN
    RAISE EXCEPTION 'E_OP_TRANSICION: la orden está % y ese estado es final', OLD.status;
  END IF;

  IF NOT (
       (OLD.status = 'BORRADOR' AND NEW.status IN ('APROBADA', 'ANULADA'))
    OR (OLD.status = 'APROBADA' AND NEW.status IN ('PAGADA', 'ANULADA'))
  ) THEN
    RAISE EXCEPTION 'E_OP_TRANSICION: no se puede pasar de % a %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'APROBADA' THEN
    SELECT count(*) INTO renglones
      FROM payment_order_lines l
     WHERE l.payment_order_id = NEW.id AND l.company_id = NEW.company_id;

    IF renglones = 0 THEN
      RAISE EXCEPTION 'E_OP_SIN_RENGLONES: no se aprueba una orden que no dice qué paga';
    END IF;
  END IF;

  IF NEW.status = 'PAGADA' THEN
    IF NEW.entry_id IS NULL THEN
      RAISE EXCEPTION 'E_OP_SIN_ASIENTO: una orden pagada nombra el asiento del pago';
    END IF;

    -- La prueba: cada comprobante de la orden tiene que estar imputado por
    -- ese asiento. Sin esto, «PAGADA» sería una palabra escrita al lado de un
    -- hecho que puede no haber ocurrido.
    SELECT count(*) INTO sin_imputar
      FROM payment_order_lines l
     WHERE l.payment_order_id = NEW.id
       AND l.company_id = NEW.company_id
       AND NOT EXISTS (
             SELECT 1
               FROM party_allocations a
               JOIN journal_entry_lines jl
                 ON jl.id = a.journal_entry_line_id AND jl.company_id = a.company_id
              WHERE a.company_id = l.company_id
                AND a.tax_transaction_id = l.tax_transaction_id
                AND a.status = 'ACTIVA'
                AND jl.entry_id = NEW.entry_id
           );

    IF sin_imputar > 0 THEN
      RAISE EXCEPTION 'E_OP_PAGO_NO_IMPUTADO: % comprobante(s) de la orden no están imputados por el asiento del pago',
        sin_imputar;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
