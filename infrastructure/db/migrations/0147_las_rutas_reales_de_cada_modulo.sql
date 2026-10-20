-- ---------------------------------------------------------------------------
-- Cada módulo del plan, con las rutas que de verdad tiene
-- ---------------------------------------------------------------------------
--
-- La puerta comercial (`alcanzaElPlan`) decide por el **primer segmento de la ruta**: si ese dominio está en `product_features.dominios`, la
-- empresa necesita la funcionalidad que lo cubre; si no está, deja pasar (falla abierta, a propósito: es una puerta comercial, no de seguridad).
--
-- La 0105 cargó los dominios con nombres en castellano (`solicitudes-de-compra`, `ordenes-de-pago`, `proyectos`…) que son los de la PANTALLA, pero
-- las rutas de la API se llaman en inglés (`/purchase-requests`, `/payment-orders`, `/projects`…). Resultado, medido el 2026-10-20 con
-- `tests/integration/planes-y-modulos.test.ts`: la consola ocultaba a un plan las pantallas que no incluía, pero la API **no las cerraba**; un
-- cliente de NEXO Esencial podía usar por API Ventas, Compras, Tesorería, Stock, Sucursales, Proyectos y Comisiones.
--
-- Esta migración **agrega** a cada funcionalidad las rutas reales de su módulo. No quita nada: los nombres en castellano siguen, porque la consola
-- decide qué pantalla ocultar con ellos (`fueraDelPlan` trae los dominios de lo excluido, y la consola busca por esos nombres).
--
-- Qué se cierra a quién: nada cambia para los planes que incluyen el módulo, ni para una empresa sin suscripción con plan (falla abierta). Sólo
-- se cierra, a un plan que no lo incluye, lo que la consola ya le ocultaba.
-- ---------------------------------------------------------------------------

UPDATE product_features f
   SET dominios = (SELECT array_agg(DISTINCT d ORDER BY d) FROM unnest(f.dominios || a.nuevos) AS d)
  FROM (VALUES
    ('fiscal',        ARRAY['tax-transactions', 'tax-transaction-corrections', 'party-allocations']),
    ('comercial',     ARRAY['commercial-documents']),
    ('compras',       ARRAY['purchase-requests', 'goods-receipts', 'payment-orders']),
    ('stock',         ARRAY['warehouses', 'stock-counts', 'stock-valuation', 'stock-movements', 'fixed-assets']),
    ('tesoreria',     ARRAY['cash-boxes', 'cash-sessions', 'checks']),
    ('precios',       ARRAY['price-lists', 'pricing']),
    ('sucursales',    ARRAY['branches']),
    ('proyectos',     ARRAY['projects']),
    ('comisiones',    ARRAY['salespeople']),
    ('integraciones', ARRAY['integrations', 'integration-providers', 'external-records'])
  ) AS a(code, nuevos)
 WHERE f.code = a.code;
