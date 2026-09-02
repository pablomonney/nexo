-- ============================================================================
-- 0081 — Margen real por producto: la venta contra su costo
-- ============================================================================
--
-- Con la valuación (0077) y el costo de lo vendido (0079), por primera vez se
-- pueden poner las dos puntas juntas: cuánto se vendió de cada producto y
-- cuánto costó lo que salió. Hasta acá la analítica mostraba ventas y el costo
-- vivía en otra pantalla.
--
-- ## Las dos puntas no siempre coinciden, y eso es el dato
--
-- Una venta se registra en el comprobante; la salida de stock es un acto
-- aparte que alguien tiene que hacer. Si se facturaron diez unidades y solo
-- salieron seis, el margen calculado sobre esas seis **no es el margen**: es un
-- número más grande que el real, y el más peligroso de todos porque parece
-- bueno.
--
-- Por eso la vista compara unidades vendidas contra unidades salidas y no
-- afirma margen cuando no cierran. Es el mismo criterio que la valuación aplica
-- con las entradas sin costo.
--
-- ## Las notas de crédito restan también acá
--
-- Es la lección de la 0080, aplicada al primer lugar donde podía repetirse: los
-- renglones de una nota de crédito descuentan de la venta del producto, con el
-- signo tomado del mismo catálogo archivado. Sumarlos habría inflado la venta y,
-- con ella, el margen.
--
-- ## Y un servicio no tiene costo de mercadería
--
-- Un producto que no lleva existencias no tiene salida de stock, y su margen
-- contra el costo de mercadería no existe. No se informa como margen del 100 %
-- —que sería falso— sino como lo que es: venta sin costo de mercadería
-- asociado.
-- ============================================================================

CREATE VIEW analytics_margen_por_producto WITH (security_invoker = true) AS
WITH ventas AS (
  SELECT t.company_id,
         date_trunc('month', t.cbte_fecha)::date            AS mes,
         l.product_id,
         -- El signo del catálogo, igual que en la cuenta corriente (0080). Una
         -- nota de crédito descuenta de la venta del producto.
         sum(CASE WHEN ct.clase = 'NOTA_CREDITO' THEN -l.cantidad ELSE l.cantidad END)
                                                            AS unidades,
         sum(CASE WHEN ct.clase = 'NOTA_CREDITO' THEN -l.neto ELSE l.neto END)
                                                            AS venta,
         count(*) FILTER (WHERE ct.clase = 'NOTA_CREDITO')::int
                                                            AS renglones_de_credito
    FROM tax_transaction_lines l
    JOIN tax_transactions t
      ON t.id = l.tax_transaction_id AND t.company_id = l.company_id
    LEFT JOIN arca_comprobante_types ct ON ct.codigo = t.cbte_tipo
   WHERE t.direction = 'VENTAS' AND l.product_id IS NOT NULL
   GROUP BY t.company_id, date_trunc('month', t.cbte_fecha), l.product_id
),
costos AS (
  SELECT s.company_id,
         date_trunc('month', s.fecha)::date                 AS mes,
         s.product_id,
         sum(s.cantidad_movimiento)                         AS unidades,
         sum(s.costo_de_salida) FILTER (WHERE s.costo_de_salida IS NOT NULL)
                                                            AS costo,
         count(*) FILTER (WHERE s.costo_de_salida IS NULL)::int
                                                            AS salidas_sin_costo
    FROM stock_ppp s
   WHERE s.tipo = 'SALIDA'
   GROUP BY s.company_id, date_trunc('month', s.fecha), s.product_id
)
SELECT coalesce(v.company_id, c.company_id)                 AS company_id,
       coalesce(v.mes, c.mes)                               AS mes,
       coalesce(v.product_id, c.product_id)                 AS product_id,
       p.code                                               AS producto_codigo,
       p.name                                               AS producto_nombre,
       p.tracks_stock                                       AS lleva_stock,
       coalesce(v.unidades, 0)                              AS unidades_vendidas,
       coalesce(c.unidades, 0)                              AS unidades_salidas,
       coalesce(v.venta, 0)                                 AS venta,
       c.costo,
       coalesce(c.salidas_sin_costo, 0)                     AS salidas_sin_costo,
       coalesce(v.renglones_de_credito, 0)                  AS renglones_de_credito,

       -- El margen se afirma solo cuando las dos puntas están completas: hay
       -- costo, no hay salidas sin costear, y lo vendido coincide con lo que
       -- salió del depósito.
       CASE WHEN p.tracks_stock
             AND c.costo IS NOT NULL
             AND coalesce(c.salidas_sin_costo, 0) = 0
             AND coalesce(v.unidades, 0) = coalesce(c.unidades, 0)
            THEN coalesce(v.venta, 0) - c.costo
       END                                                  AS margen,

       CASE WHEN p.tracks_stock
             AND c.costo IS NOT NULL
             AND coalesce(c.salidas_sin_costo, 0) = 0
             AND coalesce(v.unidades, 0) = coalesce(c.unidades, 0)
             AND coalesce(v.venta, 0) <> 0
            THEN round((coalesce(v.venta, 0) - c.costo) * 100 / v.venta, 2)
       END                                                  AS margen_pct,

       CASE
         WHEN NOT p.tracks_stock
           THEN 'Es un servicio: no tiene costo de mercadería. Informar un margen del 100 % '
                'sería afirmar que no costó nada producirlo.'
         WHEN c.costo IS NULL
           THEN 'No hay salidas de stock costeadas para este producto en el mes: sin costo '
                'no hay margen que afirmar.'
         WHEN coalesce(c.salidas_sin_costo, 0) > 0
           THEN 'Hay salidas sin costear porque el producto tiene entradas sin costo '
                'declarado.'
         WHEN coalesce(v.unidades, 0) <> coalesce(c.unidades, 0)
           THEN 'Se facturaron ' || coalesce(v.unidades, 0) || ' unidad(es) y salieron del '
                'depósito ' || coalesce(c.unidades, 0) || '. El margen sobre las que salieron '
                'sería más grande que el real, que es el error más peligroso de los dos.'
         ELSE 'Venta neta del mes menos el costo de las unidades que salieron, valuadas al '
              'promedio vigente al salir. Las notas de crédito descuentan de la venta.'
       END::text                                            AS metodologia
  FROM ventas v
  FULL OUTER JOIN costos c
    ON c.company_id = v.company_id AND c.mes = v.mes AND c.product_id = v.product_id
  JOIN products p
    ON p.id = coalesce(v.product_id, c.product_id)
   AND p.company_id = coalesce(v.company_id, c.company_id);

COMMENT ON VIEW analytics_margen_por_producto IS
  'Cuánto dejó cada producto, mes a mes. El margen es NULL cuando no se puede '
  'afirmar —servicio, sin costo, con salidas sin costear, o con unidades '
  'facturadas que no coinciden con las que salieron— y cada caso dice cuál es.';

GRANT SELECT ON analytics_margen_por_producto TO aai_app;
