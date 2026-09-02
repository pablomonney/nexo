-- ============================================================================
-- 0085 — La solicitud de compra: pedir no es comprar
-- ============================================================================
--
-- Es el último módulo que `COBERTURA_ERP.md` tenía marcado LIBRE —construible,
-- sin depender de ninguna decisión ni de ninguna fuente externa—. Con esto la
-- cadena de compras queda entera:
--
--   solicitud → orden de compra → recepción → factura → orden de pago → pago
--
-- ## Por qué no es un `commercial_document` más
--
-- La tentación era agregar `kind = 'SOLICITUD'` a la tabla que ya tiene
-- presupuestos y pedidos, y no duplicar nada (§70). No entra: un
-- `commercial_document` exige tercero, y sus renglones exigen precio, neto e
-- IVA. **Una solicitud no tiene nada de eso.** «Necesito diez resmas» no dice a
-- quién comprarlas ni a cuánto: eso lo dice después el proveedor.
--
-- Meterla ahí obligaría a aflojar tres columnas NOT NULL de una tabla que hoy
-- sostiene presupuestos y pedidos reales, para que acepte documentos a los que
-- esas columnas no les corresponden. Se debilitaría lo que funciona para
-- alojar algo distinto. Son dos documentos distintos y son dos tablas.
--
-- ## Una solicitud no lleva precios, a propósito
--
-- Si el que pide escribe el precio, ese número va a viajar hasta la orden de
-- compra sin que nadie lo haya cotizado. Lo que la solicitud declara es **qué**
-- y **cuánto**; el precio aparece cuando hay proveedor.
--
-- ## La orden de compra se cita, no se genera
--
-- Aprobada la solicitud, alguien arma la orden de compra por el camino de
-- siempre —con su proveedor y sus precios— y la solicitud la **cita**. Generar
-- la orden desde acá exigiría inventar el proveedor y los importes, que es
-- justo lo que este módulo evita.
--
-- Es el mismo criterio de la orden de pago (0082) con el asiento: la base
-- verifica que el documento citado sea de compras y sea un pedido, así que
-- «convertida» no es una palabra suelta.
--
-- ## Qué NO decide esta migración
--
-- No inventa circuitos de autorización por monto —no hay ningún límite
-- declarado— ni exige que el que aprueba sea distinto del que pide: en una
-- empresa de dos personas eso trabaría el trabajo real. Quién puede aprobar es
-- un permiso, y el registro dice quién lo hizo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La solicitud
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_requests (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),

  numero            bigint NOT NULL DEFAULT 0,
  fecha             date NOT NULL,
  -- Para qué se pide. Una solicitud sin justificación es un pedido sin
  -- explicación, y quien la aprueba no tiene con qué decidir.
  justificacion     text NOT NULL CHECK (length(btrim(justificacion)) >= 5),
  -- Opcional: no toda empresa imputa sus compras a un centro de costo.
  cost_center_id    uuid,
  necesaria_para    date,

  status            text NOT NULL DEFAULT 'BORRADOR'
                    CHECK (status IN ('BORRADOR', 'ENVIADA', 'APROBADA',
                                      'RECHAZADA', 'CONVERTIDA', 'ANULADA')),

  -- La orden de compra que salió de esta solicitud, cuando existe.
  commercial_document_id uuid,

  enviada_at        timestamptz,
  resuelta_at       timestamptz,
  resuelta_por      text,
  motivo_rechazo    text,
  motivo_anulacion  text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,

  CONSTRAINT pr_centro_fk
    FOREIGN KEY (company_id, cost_center_id) REFERENCES cost_centers (company_id, id),
  CONSTRAINT pr_orden_fk
    FOREIGN KEY (company_id, commercial_document_id)
    REFERENCES commercial_documents (company_id, id),

  CONSTRAINT pr_numero_unico UNIQUE (company_id, numero),
  CONSTRAINT pr_id_empresa   UNIQUE (company_id, id),

  CONSTRAINT pr_rechazada_con_motivo
    CHECK (status <> 'RECHAZADA' OR motivo_rechazo IS NOT NULL),
  CONSTRAINT pr_anulada_con_motivo
    CHECK (status <> 'ANULADA' OR motivo_anulacion IS NOT NULL),
  CONSTRAINT pr_resuelta_firmada
    CHECK (status NOT IN ('APROBADA', 'RECHAZADA', 'CONVERTIDA')
           OR (resuelta_at IS NOT NULL AND resuelta_por IS NOT NULL)),
  CONSTRAINT pr_convertida_con_orden
    CHECK ((status = 'CONVERTIDA') = (commercial_document_id IS NOT NULL))
);

ALTER TABLE purchase_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY pr_por_empresa ON purchase_requests
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON purchase_requests TO aai_app;

CREATE INDEX pr_por_estado ON purchase_requests (company_id, status, fecha DESC);

COMMENT ON TABLE purchase_requests IS
  'Lo que alguien necesita comprar, antes de saber a quién ni a cuánto. No '
  'lleva precios a propósito: si el que pide escribe el precio, ese número '
  'viaja hasta la orden de compra sin que nadie lo haya cotizado.';

-- ---------------------------------------------------------------------------
-- 2 · Qué se pide
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_request_lines (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),
  purchase_request_id uuid NOT NULL,
  line_no             integer NOT NULL CHECK (line_no >= 1),

  -- Opcional: se puede pedir algo que todavía no está en el maestro. La
  -- descripción no, porque sin ella nadie sabe qué comprar.
  product_id          uuid,
  descripcion         text NOT NULL CHECK (length(btrim(descripcion)) >= 2),
  cantidad            numeric(18, 4) NOT NULL CHECK (cantidad > 0),
  unidad              text NOT NULL DEFAULT 'UNIDAD',
  observaciones       text,

  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL,

  CONSTRAINT prl_solicitud_fk
    FOREIGN KEY (company_id, purchase_request_id)
    REFERENCES purchase_requests (company_id, id) ON DELETE CASCADE,
  CONSTRAINT prl_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),

  CONSTRAINT prl_orden_unico UNIQUE (company_id, purchase_request_id, line_no)
);

ALTER TABLE purchase_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_request_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY prl_por_empresa ON purchase_request_lines
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_request_lines TO aai_app;

CREATE INDEX prl_por_solicitud ON purchase_request_lines (company_id, purchase_request_id);

COMMENT ON TABLE purchase_request_lines IS
  'Qué y cuánto se pide. Sin precio: eso lo dice el proveedor. El producto del '
  'maestro es opcional —se puede pedir algo que todavía no existe ahí— y la '
  'descripción no lo es.';

-- ---------------------------------------------------------------------------
-- 3 · El número, uno por empresa
-- ---------------------------------------------------------------------------
CREATE FUNCTION asignar_numero_de_solicitud() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.numero IS NOT NULL AND NEW.numero > 0 THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('purchase_requests:' || NEW.company_id::text));

  SELECT coalesce(max(r.numero), 0) + 1 INTO NEW.numero
    FROM purchase_requests r
   WHERE r.company_id = NEW.company_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pr_numero
  BEFORE INSERT ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION asignar_numero_de_solicitud();

-- ---------------------------------------------------------------------------
-- 4 · Los renglones se tocan mientras es borrador
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_renglon_de_solicitud() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fila    record;
  estado  text;
BEGIN
  fila := coalesce(NEW, OLD);

  SELECT r.status INTO estado
    FROM purchase_requests r
   WHERE r.id = fila.purchase_request_id AND r.company_id = fila.company_id;

  IF estado IS NULL THEN
    RAISE EXCEPTION 'E_SOL_SIN_SOLICITUD: el renglón no pertenece a ninguna solicitud de esta empresa';
  END IF;

  IF estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'E_SOL_NO_EDITABLE: la solicitud está % y sus renglones ya no se modifican',
      estado;
  END IF;

  RETURN fila;
END;
$$;

CREATE TRIGGER prl_reglas
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_request_lines
  FOR EACH ROW EXECUTE FUNCTION assert_renglon_de_solicitud();

-- ---------------------------------------------------------------------------
-- 5 · La máquina de estados
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_transicion_de_solicitud() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  renglones integer;
  orden     record;
BEGIN
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'BORRADOR'
       AND (NEW.justificacion <> OLD.justificacion OR NEW.fecha <> OLD.fecha) THEN
      RAISE EXCEPTION 'E_SOL_NO_EDITABLE: la solicitud está % y su encabezado ya no se modifica',
        OLD.status;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('CONVERTIDA', 'RECHAZADA', 'ANULADA') THEN
    RAISE EXCEPTION 'E_SOL_TRANSICION: la solicitud está % y ese estado es final', OLD.status;
  END IF;

  IF NOT (
       (OLD.status = 'BORRADOR' AND NEW.status IN ('ENVIADA', 'ANULADA'))
    OR (OLD.status = 'ENVIADA'  AND NEW.status IN ('APROBADA', 'RECHAZADA', 'ANULADA'))
    OR (OLD.status = 'APROBADA' AND NEW.status IN ('CONVERTIDA', 'ANULADA'))
  ) THEN
    RAISE EXCEPTION 'E_SOL_TRANSICION: no se puede pasar de % a %', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'ENVIADA' THEN
    SELECT count(*) INTO renglones
      FROM purchase_request_lines l
     WHERE l.purchase_request_id = NEW.id AND l.company_id = NEW.company_id;

    IF renglones = 0 THEN
      RAISE EXCEPTION 'E_SOL_SIN_RENGLONES: no se manda a aprobar una solicitud que no pide nada';
    END IF;
  END IF;

  IF NEW.status = 'CONVERTIDA' THEN
    SELECT d.direction, d.kind, d.status INTO orden
      FROM commercial_documents d
     WHERE d.id = NEW.commercial_document_id AND d.company_id = NEW.company_id;

    IF orden IS NULL THEN
      RAISE EXCEPTION 'E_SOL_SIN_ORDEN: convertir una solicitud es citar la orden de compra que salió de ella';
    END IF;

    -- Que el documento citado sea de compras y sea un pedido. Sin esto,
    -- «convertida» sería una palabra al lado de un presupuesto de ventas.
    IF orden.direction <> 'COMPRAS' OR orden.kind <> 'PEDIDO' THEN
      RAISE EXCEPTION 'E_SOL_ORDEN_INVALIDA: el documento citado no es una orden de compra';
    END IF;

    IF orden.status = 'ANULADO' THEN
      RAISE EXCEPTION 'E_SOL_ORDEN_ANULADA: la orden de compra citada está anulada';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER pr_transicion
  BEFORE UPDATE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_de_solicitud();

CREATE FUNCTION assert_baja_de_solicitud() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'BORRADOR' THEN
    RAISE EXCEPTION 'E_SOL_NO_SE_BORRA: la solicitud está % y se anula con motivo, no se borra',
      OLD.status;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER pr_baja
  BEFORE DELETE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION assert_baja_de_solicitud();

-- ---------------------------------------------------------------------------
-- 6 · Qué muestra la solicitud
-- ---------------------------------------------------------------------------
CREATE VIEW purchase_request_status WITH (security_invoker = true) AS
SELECT r.company_id,
       r.id                                          AS purchase_request_id,
       r.numero,
       r.fecha,
       r.status,
       r.justificacion,
       r.necesaria_para,
       r.cost_center_id,
       cc.name                                       AS centro_de_costo,
       r.commercial_document_id,
       d.number                                      AS orden_numero,
       p.razon_social                                AS proveedor,
       r.enviada_at,
       r.resuelta_at,
       r.resuelta_por,
       r.motivo_rechazo,
       r.motivo_anulacion,
       r.created_by,
       coalesce(l.renglones, 0)                      AS renglones,
       l.unidades,
       -- Cuántos días lleva esperando una respuesta. Es un hecho contado, no
       -- un juicio: no hay plazo declarado para aprobar una solicitud, así que
       -- el sistema no dice «atrasada».
       CASE WHEN r.status = 'ENVIADA'
            THEN (current_date - r.enviada_at::date)
       END                                           AS dias_esperando,
       CASE
         WHEN r.status = 'BORRADOR' AND coalesce(l.renglones, 0) = 0
           THEN 'Borrador sin renglones: todavía no dice qué se necesita.'
         WHEN r.status = 'BORRADOR'
           THEN 'Borrador con ' || l.renglones || ' renglón(es). No la ve quien aprueba ' ||
                'hasta que se envíe.'
         WHEN r.status = 'ENVIADA'
           THEN 'Esperando respuesta desde hace ' || (current_date - r.enviada_at::date) ||
                ' día(s).'
         WHEN r.status = 'APROBADA'
           THEN 'Aprobada. Falta armar la orden de compra: el proveedor y los precios no ' ||
                'salen de acá.'
         WHEN r.status = 'RECHAZADA' THEN 'Rechazada: ' || r.motivo_rechazo
         WHEN r.status = 'ANULADA'   THEN 'Anulada: ' || r.motivo_anulacion
         WHEN r.status = 'CONVERTIDA'
           THEN 'Convertida en la orden de compra N° ' || d.number ||
                coalesce(' a ' || p.razon_social, '') || '.'
       END::text                                     AS situacion
  FROM purchase_requests r
  LEFT JOIN cost_centers cc
    ON cc.id = r.cost_center_id AND cc.company_id = r.company_id
  LEFT JOIN commercial_documents d
    ON d.id = r.commercial_document_id AND d.company_id = r.company_id
  LEFT JOIN parties p ON p.id = d.party_id AND p.company_id = d.company_id
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS renglones, sum(x.cantidad) AS unidades
          FROM purchase_request_lines x
         WHERE x.purchase_request_id = r.id AND x.company_id = r.company_id
       ) l ON true;

COMMENT ON VIEW purchase_request_status IS
  'La solicitud con lo que pide y en qué anda. Los días de espera se cuentan; '
  'no se llaman atraso, porque no hay plazo declarado para responder.';

-- ---------------------------------------------------------------------------
-- 7 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_solicitudes WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Enviada y sin responder. Alguien está esperando.
SELECT r.company_id,
       'SOLICITUD_SIN_RESPONDER'::text               AS rama,
       'REQUIERE_APROBACION'::text                   AS categoria,
       'purchase_requests'::text                     AS entidad,
       r.purchase_request_id                         AS entity_id,
       r.status                                      AS estado,
       'La solicitud de compra N° ' || r.numero || ' espera respuesta desde hace ' ||
         r.dias_esperando || ' día(s): ' || r.justificacion
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY[]::text[]                               AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       r.enviada_at                                  AS creado_en,
       r.enviada_at                                  AS actualizado_en,
       r.necesaria_para                              AS fecha_limite,
       '/purchase-requests'::text                    AS traza_ref
  FROM purchase_request_status r
 WHERE r.status = 'ENVIADA'

UNION ALL

-- 2 · Aprobada y sin orden de compra. Se dijo que sí y no se compró.
SELECT r.company_id,
       'SOLICITUD_SIN_ORDEN'::text                   AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'purchase_requests'::text                     AS entidad,
       r.purchase_request_id                         AS entity_id,
       r.status                                      AS estado,
       'La solicitud N° ' || r.numero || ' está aprobada y todavía no hay orden de ' ||
         'compra que la cite'                        AS motivo,
       false                                         AS bloquea,
       ARRAY['ORDEN_DE_COMPRA']::text[]              AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       r.resuelta_at                                 AS creado_en,
       r.resuelta_at                                 AS actualizado_en,
       r.necesaria_para                              AS fecha_limite,
       '/purchase-requests'::text                    AS traza_ref
  FROM purchase_request_status r
 WHERE r.status = 'APROBADA'

) q;

COMMENT ON VIEW work_queue_solicitudes IS
  'Solicitudes de compra sin resolver. Ninguna bloquea: se puede comprar sin '
  'solicitud, y una solicitud sin responder no impide ningún hecho contable.';

-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions.
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
UNION ALL SELECT * FROM work_queue_correcciones
UNION ALL SELECT * FROM work_queue_solicitudes;

-- ---------------------------------------------------------------------------
-- 8 · Permisos
-- ---------------------------------------------------------------------------
-- Pedir y autorizar son dos actos distintos, y por eso son dos permisos. No hay
-- umbrales por monto —una solicitud no tiene importes— ni se exige que el que
-- aprueba sea otro: en una empresa de dos personas eso trabaría el trabajo
-- real. Quién aprobó queda registrado.
INSERT INTO permissions (code, description) VALUES
  ('purchase_request:read',    'Consultar solicitudes de compra'),
  ('purchase_request:write',   'Armar solicitudes de compra y enviarlas a aprobar'),
  ('purchase_request:approve', 'Aprobar o rechazar una solicitud de compra');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'purchase_request:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code = 'purchase_request:write';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
  AND p.code = 'purchase_request:approve';

GRANT SELECT ON purchase_request_status TO aai_app;
GRANT SELECT ON work_queue_solicitudes TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
