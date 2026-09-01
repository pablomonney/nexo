-- 0053_imputacion_y_antiguedad_de_saldos.sql — de cuánto debe a qué debe.
--
-- ## Lo que ya se sabía y lo que no
--
-- `party_balances` (0047) dice **cuánto** se le debe a cada tercero, sumando el
-- Mayor. Es correcto y no alcanza para trabajar: un contador que mira una
-- cuenta corriente necesita saber **qué facturas** componen ese saldo y **desde
-- cuándo**. Un neto de $500.000 puede ser una factura de ayer o doce de hace un
-- año, y las dos situaciones no se parecen en nada.
--
-- ## Por qué hace falta una tabla y no alcanza con derivar
--
-- El resto de este trabajo evitó tablas nuevas derivando de los hechos. Acá no
-- se puede, y conviene decir por qué en vez de forzarlo:
--
-- **Qué factura cancela un pago es una decisión de una persona, no un hecho
-- deducible.** Un cliente que debe tres facturas de $1.000 y paga $1.000 puede
-- estar pagando cualquiera de las tres. La convención habitual —la más vieja
-- primero— es una suposición, y suponer acá tiene consecuencias: cambia qué
-- factura figura vencida, qué se reclama y qué se informa como incobrable.
--
-- Así que la imputación se **declara**, como se declara una afectación fiscal
-- (0031), y queda firmada y auditada. Lo que sí se deriva es todo lo demás:
-- cuánto queda pendiente de cada factura, desde cuándo, y en qué tramo de
-- antigüedad cae. Ninguna de esas cifras se almacena.
--
-- ## El vencimiento: declarado o no hay vencimiento
--
-- `tax_transactions` no tiene fecha de vencimiento, y **no se la inventa**.
-- NEXO no conoce las condiciones de pago pactadas: deducirlas de la fecha del
-- comprobante sería afirmar un plazo que nadie acordó, y sobre esa afirmación
-- se construirían reclamos.
--
-- Lo que sí puede saberse es lo que alguien declara: `parties.dias_de_pago` es
-- la condición comercial acordada con ese tercero. Cuando está declarada, el
-- vencimiento se **deriva** —fecha del comprobante más los días— y la mora es
-- una afirmación fundada. Cuando no lo está, la antigüedad se cuenta desde la
-- fecha del comprobante y **el sistema no afirma que nada esté vencido**.
--
-- La diferencia viaja en la propia vista (`vencimiento_declarado`), para que
-- ninguna pantalla pueda presentar una suposición como un hecho (§42).

-- ---------------------------------------------------------------------------
-- 1 · La condición de pago, declarada
-- ---------------------------------------------------------------------------
ALTER TABLE parties ADD COLUMN dias_de_pago integer
  CHECK (dias_de_pago IS NULL OR (dias_de_pago >= 0 AND dias_de_pago <= 3650));

COMMENT ON COLUMN parties.dias_de_pago IS
  'Condición de pago acordada, en días. NULL significa que no se declaró: el '
  'sistema entonces NO afirma que ninguna factura de este tercero esté vencida.';

-- La línea de asiento pasa a ser referenciable con su empresa incluida.
ALTER TABLE journal_entry_lines ADD CONSTRAINT jel_id_empresa UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 2 · La imputación
-- ---------------------------------------------------------------------------
CREATE TABLE party_allocations (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id            uuid NOT NULL REFERENCES companies (id),
  party_id              uuid NOT NULL,

  -- La factura que se cancela.
  tax_transaction_id    uuid NOT NULL,
  -- El movimiento del Mayor que la cancela: un cobro, un pago, una nota de
  -- crédito imputada. Se nombra la línea y no el asiento porque un asiento
  -- puede tocar a varios terceros.
  journal_entry_line_id uuid NOT NULL,

  importe               numeric(18, 2) NOT NULL CHECK (importe > 0),

  status                text NOT NULL DEFAULT 'ACTIVA'
                          CHECK (status IN ('ACTIVA', 'ANULADA')),
  motivo_anulacion      text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL,

  CONSTRAINT pa_anulada_con_motivo
    CHECK (status <> 'ANULADA' OR length(btrim(coalesce(motivo_anulacion, ''))) > 2),

  CONSTRAINT pa_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT pa_comprobante_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id),
  CONSTRAINT pa_linea_fk
    FOREIGN KEY (company_id, journal_entry_line_id)
    REFERENCES journal_entry_lines (company_id, id)
);

-- La misma línea no se imputa dos veces a la misma factura. Si hay que cambiar
-- el importe se anula la imputación y se hace otra: así queda el rastro de que
-- alguien cambió de opinión, que es justo lo que se quiere poder auditar.
CREATE UNIQUE INDEX pa_una_por_par
  ON party_allocations (tax_transaction_id, journal_entry_line_id)
  WHERE status = 'ACTIVA';

CREATE INDEX pa_por_comprobante ON party_allocations (company_id, tax_transaction_id)
  WHERE status = 'ACTIVA';
CREATE INDEX pa_por_linea ON party_allocations (company_id, journal_entry_line_id)
  WHERE status = 'ACTIVA';

COMMENT ON TABLE party_allocations IS
  'Qué movimiento del Mayor cancela qué factura, y por cuánto. Es una '
  'declaración de una persona: qué factura paga un cobro no se deduce. Lo que '
  'se deriva es el pendiente, el vencimiento y la antigüedad.';

CREATE TRIGGER party_allocations_no_delete
  BEFORE DELETE ON party_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 3 · Que la imputación sea posible
-- ---------------------------------------------------------------------------
-- Cuatro comprobaciones inmediatas. Ninguna es teórica: cada una corresponde a
-- una forma concreta de dejar la cuenta corriente diciendo algo falso.
--
-- Cada mensaje arranca con un código `E_`, como los candados de la 0005. No es
-- decoración: la aplicación tiene que poder distinguir cuál falló para contestar
-- lo que corresponde, y reconocerlos por su prosa es frágil — dos de estos
-- mensajes contienen «cancela» y uno «no la cancela», que no es lo mismo.
CREATE OR REPLACE FUNCTION assert_imputacion_valida() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tercero_factura uuid;
  tercero_linea uuid;
  estado_asiento text;
  origen_asiento uuid;
BEGIN
  SELECT t.party_id INTO tercero_factura
    FROM tax_transactions t
   WHERE t.id = NEW.tax_transaction_id AND t.company_id = NEW.company_id;

  -- 1 · La factura tiene que estar resuelta contra un tercero. Sin eso no se
  --     sabe de quién es la deuda que se está cancelando.
  IF tercero_factura IS NULL THEN
    RAISE EXCEPTION
      'E_ALLOC_SIN_TERCERO: el comprobante % no está vinculado a ningún tercero: resolvelo antes de imputarle un pago.',
      NEW.tax_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF tercero_factura <> NEW.party_id THEN
    RAISE EXCEPTION 'E_ALLOC_TERCERO_DISTINTO: el comprobante es de otro tercero'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT l.party_id, e.status, e.source_id
    INTO tercero_linea, estado_asiento, origen_asiento
    FROM journal_entry_lines l
    JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
   WHERE l.id = NEW.journal_entry_line_id AND l.company_id = NEW.company_id;

  -- 2 · El movimiento tiene que ser del mismo tercero.
  IF tercero_linea IS DISTINCT FROM NEW.party_id THEN
    RAISE EXCEPTION 'E_ALLOC_TERCERO_DISTINTO: el movimiento del Mayor no está imputado a este tercero'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3 · Un asiento en borrador no cancela nada. Todavía puede no existir.
  IF estado_asiento <> 'APROBADO' THEN
    RAISE EXCEPTION
      'E_ALLOC_SIN_APROBAR: el asiento está en %, y un movimiento sin aprobar no cancela una factura.',
      estado_asiento
      USING ERRCODE = 'check_violation';
  END IF;

  -- 4 · Una factura no se cancela con su propio asiento. Es el error que
  --     dejaría toda la cartera en cero sin que entrara un peso.
  IF origen_asiento = NEW.tax_transaction_id THEN
    RAISE EXCEPTION
      'E_ALLOC_ES_LA_FACTURA: ese movimiento es del asiento que registra la propia factura.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER party_allocations_valida
  BEFORE INSERT OR UPDATE ON party_allocations
  FOR EACH ROW EXECUTE FUNCTION assert_imputacion_valida();

-- ---------------------------------------------------------------------------
-- 4 · Que no se impute de más
-- ---------------------------------------------------------------------------
-- Diferido al COMMIT, como `je_entry_consistent`: una operación que anula una
-- imputación y crea otra pasa por un estado intermedio que no cierra, y
-- verificar en cada fila la rechazaría por un orden de escritura.
--
-- Dos topes, por motivos distintos:
--   · una factura no se cancela por más de lo que dice;
--   · un cobro no cancela más de lo que entró.
CREATE OR REPLACE FUNCTION assert_imputacion_no_excede() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total_factura numeric(18, 2);
  imputado numeric(18, 2);
  importe_linea numeric(18, 2);
  usado numeric(18, 2);
BEGIN
  SELECT t.total INTO total_factura
    FROM tax_transactions t WHERE t.id = NEW.tax_transaction_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(a.importe), 0) INTO imputado
    FROM party_allocations a
   WHERE a.tax_transaction_id = NEW.tax_transaction_id AND a.status = 'ACTIVA';

  IF imputado > total_factura THEN
    RAISE EXCEPTION
      'E_ALLOC_EXCEDE_COMPROBANTE: % imputado sobre un total de %.',
      imputado, total_factura
      USING ERRCODE = 'check_violation';
  END IF;

  -- El importe de una línea es su débito o su crédito: uno de los dos es cero
  -- por el CANDADO 2 de la 0005.
  SELECT l.debit + l.credit INTO importe_linea
    FROM journal_entry_lines l WHERE l.id = NEW.journal_entry_line_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(a.importe), 0) INTO usado
    FROM party_allocations a
   WHERE a.journal_entry_line_id = NEW.journal_entry_line_id AND a.status = 'ACTIVA';

  IF usado > importe_linea THEN
    RAISE EXCEPTION
      'E_ALLOC_EXCEDE_MOVIMIENTO: se imputó por % y su importe es %.', usado, importe_linea
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER party_allocations_no_excede
  AFTER INSERT OR UPDATE ON party_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_imputacion_no_excede();

-- ---------------------------------------------------------------------------
-- 5 · La composición del saldo, derivada
-- ---------------------------------------------------------------------------
CREATE VIEW invoice_settlement WITH (security_invoker = true) AS
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

       -- El vencimiento existe solo si alguien declaró la condición de pago.
       -- Sin eso no se deduce: sería afirmar un plazo que nadie acordó.
       p.dias_de_pago IS NOT NULL              AS vencimiento_declarado,
       CASE WHEN p.dias_de_pago IS NOT NULL
            THEN t.cbte_fecha + p.dias_de_pago
       END                                     AS vencimiento,

       -- Días de mora: solo cuando hay vencimiento declarado. Cuando no lo hay,
       -- `NULL` — que es distinto de cero y se lee distinto.
       CASE WHEN p.dias_de_pago IS NOT NULL
            THEN greatest(0, current_date - (t.cbte_fecha + p.dias_de_pago))
       END                                     AS dias_de_mora,

       -- La antigüedad desde el comprobante siempre se puede calcular, y no
       -- afirma nada sobre mora: es cuántos días hace que existe la factura.
       (current_date - t.cbte_fecha)           AS antiguedad_dias
  FROM tax_transactions t
  JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
  LEFT JOIN LATERAL (
        SELECT sum(x.importe) AS imputado
          FROM party_allocations x
         WHERE x.tax_transaction_id = t.id
           AND x.company_id = t.company_id
           AND x.status = 'ACTIVA'
       ) a ON true
 WHERE t.party_id IS NOT NULL;

COMMENT ON VIEW invoice_settlement IS
  'Composición del saldo: qué queda pendiente de cada comprobante. Todo '
  'derivado. dias_de_mora es NULL cuando el tercero no tiene condición de pago '
  'declarada: sin eso el sistema no afirma que nada esté vencido.';

-- ---------------------------------------------------------------------------
-- 6 · La antigüedad por tramos
-- ---------------------------------------------------------------------------
-- Los tramos se cuentan por antigüedad del comprobante, que es una cifra que
-- siempre se puede calcular. La mora —que exige vencimiento declarado— va en
-- su propia columna, aparte, para que nadie las confunda.
CREATE VIEW party_aging WITH (security_invoker = true) AS
SELECT s.company_id,
       s.party_id,
       s.razon_social,
       s.direction,
       sum(s.pendiente)                                                   AS pendiente,
       sum(s.pendiente) FILTER (WHERE s.antiguedad_dias <= 30)            AS hasta_30,
       sum(s.pendiente) FILTER (WHERE s.antiguedad_dias BETWEEN 31 AND 60) AS de_31_a_60,
       sum(s.pendiente) FILTER (WHERE s.antiguedad_dias BETWEEN 61 AND 90) AS de_61_a_90,
       sum(s.pendiente) FILTER (WHERE s.antiguedad_dias > 90)             AS mas_de_90,
       -- Solo lo que está vencido con fundamento: exige condición declarada.
       coalesce(sum(s.pendiente) FILTER (WHERE s.dias_de_mora > 0), 0)    AS vencido,
       count(*)::int                                                      AS comprobantes,
       max(s.antiguedad_dias)                                             AS mas_antiguo
  FROM invoice_settlement s
 WHERE s.pendiente > 0
 GROUP BY s.company_id, s.party_id, s.razon_social, s.direction;

COMMENT ON VIEW party_aging IS
  'Antigüedad de saldos por tercero. Los tramos son por antigüedad del '
  'comprobante; `vencido` es lo único que afirma mora, y solo cuenta lo que '
  'tiene condición de pago declarada.';

-- ---------------------------------------------------------------------------
-- 7 · Las ramas de cobranzas en la bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_cobranzas WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 26 · Factura de venta vencida y sin cobrar.
--      Solo cuando la condición de pago está declarada. Sin eso el sistema no
--      afirma mora, y una bandeja que la afirmara estaría inventando el plazo.
SELECT s.company_id,
       'FACTURA_VENCIDA'::text                      AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       'tax_transactions'::text                     AS entidad,
       s.tax_transaction_id                         AS entity_id,
       'PENDIENTE'::text                            AS estado,
       s.razon_social || ' debe ' || s.pendiente || ' del comprobante ' ||
         s.punto_venta || '-' || s.cbte_numero || ', vencido hace ' ||
         s.dias_de_mora || ' días'                  AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       s.cbte_fecha::timestamptz                    AS creado_en,
       s.cbte_fecha::timestamptz                    AS actualizado_en,
       s.vencimiento                                AS fecha_limite,
       '/parties/' || s.party_id                    AS traza_ref
  FROM invoice_settlement s
 WHERE s.direction = 'VENTAS'
   AND s.pendiente > 0
   AND s.dias_de_mora > 0

UNION ALL

-- 27 · Entró plata de un tercero y nadie dijo qué cancela.
--      El saldo neto ya está bien; lo que falta es saber qué factura quedó
--      saldada. Sin eso la antigüedad de saldos miente por omisión.
SELECT l.company_id,
       'COBRO_SIN_IMPUTAR'::text                    AS rama,
       'REQUIERE_DECLARACION'::text                 AS categoria,
       'journal_entries'::text                      AS entidad,
       l.entry_id                                   AS entity_id,
       e.status                                     AS estado,
       'Hay ' || (l.debit + l.credit - coalesce(im.usado, 0)) ||
         ' de ' || p.razon_social || ' sin imputar a ninguna factura' AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       e.created_at                                 AS creado_en,
       e.updated_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/journal-entries/' || l.entry_id            AS traza_ref
  FROM journal_entry_lines l
  JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
  JOIN parties p ON p.id = l.party_id AND p.company_id = l.company_id
  LEFT JOIN LATERAL (
        SELECT sum(a.importe) AS usado
          FROM party_allocations a
         WHERE a.journal_entry_line_id = l.id AND a.status = 'ACTIVA'
       ) im ON true
 WHERE l.party_id IS NOT NULL
   AND e.status = 'APROBADO'
   -- El asiento de la propia factura no es un cobro: se excluye por el hecho
   -- —tiene origen en una operación fiscal—, no por una lista de diarios.
   AND e.source_id IS NULL
   AND (l.debit + l.credit) > coalesce(im.usado, 0)

) q;

COMMENT ON VIEW work_queue_cobranzas IS
  'Ramas de cobranzas. FACTURA_VENCIDA solo aparece con condición de pago '
  'declarada: sin eso el sistema no afirma mora.';

DROP VIEW work_queue;
CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL
SELECT * FROM work_queue_comercial
UNION ALL
SELECT * FROM work_queue_compras
UNION ALL
SELECT * FROM work_queue_cobranzas;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

-- ---------------------------------------------------------------------------
-- 8 · Permisos
-- ---------------------------------------------------------------------------
-- Imputar un cobro decide qué factura queda saldada, y de ahí salen los
-- reclamos y la previsión de incobrables. Es un acto contable.
INSERT INTO permissions (code, description) VALUES
  ('allocation:read',  'Consultar la composición y la antigüedad de los saldos'),
  ('allocation:write', 'Imputar cobros y pagos a comprobantes');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'allocation:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
  AND p.code = 'allocation:write';

-- ---------------------------------------------------------------------------
-- 9 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE party_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON party_allocations
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON party_allocations TO aai_app;
GRANT SELECT ON invoice_settlement TO aai_app;
GRANT SELECT ON party_aging TO aai_app;
GRANT SELECT ON work_queue_cobranzas TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
