-- ---------------------------------------------------------------------------
-- Deber no es lo mismo que estar cortado
-- ---------------------------------------------------------------------------
--
-- Hasta acá una suscripción con deuda saltaba de `ACTIVA` a `SUSPENDIDA` sin
-- escala: o el cliente tenía todo, o no tenía nada. Entre las dos cosas falta
-- el caso más común de la vida real —debe, y lo va a pagar— y el sistema no
-- tenía forma de decirlo.
--
-- `MOROSA` es ese estado: **existe deuda vencida reconocida, el servicio sigue
-- funcionando, y el acceso está degradado.**
--
-- ## Por qué es un estado y no una columna aparte
--
-- La tentación es guardar un `access_state` al lado de `estado`. Serían dos
-- registros del mismo hecho, y el día que difieran no habría forma de saber
-- cuál manda: el mismo error que la 0106 evita en la prueba de catorce días,
-- que **es** la suscripción y no una tabla de pruebas aparte.
--
-- El acceso se deriva del estado. No se guarda.
--
-- ## Qué la distingue de SUSPENDIDA
--
--     MOROSA       se presta el servicio, degradado. Lo decide el calendario.
--     SUSPENDIDA   se corta. Lo decide el calendario, una persona, o la pasarela.
--
-- Las dos son reversibles y las dos conservan **todo**: los datos, la
-- contabilidad y el historial. Ningún paso de cobranza borra nada, y eso no
-- cambia.
--
-- ## Lo que MOROSA no hace
--
-- **No deja de facturar.** La deuda corre igual: dejar de emitir mientras
-- alguien debe dejaría un hueco de servicio que ningún documento explica. Por
-- eso todo lo que miraba `('ACTIVA', 'SUSPENDIDA')` pasa a mirar las tres.
--
-- **No es terminal, y no vuelve a PRUEBA.** De `CANCELADA` no se vuelve; de
-- `MOROSA` sí, y por el camino normal: pagando.
--
-- ## Por qué exige motivo
--
-- `cs_baja_con_motivo` ya lo pedía para `SUSPENDIDA` y `CANCELADA`. Acá aprieta
-- igual: el cliente va a ver funciones que antes tenía y ahora no. Sin motivo,
-- la pantalla dice que algo cambió y no por qué, que es la peor versión de
-- avisar.
--
-- ## Por qué esta migración es larga
--
-- Agregar un valor a un `CHECK` es una línea. Lo caro —y lo que ocupa de la
-- sección 5 en adelante— es que **seis vistas ya escritas enumeran los estados
-- por nombre**, y un estado nuevo que ninguna nombra no rompe nada: desaparece.
-- Una suscripción en mora quedaría fuera del MRR, fuera de la bandeja del
-- operador y fuera de las dos vistas que comparan NEXO contra la pasarela, y
-- las seis seguirían contestando. Ese es exactamente el modo de falla que un
-- estado nuevo introduce, así que se corrige en la misma migración que lo crea.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · El estado
-- ---------------------------------------------------------------------------

ALTER TABLE company_subscriptions DROP CONSTRAINT company_subscriptions_estado_check;
ALTER TABLE company_subscriptions ADD CONSTRAINT company_subscriptions_estado_check
  CHECK (estado IN ('PRUEBA', 'ACTIVA', 'MOROSA', 'SUSPENDIDA', 'CANCELADA'));

-- Qué transición vale lo sigue diciendo `puedeTransicionar` en el motor: un
-- `CHECK` puede decir qué valores son válidos y no **en qué momento** lo son.
-- Las dos cosas hacen falta.

-- ---------------------------------------------------------------------------
-- 2 · Desde cuándo debe
-- ---------------------------------------------------------------------------

ALTER TABLE company_subscriptions ADD COLUMN morosa_desde date;

ALTER TABLE company_subscriptions ADD CONSTRAINT cs_morosa_con_fecha
  CHECK (estado <> 'MOROSA' OR morosa_desde IS NOT NULL);

COMMENT ON COLUMN company_subscriptions.morosa_desde IS
  'Desde qué día esta suscripción está en mora. Análogo a suspendida_el. Sin '
  'fecha no se puede contar cuánto lleva debiendo, que es lo que después '
  'decide si corresponde suspender.';

-- ---------------------------------------------------------------------------
-- 3 · El motivo, también para MOROSA
-- ---------------------------------------------------------------------------

ALTER TABLE company_subscriptions DROP CONSTRAINT cs_baja_con_motivo;
ALTER TABLE company_subscriptions ADD CONSTRAINT cs_baja_con_motivo
  CHECK (estado NOT IN ('MOROSA', 'SUSPENDIDA', 'CANCELADA')
         OR (motivo IS NOT NULL AND length(btrim(motivo)) > 2));

COMMENT ON CONSTRAINT cs_baja_con_motivo ON company_subscriptions IS
  'Degradar o cortar el acceso exige decir por qué. El cliente va a ver el '
  'cambio; sin motivo, la pantalla le dice que algo pasó y no qué.';

-- ---------------------------------------------------------------------------
-- 4 · La acción de bitácora
-- ---------------------------------------------------------------------------
--
-- `audit_actions` es un catálogo cerrado desde la 0091: una acción no declarada
-- levanta `E_AUDIT_ACTION_DESCONOCIDA` y hace fallar la transacción entera. Sin
-- esta fila, el primer paso de mora tiraría abajo la corrida del ciclo.
--
-- `requiere_motivo = true` por lo mismo que `SUSPENDER_POR_FALTA_DE_PAGO`:
-- dentro de seis meses, «esta empresa estuvo en mora» sin el documento que la
-- puso ahí es una afirmación que nadie puede comprobar.
--
-- `ACTIONS_REQUIRING_REASON`, en `packages/db/src/audit.ts`, es el espejo de
-- esta columna del lado del código, y S-20 comprueba que digan lo mismo.

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('MARCAR_EN_MORA', 'facturacion', true);

-- ---------------------------------------------------------------------------
-- 5 · Las métricas, que enumeran estados por nombre
-- ---------------------------------------------------------------------------
--
-- `saas_suscripciones_vigentes` alimenta el MRR, el ARR y el ARPU. Su `WHERE`
-- lista los estados uno por uno, así que una suscripción en mora —que **sigue
-- pagando el mismo importe y sigue recibiendo servicio**— desaparecería del
-- ingreso recurrente. El MRR bajaría el día que alguien entra en mora y
-- volvería a subir el día que paga, como si hubiera dado de baja y vuelto a
-- contratar. Es la clase de error que nadie encuentra, porque el número que
-- sale es plausible.

CREATE OR REPLACE VIEW saas_suscripciones_vigentes AS
SELECT
  s.id                AS subscription_id,
  s.company_id,
  c.legal_name        AS empresa,
  p.code              AS plan,
  s.estado,
  s.periodicidad,
  s.moneda,
  s.importe_acordado,
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
WHERE s.estado IN ('ACTIVA', 'PRUEBA', 'MOROSA', 'SUSPENDIDA')
  AND (s.vigencia_hasta IS NULL OR s.vigencia_hasta >= CURRENT_DATE);

COMMENT ON VIEW saas_suscripciones_vigentes IS
  'Suscripciones corriendo hoy, con el importe normalizado a mes. Incluye las '
  'MOROSAS: deben, y siguen recibiendo servicio por el mismo importe. Sacarlas '
  'haría que el MRR cayera al entrar en mora y subiera al pagar, como una baja '
  'y un alta que nunca ocurrieron. SIN security_invoker a propósito: agrega '
  'sobre todas las empresas y por eso aai_app no la puede leer (0100).';

-- `morosas` se agrega **al final**, que es la única posición que
-- `CREATE OR REPLACE VIEW` admite para una columna nueva. Se cuenta aparte de
-- `suspendidas` porque son dos hechos comerciales distintos: una mora todavía
-- se cobra sola, una suspensión ya no.
CREATE OR REPLACE VIEW saas_ingreso_recurrente AS
SELECT
  v.moneda,
  round(sum(v.mensualizado), 2)          AS mrr,
  round(sum(v.mensualizado) * 12, 2)     AS arr,
  count(*) FILTER (WHERE v.estado = 'ACTIVA')     AS suscripciones_activas,
  count(*) FILTER (WHERE v.estado = 'PRUEBA')     AS en_prueba,
  count(*) FILTER (WHERE v.estado = 'SUSPENDIDA') AS suspendidas,
  CASE
    WHEN count(*) = 0 THEN NULL
    ELSE round(sum(v.mensualizado) / count(*), 2)
  END                                     AS arpu,
  count(*) FILTER (WHERE v.estado = 'MOROSA')     AS morosas
FROM saas_suscripciones_vigentes v
WHERE v.mensualizado IS NOT NULL
GROUP BY v.moneda;

COMMENT ON VIEW saas_ingreso_recurrente IS
  'MRR, ARR y ARPU por moneda. NUNCA suma monedas distintas: un total mixto no '
  'significa nada y se ve igual que uno que sí. Las morosas se cuentan aparte '
  'de las suspendidas: la mora todavía se cobra sola y la suspensión no. Lo '
  'que quedó afuera está en saas_sin_importe, y hay que mirarlo al lado.';

-- Los movimientos salen de la bitácora, que es donde está la fecha. Sin la
-- rama de `MARCAR_EN_MORA`, entrar en mora no sería ningún movimiento: el
-- historial saltaría de «activa» a «suspendida» sin el paso del medio, que es
-- justamente el que explica por qué se suspendió.
CREATE OR REPLACE VIEW saas_movimientos AS
SELECT
  date_trunc('month', l.occurred_at)::date AS mes,
  l.company_id,
  CASE
    WHEN l.action = 'MARCAR_EN_MORA'                     THEN 'MORA_POR_PAGO'
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
                   'REACTIVAR_POR_PAGO', 'MARCAR_EN_MORA');

COMMENT ON VIEW saas_movimientos IS
  'Altas, bajas, moras y suspensiones tomadas de la bitácora, que es donde '
  'está la fecha. Distingue la baja que pide el cliente de la suspensión por '
  'falta de pago: sumarlas hace que arreglar el cobro se vea como retener '
  'clientes. La mora es su propio movimiento: sin ella, el historial salta de '
  'activa a suspendida sin el paso que lo explica.';

-- ---------------------------------------------------------------------------
-- 6 · Las dos vistas que comparan NEXO contra la pasarela
-- ---------------------------------------------------------------------------
--
-- Las dos preguntan «¿lo que dice NEXO coincide con lo que hace el proveedor?»,
-- y las dos enumeran los estados en los que la pregunta tiene sentido. Una
-- suscripción en mora **sigue conectada y sigue siendo debitada**: es
-- precisamente donde una divergencia de importe o de fecha hace más daño,
-- porque el cobro que podría sacarla de la mora es el que está saliendo mal.
--
-- Se reemiten enteras: `CREATE OR REPLACE VIEW` no deja parchear un `WHERE`.

CREATE OR REPLACE VIEW work_queue_pasarela WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id, q.*
  FROM (
SELECT s.company_id,
       'PASARELA_IMPORTE_DIVERGENTE'::text          AS rama,
       'REQUIERE_DECISION'::text                    AS categoria,
       'company_subscriptions'::text                AS entidad,
       s.id                                         AS entity_id,
       s.estado                                     AS estado,
       'La suscripción está conectada a ' || m.proveedor || ' con un plan que cobra ' ||
         m.importe_declarado || ' ' || m.moneda || ', y el importe acordado en NEXO es ' ||
         s.importe_acordado || ' ' || s.moneda ||
         '. Hay que corregir el precio o recrear el plan del lado del proveedor'
                                                    AS motivo,
       false                                        AS bloquea,
       ARRAY[]::text[]                              AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       s.created_at                                 AS creado_en,
       s.created_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/subscriptions/' || s.id                    AS traza_ref
  FROM company_subscriptions s
  JOIN payment_plan_map m
    ON m.plan_id      = s.plan_id
   AND m.proveedor    = s.proveedor_pago
   AND m.ambiente     = s.ambiente_pago
   AND m.periodicidad = s.periodicidad
   AND m.moneda       = s.moneda
 WHERE s.referencia_externa IS NOT NULL
   AND s.estado IN ('ACTIVA', 'MOROSA', 'SUSPENDIDA')
   AND s.importe_acordado IS NOT NULL
   AND m.importe_declarado <> s.importe_acordado
) q;

CREATE OR REPLACE VIEW work_queue_calendario WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id, q.*
  FROM (
SELECT s.company_id,
       'PASARELA_FECHA_DIVERGENTE'::text             AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.id                                          AS entity_id,
       s.estado                                      AS estado,
       'NEXO factura el ' || s.proxima_facturacion ||
         ' y ' || s.proveedor_pago || ' informa que debita el ' ||
         s.proxima_facturacion_pasarela ||
         '. Son ' || abs(s.proxima_facturacion - s.proxima_facturacion_pasarela) ||
         ' día(s) de diferencia: el cargo y el débito no caen en el mismo período'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY[]::text[]                               AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       least(s.proxima_facturacion, s.proxima_facturacion_pasarela) AS fecha_limite,
       '/subscriptions/' || s.id                     AS traza_ref
  FROM company_subscriptions s
 WHERE s.referencia_externa IS NOT NULL
   AND s.estado IN ('ACTIVA', 'MOROSA', 'SUSPENDIDA')
   AND s.proxima_facturacion IS NOT NULL
   AND s.proxima_facturacion_pasarela IS NOT NULL
   AND s.proxima_facturacion <> s.proxima_facturacion_pasarela
) q;

-- ---------------------------------------------------------------------------
-- 7 · La bandeja del operador
-- ---------------------------------------------------------------------------
--
-- La rama 3 de `work_queue_suscripcion` filtraba `estado = 'SUSPENDIDA'`. Una
-- empresa en mora no aparecería en ninguna bandeja, y la mora es justamente el
-- momento en que **todavía se puede hacer algo**: cuando aparezca la suspensión
-- ya se le cortó el acceso.
--
-- Se agrega como rama propia y no ensanchando el `IN` de la 3, porque el texto
-- del motivo no es el mismo. «Está suspendida» y «debe, y el acceso está
-- degradado» mandan a hacer dos cosas distintas, y una rama que dijera las dos
-- con la misma frase obligaría a abrir la suscripción para saber cuál es.
--
-- `fecha_limite` es la única diferencia estructural: en la rama de suspensión
-- es `vigencia_hasta` —hasta cuándo dura lo contratado— y acá no hay una fecha
-- equivalente, porque cuándo se suspende lo decide la política de cobranza y no
-- la suscripción. Poner `morosa_desde` sería mentir sobre el nombre de la
-- columna: es desde cuándo, no hasta cuándo.

CREATE OR REPLACE VIEW work_queue_suscripcion WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · La empresa no tiene plan vigente. No bloquea nada —a propósito— pero es
--     un hecho que alguien tiene que resolver.
SELECT s.company_id,
       'EMPRESA_SIN_PLAN'::text                      AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.company_id                                  AS entity_id,
       'SIN_PLAN'::text                              AS estado,
       'Esta empresa no tiene un plan vigente. No se le impide operar: los ' ||
         'libros no se dejan incompletos por una cuestión comercial'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['PLAN']::text[]                         AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.subscription_id IS NULL

UNION ALL

-- 2 · Se pasó de un tope **declarado**. Sin topes declarados esta rama no
--     produce nada: el uso se informa y no se lo llama exceso.
SELECT s.company_id,
       'PLAN_EXCEDIDO'::text                         AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.subscription_id                             AS entity_id,
       s.estado                                      AS estado,
       'El uso supera ' || s.topes_excedidos || ' tope(s) declarado(s) del plan ' ||
         s.plan_codigo || '. Se informa: no se bloquea ninguna operación'
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'INFORMATIVO'::text                           AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.topes_excedidos > 0

UNION ALL

-- 3 · La suscripción está suspendida. También informativo: quien resuelve esto
--     no está adentro del sistema contable.
SELECT s.company_id,
       'SUSCRIPCION_SUSPENDIDA'::text                AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text               AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.subscription_id                             AS entity_id,
       s.estado                                      AS estado,
       'La suscripción está suspendida: ' || coalesce(s.motivo, 'sin motivo registrado')
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'INFORMATIVO'::text                           AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       s.vigencia_hasta                              AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.estado = 'SUSPENDIDA'

UNION ALL

-- 4 · La suscripción está en mora: debe, sigue funcionando, y parte del
--     producto dejó de estar disponible. Es la rama accionable de las tres
--     comerciales — todavía se puede cobrar antes de cortar.
SELECT s.company_id,
       'SUSCRIPCION_EN_MORA'::text                   AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text               AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.subscription_id                             AS entity_id,
       s.estado                                      AS estado,
       'La suscripción está en mora y el acceso quedó degradado: ' ||
         coalesce(s.motivo, 'sin motivo registrado') ||
         '. El servicio sigue prestándose y la deuda se sigue facturando'
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.estado = 'MOROSA'

) q;

COMMENT ON VIEW work_queue_suscripcion IS
  'Ramas de suscripción. Ninguna bloquea: registrar un hecho contable no '
  'depende de una cuestión comercial, y los libros incompletos no se arreglan '
  'pagando. La mora y la suspensión son ramas separadas a propósito: mandan a '
  'hacer cosas distintas, y en la primera todavía se puede cobrar.';
