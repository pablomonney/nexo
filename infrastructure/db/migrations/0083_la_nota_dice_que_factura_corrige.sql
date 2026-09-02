-- ============================================================================
-- 0083 — La nota de crédito dice qué factura corrige
-- ============================================================================
--
-- La 0080 arregló el signo: una nota de crédito **resta** de la cuenta
-- corriente. Quedó anotado lo que faltaba: *«hoy afectan el saldo del tercero,
-- no un comprobante en particular»*.
--
-- Se ve en la antigüedad de saldos. Un cliente con una factura de 10.000 y una
-- nota de crédito de 4.000 muestra dos renglones: uno de 10.000 que dice que
-- debe todo, y otro de −4.000 flotando, sin decir de qué factura salió. El
-- neto es correcto —6.000— y el detalle no explica nada: al salir a cobrar hay
-- que reclamar 10.000 o 6.000, y la lista no lo dice.
--
-- ## La corrección mueve saldo, no lo duplica
--
-- Aplicar una nota de crédito a una factura **traslada** importe de una a la
-- otra: la factura baja lo que la nota sube. La suma del tercero no cambia
-- —era correcta desde la 0080—, y lo que cambia es de quién es cada peso.
--
-- Es el mismo mecanismo que la imputación de un cobro (0053), con una
-- diferencia: el cobro viene de un asiento y la corrección viene de otro
-- comprobante. Por eso no se reusó `party_allocations` —que apunta a una línea
-- del Mayor— y sí se copió su forma: se anula con motivo, nunca se borra.
--
-- ## Cuánto se aplica lo dice una persona
--
-- Una nota de crédito de 4.000 sobre un cliente con tres facturas abiertas no
-- dice a cuál corrige. La convención cómoda —la más vieja primero— es una
-- suposición sobre qué quedó cancelado, exactamente lo que ADR-015 §7 prohíbe
-- para la imputación. Acá vale igual: lo declara quien lo sabe.
--
-- Sin declarar nada, todo sigue como antes: la nota flota, el neto del tercero
-- es correcto y la bandeja avisa que hay una nota sin aplicar habiendo facturas
-- abiertas del mismo tercero. Avisa, no bloquea.
--
-- ## Las notas de débito, por el mismo camino y al revés
--
-- Una nota de débito aumenta lo que el tercero debe. Aplicada a una factura, le
-- suma a esa factura lo que se descuenta a sí misma. El signo no se decide
-- acá: sale de `arca_comprobante_types.clase`, igual que en la 0080.
--
-- ## Y si la factura tiene plan de cuotas, la corrección nombra la cuota
--
-- Es la regla de la 0060 aplicada a esta otra forma de bajar un saldo. Sin
-- cuota, el pendiente del comprobante bajaría y el de sus cuotas no: dos
-- verdades sobre la misma deuda.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La corrección
-- ---------------------------------------------------------------------------
CREATE TABLE tax_transaction_corrections (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),

  -- La nota (de crédito o de débito) y el comprobante que corrige.
  correctora_id     uuid NOT NULL,
  corregida_id      uuid NOT NULL,
  -- Obligatoria si la corregida tiene plan; prohibida si no lo tiene. Lo hace
  -- cumplir un trigger, igual que en `party_allocations`.
  installment_id    uuid,

  importe           numeric(18, 2) NOT NULL CHECK (importe > 0),

  status            text NOT NULL DEFAULT 'ACTIVA'
                    CHECK (status IN ('ACTIVA', 'ANULADA')),
  motivo_anulacion  text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,

  -- La empresa viaja dentro de cada clave foránea: el RLS no protege la
  -- verificación de una FK.
  CONSTRAINT ttc_correctora_fk
    FOREIGN KEY (company_id, correctora_id) REFERENCES tax_transactions (company_id, id),
  CONSTRAINT ttc_corregida_fk
    FOREIGN KEY (company_id, corregida_id) REFERENCES tax_transactions (company_id, id),
  CONSTRAINT ttc_cuota_fk
    FOREIGN KEY (company_id, installment_id)
    REFERENCES tax_transaction_installments (company_id, id),

  -- Un comprobante no se corrige a sí mismo. Sin esto, una nota podría
  -- cancelarse contra sí misma y desaparecer del saldo sin explicación.
  CONSTRAINT ttc_no_es_la_misma CHECK (correctora_id <> corregida_id),
  CONSTRAINT ttc_anulada_con_motivo
    CHECK (status <> 'ANULADA' OR motivo_anulacion IS NOT NULL)
);

ALTER TABLE tax_transaction_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_transaction_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY ttc_por_empresa ON tax_transaction_corrections
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON tax_transaction_corrections TO aai_app;

CREATE INDEX ttc_por_correctora ON tax_transaction_corrections (company_id, correctora_id);
CREATE INDEX ttc_por_corregida  ON tax_transaction_corrections (company_id, corregida_id);
CREATE INDEX ttc_por_cuota      ON tax_transaction_corrections (company_id, installment_id)
  WHERE installment_id IS NOT NULL;

COMMENT ON TABLE tax_transaction_corrections IS
  'Qué factura corrige cada nota de crédito o de débito, y por cuánto. No crea '
  'ni destruye saldo: traslada importe de un comprobante al otro. Se anula con '
  'motivo, nunca se borra.';

-- ---------------------------------------------------------------------------
-- 2 · Las reglas de la corrección
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_correccion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  correctora  record;
  corregida   record;
  disponible  numeric(18, 2);
  debido      numeric(18, 2);
  cuotas      integer;
  cuota_ok    boolean;
BEGIN
  -- Anular no revalida nada: es la salida prevista de una corrección que se
  -- cargó mal, y exigirle las reglas de alta la dejaría trabada.
  IF TG_OP = 'UPDATE' AND NEW.status = 'ANULADA' AND OLD.status = 'ACTIVA' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'ANULADA' THEN
    RAISE EXCEPTION 'E_CORR_ANULADA: una corrección anulada no vuelve; se carga otra';
  END IF;

  SELECT t.direction, t.party_id, t.total, ct.clase
    INTO correctora
    FROM tax_transactions t
    LEFT JOIN arca_comprobante_types ct ON ct.codigo = t.cbte_tipo
   WHERE t.id = NEW.correctora_id AND t.company_id = NEW.company_id;

  SELECT t.direction, t.party_id, t.total, ct.clase
    INTO corregida
    FROM tax_transactions t
    LEFT JOIN arca_comprobante_types ct ON ct.codigo = t.cbte_tipo
   WHERE t.id = NEW.corregida_id AND t.company_id = NEW.company_id;

  IF correctora.clase NOT IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    RAISE EXCEPTION 'E_CORR_NO_ES_NOTA: solo una nota de crédito o de débito corrige a otro comprobante';
  END IF;

  -- Que la corregida sea una factura no es un capricho: corregir una nota con
  -- otra nota encadenaría saldos sin que la cuenta corriente pueda explicar
  -- cuál cancela a cuál.
  IF corregida.clase IS DISTINCT FROM 'FACTURA' THEN
    RAISE EXCEPTION 'E_CORR_NO_ES_FACTURA: una nota corrige una factura, no otra nota';
  END IF;

  IF correctora.direction <> corregida.direction THEN
    RAISE EXCEPTION 'E_CORR_OTRA_PUNTA: una nota de ventas no corrige un comprobante de compras';
  END IF;

  IF correctora.party_id IS NULL OR corregida.party_id IS NULL THEN
    RAISE EXCEPTION 'E_CORR_SIN_TERCERO: los dos comprobantes tienen que estar imputados a un tercero';
  END IF;

  IF correctora.party_id <> corregida.party_id THEN
    RAISE EXCEPTION 'E_CORR_OTRO_TERCERO: la nota de un tercero no corrige la factura de otro';
  END IF;

  -- Lo que a la nota le queda por aplicar: su total menos lo ya aplicado en
  -- otras correcciones vivas.
  SELECT correctora.total - coalesce(sum(c.importe), 0)
    INTO disponible
    FROM tax_transaction_corrections c
   WHERE c.company_id = NEW.company_id
     AND c.correctora_id = NEW.correctora_id
     AND c.status = 'ACTIVA'
     AND c.id <> NEW.id;

  IF NEW.importe > disponible THEN
    RAISE EXCEPTION 'E_CORR_EXCEDE_NOTA: a la nota le quedan % y se quiere aplicar %',
      disponible, NEW.importe;
  END IF;

  -- Y lo que la factura todavía debe, ya descontados los pagos y las
  -- correcciones anteriores. Sale de `invoice_settlement`: es la única verdad
  -- sobre el pendiente de un comprobante.
  SELECT s.pendiente INTO debido
    FROM invoice_settlement s
   WHERE s.tax_transaction_id = NEW.corregida_id AND s.company_id = NEW.company_id;

  -- Una nota de crédito no puede cancelar más de lo que la factura debe: eso
  -- dejaría a la factura en negativo, que es decir que el cliente pagó de más
  -- sin que haya entrado un peso. La nota de débito no tiene ese techo — le
  -- suma a la factura, no le resta.
  IF correctora.clase = 'NOTA_CREDITO' AND NEW.importe > debido THEN
    RAISE EXCEPTION 'E_CORR_EXCEDE_FACTURA: la factura debe % y la nota quiere cancelar %',
      debido, NEW.importe;
  END IF;

  -- La cuota, con la misma regla de la 0060.
  SELECT count(*) INTO cuotas
    FROM tax_transaction_installments i
   WHERE i.tax_transaction_id = NEW.corregida_id AND i.company_id = NEW.company_id;

  IF cuotas > 0 AND NEW.installment_id IS NULL THEN
    RAISE EXCEPTION 'E_CORR_SIN_CUOTA: la factura tiene plan de cuotas y la corrección dice cuál corrige';
  END IF;

  IF cuotas = 0 AND NEW.installment_id IS NOT NULL THEN
    RAISE EXCEPTION 'E_CORR_CUOTA_SIN_PLAN: la factura no tiene plan y no hay cuota que nombrar';
  END IF;

  IF NEW.installment_id IS NOT NULL THEN
    SELECT true INTO cuota_ok
      FROM tax_transaction_installments i
     WHERE i.id = NEW.installment_id
       AND i.company_id = NEW.company_id
       AND i.tax_transaction_id = NEW.corregida_id;

    IF cuota_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'E_CORR_CUOTA_AJENA: esa cuota no es de la factura que se corrige';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ttc_reglas
  BEFORE INSERT OR UPDATE ON tax_transaction_corrections
  FOR EACH ROW EXECUTE FUNCTION assert_correccion();

-- Una corrección se anula, no se borra: borrarla haría desaparecer del rastro
-- que alguna vez esa nota se aplicó a esa factura.
CREATE FUNCTION assert_correccion_no_se_borra() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'E_CORR_NO_SE_BORRA: una corrección se anula con motivo, no se borra';
END;
$$;

CREATE TRIGGER ttc_no_delete
  BEFORE DELETE ON tax_transaction_corrections
  FOR EACH ROW EXECUTE FUNCTION assert_correccion_no_se_borra();

-- ---------------------------------------------------------------------------
-- 3 · La cuenta corriente aprende que las notas se aplican
-- ---------------------------------------------------------------------------
-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la cartera de una empresa se vería desde otra.
--
-- `corregido` va **al final**: `CREATE OR REPLACE VIEW` no admite insertar
-- columnas en el medio ni reordenarlas. `pendiente` sí cambia de expresión
-- —no de tipo—, que es lo único que la orden admite.
CREATE OR REPLACE VIEW invoice_settlement WITH (security_invoker = true) AS
SELECT t.company_id,
       t.id                                        AS tax_transaction_id,
       t.party_id,
       p.razon_social,
       t.direction,
       t.cbte_tipo,
       t.punto_venta,
       t.cbte_numero,
       t.cbte_fecha,
       (CASE WHEN ct.clase = 'NOTA_CREDITO' THEN -t.total ELSE t.total END)::numeric(18, 2)
                                                   AS total,
       coalesce(a.imputado, 0)                      AS imputado,
       -- El pendiente ahora también contempla lo trasladado por correcciones.
       -- `corregido` ya viene con signo: negativo en la factura que una nota de
       -- crédito bajó, positivo en la nota que se consumió al aplicarse.
       (CASE WHEN ct.clase = 'NOTA_CREDITO' THEN -t.total ELSE t.total END)
         - coalesce(a.imputado, 0)
         + coalesce(corr.corregido, 0)              AS pendiente,
       plan.cuotas IS NOT NULL OR p.dias_de_pago IS NOT NULL
                                                   AS vencimiento_declarado,
       coalesce(plan.proximo_vencimiento,
                CASE WHEN p.dias_de_pago IS NOT NULL
                     THEN t.cbte_fecha + p.dias_de_pago END)
                                                   AS vencimiento,
       CASE
         WHEN plan.cuotas IS NOT NULL THEN plan.mora_maxima
         WHEN p.dias_de_pago IS NOT NULL
           THEN greatest(0, current_date - (t.cbte_fecha + p.dias_de_pago))
       END                                         AS dias_de_mora,
       current_date - t.cbte_fecha                 AS antiguedad_dias,
       plan.cuotas IS NOT NULL                     AS plan_declarado,
       plan.cuotas,
       ct.clase,
       -- Agregado por la 0083, al final por lo dicho arriba.
       coalesce(corr.corregido, 0)                 AS corregido
  FROM tax_transactions t
  JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
  LEFT JOIN arca_comprobante_types ct ON ct.codigo = t.cbte_tipo
  LEFT JOIN LATERAL (
        SELECT sum(x.importe) AS imputado
          FROM party_allocations x
         WHERE x.tax_transaction_id = t.id AND x.company_id = t.company_id
           AND x.status = 'ACTIVA'
       ) a ON true
  LEFT JOIN LATERAL (
        SELECT
          -- Lo que este comprobante recibió como corrección: una nota de
          -- crédito le resta, una de débito le suma.
          coalesce(sum(CASE WHEN cc.clase = 'NOTA_CREDITO' THEN -c.importe ELSE c.importe END)
                   FILTER (WHERE c.corregida_id = t.id), 0)
          -- Y lo que dio, si el comprobante es la nota: al aplicarse se
          -- consume, así que el movimiento es el contrario.
          + coalesce(sum(CASE WHEN ct.clase = 'NOTA_CREDITO' THEN c.importe ELSE -c.importe END)
                     FILTER (WHERE c.correctora_id = t.id), 0)
            AS corregido
          FROM tax_transaction_corrections c
          LEFT JOIN tax_transactions tc
            ON tc.id = c.correctora_id AND tc.company_id = c.company_id
          LEFT JOIN arca_comprobante_types cc ON cc.codigo = tc.cbte_tipo
         WHERE c.company_id = t.company_id
           AND c.status = 'ACTIVA'
           AND (c.corregida_id = t.id OR c.correctora_id = t.id)
       ) corr ON true
  LEFT JOIN LATERAL (
        SELECT nullif(count(*), 0)::int AS cuotas,
               min(s.vencimiento) FILTER (WHERE s.pendiente > 0) AS proximo_vencimiento,
               coalesce(max(s.dias_de_mora) FILTER (WHERE s.pendiente > 0), 0) AS mora_maxima
          FROM installment_settlement s
         WHERE s.tax_transaction_id = t.id AND s.company_id = t.company_id
       ) plan ON true
 WHERE t.party_id IS NOT NULL;

COMMENT ON VIEW invoice_settlement IS
  'La composición de cada comprobante con tercero: total, imputado, corregido y '
  'pendiente. Una nota de crédito viene en negativo y, cuando se aplica a una '
  'factura, le traslada saldo en vez de flotar sin dueño.';

-- ---------------------------------------------------------------------------
-- 4 · Y las cuotas también
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW installment_settlement WITH (security_invoker = true) AS
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
       i.importe - coalesce(a.imputado, 0)
                 + coalesce(corr.corregido, 0)  AS pendiente,
       greatest(0, current_date - i.fecha_vencimiento) AS dias_de_mora,
       -- Agregada por la 0083, al final.
       coalesce(corr.corregido, 0)              AS corregido
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
       ) a ON true
  LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN cc.clase = 'NOTA_CREDITO' THEN -c.importe ELSE c.importe END)
                 AS corregido
          FROM tax_transaction_corrections c
          JOIN tax_transactions tc
            ON tc.id = c.correctora_id AND tc.company_id = c.company_id
          LEFT JOIN arca_comprobante_types cc ON cc.codigo = tc.cbte_tipo
         WHERE c.company_id = i.company_id
           AND c.installment_id = i.id
           AND c.status = 'ACTIVA'
       ) corr ON true;

COMMENT ON VIEW installment_settlement IS
  'Qué queda pendiente de cada cuota y desde cuándo, ya descontado lo que una '
  'nota de crédito le corrigió. Todo derivado: no hay saldo que mantener.';

-- ---------------------------------------------------------------------------
-- 5 · La nota que no se aplicó a nada
-- ---------------------------------------------------------------------------
CREATE VIEW notas_sin_aplicar WITH (security_invoker = true) AS
SELECT s.company_id,
       s.tax_transaction_id,
       s.party_id,
       s.razon_social,
       s.direction,
       s.cbte_tipo,
       s.punto_venta,
       s.cbte_numero,
       s.cbte_fecha,
       s.clase,
       s.total,
       s.corregido                                 AS aplicado,
       s.pendiente                                 AS sin_aplicar,
       -- Si el tercero no tiene facturas abiertas, la nota no está esperando
       -- nada: quedará para la próxima. Avisar ahí sería pedir una acción
       -- imposible.
       coalesce(abiertas.cantidad, 0)              AS facturas_abiertas
  FROM invoice_settlement s
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS cantidad
          FROM invoice_settlement f
         WHERE f.company_id = s.company_id
           AND f.party_id = s.party_id
           AND f.direction = s.direction
           AND f.clase = 'FACTURA'
           AND f.pendiente > 0
       ) abiertas ON true
 WHERE s.clase IN ('NOTA_CREDITO', 'NOTA_DEBITO')
   AND s.pendiente <> 0;

COMMENT ON VIEW notas_sin_aplicar IS
  'Notas de crédito y de débito que todavía no se aplicaron —del todo o en '
  'parte— a ninguna factura, con cuántas facturas abiertas tiene ese tercero.';

CREATE VIEW work_queue_correcciones WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- Una nota sin aplicar y facturas abiertas del mismo tercero. No bloquea: el
-- saldo del tercero ya está bien desde la 0080, y lo que falta es saber a qué
-- factura corresponde para poder reclamar el número correcto.
SELECT n.company_id,
       'NOTA_SIN_APLICAR'::text                      AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'tax_transactions'::text                      AS entidad,
       n.tax_transaction_id                          AS entity_id,
       n.clase                                       AS estado,
       'La ' || lower(replace(n.clase, '_', ' ')) || ' ' || n.punto_venta || '-' ||
         n.cbte_numero || ' de ' || n.razon_social || ' no dice qué factura ' ||
         'corrige, y ese tercero tiene ' || n.facturas_abiertas ||
         ' factura(s) abierta(s)'                    AS motivo,
       false                                         AS bloquea,
       ARRAY['FACTURA_CORREGIDA']::text[]            AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       n.cbte_fecha::timestamptz                     AS creado_en,
       n.cbte_fecha::timestamptz                     AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/tax-transactions'::text                     AS traza_ref
  FROM notas_sin_aplicar n
 WHERE n.facturas_abiertas > 0

) q;

COMMENT ON VIEW work_queue_correcciones IS
  'Notas de crédito y débito sin aplicar habiendo facturas abiertas del mismo '
  'tercero. No bloquea: el saldo ya es correcto, lo que falta es a qué factura '
  'corresponde.';

-- ⚠ `WITH (security_invoker = true)` repetido, por lo mismo de siempre.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios
UNION ALL SELECT * FROM work_queue_cheques
UNION ALL SELECT * FROM work_queue_lotes
UNION ALL SELECT * FROM work_queue_caja
UNION ALL SELECT * FROM work_queue_crm
UNION ALL SELECT * FROM work_queue_proyectos
UNION ALL SELECT * FROM work_queue_comisiones
UNION ALL SELECT * FROM work_queue_sucursales
UNION ALL SELECT * FROM work_queue_suscripcion
UNION ALL SELECT * FROM work_queue_mapeo
UNION ALL SELECT * FROM work_queue_arranque
UNION ALL SELECT * FROM work_queue_valuacion
UNION ALL SELECT * FROM work_queue_pagos
UNION ALL SELECT * FROM work_queue_correcciones;

-- ---------------------------------------------------------------------------
-- 6 · Permisos
-- ---------------------------------------------------------------------------
-- Aplicar una nota decide qué factura queda saldada, igual que imputar un
-- cobro. Va con el mismo permiso: es el mismo acto sobre la misma cuenta
-- corriente, por otro camino.
GRANT SELECT ON notas_sin_aplicar TO aai_app;
GRANT SELECT ON work_queue_correcciones TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
