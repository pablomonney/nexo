-- 0036_coherencia_decision_asiento.sql — dos agujeros que encontró la auditoría.
--
-- Los dos tienen la misma forma: un invariante que existía **solo en el código
-- de la aplicación**. Mientras nadie corriera dos pedidos a la vez ni escribiera
-- SQL a mano, no se notaban.
--
-- ## 1. Un asiento podía citar la decisión de OTRO comprobante
--
-- `assert_entry_decision_coherente` comprobaba la empresa y el ambiente, y no
-- que la decisión correspondiera al comprobante que el asiento declara como
-- origen. Reproducido: un asiento con `source_id` = comprobante B citando una
-- decisión sobre el comprobante A entra sin protestar, y `decision_trace`
-- después informa A como origen del asiento.
--
-- No es un dato inconsistente: es **trazabilidad falsa**, que es peor. El
-- recorrido se ve completo y señala el comprobante equivocado.
--
-- ## 2. Dos decisiones vigentes para la misma operación
--
-- El endpoint mira si ya hay una decisión vigente antes de emitir otra, pero
-- entre mirar y escribir hay una ventana. Dos pedidos concurrentes la
-- atraviesan los dos y quedan dos filas que dicen ser, cada una, "la" razón del
-- asiento. Reproducido con dos conexiones y 60 ms de espera.
--
-- El chequeo de la aplicación se queda: sirve para contestar 200 con la que ya
-- existe. Lo que faltaba es que la base lo garantice cuando ese chequeo pierde
-- la carrera.
--
-- ## Lo que NO se toca
--
-- El índice único de operación fiscal sigue siendo por documento (0035). La
-- auditoría confirmó que hace su trabajo: bajo concurrencia contuvo la
-- integridad —una sola fila— y lo único que falló fue el código de estado que
-- recibe el perdedor, que se arregla en la aplicación y no acá.

-- ---------------------------------------------------------------------------
-- 1. La decisión tiene que ser de este comprobante
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_entry_decision_coherente() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  amb    text;
  dueno  uuid;
  origen uuid;
BEGIN
  IF NEW.decision_id IS NULL THEN RETURN NEW; END IF;

  SELECT ambiente, company_id, tax_transaction_id
    INTO amb, dueno, origen
    FROM accounting_decisions WHERE id = NEW.decision_id;

  IF dueno IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'La decisión % pertenece a otra empresa', NEW.decision_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF amb = 'PRUEBA' THEN
    RAISE EXCEPTION
      'La decisión % es de ambiente PRUEBA y no puede fundamentar un asiento',
      NEW.decision_id USING ERRCODE = 'check_violation';
  END IF;

  -- Solo se compara cuando los dos lados dicen algo. Una decisión sin
  -- comprobante —un ajuste de cierre— puede fundar un asiento con
  -- `source_type = 'CLOSING'` y `source_id` nulo, y eso es legítimo.
  IF origen IS NOT NULL AND NEW.source_id IS NOT NULL AND origen <> NEW.source_id THEN
    RAISE EXCEPTION
      'La decisión % es sobre la operación fiscal % y este asiento declara como origen la %. '
      'Un asiento no puede fundarse en la decisión de otro comprobante.',
      NEW.decision_id, origen, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Una sola decisión vigente por operación fiscal
-- ---------------------------------------------------------------------------
-- Parcial en las dos direcciones: las SUPERSEDIDAS se acumulan —son la historia
-- de las correcciones— y una decisión sin comprobante no compite con nadie.
CREATE UNIQUE INDEX accounting_decisions_una_vigente
  ON accounting_decisions (tax_transaction_id)
  WHERE tax_transaction_id IS NOT NULL AND estado <> 'SUPERSEDIDA';

COMMENT ON INDEX accounting_decisions_una_vigente IS
  'Una operación fiscal tiene UNA decisión vigente. Dos serían indistinguibles '
  'y las dos dirían ser la razón del asiento. Las SUPERSEDIDAS quedan afuera: '
  'son el historial de correcciones.';
