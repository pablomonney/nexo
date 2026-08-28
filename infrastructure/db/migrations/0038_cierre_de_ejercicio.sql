-- 0038_cierre_de_ejercicio.sql — el ciclo del ejercicio, conectado.
--
-- ## Lo que ya estaba y nadie usaba
--
-- La auditoría de esta fase encontró tres piezas construidas y desconectadas:
--
--   * `accounting_closures` (migración 0004): tabla completa, con RLS y grants,
--     **cero triggers y cero escritores**.
--   * `fiscal_years.status` con sus tres estados ABIERTO / EN_CIERRE / CERRADO:
--     ningún endpoint los cambia y ningún trigger los hace valer.
--   * `evaluarChecklist` / `puedeCerrar` en el motor, puros y con tests: ninguna
--     ruta los llama.
--
-- Esta migración no crea ninguna estructura paralela a esas. Le agrega columnas
-- a `accounting_closures` para que la relación cierre ↔ asientos ↔ apertura sea
-- **estructural y no texto libre**, y pone en la base los invariantes que hasta
-- ahora solo podía sostener la aplicación.
--
-- ## Cierre de ejercicio ≠ cierre de período
--
-- Se mantienen separados a propósito y no comparten ni un candado:
--
--   * El **período** cerrado impide escribir en un mes. Lo gobierna
--     `assert_period_open` (CANDADO 4), que no se toca acá.
--   * El **ejercicio** en cierre o cerrado gobierna qué *clase* de asiento se
--     admite en todo el ejercicio. Lo gobierna el trigger nuevo
--     `assert_fiscal_year_admite_asiento`.
--
-- Los dos corren, y el asiento tiene que pasar los dos.

-- ---------------------------------------------------------------------------
-- 1. Qué cuenta recibe el resultado del ejercicio
-- ---------------------------------------------------------------------------
-- GAP resuelto explícitamente, no por omisión.
--
-- El modelo de `accounts` clasifica por `type` —ACTIVO, PASIVO, PN, INGRESO,
-- COSTO, GASTO, ORDEN—, lo cual alcanza para saber **qué cuentas se refunden**:
-- las de resultado. No alcanza para saber **contra cuál**. Ninguna columna decía
-- «esta es la cuenta de Resultado del ejercicio», y no hay forma de deducirla:
-- una empresa puede llamarla «Resultado del ejercicio», otra «Resultados no
-- asignados», y las dos son de tipo PN.
--
-- Adivinarla —tomar la primera PN, o buscar por nombre— sería inventar
-- contabilidad. Se agrega un marcador estructural que la empresa fija una vez, y
-- **su ausencia bloquea el cierre** con `E_RESULT_ACCOUNT_MISSING`.
--
-- Es un marcador técnico del catálogo, no una afirmación normativa: no dice qué
-- cuenta *debe* usarse según ninguna norma, dice cuál eligió esta empresa.
ALTER TABLE accounts
  ADD COLUMN closing_role text
    CHECK (closing_role IN ('RESULTADO_DEL_EJERCICIO'));

-- Una sola por empresa. Dos serían dos respuestas a la misma pregunta.
CREATE UNIQUE INDEX accounts_una_cuenta_de_resultado
  ON accounts (company_id, closing_role)
  WHERE closing_role IS NOT NULL;

-- Y tiene que poder recibir el resultado: patrimonio neto e imputable.
-- Marcar una cuenta de ingresos como receptora del resultado dejaría la
-- refundición girando en el vacío.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_resultado_es_pn_imputable
    CHECK (closing_role IS NULL
           OR (type = 'PN' AND is_postable AND status = 'ACTIVE'));

COMMENT ON COLUMN accounts.closing_role IS
  'Rol de la cuenta en el cierre de ejercicio. RESULTADO_DEL_EJERCICIO marca la '
  'que recibe la refundición. La elige la empresa: el sistema no la deduce.';

-- ---------------------------------------------------------------------------
-- 2. El expediente del cierre
-- ---------------------------------------------------------------------------
-- `accounting_closures` pasa de ser un registro suelto a ser el nudo que ata el
-- ejercicio, sus dos asientos de cierre, los saldos que quedaron y la apertura
-- que después derivó de ellos.
--
-- FASE K pide que esa relación sea estructural. Por eso son columnas con FK y no
-- una descripción en `checklist`: un `jsonb` con ids adentro se puede escribir
-- mal y nadie se entera.
ALTER TABLE accounting_closures
  -- Quién y cuándo completó el cierre. `performed_by`/`performed_at` son de la
  -- apertura del expediente (el pre-cierre); esto es de su cierre efectivo.
  ADD COLUMN closed_by  text,
  ADD COLUMN closed_at  timestamptz,

  -- La cuenta que recibió el resultado, congelada. Si mañana la empresa cambia
  -- su `closing_role`, este cierre tiene que seguir diciendo cuál usó.
  ADD COLUMN resultado_account_id uuid REFERENCES accounts (id),

  -- Resultado del ejercicio. Positivo = ganancia.
  ADD COLUMN resultado numeric(18, 2),

  -- Los dos asientos, separados. La refundición cancela las cuentas de
  -- resultado; el cierre cancela lo patrimonial. Son actos distintos y se
  -- pueden leer por separado.
  ADD COLUMN refundicion_entry_id uuid REFERENCES journal_entries (id),
  ADD COLUMN cierre_entry_id      uuid REFERENCES journal_entries (id),

  -- Saldos patrimoniales al cierre, **después** de la refundición. Es de acá y
  -- de ningún otro lado que sale la apertura: recalcularla permitiría que el
  -- asiento de apertura y el cierre que dice originarlo no coincidan.
  ADD COLUMN saldos jsonb,

  -- La apertura que derivó de este cierre, y en qué ejercicio.
  ADD COLUMN apertura_entry_id       uuid REFERENCES journal_entries (id),
  ADD COLUMN apertura_fiscal_year_id uuid REFERENCES fiscal_years (id),
  ADD COLUMN apertura_by             text,
  ADD COLUMN apertura_at             timestamptz;

-- Invariante 1 y 3: un ejercicio tiene UN cierre vivo, y un cierre es de un solo
-- ejercicio (la FK ya lo daba). Los ABORTADO quedan afuera: son intentos, y su
-- historia sirve.
CREATE UNIQUE INDEX accounting_closures_uno_por_ejercicio
  ON accounting_closures (fiscal_year_id)
  WHERE status <> 'ABORTADO';

-- Invariantes 5 y 6: cada asiento pertenece a un solo cierre. Sin esto, dos
-- expedientes podrían apuntar al mismo asiento de cierre y los dos afirmarían
-- haberlo generado.
CREATE UNIQUE INDEX accounting_closures_refundicion_unica
  ON accounting_closures (refundicion_entry_id) WHERE refundicion_entry_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_closures_cierre_unico
  ON accounting_closures (cierre_entry_id) WHERE cierre_entry_id IS NOT NULL;
CREATE UNIQUE INDEX accounting_closures_apertura_unica
  ON accounting_closures (apertura_entry_id) WHERE apertura_entry_id IS NOT NULL;

-- Un cierre COMPLETADO tiene todo lo que un cierre completo tiene. Sin esto,
-- una transacción a medias dejaría un expediente que dice haber cerrado y no
-- puede decir con qué.
--
-- Los dos `*_entry_id` NO están en la lista, y es a propósito: un ejercicio sin
-- movimientos de resultado no genera refundición, y uno sin ningún movimiento no
-- genera tampoco cierre. Fabricar un asiento vacío para llenar la columna sería
-- registrar un acto que no ocurrió — y un asiento de cero líneas ni siquiera
-- pasa el CANDADO 3 de la 0005. Lo que sí es obligatorio es poder decir **qué
-- resultado se determinó y con qué saldos**, que es lo que el cierre afirma.
ALTER TABLE accounting_closures
  ADD CONSTRAINT ac_completado_completo
    CHECK (status <> 'COMPLETADO' OR (
             closed_by IS NOT NULL AND closed_at IS NOT NULL
         AND resultado IS NOT NULL AND resultado_account_id IS NOT NULL
         AND saldos IS NOT NULL));

-- Invariante 7: la apertura solo existe sobre un cierre completado, y viene
-- entera o no viene.
ALTER TABLE accounting_closures
  ADD CONSTRAINT ac_apertura_solo_sobre_cierre_completo
    CHECK (apertura_entry_id IS NULL OR (
             status = 'COMPLETADO'
         AND apertura_fiscal_year_id IS NOT NULL
         AND apertura_by IS NOT NULL
         AND apertura_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. Invariante 8: lo que fundamentó un cierre no se cambia en silencio
-- ---------------------------------------------------------------------------
-- Un cierre COMPLETADO es un hecho pasado con un resultado informado. Lo único
-- que puede pasarle después es recibir su apertura. Todo lo demás —el checklist,
-- el resultado, los saldos, los asientos, la cuenta usada— queda congelado.
--
-- Se corrige como todo lo demás en este sistema: no editando, sino abortando y
-- volviendo a cerrar, y quedan los dos expedientes.
CREATE OR REPLACE FUNCTION assert_closure_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'COMPLETADO' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'El cierre % está COMPLETADO: su estado no cambia. Abortá y volvé a cerrar, y quedan los dos.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.checklist            IS DISTINCT FROM OLD.checklist
  OR NEW.fiscal_year_id       IS DISTINCT FROM OLD.fiscal_year_id
  OR NEW.company_id           IS DISTINCT FROM OLD.company_id
  OR NEW.resultado            IS DISTINCT FROM OLD.resultado
  OR NEW.resultado_account_id IS DISTINCT FROM OLD.resultado_account_id
  OR NEW.saldos               IS DISTINCT FROM OLD.saldos
  OR NEW.refundicion_entry_id IS DISTINCT FROM OLD.refundicion_entry_id
  OR NEW.cierre_entry_id      IS DISTINCT FROM OLD.cierre_entry_id
  OR NEW.closed_by            IS DISTINCT FROM OLD.closed_by
  OR NEW.closed_at            IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION
      'Los datos que fundamentaron el cierre % son inmutables. Lo único que se le puede agregar después es su apertura.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  -- Invariante 6, del otro lado: la apertura se escribe una vez.
  IF OLD.apertura_entry_id IS NOT NULL
     AND NEW.apertura_entry_id IS DISTINCT FROM OLD.apertura_entry_id THEN
    RAISE EXCEPTION
      'El cierre % ya derivó su asiento de apertura (%). No se genera dos veces.',
      OLD.id, OLD.apertura_entry_id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_closures_inmutable
  BEFORE UPDATE ON accounting_closures
  FOR EACH ROW EXECUTE FUNCTION assert_closure_inmutable();

CREATE TRIGGER accounting_closures_no_delete
  BEFORE DELETE ON accounting_closures
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 4. Invariante 9: el estado del ejercicio gobierna qué asiento entra
-- ---------------------------------------------------------------------------
-- Hasta acá esto vivía **solo** en el motor: `validate.ts` rechaza un asiento en
-- un ejercicio CERRADO. Es la misma forma de agujero que la auditoría encontró
-- tres veces antes — un invariante que un `psql` a mano, un script de migración
-- o un bug de la aplicación atraviesan sin resistencia.
--
--   ABIERTO     → entra cualquier asiento.
--   EN_CIERRE   → solo AJUSTE, REFUNDICION y CIERRE. Es para lo que existe el
--                 pre-cierre: los días entre «no entra más operación corriente»
--                 y «está cerrado».
--   CERRADO     → no entra nada. Ni siquiera un ajuste: para eso hay que
--                 reabrir, que es un acto formal que este sistema todavía no
--                 implementa (queda como gap declarado).
--
-- La APERTURA no aparece en la lista de EN_CIERRE a propósito: pertenece al
-- ejercicio **siguiente**, que está ABIERTO.
CREATE OR REPLACE FUNCTION assert_fiscal_year_admite_asiento() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  estado text;
  codigo text;
BEGIN
  SELECT status, code INTO estado, codigo
    FROM fiscal_years WHERE id = NEW.fiscal_year_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'E_DATE_OUT_OF_PERIOD: ejercicio inexistente %', NEW.fiscal_year_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF estado = 'CERRADO' THEN
    RAISE EXCEPTION
      'E_PERIOD_CLOSED: el ejercicio % está CERRADO y no admite asientos. Un ejercicio cerrado se corrige en el siguiente.',
      codigo USING ERRCODE = 'check_violation';
  END IF;

  IF estado = 'EN_CIERRE' AND NEW.kind NOT IN ('AJUSTE', 'REFUNDICION', 'CIERRE') THEN
    RAISE EXCEPTION
      'E_PERIOD_CLOSED: el ejercicio % está EN_CIERRE: solo admite asientos de AJUSTE, REFUNDICION o CIERRE (se intentó %).',
      codigo, NEW.kind USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. `REFUNDICION` como clase propia de asiento
-- ---------------------------------------------------------------------------
-- La refundición de resultados y el cierre de las cuentas patrimoniales son dos
-- actos distintos, y separarlos en dos asientos permite leerlos por separado
-- —y, sobre todo, permite que cada uno tenga su propio índice de unicidad.
--
-- Es una extensión de la enumeración, no la relajación de un candado: ningún
-- asiento que antes entraba deja de entrar, y ninguno que antes no entraba entra
-- ahora sin pasar por los mismos siete candados de la 0005.
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_kind_check;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_kind_check
    CHECK (kind IN ('NORMAL', 'AJUSTE', 'APERTURA', 'CIERRE', 'REVERSION', 'REFUNDICION'));

-- El trigger se crea después del CHECK para que 'REFUNDICION' ya sea un valor
-- posible cuando el trigger lo nombra.
CREATE TRIGGER je_fiscal_year_guard
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_fiscal_year_admite_asiento();

-- Invariantes 4, 5 y 6, en la base: un ejercicio tiene como mucho un asiento de
-- cada clase de cierre, y cada uno está en **su** ejercicio por construcción —la
-- columna que indexa es `fiscal_year_id`, así que un asiento de cierre no puede
-- contarse en otro.
--
-- Los ANULADO quedan afuera: un cierre anulado por contraasiento tiene que poder
-- rehacerse.
CREATE UNIQUE INDEX journal_entries_una_refundicion_por_ejercicio
  ON journal_entries (company_id, fiscal_year_id)
  WHERE kind = 'REFUNDICION' AND status IN ('BORRADOR', 'PROPUESTO', 'APROBADO');

CREATE UNIQUE INDEX journal_entries_un_cierre_por_ejercicio
  ON journal_entries (company_id, fiscal_year_id)
  WHERE kind = 'CIERRE' AND status IN ('BORRADOR', 'PROPUESTO', 'APROBADO');

CREATE UNIQUE INDEX journal_entries_una_apertura_por_ejercicio
  ON journal_entries (company_id, fiscal_year_id)
  WHERE kind = 'APERTURA' AND status IN ('BORRADOR', 'PROPUESTO', 'APROBADO');

-- ---------------------------------------------------------------------------
-- 6. Permiso
-- ---------------------------------------------------------------------------
-- Cerrar un ejercicio no es cerrar un mes. Determina el resultado que después va
-- a los estados contables y a la declaración jurada, así que es un acto del
-- profesional — misma línea que `journal_entry:approve` (0011) y `book:emit`
-- (0019). El Administrador administra el sistema; no firma el resultado.
INSERT INTO permissions (code, description) VALUES
  ('fiscal_year:close', 'Pre-cerrar y cerrar un ejercicio, y derivar su asiento de apertura');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code = 'fiscal_year:close';

COMMENT ON TABLE accounting_closures IS
  'Expediente del cierre de un ejercicio: el checklist con que se pre-cerró, el '
  'resultado determinado, los dos asientos que lo registraron, los saldos que '
  'quedaron y la apertura que derivó de ellos. Es el nudo estructural entre '
  'cierre y apertura: sin él, la relación sería una frase en una descripción.';
