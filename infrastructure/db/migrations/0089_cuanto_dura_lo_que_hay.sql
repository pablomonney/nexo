-- ============================================================================
-- 0089 — Cuánto dura lo que hay
-- ============================================================================
--
-- El sistema sabe **cuánto hay** (`stock_by_product`) y sabe si eso está por
-- debajo de un mínimo declarado. Lo que no sabe decir es lo único que sirve para
-- decidir una compra: **cuánto tiempo alcanza**.
--
-- Un mínimo declarado es una respuesta pobre a esa pregunta. Dos productos con
-- el mismo mínimo y el mismo stock están en situaciones opuestas si uno rota
-- veinte veces por mes y el otro dos veces por año — y el mínimo, además, hay
-- que mantenerlo a mano.
--
-- ## Qué es «cuánto dura»
--
--     consumo diario = unidades que salieron por venta en la ventana / días
--     cobertura      = existencia / consumo diario
--
-- Nada más. Es una división, no un pronóstico: dice **al ritmo de los últimos
-- noventa días**, y ese ritmo está a la vista para que quien mire pueda
-- descartarlo. Un producto que se vendió una sola vez porque fue una operación
-- irrepetible va a mostrar una cobertura corta y falsa, y el número de salidas
-- que la produjo aparece al lado.
--
-- ## Las cuatro decisiones
--
-- **1. La ventana es de noventa días y se declara.** Un promedio sobre treinta
-- reacciona a cualquier mes raro; sobre un año se come la estacionalidad. Se
-- eligió noventa y **se dice en la respuesta**: quien no esté de acuerdo tiene
-- que poder saber contra qué está discutiendo.
--
-- **2. Sin salidas en la ventana, la cobertura es `NULL`.** No es «infinita» ni
-- «muy alta»: es que no se puede afirmar. Un producto sin movimiento puede ser
-- obsoleto o puede ser estacional, y el sistema no sabe cuál.
--
-- **3. Solo cuentan las salidas por VENTA.** Un ajuste por rotura no es
-- consumo; una transferencia entre depósitos tampoco. Contarlas inflaría el
-- ritmo y acortaría la cobertura de todos los productos con inventario
-- desprolijo, que son justo los que menos hay que apurar.
--
-- **4. No recomienda comprar.** Dice cuánto dura. Cuánto y cuándo comprar
-- depende del plazo del proveedor, del dinero disponible y de la política de la
-- empresa — tres cosas que este sistema tiene en otro lado o no tiene, y
-- ninguna se supone acá.
-- ============================================================================

CREATE VIEW stock_coverage WITH (security_invoker = true) AS
WITH consumo AS (
  SELECT m.company_id,
         m.product_id,
         -- Las salidas se guardan en positivo: la vista de existencias les pone
         -- el signo. Acá se suman como cantidad consumida.
         sum(m.cantidad)::numeric(18, 4) AS consumido,
         count(*)::int                   AS salidas,
         min(m.fecha)                    AS primera_salida,
         max(m.fecha)                    AS ultima_salida
    FROM stock_movements m
   WHERE m.tipo = 'SALIDA'
     AND m.origen_tipo = 'VENTA'
     AND m.fecha > current_date - 90
   GROUP BY m.company_id, m.product_id
)
SELECT s.company_id,
       s.product_id,
       s.producto_codigo,
       s.producto_nombre,
       s.unidad,
       s.existencia,
       s.stock_minimo,
       s.bajo_minimo,
       90                                          AS ventana_dias,
       coalesce(c.consumido, 0)::numeric(18, 4)    AS consumido_en_la_ventana,
       coalesce(c.salidas, 0)                      AS salidas_en_la_ventana,
       c.primera_salida,
       c.ultima_salida,
       -- El ritmo, para que la cobertura se pueda rehacer a mano.
       CASE WHEN c.consumido IS NULL OR c.consumido = 0 THEN NULL
            ELSE (c.consumido / 90)::numeric(18, 4)
       END                                         AS consumo_diario,
       -- Sin consumo no hay cobertura que afirmar. `NULL` es «no se sabe», y es
       -- distinto de «alcanza para siempre».
       CASE WHEN c.consumido IS NULL OR c.consumido = 0 OR s.existencia <= 0 THEN NULL
            ELSE floor(s.existencia / (c.consumido / 90))::int
       END                                         AS dias_de_cobertura,
       CASE WHEN c.consumido IS NULL OR c.consumido = 0 OR s.existencia <= 0 THEN NULL
            ELSE current_date + floor(s.existencia / (c.consumido / 90))::int
       END                                         AS alcanza_hasta,
       -- Por qué no se puede afirmar, cuando no se puede. La pantalla no tiene
       -- que adivinar si el NULL es «sin datos» o «sin stock».
       CASE
         WHEN s.existencia <= 0 THEN 'SIN_EXISTENCIA'
         WHEN c.consumido IS NULL OR c.consumido = 0 THEN 'SIN_CONSUMO_EN_LA_VENTANA'
         ELSE NULL
       END                                         AS motivo_sin_cobertura
  FROM stock_by_product s
  LEFT JOIN consumo c
    ON c.company_id = s.company_id AND c.product_id = s.product_id;

COMMENT ON VIEW stock_coverage IS
  'Cuántos días alcanza la existencia al ritmo de las salidas por venta de los '
  'últimos 90 días. NULL cuando no hay consumo en la ventana: es «no se puede '
  'afirmar», no «alcanza para siempre». No recomienda comprar.';

GRANT SELECT ON stock_coverage TO aai_app;
