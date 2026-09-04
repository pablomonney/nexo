-- ============================================================================
-- 0090 — La cobranza tiene su fecha
-- ============================================================================
--
-- «¿Cuánto cobré este mes?» era la única pregunta de NEXO Intelligence que se
-- contestaba con un `SELECT` sobre una tabla del ERP en vez de sobre una vista.
-- Eso tiene dos consecuencias, y la segunda es la grave.
--
-- ## La primera: la métrica no existía en ningún lado
--
-- Vivía adentro de la respuesta. Cualquier otra capa que necesitara cobranzas
-- del mes —el Decision Engine, una pantalla, un informe— iba a escribir su
-- propia versión, y a partir de ahí habría dos definiciones de lo mismo que
-- nadie podría comparar. Es exactamente lo que la Data Foundation existe para
-- impedir.
--
-- ## La segunda: la fecha estaba mal
--
-- La consulta agrupaba por `party_allocations.created_at` — **cuándo alguien
-- registró la imputación**—. Todo el resto del sistema fecha por el hecho:
-- «el mes sale de la fecha del comprobante, no de cuándo se cargó». Un cobro de
-- marzo imputado en abril figuraba como cobrado en abril, y las cobranzas de un
-- mes cerrado cambiaban con solo cargar una imputación atrasada.
--
-- La fecha del cobro es la del **asiento** que lo registra: la imputación apunta
-- a un renglón del Mayor (`journal_entry_line_id`), y ese asiento tiene su
-- `entry_date`. Es el mismo dato que ya usa el Mayor, la analítica y el margen.
--
-- ## Las tres decisiones
--
-- **1. Solo asientos APROBADOS.** Un borrador no cobró nada. Es el mismo
-- criterio de `cost_center_results` y de toda la analítica.
--
-- **2. Solo imputaciones ACTIVAS.** Una imputación anulada no es un cobro que
-- se hizo y se deshizo: es un cobro que se imputó mal. Lo que se anuló no se
-- cuenta, y el motivo de la anulación queda en la tabla.
--
-- **3. Las dos direcciones, en la misma vista.** Cobranzas y pagos son la misma
-- operación mirada desde los dos lados —una imputación contra un comprobante de
-- VENTAS o de COMPRAS—, y separarlas en dos vistas habría dado dos definiciones
-- otra vez. `direccion` es una columna.
-- ============================================================================

CREATE VIEW collections_by_month WITH (security_invoker = true) AS
SELECT a.company_id,
       t.direction                                  AS direccion,
       date_trunc('month', e.entry_date)::date      AS mes,
       sum(a.importe)::numeric(18, 2)               AS imputado,
       count(*)::int                                AS imputaciones,
       count(DISTINCT a.party_id)::int              AS terceros,
       count(DISTINCT a.tax_transaction_id)::int    AS comprobantes,
       min(e.entry_date)                            AS primera,
       max(e.entry_date)                            AS ultima
  FROM party_allocations a
  JOIN tax_transactions t
    ON t.id = a.tax_transaction_id AND t.company_id = a.company_id
  JOIN journal_entry_lines l
    ON l.id = a.journal_entry_line_id AND l.company_id = a.company_id
  JOIN journal_entries e
    ON e.id = l.entry_id AND e.company_id = l.company_id
 WHERE a.status = 'ACTIVA'
   AND e.status = 'APROBADO'
 GROUP BY a.company_id, t.direction, date_trunc('month', e.entry_date)::date;

COMMENT ON VIEW collections_by_month IS
  'Cobranzas y pagos imputados por mes, fechados por el asiento que los '
  'registra —no por cuándo se cargó la imputación—. Solo imputaciones ACTIVAS '
  'contra asientos APROBADOS. Es la definición canónica: no se recalcula en '
  'ningún otro lado.';

GRANT SELECT ON collections_by_month TO aai_app;
