-- 0044_correccion_de_decisiones.sql — corregir una decisión es un acto, no un UPDATE.
--
-- El modelo ya tenía casi todo: `supersedes_id`, el estado `SUPERSEDIDA`, el
-- índice `accounting_decisions_una_vigente` y un trigger que impide modificar
-- una decisión ya usada por un asiento. Lo que faltaba eran dos cosas, y la
-- primera es un agujero.
--
-- ## 1 · Una decisión supersedida seguía pudiendo fundar un asiento
--
-- `assert_entry_decision_coherente` (0034/0036) comprueba tres cosas —empresa,
-- ambiente y comprobante— y **no mira el estado**. Así que después de corregir
-- una decisión, la anterior seguía sirviendo para fundar un asiento nuevo. La
-- corrección quedaba registrada y era, en la práctica, opcional.
--
-- Se nota poco porque nadie iba a citarla a propósito. Pero el sentido de
-- superseder es justamente que lo viejo deja de valer, y un candado que no lo
-- impone convierte la corrección en una anotación.
--
-- ## 2 · Superseder no exigía decir por qué
--
-- `justificacion` es opcional en la tabla —una decisión DETERMINISTICA no la
-- necesita, la fundan los hechos y la regla—. Pero una **corrección** sin motivo
-- escrito es un cambio de opinión sin explicación, y dentro de dos años nadie va
-- a poder reconstruirlo. Es el mismo criterio que la constancia del §32 y que el
-- `motivo_version` de las notas.
--
-- ## Lo que NO cambia
--
-- La decisión anterior **se conserva**. No se borra, no se edita: cambia de
-- estado y queda encadenada por `supersedes_id`. Quedan las dos, como un asiento
-- y su contraasiento, y el asiento que citó la vieja sigue mostrando exactamente
-- lo que citó.

-- ---------------------------------------------------------------------------
-- 1 · Una decisión supersedida no funda nada nuevo
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_entry_decision_coherente() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  amb    text;
  dueno  uuid;
  origen uuid;
  est    text;
BEGIN
  IF NEW.decision_id IS NULL THEN RETURN NEW; END IF;

  SELECT ambiente, company_id, tax_transaction_id, estado
    INTO amb, dueno, origen, est
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

  -- El control que faltaba. Se aplica solo al INSERT y a los UPDATE que cambian
  -- de decisión: un asiento ya escrito conserva la suya aunque después la
  -- corrijan, porque lo que ese asiento cita es lo que se decidió entonces.
  IF est = 'SUPERSEDIDA'
     AND (TG_OP = 'INSERT' OR NEW.decision_id IS DISTINCT FROM OLD.decision_id) THEN
    RAISE EXCEPTION
      'La decisión % fue supersedida: ya no vale. Usá la que la reemplazó.',
      NEW.decision_id
      USING ERRCODE = 'check_violation';
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
-- 2 · Superseder exige decir qué cambió, y sobre qué
-- ---------------------------------------------------------------------------

ALTER TABLE accounting_decisions
  ADD CONSTRAINT decision_correccion_con_motivo
    CHECK (
      supersedes_id IS NULL
      OR length(btrim(coalesce(justificacion, ''))) >= 30
    );

COMMENT ON COLUMN accounting_decisions.supersedes_id IS
  'La decisión que esta corrige. Encadena el historial: la anterior no se borra '
  'ni se edita, queda SUPERSEDIDA y sigue siendo lo que su asiento cita. Una '
  'corrección exige justificación escrita (decision_correccion_con_motivo).';

/**
 * La sucesora corrige una decisión de la MISMA empresa y del MISMO comprobante.
 *
 * Sin esto, `supersedes_id` es una FK que apunta a cualquier fila de la tabla, y
 * el RLS no alcanza: la comparación la hace la base sin contexto de empresa
 * cuando la escribe un rol que no lo tiene.
 */
CREATE OR REPLACE FUNCTION assert_decision_supersede_coherente() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ant record;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.supersedes_id = NEW.id THEN
    RAISE EXCEPTION 'Una decisión no se supersede a sí misma'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT company_id, tax_transaction_id, estado
    INTO ant
    FROM accounting_decisions WHERE id = NEW.supersedes_id;

  IF ant IS NULL THEN
    RAISE EXCEPTION 'La decisión % que se dice corregir no existe', NEW.supersedes_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF ant.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'La decisión % pertenece a otra empresa', NEW.supersedes_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF ant.tax_transaction_id IS DISTINCT FROM NEW.tax_transaction_id THEN
    RAISE EXCEPTION
      'La decisión % es sobre otra operación fiscal: una corrección no cambia de comprobante',
      NEW.supersedes_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- La anterior tiene que estar apagada **antes** de que entre la nueva. Es el
  -- orden que el índice `accounting_decisions_una_vigente` obliga a respetar, y
  -- decirlo con un mensaje propio ahorra descubrirlo por una violación de
  -- unicidad.
  IF ant.estado <> 'SUPERSEDIDA' THEN
    RAISE EXCEPTION
      'La decisión % sigue vigente. Marcala SUPERSEDIDA antes de emitir la que la reemplaza.',
      NEW.supersedes_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_decisions_supersede_coherente
  BEFORE INSERT OR UPDATE ON accounting_decisions
  FOR EACH ROW EXECUTE FUNCTION assert_decision_supersede_coherente();

-- ---------------------------------------------------------------------------
-- 3 · Auditoría del uso de una credencial de ARCA
-- ---------------------------------------------------------------------------
-- SECURITY.md §5 pide poder auditar el uso de la clave privada. `arca_query_log`
-- registra la consulta, no **con qué credencial** se firmó: si mañana hay dos
-- vigentes por rotación, no habría forma de saber cuál se usó ni de acotar el
-- alcance de una que se comprometa.
--
-- La columna es opcional a propósito: una consulta en ambiente `mock` no usa
-- ninguna credencial, y forzar un valor obligaría a inventar uno.

ALTER TABLE arca_query_log
  ADD COLUMN credential_id uuid REFERENCES company_arca_credentials (id);

COMMENT ON COLUMN arca_query_log.credential_id IS
  'Con qué certificado se firmó el pedido. Nulo en ambiente mock, donde no se '
  'firma nada. Permite acotar el alcance de una credencial comprometida: qué '
  'consultas la usaron y cuándo.';

CREATE INDEX arca_query_log_credencial_idx
  ON arca_query_log (credential_id, queried_at DESC)
  WHERE credential_id IS NOT NULL;

-- La credencial que respalda una consulta es de la misma empresa. Mismo
-- argumento que en la 0043 para `arca_query_id`: sin esto, un JOIN por id
-- dejaría que el certificado de una empresa aparezca respaldando la consulta de
-- otra.
CREATE OR REPLACE FUNCTION assert_arca_log_credencial() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dueno uuid;
BEGIN
  IF NEW.credential_id IS NULL THEN RETURN NEW; END IF;

  SELECT company_id INTO dueno
    FROM company_arca_credentials WHERE id = NEW.credential_id;

  IF dueno IS NULL THEN
    RAISE EXCEPTION 'La credencial % no existe', NEW.credential_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF dueno <> NEW.company_id THEN
    RAISE EXCEPTION 'La credencial % es de otra empresa', NEW.credential_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER arca_query_log_credencial_coherente
  BEFORE INSERT OR UPDATE ON arca_query_log
  FOR EACH ROW EXECUTE FUNCTION assert_arca_log_credencial();

-- ---------------------------------------------------------------------------
-- 4 · Permisos
-- ---------------------------------------------------------------------------

INSERT INTO permissions (code, description) VALUES
  ('decision:supersede', 'Corregir una decisión contable emitiendo la que la reemplaza'),
  ('arca_credential:manage', 'Cargar, rotar y revocar los certificados de ARCA de una empresa');

-- Corregir una decisión contable es un acto profesional: lo firma el CONTADOR.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code = 'decision:supersede';

-- Administrar certificados es operación del sistema, no firma contable. Va con
-- el ADMINISTRADOR, por el mismo reparto del §42 que separa las dos cosas.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'ADMINISTRADOR' AND p.code = 'arca_credential:manage';
