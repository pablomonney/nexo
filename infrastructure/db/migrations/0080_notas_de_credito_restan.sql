-- ============================================================================
-- 0080 — Una nota de crédito resta, no suma
-- ============================================================================
--
-- `invoice_settlement` trataba **todo** comprobante con tercero como algo que
-- ese tercero debe. Una nota de crédito de mil pesos aparecía como mil pesos
-- más de deuda del cliente, cuando es exactamente lo contrario: es plata que la
-- empresa ya no le va a cobrar.
--
-- El efecto no quedaba ahí. `party_aging` —la lista con la que se sale a
-- cobrar— sumaba esas notas al saldo, y el aviso de mora de la bandeja podía
-- reclamarle a un cliente una nota de crédito vencida.
--
-- ## El signo no se inventa: sale del catálogo
--
-- `arca_comprobante_types` ya clasifica cada tipo en FACTURA, NOTA_DEBITO,
-- NOTA_CREDITO o RECIBO, y su columna `fuente` cita el manual del organismo del
-- que salió. No hace falta decidir nada: el dato estaba archivado y nadie lo
-- estaba mirando.
--
-- Una nota de **débito** sigue sumando, que es lo que hace: aumenta lo que el
-- cliente debe.
--
-- ## Un tipo desconocido no invierte
--
-- La unión con el catálogo es por izquierda. Si aparece un tipo que no está
-- clasificado, `clase` viene en nulo y el comprobante suma, como venía
-- sumando. Es el default conservador: invertir por las dudas convertiría un
-- crédito en una deuda del otro lado.
--
-- ## Y la antigüedad de saldos deja de filtrar los créditos
--
-- `party_aging` traía `WHERE pendiente > 0`. Con el signo corregido, esa
-- condición dejaría las notas de crédito afuera y el saldo del cliente
-- seguiría estando de más — el mismo error, por otro camino. Pasa a `<> 0`.
-- ============================================================================

-- `clase` va **al final**: `CREATE OR REPLACE VIEW` no admite insertar columnas
-- en el medio, y de esta vista dependen cuatro más.
CREATE OR REPLACE VIEW invoice_settlement WITH (security_invoker = true) AS
SELECT t.company_id,
       t.id                                        AS tax_transaction_id,
       t.party_id,
       p.razon_social,
       t.direction,
       t.cbte_tipo,
       t.punto_venta,
       t.cbte_numero,
       t.cbte_fecha,
       -- El signo del catálogo. Una nota de crédito es plata que no se va a
       -- cobrar, y por eso su total es negativo en la cuenta corriente.
       -- El casteo de vuelta a `numeric(18,2)` no es cosmético: `CREATE OR
       -- REPLACE VIEW` no admite cambiar el tipo de una columna existente, y
       -- `-t.total` lo ensancha a `numeric` sin precisión. Lo dijo la base al
       -- aplicar esta migración por primera vez.
       (CASE WHEN ct.clase = 'NOTA_CREDITO' THEN -t.total ELSE t.total END)::numeric(18, 2)
                                                   AS total,
       coalesce(a.imputado, 0)                      AS imputado,
       -- `pendiente`, en cambio, **no** se castea: en la vista original ya era
       -- `numeric` sin precisión —una resta la ensancha igual— y fijarla ahora
       -- sería el mismo cambio de tipo, en la otra dirección.
       (CASE WHEN ct.clase = 'NOTA_CREDITO' THEN -t.total ELSE t.total END)
         - coalesce(a.imputado, 0)                  AS pendiente,
       plan.cuotas IS NOT NULL OR p.dias_de_pago IS NOT NULL
                                                   AS vencimiento_declarado,
       coalesce(plan.proximo_vencimiento,
                CASE WHEN p.dias_de_pago IS NOT NULL
                     THEN t.cbte_fecha + p.dias_de_pago END)
                                                   AS vencimiento,
       CASE
         WHEN plan.cuotas IS NOT NULL THEN plan.mora_maxima
         WHEN p.dias_de_pago IS NOT NULL
           THEN greatest(0, current_date - (t.cbte_fecha + p.dias_de_pago))
       END                                         AS dias_de_mora,
       current_date - t.cbte_fecha                 AS antiguedad_dias,
       plan.cuotas IS NOT NULL                     AS plan_declarado,
       plan.cuotas,
       -- Agregado por la 0080, al final por lo dicho arriba.
       ct.clase
  FROM tax_transactions t
  JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
  -- Por izquierda a propósito: un tipo sin clasificar no invierte nada.
  LEFT JOIN arca_comprobante_types ct ON ct.codigo = t.cbte_tipo
  LEFT JOIN LATERAL (
        SELECT sum(x.importe) AS imputado
          FROM party_allocations x
         WHERE x.tax_transaction_id = t.id AND x.company_id = t.company_id
           AND x.status = 'ACTIVA'
       ) a ON true
  LEFT JOIN LATERAL (
        SELECT nullif(count(*), 0)::int AS cuotas,
               min(s.vencimiento) FILTER (WHERE s.pendiente > 0) AS proximo_vencimiento,
               coalesce(max(s.dias_de_mora) FILTER (WHERE s.pendiente > 0), 0) AS mora_maxima
          FROM installment_settlement s
         WHERE s.tax_transaction_id = t.id AND s.company_id = t.company_id
       ) plan ON true
 WHERE t.party_id IS NOT NULL;

COMMENT ON VIEW invoice_settlement IS
  'La composición de cada comprobante con tercero: total, imputado y pendiente. '
  'Una nota de crédito viene en negativo — es plata que no se va a cobrar— y el '
  'signo sale de la clase archivada en el catálogo de ARCA, no de una decisión '
  'de este esquema.';

-- ---------------------------------------------------------------------------
-- La antigüedad de saldos, con los créditos adentro
-- ---------------------------------------------------------------------------
-- Idéntica a la original salvo el `WHERE`. El orden de las columnas se
-- conserva exactamente —`CREATE OR REPLACE VIEW` no admite reordenarlas ni
-- quitarlas, y el primer intento las reordenó y perdió `mas_antiguo`—.
CREATE OR REPLACE VIEW party_aging WITH (security_invoker = true) AS
SELECT company_id,
       party_id,
       razon_social,
       direction,
       sum(pendiente)                                         AS pendiente,
       sum(pendiente) FILTER (WHERE antiguedad_dias <= 30)     AS hasta_30,
       sum(pendiente) FILTER (WHERE antiguedad_dias >= 31 AND antiguedad_dias <= 60)
                                                              AS de_31_a_60,
       sum(pendiente) FILTER (WHERE antiguedad_dias >= 61 AND antiguedad_dias <= 90)
                                                              AS de_61_a_90,
       sum(pendiente) FILTER (WHERE antiguedad_dias > 90)      AS mas_de_90,
       coalesce(sum(pendiente) FILTER (WHERE dias_de_mora > 0), 0::numeric) AS vencido,
       count(*)::int                                          AS comprobantes,
       max(antiguedad_dias)                                   AS mas_antiguo
  FROM invoice_settlement s
 -- `<> 0` y no `> 0`: con el signo corregido, filtrar por positivo dejaría las
 -- notas de crédito afuera y el saldo del cliente seguiría estando de más.
 WHERE pendiente <> 0
 GROUP BY company_id, party_id, razon_social, direction;

COMMENT ON VIEW party_aging IS
  'El saldo de cada tercero por tramo de antigüedad, con las notas de crédito '
  'restando. Un saldo negativo es un cliente que tiene crédito a favor, y se '
  'informa como tal en vez de esconderse.';
