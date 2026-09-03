-- ============================================================================
-- 0088 — El centro de costo se podía asignar y no se podía mirar
-- ============================================================================
--
-- `journal_entry_lines.cost_center_id` existe desde la 0003, una cuenta puede
-- **exigir** centro de costo (`accounts.requires_cost_center`), el asiento lo
-- valida al cargarlo, y la 0031 lo acepta como evidencia de una afectación
-- fiscal. Todo eso funciona.
--
-- Y la única consulta que agrupaba por centro de costo estaba **adentro de otro
-- módulo**: la 0070 lee el Mayor por el centro que declara un proyecto, para
-- calcular su rentabilidad. Fuera de esa lente no había nada — ni vista, ni
-- endpoint, ni pantalla—. Una empresa que usa centros de costo sin proyectos
-- completaba la dimensión fila por fila y no podía ver el resultado de haberla
-- completado.
--
-- Es el mismo defecto que persiguen S-16 y S-17 —algo construido que nadie
-- recorre—, esta vez del lado de la lectura: un dato que se escribe y no se
-- consulta es un campo que no hace nada.
--
-- ## Qué es un resultado por centro de costo
--
-- La suma de los movimientos del Mayor de cuentas de resultado, agrupada por el
-- centro que la línea declara. Nada más:
--
--     ingresos  = suma de (haber - debe) de las cuentas de tipo INGRESO
--     gastos    = suma de (debe - haber) de las cuentas de tipo GASTO y COSTO
--     resultado = ingresos - gastos
--
-- ## Las tres decisiones que tiene esta vista
--
-- **1. Solo asientos APROBADOS.** Un borrador no es contabilidad. Es el mismo
-- criterio del Mayor y de todos los reportes: si un borrador entrara acá, el
-- resultado de un centro cambiaría al aprobar y nadie sabría por qué.
--
-- **2. Las líneas sin centro se informan aparte, no se reparten.** Prorratearlas
-- por algún criterio —proporcional al gasto, en partes iguales— sería inventar
-- una asignación que nadie declaró. Aparecen como `SIN_CENTRO`, con su importe,
-- y verlas es el punto: un resultado por centro que no cierra contra el estado
-- de resultados no está mal calculado, está incompleto, y la diferencia es
-- exactamente esa fila.
--
-- **3. No se guarda nada.** Es una vista sobre el Mayor. Una tabla de
-- resultados por centro sería un derivado que envejece (ADR-022).
--
-- ## Lo que esta vista NO hace
--
-- No distribuye gastos indirectos entre centros. Eso es contabilidad de costos
-- —con su método, sus bases de distribución y su política declarada— y no está
-- relevada. Un reparto automático produciría un número por centro que parece
-- una medición y es un supuesto.
-- ============================================================================

CREATE VIEW cost_center_results WITH (security_invoker = true) AS
SELECT l.company_id,
       -- `NULL` no agrupa con `NULL` en un GROUP BY corriente, pero acá el
       -- coalesce lo hace explícito: la fila sin centro es UNA fila, con nombre.
       coalesce(cc.id::text, 'SIN_CENTRO')              AS centro_id,
       coalesce(cc.code, 'SIN_CENTRO')                  AS centro_codigo,
       coalesce(cc.name, 'Sin centro de costo asignado') AS centro_nombre,
       date_trunc('month', e.entry_date)::date          AS mes,
       sum(CASE WHEN a.type = 'INGRESO' THEN l.credit - l.debit ELSE 0 END)
         ::numeric(18, 2)                               AS ingresos,
       sum(CASE WHEN a.type IN ('GASTO', 'COSTO') THEN l.debit - l.credit ELSE 0 END)
         ::numeric(18, 2)                               AS gastos,
       (sum(CASE WHEN a.type = 'INGRESO' THEN l.credit - l.debit ELSE 0 END)
        - sum(CASE WHEN a.type IN ('GASTO', 'COSTO') THEN l.debit - l.credit ELSE 0 END))
         ::numeric(18, 2)                               AS resultado,
       count(*)                                         AS movimientos
  FROM journal_entry_lines l
  JOIN journal_entries e
    ON e.id = l.entry_id AND e.company_id = l.company_id
  JOIN accounts a
    ON a.id = l.account_id AND a.company_id = l.company_id
  LEFT JOIN cost_centers cc
    ON cc.id = l.cost_center_id AND cc.company_id = l.company_id
 WHERE e.status = 'APROBADO'
   AND a.type IN ('INGRESO', 'GASTO', 'COSTO')
 GROUP BY l.company_id, cc.id, cc.code, cc.name, date_trunc('month', e.entry_date);

COMMENT ON VIEW cost_center_results IS
  'Resultado por centro de costo y mes, derivado del Mayor. Las líneas sin '
  'centro se informan como SIN_CENTRO en vez de repartirse: prorratearlas sería '
  'inventar una asignación que nadie declaró.';

GRANT SELECT ON cost_center_results TO aai_app;
