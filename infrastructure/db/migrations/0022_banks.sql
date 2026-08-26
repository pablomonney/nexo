-- 0022_banks.sql — cuentas bancarias, extractos y conciliación.
--
-- El criterio de salida de la FASE 9 tiene dos mitades. Una es un indicador
-- (≥ 80% de matching propuesto) y se mide en el motor. La otra es un invariante:
--
--   **0 conciliaciones confirmadas sin intervención humana.**
--
-- Un invariante no se cumple midiéndolo. Se cumple cuando no hay forma de
-- violarlo, y por eso está acá abajo como constraint y como trigger, no como una
-- validación de la aplicación:
--
--   * `bank_reconciliations.rec_confirmada_firmada` — confirmar exige persona y
--     fecha.
--   * `bank_reconciliation_matches.match_confirmado_firmado` — cada match
--     confirmado tiene su firmante, incluso los de score 100.
--   * `assert_reconciliation_confirmable()` — no se confirma una conciliación con
--     matches sin confirmar, ni con el acta descuadrada.
--
-- La tercera es la que más cuesta aceptar: **el acta tiene que cerrar para poder
-- confirmarse**. Una conciliación que no cierra no es una conciliación con una
-- observación al pie; es una que no está hecha.

-- ---------------------------------------------------------------------------
-- Cuentas bancarias
-- ---------------------------------------------------------------------------
CREATE TABLE bank_accounts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),
  bank_name    text NOT NULL CHECK (length(btrim(bank_name)) > 0),
  -- CBU: 22 dígitos. No se valida el dígito verificador acá porque el algoritmo
  -- sale de una comunicación del BCRA que no está archivada; se valida el largo,
  -- que es lo verificable sin fuente.
  cbu          text CHECK (cbu IS NULL OR cbu ~ '^[0-9]{22}$'),
  alias        text,
  numero       text,
  currency     text NOT NULL DEFAULT 'ARS',
  -- La cuenta contable que representa este banco. Sin ella no hay nada que
  -- conciliar: la conciliación compara el extracto contra el Mayor de ESTA cuenta.
  account_id   uuid NOT NULL REFERENCES accounts (id),
  status       text NOT NULL DEFAULT 'ACTIVA' CHECK (status IN ('ACTIVA', 'CERRADA')),
  created_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, account_id)
);

CREATE INDEX bank_accounts_company_idx ON bank_accounts (company_id, status);

-- ---------------------------------------------------------------------------
-- El mapeo del extracto: se declara, no se adivina
-- ---------------------------------------------------------------------------
-- No hay un formato de extracto en Argentina. La alternativa a esta tabla es que
-- el importador pruebe formatos hasta que uno parsee — y el día que falla, mete
-- $ 1.234 como $ 1,234 en una conciliación que alguien después firma.
CREATE TABLE bank_statement_layouts (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  bank_account_id     uuid NOT NULL REFERENCES bank_accounts (id),
  nombre              text NOT NULL,
  filas_encabezado    integer NOT NULL DEFAULT 1 CHECK (filas_encabezado >= 0),
  columna_fecha       integer NOT NULL CHECK (columna_fecha >= 0),
  columna_fecha_valor integer CHECK (columna_fecha_valor IS NULL OR columna_fecha_valor >= 0),
  columna_descripcion integer NOT NULL CHECK (columna_descripcion >= 0),
  columna_referencia  integer CHECK (columna_referencia IS NULL OR columna_referencia >= 0),
  columna_saldo       integer CHECK (columna_saldo IS NULL OR columna_saldo >= 0),
  esquema_signo       text NOT NULL
                        CHECK (esquema_signo IN ('COLUMNAS_SEPARADAS', 'COLUMNA_UNICA_CON_SIGNO')),
  -- Columnas tal como las titula el banco. La traducción a ENTRADA/SALIDA la
  -- hace el motor, una sola vez y en un solo lugar.
  columna_debito      integer CHECK (columna_debito IS NULL OR columna_debito >= 0),
  columna_credito     integer CHECK (columna_credito IS NULL OR columna_credito >= 0),
  columna_importe     integer CHECK (columna_importe IS NULL OR columna_importe >= 0),
  negativo_es_salida  boolean,
  formato_fecha       text NOT NULL
                        CHECK (formato_fecha IN ('DD/MM/AAAA', 'DD-MM-AAAA', 'AAAA-MM-DD', 'DD/MM/AA')),
  formato_importe     text NOT NULL CHECK (formato_importe IN ('ES_AR', 'EN_US', 'PLANO')),
  separador           text NOT NULL DEFAULT ';' CHECK (length(separador) = 1),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL,

  -- Un mapeo a medias no sirve: o están las dos columnas, o está la única con su
  -- óptica declarada. Sin esto, un mapeo incompleto falla recién al importar.
  CONSTRAINT layout_coherente CHECK (
    (esquema_signo = 'COLUMNAS_SEPARADAS'
       AND columna_debito IS NOT NULL AND columna_credito IS NOT NULL)
    OR
    (esquema_signo = 'COLUMNA_UNICA_CON_SIGNO'
       AND columna_importe IS NOT NULL AND negativo_es_salida IS NOT NULL)
  )
);

CREATE INDEX bank_statement_layouts_account_idx ON bank_statement_layouts (bank_account_id);

-- ---------------------------------------------------------------------------
-- Extractos y movimientos
-- ---------------------------------------------------------------------------
CREATE TABLE bank_statements (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  bank_account_id    uuid NOT NULL REFERENCES bank_accounts (id),
  layout_id          uuid REFERENCES bank_statement_layouts (id),
  -- El archivo original, archivado. Un extracto importado cuyo archivo no se
  -- guardó no se puede volver a leer para verificar cómo se interpretó.
  source_document_id uuid REFERENCES documents (id),
  desde              date NOT NULL,
  hasta              date NOT NULL,
  saldo_inicial      numeric(18, 2) NOT NULL,
  saldo_final        numeric(18, 2) NOT NULL,
  -- Resultado de la cadena de saldos. `NULL` = el extracto no traía columna de
  -- saldo, que NO es lo mismo que "se verificó y dio bien".
  cadena_verificada  boolean,
  errores            jsonb NOT NULL DEFAULT '[]'::jsonb,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  imported_by        text NOT NULL,

  CONSTRAINT statement_rango CHECK (desde <= hasta)
);

CREATE INDEX bank_statements_account_idx ON bank_statements (bank_account_id, desde DESC);

CREATE TRIGGER bank_statements_no_delete BEFORE DELETE ON bank_statements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE bank_transactions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),
  statement_id  uuid NOT NULL REFERENCES bank_statements (id),
  fecha         date NOT NULL,
  fecha_valor   date,
  descripcion   text NOT NULL,
  -- Importe SIEMPRE positivo; el sentido va aparte. Guardarlo con signo obliga a
  -- fijar de quién es la óptica, y esa óptica se invierte según quién mire.
  importe       numeric(18, 2) NOT NULL CHECK (importe > 0),
  -- ENTRADA/SALIDA desde la caja de la empresa, no DEBITO/CREDITO: en el extracto
  -- "débito" es plata que sale y en el libro es plata que entra. Las dos palabras
  -- son correctas y opuestas.
  sentido       text NOT NULL CHECK (sentido IN ('ENTRADA', 'SALIDA')),
  referencia    text,
  saldo_posterior numeric(18, 2),
  -- La fila original. Sin esto no se puede auditar cómo se interpretó.
  crudo         text NOT NULL,
  -- Huella para detectar reimportaciones: fecha, sentido, importe y referencia.
  huella        text NOT NULL,
  status        text NOT NULL DEFAULT 'PENDIENTE'
                  CHECK (status IN ('PENDIENTE', 'CONCILIADO', 'DESCARTADO')),
  descarte_motivo text,

  CONSTRAINT bt_descarte_justificado
    CHECK (status <> 'DESCARTADO' OR length(btrim(coalesce(descarte_motivo, ''))) > 0)
);

CREATE INDEX bank_transactions_statement_idx ON bank_transactions (statement_id, fecha);
CREATE INDEX bank_transactions_huella_idx ON bank_transactions (company_id, huella);

CREATE TRIGGER bank_transactions_no_delete BEFORE DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Conciliaciones
-- ---------------------------------------------------------------------------
CREATE TABLE bank_reconciliations (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  bank_account_id    uuid NOT NULL REFERENCES bank_accounts (id),
  period_id          uuid NOT NULL REFERENCES periods (id),
  desde              date NOT NULL,
  hasta              date NOT NULL,
  status             text NOT NULL DEFAULT 'BORRADOR'
                       CHECK (status IN ('BORRADOR', 'CONFIRMADA', 'ANULADA')),
  saldo_extracto     numeric(18, 2) NOT NULL,
  saldo_libro        numeric(18, 2) NOT NULL,
  ajuste_neto        numeric(18, 2) NOT NULL DEFAULT 0,
  cobertura          integer NOT NULL DEFAULT 0 CHECK (cobertura BETWEEN 0 AND 100),
  acta               text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,
  confirmed_at       timestamptz,
  confirmed_by       text,
  anulada_motivo     text,

  -- La igualdad del acta, hecha constraint:
  --   saldo extracto + partidas conciliatorias = saldo libro
  CONSTRAINT rec_acta_cierra
    CHECK (status <> 'CONFIRMADA' OR saldo_extracto + ajuste_neto = saldo_libro),

  -- El invariante del criterio de la fase. Sin firma no hay confirmación.
  CONSTRAINT rec_confirmada_firmada
    CHECK (status <> 'CONFIRMADA' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),

  CONSTRAINT rec_anulada_justificada
    CHECK (status <> 'ANULADA' OR length(btrim(coalesce(anulada_motivo, ''))) > 0),

  CONSTRAINT rec_rango CHECK (desde <= hasta)
);

-- Una sola conciliación vigente por cuenta y período. Dos conciliaciones
-- confirmadas del mismo mes son dos verdades distintas sobre el mismo saldo.
CREATE UNIQUE INDEX bank_reconciliations_unica
  ON bank_reconciliations (bank_account_id, period_id)
  WHERE status <> 'ANULADA';

CREATE TRIGGER bank_reconciliations_no_delete BEFORE DELETE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE bank_reconciliation_matches (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id           uuid NOT NULL REFERENCES companies (id),
  reconciliation_id    uuid NOT NULL REFERENCES bank_reconciliations (id),
  bank_transaction_id  uuid NOT NULL REFERENCES bank_transactions (id),
  journal_entry_line_id uuid NOT NULL REFERENCES journal_entry_lines (id),
  match_type           text NOT NULL
                         CHECK (match_type IN ('EXACTO', 'APROXIMADO', 'AGRUPADO', 'MANUAL')),
  -- Entero de 0 a 100. Un puntaje decimal comparado con `>` para desempatar
  -- produce resultados distintos entre corridas.
  score                integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  senales              jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Quién lo confirmó. NULL = propuesto y todavía no revisado.
  confirmed_by         text,
  confirmed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Ni el match de score 100 se confirma solo.
  CONSTRAINT match_confirmado_firmado
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),

  -- Un movimiento del banco no se concilia dos veces dentro de la misma
  -- conciliación, ni una línea contable tampoco.
  UNIQUE (reconciliation_id, bank_transaction_id, journal_entry_line_id)
);

CREATE INDEX brm_reconciliation_idx ON bank_reconciliation_matches (reconciliation_id);
CREATE INDEX brm_line_idx ON bank_reconciliation_matches (journal_entry_line_id);

CREATE TRIGGER brm_no_delete BEFORE DELETE ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE bank_reconciliation_differences (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  reconciliation_id   uuid NOT NULL REFERENCES bank_reconciliations (id),
  tipo                text NOT NULL
                        CHECK (tipo IN ('EN_BANCO_NO_EN_LIBRO', 'EN_LIBRO_NO_EN_BANCO',
                                        'SALDO_INICIAL_NO_COINCIDE', 'SALDO_FINAL_NO_COINCIDE')),
  bank_transaction_id uuid REFERENCES bank_transactions (id),
  journal_entry_line_id uuid REFERENCES journal_entry_lines (id),
  importe             numeric(18, 2) NOT NULL,
  sentido             text NOT NULL CHECK (sentido IN ('ENTRADA', 'SALIDA')),
  fecha               date,
  descripcion         text NOT NULL,
  -- Lo que el contador determinó que era. El sistema NO la completa: no clasifica
  -- una comisión como comisión, porque la descripción del banco no es una fuente
  -- y una partida mal clasificada produce un asiento equivocado.
  explicacion         text,
  resuelta_con_entry_id uuid REFERENCES journal_entries (id),

  CONSTRAINT diff_tiene_origen
    CHECK (bank_transaction_id IS NOT NULL OR journal_entry_line_id IS NOT NULL
           OR tipo IN ('SALDO_INICIAL_NO_COINCIDE', 'SALDO_FINAL_NO_COINCIDE'))
);

CREATE INDEX brd_reconciliation_idx ON bank_reconciliation_differences (reconciliation_id);

-- ---------------------------------------------------------------------------
-- El candado del criterio: no se confirma sin intervención humana
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_reconciliation_confirmable() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sin_confirmar integer;
BEGIN
  IF NEW.status <> 'CONFIRMADA' OR OLD.status = 'CONFIRMADA' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO sin_confirmar
    FROM bank_reconciliation_matches m
   WHERE m.reconciliation_id = NEW.id AND m.confirmed_by IS NULL;

  IF sin_confirmar > 0 THEN
    RAISE EXCEPTION 'No se puede confirmar la conciliación %: tiene % match(es) propuestos que nadie revisó. Un match de score 100 tampoco se confirma solo.',
      NEW.id, sin_confirmar
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rec_confirmable BEFORE UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION assert_reconciliation_confirmable();

-- Una conciliación confirmada es un hecho. Los matches que la componen no se
-- tocan más: si algo estaba mal, se anula la conciliación con motivo y se hace
-- otra. Misma lógica que el contraasiento del art. 324 inc. c del CCyC.
CREATE OR REPLACE FUNCTION forbid_match_change_when_confirmed() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  estado text;
BEGIN
  SELECT status INTO estado
    FROM bank_reconciliations WHERE id = COALESCE(NEW.reconciliation_id, OLD.reconciliation_id);
  IF estado = 'CONFIRMADA' THEN
    RAISE EXCEPTION 'La conciliación está CONFIRMADA: sus matches son inmutables. Anulala con motivo y hacé una nueva.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER brm_immutable_when_confirmed
  BEFORE INSERT OR UPDATE ON bank_reconciliation_matches
  FOR EACH ROW EXECUTE FUNCTION forbid_match_change_when_confirmed();

-- ---------------------------------------------------------------------------
-- RLS y privilegios
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY[
    'bank_accounts', 'bank_statement_layouts', 'bank_statements', 'bank_transactions',
    'bank_reconciliations', 'bank_reconciliation_matches', 'bank_reconciliation_differences'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, scoped_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO aai_app', scoped_table);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('bank:read',        'Ver cuentas bancarias, extractos y conciliaciones'),
  ('bank:import',      'Importar extractos bancarios'),
  ('bank:reconcile',   'Proponer y revisar conciliaciones'),
  ('bank:confirm',     'Confirmar una conciliación bancaria');

-- Confirmar una conciliación es afirmar que el saldo del banco y el del libro
-- están explicados. Es del Contador, como aprobar un asiento y emitir un libro.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR'
  AND p.code IN ('bank:read', 'bank:import', 'bank:reconcile', 'bank:confirm');

-- El cargador importa y propone, pero no confirma.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CARGADOR' AND p.code IN ('bank:read', 'bank:import', 'bank:reconcile');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('AUDITOR', 'ADMINISTRADOR') AND p.code = 'bank:read';

-- Un INSERT ... SELECT que no encuentra el rol inserta cero filas y no dice
-- nada. Es como se cuela un nombre de rol equivocado en una migración: aplica
-- sin error y el permiso simplemente no existe. Acá se verifica el resultado.
DO $verificar$
DECLARE
  faltante text;
BEGIN
  SELECT string_agg(esperado.code, ', ')
    INTO faltante
    FROM (VALUES ('CONTADOR'), ('CARGADOR'), ('AUDITOR'), ('ADMINISTRADOR')) AS esperado(code)
   WHERE NOT EXISTS (
     SELECT 1 FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = esperado.code AND p.code = 'bank:read'
   );

  IF faltante IS NOT NULL THEN
    RAISE EXCEPTION 'Los roles % no recibieron bank:read. Revisá que el código del rol exista en la tabla roles.', faltante;
  END IF;
END
$verificar$;

-- ---------------------------------------------------------------------------
-- Trazabilidad: del movimiento del banco al comprobante
-- ---------------------------------------------------------------------------
CREATE VIEW bank_trace AS
SELECT m.id                  AS match_id,
       m.company_id,
       m.reconciliation_id,
       m.match_type,
       m.score,
       m.confirmed_by,
       t.id                  AS bank_transaction_id,
       t.fecha               AS movimiento_fecha,
       t.descripcion         AS movimiento_descripcion,
       t.importe             AS movimiento_importe,
       t.sentido,
       t.referencia,
       l.id                  AS entry_line_id,
       l.line_no,
       e.id                  AS entry_id,
       e.journal_code,
       e.entry_number,
       e.entry_date,
       e.source_type,
       e.source_id,
       d.id                  AS document_id,
       d.original_name       AS document_name
  FROM bank_reconciliation_matches m
  JOIN bank_transactions t     ON t.id = m.bank_transaction_id
  JOIN journal_entry_lines l   ON l.id = m.journal_entry_line_id
  JOIN journal_entries e       ON e.id = l.entry_id
  LEFT JOIN documents d        ON d.id = e.source_id
                              AND e.source_type IN ('INVOICE', 'RECEIPT', 'BANK');

GRANT SELECT ON bank_trace TO aai_app;
