-- ============================================================================
-- 0082 — La orden de pago: el documento que faltaba entre la factura y el pago
-- ============================================================================
--
-- `COBERTURA_ERP.md` lo tenía anotado como PARCIAL: *«el pago es un asiento
-- imputado; no hay orden de pago como documento»*. La consecuencia práctica es
-- que el circuito de compras terminaba en el aire: la factura del proveedor
-- quedaba pendiente y lo siguiente que existía en el sistema era el asiento ya
-- hecho. Entre las dos cosas —decidir qué se paga y pagarlo— no había nada que
-- alguien pudiera revisar, aprobar o mostrar.
--
-- Esta migración crea ese documento, y no crea ningún hecho contable nuevo. La
-- plata se sigue moviendo con un asiento imputado, exactamente como antes.
--
-- ## Una orden aprobada no es plata que salió
--
-- La tentación era sumar las órdenes aprobadas a la proyección de fondos, como
-- salida comprometida. Sería contar dos veces: los comprobantes que la orden
-- nombra **ya están** en la proyección por su pendiente. Una orden de pago no
-- agrega una obligación; elige cuáles de las que ya existen se van a cancelar
-- y cuándo. Por eso no entra en `analytics_flujo_de_fondos`, y sí en la
-- bandeja, que es donde vive el trabajo sin terminar.
--
-- ## «PAGADA» tiene que poder demostrarse
--
-- El error que este repositorio ya cometió cuatro veces —estructura correcta,
-- regla escrita, nadie recorriendo el camino entre las dos— acá tendría una
-- forma muy concreta: una orden marcada PAGADA porque alguien apretó el botón,
-- sin que exista el pago. Entonces el estado PAGADA exige el asiento **y** que
-- ese asiento tenga imputación activa sobre cada uno de los comprobantes de la
-- orden. Si el pago no tocó una de las facturas que la orden dice pagar, la
-- base lo rechaza: `E_OP_PAGO_NO_IMPUTADO`.
--
-- Cuánto imputó no se exige: un pago parcial es legítimo y la vista lo muestra
-- comparando el total de la orden contra lo efectivamente imputado. Lo que no
-- se admite es la palabra sin el hecho.
--
-- ## Qué NO decide esta migración
--
-- No arma el asiento del pago —de qué cuenta sale la plata es una decisión de
-- la empresa, no del esquema—, no propone qué facturas pagar primero, no
-- inventa un circuito de autorización por montos (no hay límites declarados) y
-- no bloquea la carga de un comprobante ni un pago hecho por fuera de una
-- orden. La orden es un documento de trabajo: quien pague sin ella sigue
-- pudiendo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La orden
-- ---------------------------------------------------------------------------
CREATE TABLE payment_orders (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),
  party_id          uuid NOT NULL,

  -- Lo completa un trigger; el default provisorio existe para que el INSERT
  -- pueda no traer la columna.
  numero            bigint NOT NULL DEFAULT 0,
  fecha             date NOT NULL,
  status            text NOT NULL DEFAULT 'BORRADOR'
                    CHECK (status IN ('BORRADOR', 'APROBADA', 'PAGADA', 'ANULADA')),

  -- El asiento del pago. NULL mientras la plata no salió.
  entry_id          uuid,

  aprobada_at       timestamptz,
  aprobada_por      text,
  pagada_at         timestamptz,
  motivo_anulacion  text,
  observaciones     text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,

  -- La empresa viaja dentro de cada clave foránea: el RLS no protege la
  -- verificación de una FK.
  CONSTRAINT po_proveedor_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT po_asiento_fk
    FOREIGN KEY (company_id, entry_id) REFERENCES journal_entries (company_id, id),

  CONSTRAINT po_numero_unico UNIQUE (company_id, numero),
  CONSTRAINT po_id_empresa   UNIQUE (company_id, id),

  -- Una anulación sin motivo es una anulación sin explicación.
  CONSTRAINT po_anulada_con_motivo
    CHECK (status <> 'ANULADA' OR motivo_anulacion IS NOT NULL),
  CONSTRAINT po_aprobada_con_firma
    CHECK (status IN ('BORRADOR', 'ANULADA')
           OR (aprobada_at IS NOT NULL AND aprobada_por IS NOT NULL)),
  CONSTRAINT po_pagada_con_asiento
    CHECK (status <> 'PAGADA' OR (entry_id IS NOT NULL AND pagada_at IS NOT NULL))
);

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY po_por_empresa ON payment_orders
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_orders TO aai_app;

CREATE INDEX po_por_proveedor ON payment_orders (company_id, party_id, fecha DESC);
CREATE INDEX po_por_estado    ON payment_orders (company_id, status, fecha DESC);

COMMENT ON TABLE payment_orders IS
  'La decisión de pagar, antes del pago. No es un hecho contable: la plata se '
  'sigue moviendo con un asiento imputado. Sirve para revisar y aprobar qué se '
  'va a pagar, y para que después se pueda demostrar que se pagó.';

COMMENT ON COLUMN payment_orders.entry_id IS
  'El asiento del pago. Para pasar a PAGADA no alcanza con que exista: tiene '
  'que tener imputación activa sobre cada comprobante de la orden.';

-- ---------------------------------------------------------------------------
-- 2 · Los renglones: qué comprobantes se pagan
-- ---------------------------------------------------------------------------
CREATE TABLE payment_order_lines (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  payment_order_id   uuid NOT NULL,
  tax_transaction_id uuid NOT NULL,

  importe            numeric(18, 2) NOT NULL CHECK (importe > 0),

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,

  CONSTRAINT pol_orden_fk
    FOREIGN KEY (company_id, payment_order_id)
    REFERENCES payment_orders (company_id, id) ON DELETE CASCADE,
  CONSTRAINT pol_comprobante_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id),

  -- Un comprobante entra una sola vez en la misma orden: dos renglones sobre
  -- la misma factura son un error de carga, no un pago en dos partes.
  CONSTRAINT pol_comprobante_unico
    UNIQUE (company_id, payment_order_id, tax_transaction_id)
);

ALTER TABLE payment_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY pol_por_empresa ON payment_order_lines
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_order_lines TO aai_app;

CREATE INDEX pol_por_orden       ON payment_order_lines (company_id, payment_order_id);
CREATE INDEX pol_por_comprobante ON payment_order_lines (company_id, tax_transaction_id);

COMMENT ON TABLE payment_order_lines IS
  'Qué comprobantes cancela la orden y por cuánto. El importe no puede superar '
  'el pendiente del comprobante: ordenar pagar más de lo que se debe es un '
  'error, no una decisión.';

-- ---------------------------------------------------------------------------
-- 3 · El número, uno por empresa
-- ---------------------------------------------------------------------------
-- Una orden sin número no es un documento que alguien pueda citar por
-- teléfono. Se asigna acá y no con una secuencia global porque la numeración
-- es por empresa. El `pg_advisory_xact_lock` serializa dos altas simultáneas
-- de la misma empresa; sin él, ambas leerían el mismo máximo y una moriría
-- contra `po_numero_unico` —que igual queda como última línea de defensa—.
CREATE FUNCTION asignar_numero_de_orden() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.numero IS NOT NULL AND NEW.numero > 0 THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('payment_orders:' || NEW.company_id::text));

  SELECT coalesce(max(o.numero), 0) + 1 INTO NEW.numero
    FROM payment_orders o
   WHERE o.company_id = NEW.company_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER po_numero
  BEFORE INSERT ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION asignar_numero_de_orden();

-- ---------------------------------------------------------------------------
-- 4 · Los renglones solo se tocan en borrador, y solo del mismo proveedor
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_renglon_de_orden() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fila        record;
  estado      text;
  proveedor   uuid;
  cbte        record;
  disponible  numeric(18, 2);
BEGIN
  fila := coalesce(NEW, OLD);

  SELECT o.status, o.party_id INTO estado, proveedor
    FROM payment_orders o
   WHERE o.id = fila.payment_order_id AND o.company_id = fila.company_id;

  IF estado IS NULL THEN
    RAISE EXCEPTION 'E_OP_SIN_ORDEN: el renglón no pertenece a ninguna orden de esta empresa';
  END IF;

  IF estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'E_OP_NO_EDITABLE: la orden está % y sus renglones ya no se modifican', estado;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT t.direction, t.party_id, t.cbte_tipo, t.punto_venta, t.cbte_numero
    INTO cbte
    FROM tax_transactions t
   WHERE t.id = NEW.tax_transaction_id AND t.company_id = NEW.company_id;

  IF cbte.direction <> 'COMPRAS' THEN
    RAISE EXCEPTION 'E_OP_COMPROBANTE_DE_VENTAS: una orden de pago cancela comprobantes de compras';
  END IF;

  IF cbte.party_id IS DISTINCT FROM proveedor THEN
    RAISE EXCEPTION 'E_OP_COMPROBANTE_AJENO: el comprobante no es del proveedor de la orden';
  END IF;

  -- Lo que queda por pagar sale de `invoice_settlement`, que es la única
  -- verdad sobre el pendiente de un comprobante. Se compara contra el
  -- pendiente contable —no contra lo comprometido en otras órdenes—: una orden
  -- en borrador todavía no compromete nada, y avisar del solapamiento es
  -- trabajo de la vista, no de un bloqueo.
  SELECT s.pendiente INTO disponible
    FROM invoice_settlement s
   WHERE s.tax_transaction_id = NEW.tax_transaction_id
     AND s.company_id = NEW.company_id;

  IF disponible IS NULL THEN
    RAISE EXCEPTION 'E_OP_COMPROBANTE_SIN_TERCERO: el comprobante no tiene proveedor imputable';
  END IF;

  IF NEW.importe > disponible THEN
    RAISE EXCEPTION 'E_OP_EXCEDE_PENDIENTE: el comprobante % %-% debe % y la orden ordena pagar %',
      cbte.cbte_tipo, cbte.punto_venta, cbte.cbte_numero, disponible, NEW.importe;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pol_reglas
  BEFORE INSERT OR UPDATE OR DELETE ON payment_order_lines
  FOR EACH ROW EXECUTE FUNCTION assert_renglon_de_orden();

-- ---------------------------------------------------------------------------
-- 5 · La máquina de estados, y la prueba del pago
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_transicion_de_orden() RETURNS trigger
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

CREATE TRIGGER po_transicion
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_de_orden();

-- Una orden aprobada no se borra: se anula, con motivo. Borrarla dejaría un
-- número sin explicación en la numeración.
CREATE FUNCTION assert_baja_de_orden() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'BORRADOR' THEN
    RAISE EXCEPTION 'E_OP_NO_SE_BORRA: la orden está % y se anula con motivo, no se borra',
      OLD.status;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER po_baja
  BEFORE DELETE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION assert_baja_de_orden();

-- ---------------------------------------------------------------------------
-- 6 · Qué muestra la orden
-- ---------------------------------------------------------------------------
-- El total no se guarda: se deriva de los renglones. Guardarlo sería una
-- segunda verdad sobre la misma suma, y la primera vez que difieran alguien
-- tendría que decidir cuál gana.
CREATE VIEW payment_order_lines_status WITH (security_invoker = true) AS
SELECT l.company_id,
       l.payment_order_id,
       l.id                                          AS line_id,
       l.tax_transaction_id,
       l.importe,
       s.cbte_tipo,
       s.punto_venta,
       s.cbte_numero,
       s.cbte_fecha,
       s.total                                       AS total_comprobante,
       s.pendiente,
       s.vencimiento_declarado,
       s.vencimiento,
       s.dias_de_mora,
       -- Cuánto de este comprobante está comprometido en **otras** órdenes
       -- vivas. No bloquea nada: dos borradores sobre la misma factura son un
       -- descuido frecuente y el sistema lo muestra en vez de impedirlo.
       coalesce(otras.comprometido, 0)               AS comprometido_en_otras,
       l.importe + coalesce(otras.comprometido, 0) > s.pendiente
                                                     AS sobrecompromiso
  FROM payment_order_lines l
  JOIN invoice_settlement s
    ON s.tax_transaction_id = l.tax_transaction_id AND s.company_id = l.company_id
  LEFT JOIN LATERAL (
        SELECT sum(o2.importe) AS comprometido
          FROM payment_order_lines o2
          JOIN payment_orders po2
            ON po2.id = o2.payment_order_id AND po2.company_id = o2.company_id
         WHERE o2.company_id = l.company_id
           AND o2.tax_transaction_id = l.tax_transaction_id
           AND o2.payment_order_id <> l.payment_order_id
           AND po2.status IN ('BORRADOR', 'APROBADA')
       ) otras ON true;

COMMENT ON VIEW payment_order_lines_status IS
  'Cada renglón de una orden contra el pendiente real del comprobante, y contra '
  'lo que otras órdenes vivas ya comprometieron sobre la misma factura.';

CREATE VIEW payment_order_status WITH (security_invoker = true) AS
SELECT o.company_id,
       o.id                                          AS payment_order_id,
       o.numero,
       o.fecha,
       o.status,
       o.party_id,
       p.razon_social                                AS proveedor,
       o.entry_id,
       o.aprobada_at,
       o.aprobada_por,
       o.pagada_at,
       o.motivo_anulacion,
       o.observaciones,
       coalesce(r.renglones, 0)                      AS renglones,
       coalesce(r.total, 0)                          AS total,
       coalesce(r.con_sobrecompromiso, 0)            AS renglones_con_sobrecompromiso,
       -- Cuánto imputó efectivamente el asiento del pago sobre los
       -- comprobantes de esta orden. NULL mientras no hay asiento: cero diría
       -- «no imputó nada», que es otra cosa.
       imp.imputado                                  AS imputado_por_el_asiento,
       CASE
         WHEN o.status = 'ANULADA' THEN 'Anulada: ' || o.motivo_anulacion
         WHEN o.status = 'BORRADOR' AND coalesce(r.renglones, 0) = 0
           THEN 'Borrador sin renglones: todavía no dice qué paga.'
         WHEN o.status = 'BORRADOR'
           THEN 'Borrador con ' || r.renglones || ' comprobante(s) por ' || r.total ||
                '. No compromete nada hasta que se apruebe.'
         WHEN o.status = 'APROBADA'
           THEN 'Aprobada y esperando el pago. La plata no salió: no hay asiento.'
         WHEN o.status = 'PAGADA' AND imp.imputado < r.total
           THEN 'Pagada parcialmente: el asiento imputó ' || imp.imputado || ' de ' ||
                r.total || '. El resto sigue pendiente en la cuenta del proveedor.'
         WHEN o.status = 'PAGADA'
           THEN 'Pagada: el asiento imputó ' || imp.imputado || ' sobre los comprobantes ' ||
                'de la orden.'
       END::text                                     AS situacion
  FROM payment_orders o
  JOIN parties p ON p.id = o.party_id AND p.company_id = o.company_id
  LEFT JOIN LATERAL (
        SELECT count(*)::int                                         AS renglones,
               sum(x.importe)                                        AS total,
               count(*) FILTER (WHERE x.sobrecompromiso)::int        AS con_sobrecompromiso
          FROM payment_order_lines_status x
         WHERE x.payment_order_id = o.id AND x.company_id = o.company_id
       ) r ON true
  LEFT JOIN LATERAL (
        SELECT sum(a.importe) AS imputado
          FROM party_allocations a
          JOIN journal_entry_lines jl
            ON jl.id = a.journal_entry_line_id AND jl.company_id = a.company_id
         WHERE a.company_id = o.company_id
           AND a.status = 'ACTIVA'
           AND jl.entry_id = o.entry_id
           AND a.tax_transaction_id IN (
                 SELECT l.tax_transaction_id
                   FROM payment_order_lines l
                  WHERE l.payment_order_id = o.id AND l.company_id = o.company_id
               )
       ) imp ON o.entry_id IS NOT NULL;

COMMENT ON VIEW payment_order_status IS
  'La orden de pago con su total derivado de los renglones y, cuando hay pago, '
  'lo que ese asiento imputó realmente. Un pago parcial se ve como tal en vez '
  'de darse por completo.';

-- ---------------------------------------------------------------------------
-- 7 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_pagos WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Aprobada y sin pagar. Es un hecho, no un juicio: no hay plazo declarado
--     para pagar una orden, así que no se dice «atrasada».
SELECT o.company_id,
       'ORDEN_DE_PAGO_SIN_PAGAR'::text               AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'payment_orders'::text                        AS entidad,
       o.payment_order_id                            AS entity_id,
       o.status                                      AS estado,
       'La orden de pago N° ' || o.numero || ' a ' || o.proveedor ||
         ' está aprobada por ' || o.total || ' y todavía no tiene el asiento del pago'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['ASIENTO_DEL_PAGO']::text[]             AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       o.aprobada_at                                 AS creado_en,
       o.aprobada_at                                 AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/payment-orders'::text                       AS traza_ref
  FROM payment_order_status o
 WHERE o.status = 'APROBADA'

UNION ALL

-- 2 · Dos órdenes vivas sobre la misma factura. Puede ser correcto —un pago en
--     dos partes cargado en dos órdenes— y puede ser un duplicado. El sistema
--     no elige: avisa.
SELECT o.company_id,
       'ORDEN_DE_PAGO_SOLAPADA'::text                AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'payment_orders'::text                        AS entidad,
       o.payment_order_id                            AS entity_id,
       o.status                                      AS estado,
       'La orden N° ' || o.numero || ' tiene ' || o.renglones_con_sobrecompromiso ||
         ' comprobante(s) que, sumando lo que ya comprometieron otras órdenes ' ||
         'vivas, superan lo que se debe'             AS motivo,
       false                                         AS bloquea,
       ARRAY[]::text[]                               AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       o.fecha::timestamptz                          AS creado_en,
       o.fecha::timestamptz                          AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/payment-orders'::text                       AS traza_ref
  FROM payment_order_status o
 WHERE o.status IN ('BORRADOR', 'APROBADA')
   AND o.renglones_con_sobrecompromiso > 0

) q;

COMMENT ON VIEW work_queue_pagos IS
  'Órdenes de pago sin terminar. Ninguna bloquea: se puede pagar sin orden, y '
  'una orden solapada puede ser correcta.';

-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la bandeja de una empresa aparecería en la de otra.
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
UNION ALL SELECT * FROM work_queue_pagos;

-- ---------------------------------------------------------------------------
-- 8 · Permisos
-- ---------------------------------------------------------------------------
-- Armar una orden y aprobarla son dos actos distintos, y por eso son dos
-- permisos: quien prepara el pago no es necesariamente quien lo autoriza. No
-- hay umbrales por monto —no hay ningún límite declarado que los sostenga—,
-- solo la separación entre preparar y firmar.
INSERT INTO permissions (code, description) VALUES
  ('payment_order:read',    'Consultar órdenes de pago'),
  ('payment_order:write',   'Armar y modificar órdenes de pago en borrador'),
  ('payment_order:approve', 'Aprobar una orden de pago, anularla y registrar su pago');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'payment_order:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code = 'payment_order:write';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
  AND p.code = 'payment_order:approve';

GRANT SELECT ON payment_order_lines_status TO aai_app;
GRANT SELECT ON payment_order_status TO aai_app;
GRANT SELECT ON work_queue_pagos TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
