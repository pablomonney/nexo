-- ============================================================================
-- 0063 — La bandeja avisa cuando una lista de precios dejó de regir
-- ============================================================================
--
-- La 0061 hizo lo correcto: una lista rige entre dos fechas y `resolver_precio()`
-- pregunta siempre por la fecha de la operación. Fuera de esa vigencia la lista
-- no aplica y el precio cae al base del producto.
--
-- Ese comportamiento está bien y **falla en silencio**. El día que vence la
-- lista mayorista, el cliente mayorista empieza a cotizarse al precio de
-- mostrador y nadie se entera hasta que alguien mira una factura. No hay error,
-- no hay rechazo, no hay nada: hay una cotización distinta.
--
-- Es exactamente la clase de hueco que la bandeja existe para hacer visible.
--
-- ## Qué se informa, y qué no
--
-- Solo **hechos**: una vigencia que terminó. No hay «vence pronto», porque
-- «pronto» sería un umbral que nadie declaró — el mismo criterio que
-- `analysis_thresholds` (0058) y que `products.stock_minimo` (0054).
--
-- Y solo cuando le importa a alguien: una lista vencida sin terceros asignados
-- no cambia ninguna cotización, así que no es un pendiente. Un aviso sobre algo
-- que no afecta a nadie es cómo una bandeja se vuelve ruido y se deja de mirar.
-- ============================================================================

CREATE VIEW work_queue_precios WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · La lista venció y todavía hay terceros cotizando con ella.
--     Desde hoy esos clientes se cotizan al precio base del producto, sin que
--     nada haya fallado. La lista no se «reactiva» sola: alguien tiene que
--     decidir si se extiende la vigencia o si se carga la lista nueva.
SELECT l.company_id,
       'LISTA_DE_PRECIOS_VENCIDA'::text              AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'price_lists'::text                           AS entidad,
       l.id                                          AS entity_id,
       'VENCIDA'::text                               AS estado,
       'La lista ' || l.code || ' venció el ' || l.vigente_hasta ||
         ' y ' || count(a.id) || ' tercero(s) la tienen asignada: desde ese día ' ||
         'se cotizan al precio base del producto'    AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       l.created_at                                  AS creado_en,
       l.created_at                                  AS actualizado_en,
       l.vigente_hasta                               AS fecha_limite,
       '/price-lists/' || l.id                       AS traza_ref
  FROM price_lists l
  JOIN party_price_lists a
    ON a.price_list_id = l.id AND a.company_id = l.company_id
   -- La asignación al tercero tiene que seguir vigente: una lista vencida cuya
   -- asignación también terminó ya no cotiza a nadie.
   AND current_date BETWEEN a.desde AND coalesce(a.hasta, 'infinity'::date)
 WHERE l.status = 'ACTIVA'
   AND l.vigente_hasta IS NOT NULL
   AND l.vigente_hasta < current_date
 GROUP BY l.company_id, l.id, l.code, l.vigente_hasta, l.created_at

UNION ALL

-- 2 · Una lista activa y vigente que no tiene ni un precio cargado.
--     Cotiza exactamente igual que no tener lista, y esa es la trampa: parece
--     configurado y no lo está.
SELECT l.company_id,
       'LISTA_DE_PRECIOS_VACIA'::text                AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'price_lists'::text                           AS entidad,
       l.id                                          AS entity_id,
       'SIN_PRECIOS'::text                           AS estado,
       'La lista ' || l.code || ' está vigente y no tiene ningún precio cargado: ' ||
         'cotiza igual que no tenerla'               AS motivo,
       false                                         AS bloquea,
       ARRAY['PRECIOS']::text[]                      AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       l.created_at                                  AS creado_en,
       l.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/price-lists/' || l.id                       AS traza_ref
  FROM price_lists l
 WHERE l.status = 'ACTIVA'
   AND current_date BETWEEN l.vigente_desde AND coalesce(l.vigente_hasta, 'infinity'::date)
   AND NOT EXISTS (
         SELECT 1 FROM price_list_items i
          WHERE i.price_list_id = l.id AND i.company_id = l.company_id)

) q;

COMMENT ON VIEW work_queue_precios IS
  'Ramas de precios. Solo hechos: una vigencia que terminó y una lista sin '
  'precios. No hay «vence pronto» porque «pronto» sería un umbral que nadie '
  'declaró, y una lista vencida sin terceros asignados no cambia ninguna '
  'cotización, así que no es un pendiente.';

-- ---------------------------------------------------------------------------
-- La bandeja suma una rama
-- ---------------------------------------------------------------------------
-- ⚠ `WITH (security_invoker = true)` va repetido a propósito. `CREATE OR
-- REPLACE` **no conserva las reloptions**: omitirlo las borra, la vista pasa a
-- evaluarse con los permisos de su dueño y saltea el RLS de todas las tablas de
-- abajo. Pasó una vez en la 0058, y la bandeja de una empresa habría aparecido
-- en la de otra.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios;
