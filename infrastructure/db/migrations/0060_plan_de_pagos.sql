-- ============================================================================
-- 0060 — Condiciones de pago por comprobante: el plan de cuotas
-- ============================================================================
--
-- `PROJECT_STATUS.md` lo tenía anotado como carencia: *«el plazo es del
-- tercero; una factura con condiciones distintas o en tres cuotas no se puede
-- expresar»*. No era solo algo que faltaba. Era algo que daba **mal**.
--
-- Una factura en tres cuotas, con el modelo de la 0053, se proyecta como un
-- único vencimiento por el total en la fecha de la primera —o de la última,
-- según cómo se hubiera cargado `dias_de_pago`—. La proyección de cobranzas y
-- la antigüedad de saldos no quedaban incompletas: quedaban equivocadas, con
-- toda la apariencia de estar bien. Y desde el bloque anterior esa proyección
-- está en pantalla.
--
-- ## Una sola forma de decir cuándo vence
--
-- La tentación era agregar `tax_transactions.dias_de_pago` para el caso simple
-- —«esta factura es a 60 y no a 30»— y dejar las cuotas para el caso complejo.
-- Serían **dos verdades sobre la misma fecha**, y la primera vez que difieran
-- alguien va a tener que decidir cuál gana.
--
-- Hay un solo mecanismo: el plan. Una factura con condiciones propias es un
-- plan de **una** cuota. Es más ceremonia para el caso fácil, y a cambio no
-- existe la pregunta de cuál de las dos vale.
--
-- Sigue en pie lo de la 0053: sin plan declarado y sin `dias_de_pago` del
-- tercero, **no hay vencimiento**. El sistema no lo deduce.
--
-- ## La cuota se declara al imputar, no se adivina
--
-- Con un plan de tres cuotas y un cobro parcial, el sistema **no sabe** qué
-- cuota se pagó. La convención cómoda —consumir de la más vieja a la más
-- nueva— es una suposición, y una suposición sobre qué quedó cancelado es
-- exactamente lo que ADR-015 §7 prohíbe para la imputación.
--
-- Entonces: si el comprobante tiene plan, la imputación **nombra la cuota**.
-- Si no lo tiene, no hay cuota que nombrar y la columna va en `NULL`. Las dos
-- reglas las hace cumplir un trigger, porque una imputación sin cuota sobre un
-- comprobante con plan dejaría un pendiente que no se sabe a qué fecha vence.
--
-- ## Qué NO decide esta migración
--
-- No genera planes. No hay «12 cuotas iguales desde hoy» calculado por el
-- sistema: el plan es un acuerdo entre dos partes y lo carga quien lo conoce.
-- Que la consola ofrezca ayuda para tipearlo es otra cosa — el dato guardado
-- es siempre el declarado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El plan
-- ---------------------------------------------------------------------------
CREATE TABLE tax_transaction_installments (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  tax_transaction_id uuid NOT NULL,

  numero             integer NOT NULL CHECK (numero >= 1 AND numero <= 360),
  fecha_vencimiento  date NOT NULL,
  importe            numeric(18, 2) NOT NULL CHECK (importe > 0),

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,

  -- La empresa viaja dentro de la clave foránea. El RLS no protege la
  -- verificación de una FK —corre con privilegios del sistema— así que sin el
  -- `company_id` adentro, una cuota podría colgarse del comprobante de otra
  -- empresa y la base la aceptaría.
  CONSTRAINT tti_comprobante_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id),

  CONSTRAINT tti_numero_unico UNIQUE (company_id, tax_transaction_id, numero),
  -- Necesaria para que `party_allocations` pueda apuntar a una cuota llevando
  -- la empresa en la clave, igual que todo lo demás.
  CONSTRAINT tti_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE tax_transaction_installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_transaction_installments FORCE ROW LEVEL SECURITY;
-- `app_company_id()` y no `current_setting(...)::uuid` a mano. No es estilo: la
-- función hace `nullif(..., '')` antes de convertir, así que sin empresa en
-- contexto devuelve NULL y la política no deja pasar nada. La versión cruda
-- revienta con «invalid input syntax for type uuid: ""», que es un error en el
-- lugar equivocado. Lo cazó el test de aislamiento, que barre `pg_policies`
-- buscando exactamente esta comparación.
CREATE POLICY tti_por_empresa ON tax_transaction_installments
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tax_transaction_installments TO aai_app;

CREATE INDEX tti_comprobante_idx
  ON tax_transaction_installments (company_id, tax_transaction_id, numero);

COMMENT ON TABLE tax_transaction_installments IS
  'Plan de pagos declarado de un comprobante. Una factura con condiciones '
  'propias es un plan de una sola cuota: no hay un segundo mecanismo para el '
  'caso simple, para que no existan dos verdades sobre la misma fecha.';

COMMENT ON COLUMN tax_transaction_installments.importe IS
  'Las cuotas suman exactamente el total del comprobante. Lo verifica un '
  'trigger diferido: un plan a medio cargar es válido dentro de la '
  'transacción y no al confirmarla.';

-- ---------------------------------------------------------------------------
-- 2 · El plan cierra contra el total
-- ---------------------------------------------------------------------------
-- Diferido, por el mismo motivo que los renglones de la 0049: cargar tres
-- cuotas son tres INSERT, y exigir que cierre en cada uno haría imposible
-- cargar la primera.
CREATE FUNCTION assert_plan_cierra() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  comprobante uuid;
  empresa     uuid;
  total_cbte  numeric(18, 2);
  fecha_cbte  date;
  suma        numeric(18, 2);
  cuotas      integer;
  temprana    date;
BEGIN
  -- Dos ramas y no un `CASE`: PL/pgSQL prepara la expresión entera antes de
  -- evaluarla, y `NEW.tax_transaction_id` no existe cuando el disparo viene de
  -- `tax_transactions`.
  IF TG_TABLE_NAME = 'tax_transactions' THEN
    comprobante := NEW.id;
    empresa     := NEW.company_id;
  ELSE
    comprobante := NEW.tax_transaction_id;
    empresa     := NEW.company_id;
  END IF;

  SELECT t.total, t.cbte_fecha INTO total_cbte, fecha_cbte
    FROM tax_transactions t
   WHERE t.id = comprobante AND t.company_id = empresa;

  SELECT coalesce(sum(i.importe), 0), count(*), min(i.fecha_vencimiento)
    INTO suma, cuotas, temprana
    FROM tax_transaction_installments i
   WHERE i.tax_transaction_id = comprobante AND i.company_id = empresa;

  -- Sin plan no hay nada que verificar: declarar un plan es opcional.
  IF cuotas = 0 THEN
    RETURN NULL;
  END IF;

  IF suma <> total_cbte THEN
    RAISE EXCEPTION
      'E_PLAN_NO_CIERRA: las % cuota(s) suman % y el comprobante es de %.',
      cuotas, suma, total_cbte
      USING ERRCODE = 'check_violation';
  END IF;

  -- Una cuota que vence antes de que exista la factura es un error de carga, no
  -- un acuerdo. Se corta acá y no en un CHECK de columna porque la fecha del
  -- comprobante vive en otra tabla.
  IF temprana < fecha_cbte THEN
    RAISE EXCEPTION
      'E_PLAN_ANTES_DEL_COMPROBANTE: hay una cuota al % y el comprobante es del %.',
      temprana, fecha_cbte
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER tti_plan_cierra
  AFTER INSERT OR UPDATE OR DELETE ON tax_transaction_installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_plan_cierra();

-- También del lado del comprobante: si cambia el total, el plan que ya estaba
-- deja de cerrar y hay que enterarse en ese momento.
CREATE CONSTRAINT TRIGGER tt_plan_cierra
  AFTER UPDATE ON tax_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_plan_cierra();

-- ---------------------------------------------------------------------------
-- 3 · La imputación nombra la cuota
-- ---------------------------------------------------------------------------
ALTER TABLE party_allocations
  ADD COLUMN installment_id uuid,
  ADD CONSTRAINT pa_cuota_fk
    FOREIGN KEY (company_id, installment_id)
    REFERENCES tax_transaction_installments (company_id, id);

COMMENT ON COLUMN party_allocations.installment_id IS
  'Qué cuota cancela. Obligatoria si el comprobante tiene plan, prohibida si '
  'no lo tiene. Consumir de la más vieja a la más nueva habría sido cómodo y '
  'habría sido adivinar qué se pagó (ADR-015 §7).';

CREATE INDEX pa_cuota_idx
  ON party_allocations (company_id, installment_id)
  WHERE installment_id IS NOT NULL;

CREATE FUNCTION assert_imputacion_nombra_cuota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cuotas       integer;
  de_otro      integer;
  cuota_total  numeric(18, 2);
  cuota_usada  numeric(18, 2);
BEGIN
  SELECT count(*) INTO cuotas
    FROM tax_transaction_installments i
   WHERE i.tax_transaction_id = NEW.tax_transaction_id
     AND i.company_id = NEW.company_id;

  IF cuotas > 0 AND NEW.installment_id IS NULL THEN
    RAISE EXCEPTION
      'E_ALLOC_SIN_CUOTA: el comprobante tiene un plan de % cuota(s): la imputación tiene que decir cuál cancela.',
      cuotas
      USING ERRCODE = 'check_violation';
  END IF;

  IF cuotas = 0 AND NEW.installment_id IS NOT NULL THEN
    RAISE EXCEPTION
      'E_ALLOC_CUOTA_SIN_PLAN: el comprobante no tiene plan de pagos y la imputación nombra una cuota.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.installment_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- La cuota tiene que ser **de este** comprobante. La clave foránea garantiza
  -- que exista y que sea de la empresa; no que pertenezca a la factura que se
  -- está cancelando.
  SELECT count(*) INTO de_otro
    FROM tax_transaction_installments i
   WHERE i.id = NEW.installment_id
     AND i.company_id = NEW.company_id
     AND i.tax_transaction_id <> NEW.tax_transaction_id;

  IF de_otro > 0 THEN
    RAISE EXCEPTION
      'E_ALLOC_CUOTA_DE_OTRO_COMPROBANTE: esa cuota pertenece a otra factura.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Y no se puede imputar a una cuota más de lo que la cuota vale. El control
  -- del total del comprobante ya existe desde la 0053 y no alcanza: tres cuotas
  -- de 100 admiten 300 en la primera sin que aquel se queje.
  SELECT i.importe INTO cuota_total
    FROM tax_transaction_installments i
   WHERE i.id = NEW.installment_id AND i.company_id = NEW.company_id;

  SELECT coalesce(sum(a.importe), 0) INTO cuota_usada
    FROM party_allocations a
   WHERE a.installment_id = NEW.installment_id
     AND a.company_id = NEW.company_id
     AND a.status = 'ACTIVA';

  IF cuota_usada > cuota_total THEN
    RAISE EXCEPTION
      'E_ALLOC_EXCEDE_CUOTA: se imputó % a una cuota de %.', cuota_usada, cuota_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER pa_nombra_cuota
  AFTER INSERT OR UPDATE ON party_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_imputacion_nombra_cuota();

-- ---------------------------------------------------------------------------
-- 4 · La composición del saldo, cuota por cuota
-- ---------------------------------------------------------------------------
CREATE VIEW installment_settlement WITH (security_invoker = true) AS
SELECT i.company_id,
       i.id                                     AS installment_id,
       i.tax_transaction_id,
       t.party_id,
       p.razon_social,
       t.direction,
       t.punto_venta,
       t.cbte_numero,
       t.cbte_fecha,
       i.numero,
       i.fecha_vencimiento                      AS vencimiento,
       i.importe,
       coalesce(a.imputado, 0)                  AS imputado,
       i.importe - coalesce(a.imputado, 0)      AS pendiente,
       -- Acá la mora no lleva `CASE`: si hay cuota, hay vencimiento declarado.
       -- Es la diferencia con `invoice_settlement`, donde el vencimiento puede
       -- no existir y `NULL` significa «nadie declaró el plazo».
       greatest(0, current_date - i.fecha_vencimiento) AS dias_de_mora
  FROM tax_transaction_installments i
  JOIN tax_transactions t
    ON t.id = i.tax_transaction_id AND t.company_id = i.company_id
  JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
  LEFT JOIN LATERAL (
        SELECT sum(x.importe) AS imputado
          FROM party_allocations x
         WHERE x.installment_id = i.id
           AND x.company_id = i.company_id
           AND x.status = 'ACTIVA'
       ) a ON true;

COMMENT ON VIEW installment_settlement IS
  'Qué queda pendiente de cada cuota y desde cuándo. Todo derivado: no hay '
  'una columna de saldo que mantener.';

-- ---------------------------------------------------------------------------
-- 5 · `invoice_settlement` aprende que existen los planes
-- ---------------------------------------------------------------------------
-- ⚠ `WITH (security_invoker = true)` va repetido a propósito. `CREATE OR
-- REPLACE` **no conserva las reloptions**: omitirlo las borra, la vista pasa a
-- evaluarse con los permisos de su dueño y saltea el RLS de las tablas de
-- abajo. Ya pasó una vez, en la 0058, y la bandeja de una empresa habría
-- aparecido en la de otra.
CREATE OR REPLACE VIEW invoice_settlement WITH (security_invoker = true) AS
SELECT t.company_id,
       t.id                                    AS tax_transaction_id,
       t.party_id,
       p.razon_social,
       t.direction,
       t.cbte_tipo,
       t.punto_venta,
       t.cbte_numero,
       t.cbte_fecha,
       t.total,
       coalesce(a.imputado, 0)                 AS imputado,
       t.total - coalesce(a.imputado, 0)       AS pendiente,

       -- Tres fuentes posibles para el vencimiento, en este orden:
       --   1. el plan del comprobante, si lo tiene;
       --   2. los días de pago del tercero, si están declarados;
       --   3. ninguna — y entonces no hay vencimiento y no se lo deduce.
       plan.cuotas IS NOT NULL
         OR p.dias_de_pago IS NOT NULL          AS vencimiento_declarado,

       -- Con plan, el vencimiento del comprobante es el de **la cuota impaga
       -- más vieja**: es la próxima fecha en la que la empresa espera plata.
       -- No es una suposición sobre qué se pagó — sale de las imputaciones
       -- declaradas, cada una nombrando su cuota.
       coalesce(plan.proximo_vencimiento,
                CASE WHEN p.dias_de_pago IS NOT NULL
                     THEN t.cbte_fecha + p.dias_de_pago END)  AS vencimiento,

       CASE
         WHEN plan.cuotas IS NOT NULL THEN plan.mora_maxima
         WHEN p.dias_de_pago IS NOT NULL
           THEN greatest(0, current_date - (t.cbte_fecha + p.dias_de_pago))
       END                                     AS dias_de_mora,

       (current_date - t.cbte_fecha)           AS antiguedad_dias,

       -- ⚠ Las dos columnas nuevas van **al final** y no donde se leerían
       -- mejor. `CREATE OR REPLACE VIEW` solo sabe agregar columnas después de
       -- las que ya había: intercalarlas falla con «no se puede cambiar el
       -- nombre de la columna». Y no se puede hacer DROP + CREATE porque de
       -- esta vista cuelgan `party_aging` y `work_queue_cobranzas`, y de esa
       -- última cuelga la bandeja entera.
       plan.cuotas IS NOT NULL                  AS plan_declarado,
       plan.cuotas                              AS cuotas
  FROM tax_transactions t
  JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
  LEFT JOIN LATERAL (
        SELECT sum(x.importe) AS imputado
          FROM party_allocations x
         WHERE x.tax_transaction_id = t.id
           AND x.company_id = t.company_id
           AND x.status = 'ACTIVA'
       ) a ON true
  LEFT JOIN LATERAL (
        -- `count(*)` sobre un LEFT JOIN LATERAL sin filas devuelve 0, no NULL,
        -- y 0 se leería como «tiene plan de cero cuotas». Se usa `nullif` para
        -- que «sin plan» siga siendo NULL, que es como lo lee todo lo de arriba.
        SELECT nullif(count(*), 0)::int              AS cuotas,
               min(s.vencimiento) FILTER (WHERE s.pendiente > 0) AS proximo_vencimiento,
               coalesce(max(s.dias_de_mora) FILTER (WHERE s.pendiente > 0), 0) AS mora_maxima
          FROM installment_settlement s
         WHERE s.tax_transaction_id = t.id
           AND s.company_id = t.company_id
       ) plan ON true
 WHERE t.party_id IS NOT NULL;

COMMENT ON VIEW invoice_settlement IS
  'Composición del saldo: qué queda pendiente de cada comprobante. Todo '
  'derivado. El vencimiento sale del plan si lo hay, del plazo del tercero si '
  'no, y no existe si no hay ninguno de los dos: sin eso el sistema no afirma '
  'que nada esté vencido. Con plan, dias_de_mora es la de la cuota impaga más '
  'atrasada, no la del comprobante entero.';
