-- 0041_candados_que_faltaban.sql — cuatro candados que la auditoría encontró
-- abiertos, ninguno de ellos por falta de diseño: por falta de destino.
--
-- Los cuatro tienen la misma forma, que ya es conocida en este repositorio: hay
-- una estructura correcta, hay una regla escrita, y entre las dos falta el
-- pedazo que las conecta. Mientras nadie recorra el camino, el hueco no se ve.
--
--   1. El §32 exige que la activación de una regla quede firmada. El script que
--      la firma escribe en `audit_logs`, cuya `company_id` es NOT NULL — y una
--      regla no es de ninguna empresa. La aprobación falla SIEMPRE, después del
--      UPDATE, y el rollback la deshace. Nunca se notó porque nunca se aprobó
--      una regla.
--   2. El gap `vigencia_to_1997_iva` dice que bloquea la activación de
--      AR-IVA-CF-VINCULACION-001. Nada lo consulta salvo una pantalla.
--   3. `periods` admite ABIERTO/BLOQUEADO/CERRADO y la máquina de estados vive
--      en TypeScript. Por SQL directo, un período CERRADO vuelve a ABIERTO sin
--      la doble firma: el CHECK que la exige solo mira si `reopened_at` está
--      cargado, y quien saltea la API no lo carga.
--   4. `BLOQUEADO` no tiene permiso ni endpoint: es un estado inalcanzable.

-- ---------------------------------------------------------------------------
-- 1 · La bitácora del plano normativo
-- ---------------------------------------------------------------------------
-- `audit_logs` es por empresa por construcción: la columna es NOT NULL, la
-- política de RLS es `company_id = app_company_id()` y la cadena de hash se
-- encadena por empresa. Nada de eso es un accidente que convenga aflojar para
-- que entre una fila sin empresa: aflojarlo abriría una fila invisible para
-- todos los inquilinos dentro de la bitácora contable.
--
-- Una regla no pertenece a una empresa. Pertenece al plano normativo, que en
-- este sistema es uno solo y compartido —`accounting_rules` ni siquiera tiene
-- RLS—. Entonces su bitácora es otra bitácora, con la misma forma: encadenada,
-- append-only, y con la constancia escrita al lado del antes y el después.

CREATE TABLE normative_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
  actor_id      text NOT NULL CHECK (btrim(actor_id) <> ''),
  action        text NOT NULL CHECK (btrim(action) <> ''),
  object_type   text NOT NULL CHECK (btrim(object_type) <> ''),
  object_id     text NOT NULL CHECK (btrim(object_id) <> ''),
  old_value     jsonb,
  new_value     jsonb,

  -- Acá el motivo NO es opcional, a diferencia de `audit_logs`. Un acto
  -- normativo sin constancia escrita es una firma que no dice qué se revisó, y
  -- es exactamente lo que el §32 pide que no pase. El mínimo de largo no
  -- garantiza calidad: descarta el "ok".
  motivo        text NOT NULL CHECK (length(btrim(motivo)) >= 30),

  occurred_at   timestamptz NOT NULL DEFAULT now(),
  prev_hash     char(64) NOT NULL,
  hash          char(64) NOT NULL,
  seq           bigint NOT NULL
);

CREATE SEQUENCE normative_audit_seq_sequence;

CREATE INDEX normative_audit_logs_objeto_idx
  ON normative_audit_logs (object_type, object_id, seq);

-- La cadena es una sola —el plano normativo no está particionado—, así que el
-- lock es uno solo. `hashtext` de una constante: mismo mecanismo que la cadena
-- por empresa, con un único cubo.
CREATE OR REPLACE FUNCTION normative_audit_chain_link() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous char(64);
  payload  text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('normative_audit_logs'));

  NEW.seq := nextval('normative_audit_seq_sequence');

  SELECT hash INTO previous FROM normative_audit_logs ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := COALESCE(previous, repeat('0', 64));

  payload := concat_ws('|',
    NEW.prev_hash, NEW.seq::text, NEW.actor_type, NEW.actor_id, NEW.action,
    NEW.object_type, NEW.object_id,
    COALESCE(NEW.old_value::text, ''), COALESCE(NEW.new_value::text, ''),
    NEW.motivo, NEW.occurred_at::text);

  NEW.hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER normative_audit_logs_chain
  BEFORE INSERT ON normative_audit_logs
  FOR EACH ROW EXECUTE FUNCTION normative_audit_chain_link();

CREATE OR REPLACE FUNCTION forbid_normative_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'La bitácora normativa es append-only: % no está permitido sobre normative_audit_logs', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER normative_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON normative_audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_normative_audit_mutation();

GRANT SELECT, INSERT ON normative_audit_logs TO aai_app;
GRANT USAGE ON SEQUENCE normative_audit_seq_sequence TO aai_app;

COMMENT ON TABLE normative_audit_logs IS
  'Bitácora encadenada de los actos sobre el plano normativo: aprobación de '
  'reglas, adopciones, cambios de estado. No lleva company_id porque las normas '
  'no son de ninguna empresa; por eso no puede vivir en audit_logs, cuya '
  'company_id es NOT NULL y cuya cadena se encadena por empresa.';

-- ---------------------------------------------------------------------------
-- 2 · Un gap abierto bloquea de verdad
-- ---------------------------------------------------------------------------
-- La 0033 dice: «Se registra como gap en la base y no solo en un documento
-- porque el motor consulta esta tabla». El motor no la consultaba. La única
-- lectura de `normative_gaps` estaba en una pantalla del estudio.
--
-- El vínculo se hace por columna y no leyendo el texto de `blocks`: buscar el
-- `rule_key` dentro de una descripción en prosa es inferir por texto libre, que
-- es justamente lo que este sistema no hace en ningún otro lado.

ALTER TABLE normative_gaps
  ADD COLUMN blocks_rule_key text;

COMMENT ON COLUMN normative_gaps.blocks_rule_key IS
  'Regla cuya activación este gap bloquea, si bloquea alguna. Es el vínculo '
  'estructural: mientras el gap esté ABIERTO, la regla no puede pasar a ACTIVE.';

UPDATE normative_gaps
   SET blocks_rule_key = 'AR-IVA-CF-VINCULACION-001'
 WHERE topic = 'vigencia_to_1997_iva';

CREATE OR REPLACE FUNCTION assert_rule_not_blocked_by_gap() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  gap_abierto text;
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  SELECT g.topic INTO gap_abierto
    FROM normative_gaps g
   WHERE g.blocks_rule_key = NEW.rule_key
     AND g.status = 'ABIERTO'
   LIMIT 1;

  IF gap_abierto IS NOT NULL THEN
    RAISE EXCEPTION
      'La regla % no puede activarse: el gap normativo "%" sigue ABIERTO. '
      'Cerrar el gap exige la fuente oficial que falta, no un cambio de estado.',
      NEW.rule_key, gap_abierto
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_rules_gap_abierto
  BEFORE INSERT OR UPDATE ON accounting_rules
  FOR EACH ROW EXECUTE FUNCTION assert_rule_not_blocked_by_gap();

-- ---------------------------------------------------------------------------
-- 3 · La máquina de estados del período, en la base
-- ---------------------------------------------------------------------------
-- `packages/accounting-engine/src/periods.ts` tiene la máquina completa y
-- ningún llamador productivo: la ruta reimplementa las reglas en SQL. Eso deja
-- dos consecuencias, y la segunda es la grave:
--
--   · la transición no se valida contra la máquina, sino contra un `if` suelto;
--   · por SQL directo no se valida contra nada.
--
-- El CHECK `periods_check2` ya exige dos firmantes distintos, pero solo cuando
-- `reopened_at` está cargado. Un UPDATE que ponga `status = 'ABIERTO'` y deje
-- las columnas de reapertura en NULL lo pasa por al lado. Ese es el agujero.

CREATE OR REPLACE FUNCTION assert_period_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- ABIERTO → BLOQUEADO → CERRADO, y de CERRADO solo se sale reabriendo.
  IF OLD.status = 'ABIERTO' AND NEW.status NOT IN ('BLOQUEADO', 'CERRADO') THEN
    RAISE EXCEPTION 'Transición de período inválida: ABIERTO → %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'BLOQUEADO' AND NEW.status NOT IN ('CERRADO', 'ABIERTO') THEN
    RAISE EXCEPTION 'Transición de período inválida: BLOQUEADO → %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- La reapertura es el único camino de vuelta, y exige dejar la constancia en
  -- la misma sentencia que cambia el estado. Sin esto, `periods_check2` es una
  -- restricción sobre columnas que quien saltea la API simplemente no toca.
  IF OLD.status = 'CERRADO' THEN
    IF NEW.status <> 'ABIERTO' THEN
      RAISE EXCEPTION 'Transición de período inválida: CERRADO → %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reopened_at IS NULL
       OR NEW.reopened_by IS NULL
       OR NEW.reopened_countersigned_by IS NULL
       OR btrim(coalesce(NEW.reopen_reason, '')) = ''
       OR NEW.reopened_at IS NOT DISTINCT FROM OLD.reopened_at THEN
      RAISE EXCEPTION
        'Reabrir un período exige registrar la reapertura en la misma operación: '
        'quién, quién refrenda y por qué. Un UPDATE de status a secas no alcanza.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'BLOQUEADO' AND OLD.status = 'CERRADO' THEN
    RAISE EXCEPTION 'Un período CERRADO no se bloquea: se reabre'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER periods_transicion_valida
  BEFORE UPDATE ON periods
  FOR EACH ROW EXECUTE FUNCTION assert_period_transition();

-- ---------------------------------------------------------------------------
-- 4 · BLOQUEADO deja de ser inalcanzable
-- ---------------------------------------------------------------------------
-- El estado existe en el CHECK desde la 0004, el guard de asientos lo contempla
-- desde la 0010 —solo AJUSTE y CIERRE— y `validate.ts` tiene
-- `actorCanPostToBlocked`. Nada de eso se puede ejercitar: no hay permiso ni
-- endpoint que lleve un período a BLOQUEADO.

INSERT INTO permissions (code, description) VALUES
  ('period:block', 'Bloquear un período: solo admite asientos de AJUSTE o CIERRE');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code = 'period:block';
