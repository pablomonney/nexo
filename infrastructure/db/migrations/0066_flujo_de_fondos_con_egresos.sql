-- ============================================================================
-- 0066 — El flujo de fondos deja de mirar solo un lado
-- ============================================================================
--
-- La 0065 llamó `analytics_flujo_de_fondos` a algo que era solo **entradas**:
-- cobranzas y cheques. Contestar «¿llego a fin de mes?» con la mitad de la
-- información es peor que no contestar, porque la respuesta se ve completa.
--
-- Entran las dos salidas que hoy están modeladas:
--
--   PAGOS           lo que se le debe a proveedores, por su vencimiento
--   COMPROMETIDO    órdenes de compra aceptadas y todavía sin facturar
--
-- ## Por qué estas dos no se pisan
--
-- Es el mismo razonamiento de la 0065 y da el mismo tipo de respuesta: el
-- solapamiento tiene una condición derivable.
--
-- Una orden de compra facturada **deja de ser un compromiso y pasa a ser una
-- deuda**: su factura ya figura en `invoice_settlement` con dirección COMPRAS.
-- Por eso `COMPROMETIDO` excluye las que están en `FACTURADO` — y el estado no
-- se elige, lo pone el propio circuito al vincular la factura.
--
-- ## El signo
--
-- La vista gana una columna `sentido`. No se guardan importes negativos: un
-- importe negativo en una tabla de plata es una invitación a que alguien lo sume
-- sin mirar. El sentido viaja aparte y quien consolida decide qué hacer con él.
--
-- Se hace con DROP + CREATE porque `CREATE OR REPLACE VIEW` no admite intercalar
-- una columna, y `sentido` tiene que ir adelante para que la vista se lea. Nada
-- depende de esta vista salvo su ruta, así que el costo es cero — no es el caso
-- de `work_queue`, donde tirar y recrear obligaría a copiar cuerpos ajenos.
-- ============================================================================

DROP VIEW analytics_flujo_de_fondos;

CREATE VIEW analytics_flujo_de_fondos WITH (security_invoker = true) AS
WITH partidas AS (
  -- ── ENTRA ─────────────────────────────────────────────────────────────────

  -- a · Lo que deben los clientes, por su vencimiento. Con plan de cuotas la
  --     unidad es la cuota; sin plan, el comprobante entero (0060).
  SELECT s.company_id,
         'ENTRA'::text                           AS sentido,
         'COBRANZAS'::text                       AS fuente,
         s.pendiente                             AS importe,
         s.vencimiento                           AS fecha,
         s.vencimiento_declarado                 AS con_fecha,
         true                                    AS sumable,
         NULL::text                              AS motivo_no_sumable
    FROM invoice_settlement s
   WHERE s.direction = 'VENTAS' AND s.pendiente > 0 AND NOT s.plan_declarado

  UNION ALL

  SELECT i.company_id, 'ENTRA'::text, 'COBRANZAS'::text,
         i.pendiente, i.vencimiento, true, true, NULL::text
    FROM installment_settlement i
   WHERE i.direction = 'VENTAS' AND i.pendiente > 0

  UNION ALL

  -- b · Cheques en cartera, por su fecha de pago declarada. `sumable` sale del
  --     asiento: sin él, el crédito que lo originó sigue entero y sumarlo
  --     contaría la misma plata dos veces (0065).
  SELECT c.company_id, 'ENTRA'::text, 'CHEQUES'::text,
         c.importe, c.fecha_pago, true,
         c.journal_entry_id IS NOT NULL,
         CASE WHEN c.journal_entry_id IS NULL
              THEN 'El cheque no cita ningún asiento: el crédito que lo originó sigue '
                   'figurando pendiente, así que sumarlo contaría la misma plata dos veces.'
         END
    FROM check_status c
   WHERE c.en_cartera

  -- ── SALE ──────────────────────────────────────────────────────────────────

  UNION ALL

  -- c · Lo que se le debe a proveedores. Mismo mecanismo que las cobranzas, del
  --     otro lado: el vencimiento sale del plan del comprobante o del plazo
  --     declarado del tercero, y si no hay ninguno no hay fecha.
  SELECT s.company_id, 'SALE'::text, 'PAGOS'::text,
         s.pendiente, s.vencimiento, s.vencimiento_declarado, true, NULL::text
    FROM invoice_settlement s
   WHERE s.direction = 'COMPRAS' AND s.pendiente > 0 AND NOT s.plan_declarado

  UNION ALL

  SELECT i.company_id, 'SALE'::text, 'PAGOS'::text,
         i.pendiente, i.vencimiento, true, true, NULL::text
    FROM installment_settlement i
   WHERE i.direction = 'COMPRAS' AND i.pendiente > 0

  UNION ALL

  -- d · Órdenes de compra aceptadas y sin facturar. Es plata comprometida: la
  --     empresa se obligó y todavía no hay factura.
  --
  --     No se pisa con PAGOS porque una orden facturada deja de ser un
  --     compromiso y pasa a ser una deuda — y el estado `FACTURADO` no lo elige
  --     nadie: lo pone el circuito al vincular la factura.
  --
  --     `con_fecha` es false: una orden aceptada no dice cuándo se paga. Se
  --     informa el importe y no se lo ubica en ningún tramo, en vez de
  --     inventarle una fecha de vencimiento.
  SELECT d.company_id, 'SALE'::text, 'COMPROMETIDO'::text,
         coalesce(sum(l.neto + l.iva), 0), NULL::date, false, true, NULL::text
    FROM commercial_documents d
    LEFT JOIN commercial_document_lines l
      ON l.document_id = d.id AND l.company_id = d.company_id
   WHERE d.direction = 'COMPRAS'
     AND d.status = 'ACEPTADO'
   GROUP BY d.company_id, d.id
  HAVING coalesce(sum(l.neto + l.iva), 0) > 0
)
SELECT company_id,
       sentido,
       fuente,
       count(*)::int                                                    AS partidas,
       sum(importe) FILTER (WHERE sumable)                              AS total,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha <= current_date)                AS vencido,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha > current_date
                              AND fecha <= current_date + 30)           AS proximos_30,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha > current_date + 30
                              AND fecha <= current_date + 60)           AS de_31_a_60,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha > current_date + 60)            AS mas_de_60,
       coalesce(sum(importe) FILTER (WHERE NOT sumable), 0)             AS no_sumable,
       -- Lo que suma al total pero no se puede ubicar en ningún tramo porque
       -- nadie declaró su fecha. Se informa aparte: un total cuya composición
       -- por tramos no cierra con él necesita explicar la diferencia.
       coalesce(sum(importe) FILTER (WHERE sumable AND NOT con_fecha), 0) AS sin_fecha,
       max(motivo_no_sumable) FILTER (WHERE NOT sumable)                AS motivo_no_sumable
  FROM partidas
 GROUP BY company_id, sentido, fuente;

COMMENT ON VIEW analytics_flujo_de_fondos IS
  'Qué entra, qué sale y cuándo, por fuente. Los importes son siempre positivos '
  'y el signo viaja en `sentido`: un importe negativo en una tabla de plata es '
  'una invitación a que alguien lo sume sin mirar. Lo que no se puede ubicar en '
  'un tramo va en `sin_fecha`, y lo que no suma va en `no_sumable` con su motivo.';

GRANT SELECT ON analytics_flujo_de_fondos TO aai_app;
