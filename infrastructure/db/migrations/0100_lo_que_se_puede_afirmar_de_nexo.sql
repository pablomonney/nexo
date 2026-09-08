-- ============================================================================
-- 0100 — Lo que se puede afirmar de NEXO
-- ============================================================================
--
-- Las métricas SaaS —MRR, ARR, ARPU, altas, bajas— no son de ninguna empresa
-- cliente: son **del negocio de NEXO**, y se calculan atravesando a todas. Eso
-- las pone en el lugar más delicado del esquema, así que conviene decir dónde
-- están paradas antes de leerlas.
--
-- ## Estas vistas NO llevan `security_invoker`, y es al revés de todo lo demás
--
-- Cada vista de este repositorio lleva `security_invoker = true` para que el RLS
-- de las tablas de abajo se aplique con los privilegios de quien consulta. Estas
-- cinco **no**, porque su propósito es exactamente el contrario: agregar sobre
-- todas las empresas.
--
-- Lo que las hace seguras no es el `security_invoker` que no tienen, es que
-- **`aai_app` no las puede leer**. Se revoca explícitamente al final —no alcanza
-- con no conceder, porque la 0009 concede sobre todo objeto nuevo— y
-- `tests/security/metricas-del-operador.test.ts` lo comprueba contra el
-- catálogo. Si alguna vez `aai_app` pudiera leerlas, cualquier usuario de
-- cualquier empresa vería la facturación de todas.
--
-- ## Cero no es «no se puede afirmar», y acá se nota más que en ningún lado
--
-- Hoy **no hay precios declarados** y casi ninguna suscripción tiene importe
-- acordado. Un MRR que devolviera `0` se leería como «NEXO no factura nada»,
-- que es distinto de «nadie declaró cuánto cobra». Por eso cada vista informa,
-- al lado del número, **cuántas suscripciones quedaron afuera del cálculo y por
-- qué**. Un total sin ese acompañamiento es un número que no se puede auditar.
--
-- ## Lo que no está acá, y no por olvido
--
-- **CAC y LTV no se calculan.** CAC necesita el gasto de adquisición —marketing,
-- ventas, comisiones— y LTV necesita el margen bruto por cliente. Ninguno de los
-- dos existe en este esquema: NEXO no lleva su propia contabilidad todavía. Una
-- vista que los devolviera con los datos que hay estaría inventando el
-- numerador, y un CAC inventado se ve exactamente igual que uno medido.
--
-- La forma de tenerlos no es una vista: es que NEXO sea una empresa más dentro
-- de NEXO, con su plan de cuentas y sus gastos imputados. Ver NEXO_CORPORATE.md.
--
-- ## De dónde sale la fecha de una baja
--
-- De `audit_logs`, no de una columna nueva. `company_subscriptions` guarda el
-- estado actual; **cuándo** pasó a estarlo lo sabe la bitácora, que registra
-- cada cambio con su `occurred_at`, su actor y su motivo. Agregar un
-- `cancelada_el` sería un segundo registro del mismo hecho, capaz de
-- contradecir al primero (ADR-022).
--
-- Y distingue dos cosas que suelen mezclarse: la baja que pide el cliente
-- —`CAMBIAR_ESTADO_DE_PLAN` a `CANCELADA`— y la suspensión por falta de pago,
-- que es `SUSPENDER_POR_FALTA_DE_PAGO`. La primera es una decisión comercial;
-- la segunda, una consecuencia de cobranza. Sumarlas en un solo «churn» hace
-- que arreglar el cobro se vea como retener clientes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Las suscripciones que están corriendo, con su importe normalizado a mes
-- ---------------------------------------------------------------------------

CREATE VIEW saas_suscripciones_vigentes AS
SELECT
  s.id                AS subscription_id,
  s.company_id,
  c.legal_name        AS empresa,
  p.code              AS plan,
  s.estado,
  s.periodicidad,
  s.moneda,
  s.importe_acordado,
  -- Normalizado a mes. Un plan anual aporta la doceava parte: es la definición
  -- estándar de MRR y la única que hace comparables las dos periodicidades.
  --
  -- **No se redondea acá.** Redondear cada fila y después sumar deja unos
  -- centavos de diferencia contra redondear el total, y el que se mira es el
  -- total. Se redondea una sola vez, arriba.
  CASE
    WHEN s.importe_acordado IS NULL THEN NULL
    WHEN s.periodicidad = 'ANUAL'   THEN s.importe_acordado / 12
    ELSE s.importe_acordado
  END                 AS mensualizado,
  s.vigencia_desde,
  s.vigencia_hasta
FROM company_subscriptions s
JOIN companies c ON c.id = s.company_id
LEFT JOIN subscription_plans p ON p.id = s.plan_id
WHERE s.estado IN ('ACTIVA', 'PRUEBA', 'SUSPENDIDA')
  AND (s.vigencia_hasta IS NULL OR s.vigencia_hasta >= CURRENT_DATE);

COMMENT ON VIEW saas_suscripciones_vigentes IS
  'Suscripciones corriendo hoy, con el importe normalizado a mes. SIN '
  'security_invoker a propósito: agrega sobre todas las empresas y por eso '
  'aai_app no la puede leer (0100).';

-- ---------------------------------------------------------------------------
-- MRR y ARR, por moneda, con lo que quedó afuera
-- ---------------------------------------------------------------------------

CREATE VIEW saas_ingreso_recurrente AS
SELECT
  v.moneda,
  -- Se redondea una sola vez, al final.
  round(sum(v.mensualizado), 2)          AS mrr,
  round(sum(v.mensualizado) * 12, 2)     AS arr,
  count(*) FILTER (WHERE v.estado = 'ACTIVA')     AS suscripciones_activas,
  count(*) FILTER (WHERE v.estado = 'PRUEBA')     AS en_prueba,
  count(*) FILTER (WHERE v.estado = 'SUSPENDIDA') AS suspendidas,
  -- ARPU. `NULL` si no hay ninguna con importe: dividir por cero no da cero,
  -- y devolver cero diría que el cliente promedio no paga nada.
  CASE
    WHEN count(*) = 0 THEN NULL
    ELSE round(sum(v.mensualizado) / count(*), 2)
  END                                     AS arpu
FROM saas_suscripciones_vigentes v
WHERE v.mensualizado IS NOT NULL
GROUP BY v.moneda;

COMMENT ON VIEW saas_ingreso_recurrente IS
  'MRR, ARR y ARPU por moneda. NUNCA suma monedas distintas: un total mixto no '
  'significa nada y se ve igual que uno que sí. Lo que quedó afuera está en '
  'saas_sin_importe, y hay que mirarlo al lado.';

-- ---------------------------------------------------------------------------
-- Lo que quedó afuera del MRR
-- ---------------------------------------------------------------------------

CREATE VIEW saas_sin_importe AS
SELECT
  v.subscription_id,
  v.company_id,
  v.empresa,
  v.plan,
  v.estado,
  v.vigencia_desde
FROM saas_suscripciones_vigentes v
WHERE v.mensualizado IS NULL;

COMMENT ON VIEW saas_sin_importe IS
  'Suscripciones vigentes SIN importe acordado. No entran en el MRR y no son '
  'cero: son las que nadie terminó de acordar. Un MRR sin esta lista al lado '
  'es un número que no se puede auditar.';

-- ---------------------------------------------------------------------------
-- Altas y bajas, del registro que ya las tiene
-- ---------------------------------------------------------------------------

CREATE VIEW saas_movimientos AS
SELECT
  date_trunc('month', l.occurred_at)::date AS mes,
  l.company_id,
  CASE
    WHEN l.action = 'SUSPENDER_POR_FALTA_DE_PAGO'        THEN 'SUSPENSION_POR_PAGO'
    WHEN l.action = 'REACTIVAR_POR_PAGO'                 THEN 'REACTIVACION_POR_PAGO'
    WHEN l.new_value->>'estado' = 'CANCELADA'            THEN 'BAJA_VOLUNTARIA'
    WHEN l.new_value->>'estado' = 'SUSPENDIDA'           THEN 'SUSPENSION_DECLARADA'
    WHEN l.new_value->>'estado' = 'ACTIVA'               THEN 'REACTIVACION_DECLARADA'
    ELSE 'OTRO'
  END                                      AS tipo,
  l.occurred_at,
  l.motivo,
  l.actor_id
FROM audit_logs l
WHERE l.action IN ('CAMBIAR_ESTADO_DE_PLAN', 'SUSPENDER_POR_FALTA_DE_PAGO',
                   'REACTIVAR_POR_PAGO');

COMMENT ON VIEW saas_movimientos IS
  'Altas, bajas y suspensiones tomadas de la bitácora, que es donde está la '
  'fecha. Distingue la baja que pide el cliente de la suspensión por falta de '
  'pago: sumarlas hace que arreglar el cobro se vea como retener clientes.';

-- ---------------------------------------------------------------------------
-- Lo cobrado, por mes
-- ---------------------------------------------------------------------------

CREATE VIEW saas_cobranza_mensual AS
SELECT
  date_trunc('month', d.emitido_el)::date AS mes,
  d.moneda,
  count(*)                                                     AS documentos,
  sum(d.importe_total)                                         AS emitido,
  sum(d.importe_total) FILTER (WHERE d.estado = 'PAGADO')      AS cobrado,
  sum(d.importe_total) FILTER (WHERE d.estado = 'EMITIDO')     AS pendiente,
  sum(d.importe_total) FILTER (WHERE d.estado = 'INCOBRABLE')  AS incobrable,
  sum(d.importe_total) FILTER (WHERE d.estado = 'ANULADO')     AS anulado
FROM billing_documents d
WHERE d.emitido_el IS NOT NULL AND d.tipo = 'CARGO'
GROUP BY 1, 2;

COMMENT ON VIEW saas_cobranza_mensual IS
  'Emitido y cobrado por mes y moneda. Lo anulado se informa aparte y no se '
  'resta de lo emitido: anular dice que no debió emitirse, y esconderlo dentro '
  'del neto borra que se emitió.';

-- ---------------------------------------------------------------------------
-- Privilegios
-- ---------------------------------------------------------------------------
--
-- **Lo más importante de esta migración.** La 0009 concede `SELECT, INSERT,
-- UPDATE` sobre todo objeto nuevo del esquema, así que estas cinco vistas nacen
-- legibles por la aplicación. Sin este `REVOKE`, cualquier usuario de cualquier
-- empresa podría ver la facturación de todas — y sin `security_invoker` para
-- filtrarlo, porque justamente no lo tienen.
--
-- Es el mismo hallazgo de la 0097 aplicado antes de que ocurra, por una vez.

REVOKE ALL ON saas_suscripciones_vigentes FROM aai_app;
REVOKE ALL ON saas_ingreso_recurrente FROM aai_app;
REVOKE ALL ON saas_sin_importe FROM aai_app;
REVOKE ALL ON saas_movimientos FROM aai_app;
REVOKE ALL ON saas_cobranza_mensual FROM aai_app;
