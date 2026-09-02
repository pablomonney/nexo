-- ============================================================================
-- 0077 — Valuación de existencias: el método se declara, el costo se calcula
-- ============================================================================
--
-- `COBERTURA_ERP.md` tenía la valuación como DECISIÓN desde la primera
-- auditoría: «PPP, FIFO o costo de reposición es una decisión contable con
-- norma detrás. Sin ella no hay costo de mercadería vendida ni margen».
--
-- La decisión sigue siendo de la empresa. Lo que cambia es que ahora **hay
-- dónde declararla**, y que el método declarado se calcula de verdad.
--
-- ## Qué se ofrece y qué no
--
-- El catálogo de métodos sigue el mismo patrón que los proveedores de
-- integración (0056): cada uno dice si está DISPONIBLE o PLANIFICADO. Hoy el
-- único disponible es el promedio ponderado móvil, porque es el único que la
-- arquitectura actual calcula sin agregar nada: sale de los movimientos que ya
-- existen. FIFO exige costear por capas —seguir cada salida contra la entrada
-- que la abastece— y eso es un modelo nuevo, no una consulta distinta.
--
-- Ofrecer FIFO y no calcularlo sería peor que no ofrecerlo: la empresa lo
-- declararía y se quedaría sin valuación sin entender por qué.
--
-- ## El costo de entrada se declara; el de salida se deriva
--
-- `stock_movements.costo_unitario` es para las entradas. Las salidas **no lo
-- llevan**: su costo es el promedio al momento de salir, y dejar que alguien lo
-- escriba crearía una segunda verdad que puede contradecir al promedio. Lo
-- impide un CHECK.
--
-- Y si una entrada no declaró costo, la valuación de ese producto **no se
-- afirma**: se informa cuántas entradas no tienen costo y cuáles. Un promedio
-- que ignora las entradas sin costo no es un promedio: es un número más chico.
--
-- ## Las transferencias no entran
--
-- Mover mercadería de un depósito a otro no cambia ni la cantidad ni el costo
-- de la empresa. Contarlas haría que el promedio se moviera por una mudanza.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El catálogo de métodos
-- ---------------------------------------------------------------------------
CREATE TABLE stock_valuation_methods (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  descripcion text NOT NULL,
  estado      text NOT NULL CHECK (estado IN ('DISPONIBLE', 'PLANIFICADO')),
  por_que     text NOT NULL
);

GRANT SELECT ON stock_valuation_methods TO aai_app;

COMMENT ON TABLE stock_valuation_methods IS
  'Los métodos de valuación y si el sistema los calcula. Mismo patrón que los '
  'proveedores de integración: ofrecer uno que no se calcula haría que una '
  'empresa lo declare y se quede sin valuación sin entender por qué.';

INSERT INTO stock_valuation_methods (code, name, descripcion, estado, por_que) VALUES
  ('PPP',
   'Promedio ponderado móvil',
   'Cada entrada recalcula el costo promedio; cada salida se costea al promedio '
   'vigente en ese momento.',
   'DISPONIBLE',
   'Sale de los movimientos que ya existen: no hace falta ninguna estructura nueva.'),
  ('FIFO',
   'Primero entrado, primero salido',
   'Cada salida se costea contra la entrada más antigua que quede sin consumir.',
   'PLANIFICADO',
   'Exige costear por capas: seguir cada salida contra la entrada que la abastece. '
   'Es un modelo nuevo, no una consulta distinta sobre lo que ya hay.'),
  ('COSTO_REPOSICION',
   'Costo de reposición',
   'Las existencias se valúan a lo que costaría reponerlas hoy.',
   'PLANIFICADO',
   'Exige una fuente de precios de reposición vigente por producto, que este '
   'sistema no tiene ni puede inventar.');

-- ---------------------------------------------------------------------------
-- 2 · La declaración de la empresa
-- ---------------------------------------------------------------------------
-- Con vigencia, porque cambiar de método es un cambio de política contable: la
-- norma exige exponerlo, y el histórico tiene que seguir valuado como se valuó.
CREATE TABLE company_stock_valuation (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  metodo         text NOT NULL REFERENCES stock_valuation_methods (code),

  vigencia_desde date NOT NULL,
  vigencia_hasta date,
  -- Obligatorio: un cambio de método de valuación se expone en las notas, y
  -- sin el motivo escrito la nota no se puede redactar.
  motivo         text NOT NULL CHECK (length(btrim(motivo)) > 2),

  declarado_por  text NOT NULL,
  declarado_el   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT csv_vigencia_coherente
    CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde)
);

ALTER TABLE company_stock_valuation ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_stock_valuation FORCE ROW LEVEL SECURITY;
CREATE POLICY csv_por_empresa ON company_stock_valuation
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON company_stock_valuation TO aai_app;

-- Un método por vez. Con dos vigentes, el mismo producto tendría dos costos y
-- el balance dependería de cuál se leyó primero.
CREATE FUNCTION assert_un_metodo_por_fecha() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM company_stock_valuation v
     WHERE v.company_id = NEW.company_id
       AND v.id <> NEW.id
       AND daterange(v.vigencia_desde, v.vigencia_hasta, '[]')
           && daterange(NEW.vigencia_desde, NEW.vigencia_hasta, '[]')
  ) THEN
    RAISE EXCEPTION
      'E_VAL_METODO_SUPERPUESTO: ya hay un método de valuación vigente en esas fechas.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER csv_uno_por_fecha
  AFTER INSERT OR UPDATE ON company_stock_valuation
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_un_metodo_por_fecha();

-- ---------------------------------------------------------------------------
-- 3 · El costo de entrada
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movements ADD COLUMN costo_unitario numeric(18, 4)
  CHECK (costo_unitario IS NULL OR costo_unitario >= 0);

-- Solo las entradas lo llevan. El costo de una salida es el promedio al momento
-- de salir: dejar que alguien lo escriba crearía una segunda verdad capaz de
-- contradecir al promedio, y la que gana en ese empate es la que alguien tipeó.
ALTER TABLE stock_movements ADD CONSTRAINT sm_costo_solo_en_entradas
  CHECK (costo_unitario IS NULL
         OR tipo IN ('ENTRADA', 'AJUSTE_POSITIVO'));

COMMENT ON COLUMN stock_movements.costo_unitario IS
  'Costo unitario declarado de una entrada. Las salidas no lo llevan: su costo '
  'se deriva del promedio vigente. Una entrada sin costo deja la valuación de '
  'ese producto sin afirmar.';

-- ---------------------------------------------------------------------------
-- 4 · El promedio ponderado móvil, calculado
-- ---------------------------------------------------------------------------
-- Recursivo a propósito: el promedio cambia con cada entrada y cada salida se
-- costea al promedio de ese momento, así que no hay forma de obtenerlo con una
-- sola agregación. Se recorre en orden.
CREATE VIEW stock_movements_ordenados WITH (security_invoker = true) AS
SELECT m.company_id,
       m.product_id,
       m.id                                        AS movement_id,
       m.fecha,
       m.tipo,
       m.cantidad,
       m.costo_unitario,
       CASE WHEN m.tipo IN ('ENTRADA', 'AJUSTE_POSITIVO') THEN m.cantidad
            ELSE -m.cantidad
       END                                         AS delta,
       row_number() OVER (PARTITION BY m.company_id, m.product_id
                          ORDER BY m.fecha, m.created_at, m.id)
                                                   AS n
  FROM stock_movements m
 -- Las transferencias no cambian ni la cantidad ni el costo de la empresa:
 -- contarlas movería el promedio por una mudanza entre depósitos.
 WHERE m.tipo NOT IN ('TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SALIDA');

COMMENT ON VIEW stock_movements_ordenados IS
  'Los movimientos que afectan el costo, numerados por producto y en orden. Las '
  'transferencias quedan afuera: mover mercadería entre depósitos propios no '
  'cambia el costo de la empresa.';

CREATE VIEW stock_ppp WITH (security_invoker = true) AS
WITH RECURSIVE paso AS (
  SELECT m.company_id,
         m.product_id,
         m.n,
         m.movement_id,
         m.fecha,
         m.tipo,
         m.delta,
         m.cantidad                                AS cantidad_movimiento,
         m.delta                                   AS cantidad,
         CASE WHEN m.delta > 0 AND m.costo_unitario IS NOT NULL
              THEN m.delta * m.costo_unitario ELSE 0 END
                                                   AS costo_total,
         -- Costo de esta salida. En la primera fila no hay promedio previo, así
         -- que una salida inicial no se puede costear.
         NULL::numeric                             AS costo_de_salida,
         (m.delta > 0 AND m.costo_unitario IS NULL) AS falta_costo
    FROM stock_movements_ordenados m
   WHERE m.n = 1

  UNION ALL

  SELECT m.company_id,
         m.product_id,
         m.n,
         m.movement_id,
         m.fecha,
         m.tipo,
         m.delta,
         m.cantidad,
         p.cantidad + m.delta,
         CASE
           WHEN m.delta > 0 THEN
             p.costo_total
             + CASE WHEN m.costo_unitario IS NULL THEN 0 ELSE m.delta * m.costo_unitario END
           -- Una salida se lleva su parte del costo al promedio vigente. Con
           -- existencia en cero o negativa no hay promedio: no se descuenta
           -- nada y la marca de «falta costo» ya viene arrastrada.
           WHEN p.cantidad > 0 THEN
             p.costo_total + m.delta * (p.costo_total / p.cantidad)
           ELSE p.costo_total
         END,
         CASE WHEN m.delta < 0 AND p.cantidad > 0
              THEN round(-m.delta * (p.costo_total / p.cantidad), 2)
         END,
         p.falta_costo OR (m.delta > 0 AND m.costo_unitario IS NULL)
    FROM paso p
    JOIN stock_movements_ordenados m
      ON m.company_id = p.company_id
     AND m.product_id = p.product_id
     AND m.n = p.n + 1
)
SELECT * FROM paso;

COMMENT ON VIEW stock_ppp IS
  'El recorrido del promedio ponderado móvil, movimiento por movimiento. Cada '
  'salida trae el costo con el que salió. Es la base del costo de mercadería '
  'vendida y del valor de las existencias.';

-- ---------------------------------------------------------------------------
-- 5 · Lo que se afirma: solo con método declarado
-- ---------------------------------------------------------------------------
CREATE VIEW stock_valuation WITH (security_invoker = true) AS
SELECT p.company_id,
       p.product_id,
       pr.code                                     AS producto_codigo,
       pr.name                                     AS producto_nombre,
       v.metodo,
       u.cantidad,
       -- Sin método declarado no se afirma nada, y con una entrada sin costo
       -- tampoco: un promedio que ignora las entradas sin costo no es un
       -- promedio, es un número más chico.
       CASE WHEN v.metodo IS NULL OR u.falta_costo OR u.cantidad <= 0 THEN NULL
            ELSE round(u.costo_total, 2) END       AS costo_total,
       CASE WHEN v.metodo IS NULL OR u.falta_costo OR u.cantidad <= 0 THEN NULL
            ELSE round(u.costo_total / u.cantidad, 4) END
                                                   AS costo_unitario,
       u.falta_costo                               AS entradas_sin_costo,
       CASE
         WHEN v.metodo IS NULL
           THEN 'La empresa no declaró método de valuación: el costo de las existencias no '
                'se afirma. Es una decisión contable con norma detrás.'
         WHEN u.falta_costo
           THEN 'Hay entradas sin costo declarado: un promedio que las ignora no es un '
                'promedio, es un número más chico.'
         WHEN u.cantidad < 0
           THEN 'La existencia es negativa: no hay promedio que calcular hasta que se '
                'corrija con un recuento.'
         WHEN u.cantidad = 0
           THEN 'Sin existencias: no hay nada que valuar.'
         ELSE 'Promedio ponderado móvil sobre las entradas con costo declarado.'
       END::text                                   AS metodologia
  FROM (
        SELECT DISTINCT ON (company_id, product_id)
               company_id, product_id, cantidad, costo_total, falta_costo
          FROM stock_ppp
         ORDER BY company_id, product_id, n DESC
       ) u
  JOIN stock_ppp p ON p.company_id = u.company_id AND p.product_id = u.product_id AND p.n = 1
  JOIN products pr ON pr.id = u.product_id AND pr.company_id = u.company_id
  LEFT JOIN LATERAL (
        SELECT c.metodo
          FROM company_stock_valuation c
         WHERE c.company_id = u.company_id
           AND c.vigencia_desde <= current_date
           AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= current_date)
         LIMIT 1
       ) v ON true;

COMMENT ON VIEW stock_valuation IS
  'Cuánto valen las existencias de cada producto, si la empresa declaró cómo '
  'valuarlas. Sin método declarado el costo es NULL y se dice por qué: es una '
  'decisión contable con norma detrás, no un valor por defecto.';

-- ---------------------------------------------------------------------------
-- 6 · Costo de mercadería vendida
-- ---------------------------------------------------------------------------
CREATE VIEW analytics_costo_de_ventas WITH (security_invoker = true) AS
SELECT s.company_id,
       date_trunc('month', s.fecha)::date          AS mes,
       s.product_id,
       pr.code                                     AS producto_codigo,
       pr.name                                     AS producto_nombre,
       sum(s.cantidad_movimiento)                  AS unidades,
       -- Solo se suma lo que tiene costo. Lo que no, se cuenta aparte: sumarlo
       -- como cero diría que esa mercadería salió gratis.
       CASE WHEN v.metodo IS NULL THEN NULL
            ELSE sum(s.costo_de_salida) FILTER (WHERE s.costo_de_salida IS NOT NULL)
       END                                         AS costo,
       count(*) FILTER (WHERE s.costo_de_salida IS NULL)::int
                                                   AS salidas_sin_costo,
       v.metodo
  FROM stock_ppp s
  JOIN products pr ON pr.id = s.product_id AND pr.company_id = s.company_id
  LEFT JOIN LATERAL (
        SELECT c.metodo
          FROM company_stock_valuation c
         WHERE c.company_id = s.company_id
           AND c.vigencia_desde <= s.fecha
           AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= s.fecha)
         LIMIT 1
       ) v ON true
 WHERE s.tipo = 'SALIDA'
 GROUP BY s.company_id, date_trunc('month', s.fecha), s.product_id, pr.code, pr.name, v.metodo;

COMMENT ON VIEW analytics_costo_de_ventas IS
  'El costo de lo que salió por venta, mes a mes. Es la pieza que le faltaba al '
  'resultado del ejercicio: sin ella el margen es la venta entera. No escribe '
  'ningún asiento — el asiento de costo lo firma una persona.';

-- ---------------------------------------------------------------------------
-- 7 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_valuacion WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Hay existencias y no hay método declarado. No bloquea nada: se puede
--     seguir moviendo stock, y lo que no se puede es valuarlo.
SELECT r.company_id,
       'SIN_METODO_DE_VALUACION'::text               AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'companies'::text                             AS entidad,
       r.company_id                                  AS entity_id,
       'SIN_DECLARAR'::text                          AS estado,
       'Hay productos con existencias y la empresa no declaró cómo valuarlas: ' ||
         'sin método no hay costo de mercadería vendida ni margen'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['METODO_DE_VALUACION']::text[]          AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/stock-valuation'::text                      AS traza_ref
  FROM company_readiness r
 WHERE r.productos_con_stock > 0
   AND NOT EXISTS (SELECT 1 FROM company_stock_valuation c
                    WHERE c.company_id = r.company_id
                      AND c.vigencia_desde <= current_date
                      AND (c.vigencia_hasta IS NULL OR c.vigencia_hasta >= current_date))

UNION ALL

-- 2 · Con método declarado, las entradas sin costo dejan a ese producto sin
--     valuar. Cuelga del producto: es donde se resuelve.
SELECT s.company_id,
       'ENTRADA_SIN_COSTO'::text                     AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'products'::text                              AS entidad,
       s.product_id                                  AS entity_id,
       'SIN_COSTO'::text                             AS estado,
       'El producto ' || s.producto_codigo || ' tiene entradas sin costo ' ||
         'declarado: su existencia no se puede valuar'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['COSTO_DE_ENTRADA']::text[]             AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/stock/movements'::text                      AS traza_ref
  FROM stock_valuation s
 WHERE s.metodo IS NOT NULL AND s.entradas_sin_costo

) q;

COMMENT ON VIEW work_queue_valuacion IS
  'Ramas de valuación. Ninguna bloquea: el stock se mueve igual. Lo que no se '
  'puede sin ellas es afirmar cuánto vale.';

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
UNION ALL SELECT * FROM work_queue_valuacion;

GRANT SELECT ON stock_movements_ordenados TO aai_app;
GRANT SELECT ON stock_ppp TO aai_app;
GRANT SELECT ON stock_valuation TO aai_app;
GRANT SELECT ON analytics_costo_de_ventas TO aai_app;
GRANT SELECT ON work_queue_valuacion TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
