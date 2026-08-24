-- 0008_audit_lineage.sql — bitácora encadenada, linaje, alertas.
--
-- Dos mecanismos distintos que se suelen confundir:
--   · audit_logs   registra ACCIONES  (quién hizo qué, cuándo y por qué)
--   · lineage_edges registra DERIVACIONES (de qué se compone esta cifra)

CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id  uuid NOT NULL REFERENCES companies (id),
  actor_type  text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'AI')),
  actor_id    text NOT NULL,
  action      text NOT NULL,
  object_type text NOT NULL,
  object_id   text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  motivo      text,
  ip          inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  prev_hash   char(64) NOT NULL,
  hash        char(64) NOT NULL,

  -- Las acciones excepcionales exigen motivo. Un contraasiento sin explicación
  -- es un agujero en la auditoría.
  CONSTRAINT audit_reason_required
    CHECK (action NOT IN ('ANULAR_ASIENTO', 'REABRIR_PERIODO', 'ACTIVAR_REGLA',
                          'RECLASIFICAR_APROBADO', 'CAMBIAR_PLAN_CUENTAS')
           OR motivo IS NOT NULL)
);

CREATE INDEX audit_logs_company_time_idx ON audit_logs (company_id, occurred_at);
CREATE INDEX audit_logs_object_idx ON audit_logs (object_type, object_id);

-- Encadenamiento por hash: alterar un registro pasado invalida toda la cadena
-- posterior, y eso es detectable con scripts/verify-audit-chain.
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

  SELECT hash INTO previous
    FROM audit_logs
   WHERE company_id = NEW.company_id
   ORDER BY occurred_at DESC, id DESC
   LIMIT 1;

  NEW.prev_hash := COALESCE(previous, repeat('0', 64));

  payload := concat_ws('|',
    NEW.prev_hash, NEW.company_id::text, NEW.actor_type, NEW.actor_id, NEW.action,
    NEW.object_type, NEW.object_id,
    COALESCE(NEW.old_value::text, ''), COALESCE(NEW.new_value::text, ''),
    COALESCE(NEW.motivo, ''), NEW.occurred_at::text);

  NEW.hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_chain_link();

-- Append-only de verdad: se bloquea a nivel de trigger, y además se revocan los
-- privilegios al rol de aplicación en 0009_rls.sql. Dos candados, no uno.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora es append-only: % no está permitido sobre audit_logs', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- Verificador de integridad de la cadena.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_company_id uuid)
RETURNS TABLE (broken_at uuid, expected char(64), found char(64))
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  row_record record;
  running char(64) := repeat('0', 64);
  payload text;
  computed char(64);
BEGIN
  FOR row_record IN
    SELECT * FROM audit_logs
     WHERE company_id = p_company_id
     ORDER BY occurred_at ASC, id ASC
  LOOP
    payload := concat_ws('|',
      running, row_record.company_id::text, row_record.actor_type, row_record.actor_id,
      row_record.action, row_record.object_type, row_record.object_id,
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
$$;

-- ---------------------------------------------------------------------------
-- Linaje bidireccional (§24)
-- ---------------------------------------------------------------------------
-- Una sola tabla para las dos direcciones. El recorrido "estado contable →
-- documento" y el recorrido "documento → nota" son el mismo grafo leído al
-- derecho y al revés; por eso funciona igual en el balance, en una nota y en un
-- anexo, sin lógica especial por tipo de reporte.
CREATE TABLE lineage_edges (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid NOT NULL REFERENCES companies (id),
  from_type  text NOT NULL,
  from_id    uuid NOT NULL,
  to_type    text NOT NULL,
  to_id      uuid NOT NULL,
  relation   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, from_type, from_id, to_type, to_id, relation)
);

CREATE INDEX lineage_forward_idx ON lineage_edges (company_id, from_type, from_id);
CREATE INDEX lineage_backward_idx ON lineage_edges (company_id, to_type, to_id);

CREATE TRIGGER lineage_no_delete BEFORE DELETE ON lineage_edges
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- "¿De dónde salió este importe?" — un único recorrido recursivo hacia atrás.
CREATE OR REPLACE FUNCTION trace_origin(p_company_id uuid, p_type text, p_id uuid)
RETURNS TABLE (depth integer, from_type text, from_id uuid, to_type text, to_id uuid, relation text)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE trace AS (
    SELECT 1 AS depth, e.from_type, e.from_id, e.to_type, e.to_id, e.relation
      FROM lineage_edges e
     WHERE e.company_id = p_company_id AND e.to_type = p_type AND e.to_id = p_id
    UNION ALL
    SELECT t.depth + 1, e.from_type, e.from_id, e.to_type, e.to_id, e.relation
      FROM lineage_edges e
      JOIN trace t ON e.to_type = t.from_type AND e.to_id = t.from_id
     WHERE e.company_id = p_company_id AND t.depth < 32
  )
  SELECT * FROM trace;
$$;

-- ---------------------------------------------------------------------------
-- Alertas (§22)
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  kind            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('BAJA', 'MEDIA', 'ALTA', 'CRITICA')),
  object_type     text,
  object_id       uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'ABIERTA'
                    CHECK (status IN ('ABIERTA', 'RECONOCIDA', 'RESUELTA', 'DESCARTADA')),
  acknowledged_by text,
  acknowledged_at timestamptz,
  ack_reason      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Una alerta no se hace desaparecer en silencio: quien la cierra deja su nombre
  -- y el motivo.
  CHECK (status = 'ABIERTA'
         OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND ack_reason IS NOT NULL))
);

CREATE INDEX alerts_open_idx ON alerts (company_id, severity) WHERE status = 'ABIERTA';

CREATE TABLE system_settings (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id uuid REFERENCES companies (id),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, key)
);
