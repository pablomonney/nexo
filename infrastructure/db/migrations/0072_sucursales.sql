-- ============================================================================
-- 0072 — Sucursales: el punto de venta las ata, y la atribución se deriva
-- ============================================================================
--
-- Hasta acá una sucursal se aproximaba con un centro de costo, y no es lo
-- mismo: un centro de costo agrupa gastos, una sucursal **factura**, tiene
-- depósito y tiene gente. Lo que faltaba no era una tabla más: era la pieza que
-- une esas tres cosas con lo que ya existe.
--
-- ## Esa pieza es el punto de venta
--
-- En Argentina cada boca de facturación tiene su punto de venta habilitado ante
-- ARCA, y el número ya viaja en cada comprobante desde la 0016. Así que la
-- sucursal **no se guarda en la factura**: se declara qué puntos de venta son
-- suyos, y la atribución se deriva de un dato que ya estaba.
--
-- Agregarle un `branch_id` al comprobante habría creado una segunda verdad —el
-- punto de venta diciendo una cosa y la columna otra— y la que gana en ese
-- empate es siempre la que alguien tipeó.
--
-- ## Con vigencia, porque los puntos de venta se mudan
--
-- Una boca cierra y su punto de venta se reasigna. Si la relación fuera un
-- hecho sin fecha, reasignarlo **reescribiría las ventas del año pasado**: el
-- comprobante de marzo pasaría a ser de otra sucursal sin que nadie lo tocara.
-- Con vigencia, cada comprobante se atribuye por el mapa que regía **el día en
-- que se emitió**. Es el mismo candado de las listas de precios (0061), las
-- tarifas (0070) y los esquemas de comisión (0071).
--
-- ## Dos atribuciones que pueden no coincidir, y se muestran las dos
--
-- Las ventas se atribuyen por punto de venta; los gastos, por el centro de
-- costo que la sucursal cita. Son dos caminos distintos y **pueden dar cifras
-- que no cierran entre sí** —una venta facturada desde otra boca, un gasto sin
-- imputar—. No se promedian ni se elige una: se informan las dos, con el método
-- de cada una al lado, porque la diferencia entre ambas es justamente el dato
-- que le sirve a quien tiene que revisar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La sucursal
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),

  code           text NOT NULL CHECK (length(btrim(code)) > 0),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  direccion      text,
  localidad      text,
  provincia      text,

  -- Su depósito y su centro de costo. Los dos opcionales y por buenas razones
  -- distintas: una oficina comercial puede no tener depósito, y una sucursal
  -- recién abierta puede todavía no tener centro de costo — pero sin él sus
  -- gastos no se pueden atribuir, y la bandeja lo dice.
  warehouse_id   uuid,
  cost_center_id uuid,

  status         text NOT NULL DEFAULT 'ACTIVA' CHECK (status IN ('ACTIVA', 'CERRADA')),
  cerrada_el     date,
  motivo_cierre  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT br_cierre_completo
    CHECK (status = 'ACTIVA'
           OR (cerrada_el IS NOT NULL
               AND motivo_cierre IS NOT NULL AND length(btrim(motivo_cierre)) > 2)),
  CONSTRAINT br_code_unico UNIQUE (company_id, code),
  CONSTRAINT br_deposito_fk
    FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id),
  CONSTRAINT br_centro_fk
    FOREIGN KEY (company_id, cost_center_id) REFERENCES cost_centers (company_id, id),
  CONSTRAINT br_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
CREATE POLICY br_por_empresa ON branches
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON branches TO aai_app;

-- Una sucursal se cierra con motivo y con fecha; no se borra. Borrarla dejaría
-- las ventas del año pasado sin lugar de origen.
CREATE FUNCTION branches_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'E_SUC_NO_BORRA: una sucursal se cierra con motivo; borrarla deja sus ventas sin origen.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER branches_no_delete BEFORE DELETE ON branches
  FOR EACH ROW EXECUTE FUNCTION branches_no_delete();

-- Un depósito es de una sola sucursal: con dos, la existencia de una boca sería
-- también la de la otra y el recuento (0067) dejaría de significar algo.
CREATE UNIQUE INDEX br_un_deposito_por_sucursal
  ON branches (company_id, warehouse_id)
  WHERE warehouse_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2 · Los puntos de venta, con vigencia
-- ---------------------------------------------------------------------------
CREATE TABLE branch_points_of_sale (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  branch_id      uuid NOT NULL,

  punto_venta    int NOT NULL CHECK (punto_venta > 0 AND punto_venta <= 99999),
  vigencia_desde date NOT NULL,
  vigencia_hasta date,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT bpv_vigencia_coherente
    CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT bpv_sucursal_fk
    FOREIGN KEY (company_id, branch_id) REFERENCES branches (company_id, id)
);

ALTER TABLE branch_points_of_sale ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_points_of_sale FORCE ROW LEVEL SECURITY;
CREATE POLICY bpv_por_empresa ON branch_points_of_sale
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON branch_points_of_sale TO aai_app;

CREATE INDEX bpv_por_punto ON branch_points_of_sale (company_id, punto_venta, vigencia_desde);

COMMENT ON TABLE branch_points_of_sale IS
  'Qué puntos de venta son de cada sucursal, y desde cuándo. Con vigencia '
  'porque las bocas se mudan: sin fecha, reasignar un punto de venta '
  'reescribiría a qué sucursal pertenecen las ventas del año pasado.';

-- Un punto de venta pertenece a UNA sucursal por vez. Con dos, el mismo
-- comprobante se contaría en las dos y el total de la empresa dejaría de cerrar
-- contra la suma de sus sucursales.
CREATE FUNCTION assert_un_punto_por_fecha() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM branch_points_of_sale p
     WHERE p.company_id = NEW.company_id
       AND p.punto_venta = NEW.punto_venta
       AND p.id <> NEW.id
       AND daterange(p.vigencia_desde, p.vigencia_hasta, '[]')
           && daterange(NEW.vigencia_desde, NEW.vigencia_hasta, '[]')
  ) THEN
    RAISE EXCEPTION
      'E_SUC_PUNTO_SUPERPUESTO: ese punto de venta ya pertenece a otra sucursal en esas fechas.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER bpv_uno_por_fecha
  AFTER INSERT OR UPDATE ON branch_points_of_sale
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_un_punto_por_fecha();

-- ---------------------------------------------------------------------------
-- 3 · Las ventas, atribuidas por el mapa vigente ese día
-- ---------------------------------------------------------------------------
CREATE VIEW branch_sales WITH (security_invoker = true) AS
SELECT t.company_id,
       p.branch_id,
       t.id                                        AS tax_transaction_id,
       t.punto_venta,
       t.cbte_numero,
       t.cbte_tipo,
       t.cbte_fecha,
       t.razon_social                              AS cliente,
       t.neto,
       t.total
  FROM tax_transactions t
  JOIN branch_points_of_sale p
    ON p.company_id = t.company_id
   AND p.punto_venta = t.punto_venta
   AND p.vigencia_desde <= t.cbte_fecha
   AND (p.vigencia_hasta IS NULL OR p.vigencia_hasta >= t.cbte_fecha)
 WHERE t.direction = 'VENTAS';

COMMENT ON VIEW branch_sales IS
  'Cada venta con la sucursal a la que pertenecía su punto de venta **el día '
  'en que se emitió**. No hay columna `branch_id` en el comprobante: la '
  'atribución se deriva de un dato que ya estaba.';

-- ---------------------------------------------------------------------------
-- 4 · La sucursal, derivada (ADR-018)
-- ---------------------------------------------------------------------------
CREATE VIEW branch_status WITH (security_invoker = true) AS
SELECT b.company_id,
       b.id                                        AS branch_id,
       b.code                                      AS sucursal_codigo,
       b.name                                      AS sucursal_nombre,
       b.direccion,
       b.localidad,
       b.provincia,
       b.status,
       b.cerrada_el,
       b.motivo_cierre,
       b.warehouse_id,
       w.code                                      AS deposito_codigo,
       b.cost_center_id,
       cc.code                                     AS centro_codigo,

       coalesce(pv.puntos, 0)                      AS puntos_de_venta,
       pv.detalle                                  AS puntos_detalle,

       coalesce(v.comprobantes, 0)                 AS comprobantes,
       coalesce(v.neto, 0)                         AS ventas_neto,
       coalesce(v.total, 0)                        AS ventas_total,
       v.ultima_venta,

       -- Del Mayor, por el centro de costo. Es la otra atribución, y puede no
       -- coincidir con la de arriba: son dos caminos distintos.
       coalesce(m.ingresos, 0)                     AS ingresos_imputados,
       coalesce(m.costos, 0)                       AS costos_imputados,

       -- Existencias: **cuántos productos** tienen stock, no cuántas unidades.
       -- Sumar unidades de productos distintos —kilos con cajas con litros— da
       -- un número que no significa nada.
       coalesce(s.productos_con_existencia, 0)     AS productos_con_existencia,

       b.created_at
  FROM branches b
  LEFT JOIN warehouses w ON w.id = b.warehouse_id AND w.company_id = b.company_id
  LEFT JOIN cost_centers cc ON cc.id = b.cost_center_id AND cc.company_id = b.company_id
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS puntos,
               string_agg(p.punto_venta::text, ', ' ORDER BY p.punto_venta) AS detalle
          FROM branch_points_of_sale p
         WHERE p.branch_id = b.id AND p.company_id = b.company_id
           AND (p.vigencia_hasta IS NULL OR p.vigencia_hasta >= current_date)
       ) pv ON true
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS comprobantes,
               sum(x.neto)   AS neto,
               sum(x.total)  AS total,
               max(x.cbte_fecha) AS ultima_venta
          FROM branch_sales x
         WHERE x.branch_id = b.id AND x.company_id = b.company_id
       ) v ON true
  LEFT JOIN LATERAL (
        SELECT sum(lm.credit - lm.debit) FILTER (WHERE a.type = 'INGRESO')  AS ingresos,
               sum(lm.debit - lm.credit) FILTER (WHERE a.type IN ('COSTO', 'GASTO'))
                                                                            AS costos
          FROM ledger_movements lm
          JOIN journal_entry_lines jel
            ON jel.id = lm.entry_line_id AND jel.company_id = lm.company_id
          JOIN accounts a ON a.id = lm.account_id AND a.company_id = lm.company_id
         WHERE lm.company_id = b.company_id
           AND jel.cost_center_id = b.cost_center_id
       ) m ON true
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS productos_con_existencia
          FROM stock_on_hand h
         WHERE h.company_id = b.company_id
           AND h.warehouse_id = b.warehouse_id
           AND h.existencia <> 0
       ) s ON true;

COMMENT ON VIEW branch_status IS
  'La sucursal con sus dos atribuciones: las ventas por punto de venta y lo '
  'imputado al centro de costo. Pueden no coincidir, y se muestran las dos '
  'porque la diferencia es el dato que le sirve a quien revisa.';

CREATE VIEW analytics_sucursales WITH (security_invoker = true) AS
SELECT s.company_id,
       s.branch_id,
       s.sucursal_codigo,
       s.sucursal_nombre,
       s.status,
       s.comprobantes,
       s.ventas_neto,
       s.ventas_total,
       s.ingresos_imputados,
       s.costos_imputados,
       -- El resultado sale del Mayor, que es donde están las dos puntas. Las
       -- ventas por punto de venta no se le restan a nada: son otra medición.
       CASE WHEN s.cost_center_id IS NULL THEN NULL
            ELSE s.ingresos_imputados - s.costos_imputados
       END                                         AS resultado_imputado,
       -- La diferencia entre las dos atribuciones, dicha en números. No se
       -- corrige sola ni se esconde: es lo que hay que ir a mirar.
       CASE WHEN s.cost_center_id IS NULL THEN NULL
            ELSE s.ventas_neto - s.ingresos_imputados
       END                                         AS brecha_de_atribucion,
       s.productos_con_existencia,
       CASE
         WHEN s.puntos_de_venta = 0 AND s.comprobantes = 0
           THEN 'Sin puntos de venta declarados: ninguna venta se le puede atribuir a esta '
                'sucursal.'
         -- Tuvo puntos y ya no tiene ninguno vigente. Decir «sin puntos
         -- declarados» acá sería falso: sus ventas anteriores están atribuidas
         -- y el número de al lado no es cero.
         WHEN s.puntos_de_venta = 0
           THEN 'Ya no tiene puntos de venta vigentes. Sus ventas anteriores siguen '
                'atribuidas —el mapa se lee a la fecha de cada comprobante— y las nuevas '
                'irán a la boca que tenga ese punto hoy.'
         WHEN s.cost_center_id IS NULL
           THEN 'Ventas atribuidas por punto de venta. Sin centro de costo declarado no hay '
                'gastos imputados, así que no se calcula resultado.'
         ELSE 'Ventas por punto de venta vigente el día del comprobante; ingresos y gastos '
              'del Mayor por el centro de costo. Son dos atribuciones distintas y su '
              'diferencia se informa en brecha_de_atribucion en vez de promediarse.'
       END::text                                   AS metodologia
  FROM branch_status s;

COMMENT ON VIEW analytics_sucursales IS
  'Cómo le va a cada boca. Informa las dos atribuciones y su brecha: elegir una '
  'y callar la otra daría un número más lindo y menos cierto.';

-- ---------------------------------------------------------------------------
-- 5 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_sucursales WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Activa y sin punto de venta. No es una preferencia: sin punto de venta
--     ninguna factura se le puede atribuir, y la sucursal existe solo en el
--     maestro.
SELECT s.company_id,
       'SUCURSAL_SIN_PUNTO_DE_VENTA'::text           AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'branches'::text                              AS entidad,
       s.branch_id                                   AS entity_id,
       s.status                                      AS estado,
       'La sucursal ' || s.sucursal_codigo || ' no tiene puntos de venta ' ||
         'declarados: ninguna venta se le puede atribuir'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['PUNTO_DE_VENTA']::text[]               AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/branches/' || s.branch_id                   AS traza_ref
  FROM branch_status s
 WHERE s.status = 'ACTIVA' AND s.puntos_de_venta = 0

UNION ALL

-- 2 · Activa y sin centro de costo. Las ventas se le atribuyen igual —eso sale
--     del punto de venta— pero sus gastos no, y sin gastos no hay resultado.
SELECT s.company_id,
       'SUCURSAL_SIN_CENTRO_DE_COSTO'::text          AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'branches'::text                              AS entidad,
       s.branch_id                                   AS entity_id,
       s.status                                      AS estado,
       'La sucursal ' || s.sucursal_codigo || ' no cita centro de costo: sus ' ||
         'gastos no se le pueden atribuir y no se calcula su resultado'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['CENTRO_DE_COSTO']::text[]              AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/branches/' || s.branch_id                   AS traza_ref
  FROM branch_status s
 WHERE s.status = 'ACTIVA' AND s.cost_center_id IS NULL

UNION ALL

-- 3 · Ventas cuyo punto de venta no pertenece a ninguna sucursal en su fecha.
--     Solo en empresas que declararon sucursales: en una sin sucursales no
--     falta nada. Se agrupa por punto de venta y no por comprobante — lo que
--     falta es declarar la boca, no corregir cada factura.
SELECT h.company_id,
       'PUNTO_DE_VENTA_SIN_SUCURSAL'::text           AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'branches'::text                              AS entidad,
       -- La entidad es la sucursal, y acá todavía no hay ninguna: se usa un id
       -- derivado del punto de venta para que el ítem sea estable entre
       -- consultas y se pueda resolver una vez.
       md5(h.company_id::text || ':pv:' || h.punto_venta)::uuid AS entity_id,
       'SIN_SUCURSAL'::text                          AS estado,
       'El punto de venta ' || h.punto_venta || ' facturó ' || h.comprobantes ||
         ' comprobante(s) y no pertenece a ninguna sucursal en esas fechas'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['SUCURSAL']::text[]                     AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       h.desde::timestamptz                          AS creado_en,
       h.hasta::timestamptz                          AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/branches'::text                             AS traza_ref
  FROM (
        SELECT t.company_id,
               t.punto_venta,
               count(*)::int     AS comprobantes,
               min(t.cbte_fecha) AS desde,
               max(t.cbte_fecha) AS hasta
          FROM tax_transactions t
         WHERE t.direction = 'VENTAS'
           AND NOT EXISTS (
                 SELECT 1 FROM branch_points_of_sale p
                  WHERE p.company_id = t.company_id
                    AND p.punto_venta = t.punto_venta
                    AND p.vigencia_desde <= t.cbte_fecha
                    AND (p.vigencia_hasta IS NULL OR p.vigencia_hasta >= t.cbte_fecha))
           AND EXISTS (
                 SELECT 1 FROM branches b
                  WHERE b.company_id = t.company_id AND b.status = 'ACTIVA')
         GROUP BY t.company_id, t.punto_venta
       ) h

) q;

COMMENT ON VIEW work_queue_sucursales IS
  'Ramas de sucursales. Las tres avisan de algo sin declarar —el punto de '
  'venta, el centro de costo, o la boca de un punto que factura— y ninguna '
  'aparece en una empresa que no declaró sucursales.';

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
UNION ALL SELECT * FROM work_queue_sucursales;

-- ---------------------------------------------------------------------------
-- 6 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('branch:read',  'Consultar sucursales, sus puntos de venta y su desempeño'),
  ('branch:write', 'Dar de alta sucursales y declarar sus puntos de venta');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
   AND p.code = 'branch:read';

-- Declarar un punto de venta cambia a qué sucursal se atribuyen las ventas:
-- es configuración de la empresa, no operación de mostrador.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
   AND p.code = 'branch:write';

GRANT SELECT ON branch_sales TO aai_app;
GRANT SELECT ON branch_status TO aai_app;
GRANT SELECT ON analytics_sucursales TO aai_app;
GRANT SELECT ON work_queue_sucursales TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
