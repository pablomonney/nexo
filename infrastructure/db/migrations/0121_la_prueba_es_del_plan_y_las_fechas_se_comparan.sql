-- ---------------------------------------------------------------------------
-- La prueba es del plan, y las fechas se comparan
-- ---------------------------------------------------------------------------
--
-- Dos cosas que salen de una decisión tomada el 2026-09-15: **los catorce días
-- de prueba viven en NEXO y no en Mercado Pago**.
--
-- ## Por qué la prueba no se duplica del otro lado
--
-- Mercado Pago acepta `free_trial` dentro de `auto_recurring`. Ponerlo ahí
-- parece gratis y no lo es: en NEXO la prueba **es la suscripción**
-- (`estado = 'PRUEBA'`), empieza sin pedir tarjeta y termina cuando el cliente
-- convierte. Recién ahí se conecta la pasarela. Si el plan del proveedor
-- también tuviera prueba, el reloj arrancaría **de nuevo** al autorizar: dos
-- semanas más de gracia mientras el ciclo de NEXO ya emite el cargo. Serían
-- catorce días de servicio facturado que nadie paga, por cliente y por plan.
--
-- El adaptador sabe mandar `free_trial` y el comando que crea los planes no lo
-- usa. Está escrito en `PlanParaProveedor` y comprobado en los tests.
--
-- ## 1 · Cuántos días dura la prueba, por plan
--
-- Hasta acá la duración era una constante de TypeScript —`DIAS_DE_PRUEBA = 14`—
-- y eso alcanzaba mientras hubo un solo número para todos. Deja de alcanzar en
-- cuanto alguien quiera dar treinta días en el plan Completo y siete en el
-- Contable: sería una decisión comercial escrita en el código, que se despliega
-- para cambiarla.
--
-- `NULL` significa **«este plan no declaró nada, vale el valor por defecto del
-- producto»**, y no «cero días». Es la misma distinción que la tabla de topes
-- hace desde la 0073, y por el mismo motivo: un cero inventado se ve igual que
-- un cero decidido, y este en particular le sacaría la prueba a todo el mundo.
--
-- El valor por defecto sigue siendo 14 y sigue viviendo en el código, que es
-- donde corresponde: es el comportamiento del producto cuando nadie declaró
-- nada, no una política por empresa.
--
-- ## 2 · La fecha que NEXO factura contra la fecha que la pasarela cobra
--
-- Este es el hueco que la decisión A deja abierto, y conviene decirlo con todas
-- las letras porque es el precio de haberla elegido.
--
-- El ciclo de NEXO avanza `proxima_facturacion` con su propio calendario,
-- contado desde la conversión. Mercado Pago debita con el suyo, contado desde el
-- día en que el cliente autorizó el medio de pago. **No tienen por qué
-- coincidir**, y cuando se separan no falla nada: los dos sistemas siguen
-- funcionando bien, cada uno por su lado, y la diferencia solo se descubre
-- comparando dos números a mano.
--
-- Es exactamente la misma forma del defecto que la 0118 hizo visible para los
-- importes, y se resuelve igual: se guarda lo que el proveedor informa y se
-- compara. `proxima_facturacion_pasarela` guarda `next_payment_date` tal como
-- viene, y `work_queue_calendario` pone la divergencia en la bandeja.
--
-- `bloquea = false`: cobrar un día distinto no impide operar. Lo que hace es no
-- desaparecer hasta que alguien lo mire.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · Los días de prueba, por plan
-- ---------------------------------------------------------------------------

ALTER TABLE subscription_plans
  ADD COLUMN dias_de_prueba integer
    CHECK (dias_de_prueba IS NULL OR dias_de_prueba > 0);

COMMENT ON COLUMN subscription_plans.dias_de_prueba IS
  'Cuántos días dura la prueba de este plan. NULL es «nadie lo declaró, vale el '
  'valor por defecto del producto», NO «cero días»: un cero acá le sacaría la '
  'prueba a todo el que contrate este plan.';

-- No se siembra ningún valor. Los cinco planes quedan en NULL y siguen dando
-- los catorce días por defecto: declarar otra duración es una decisión
-- comercial y esta migración no la toma.

-- ---------------------------------------------------------------------------
-- 2 · Cuándo dice la pasarela que va a cobrar
-- ---------------------------------------------------------------------------

ALTER TABLE company_subscriptions
  ADD COLUMN proxima_facturacion_pasarela date;

COMMENT ON COLUMN company_subscriptions.proxima_facturacion_pasarela IS
  'El next_payment_date que informó el proveedor, en su huso. NULL es «no lo '
  'informó», no «no hay próximo cobro». Se guarda para poder preguntar si la '
  'fecha en que NEXO factura es la misma en que la pasarela debita.';

-- ---------------------------------------------------------------------------
-- 3 · La divergencia de calendario, a la vista
-- ---------------------------------------------------------------------------

CREATE VIEW work_queue_calendario WITH (security_invoker = true) AS
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
   AND s.estado IN ('ACTIVA', 'SUSPENDIDA')
   AND s.proxima_facturacion IS NOT NULL
   AND s.proxima_facturacion_pasarela IS NOT NULL
   AND s.proxima_facturacion <> s.proxima_facturacion_pasarela
) q;

GRANT SELECT ON work_queue_calendario TO aai_app;

COMMENT ON VIEW work_queue_calendario IS
  'Suscripciones donde la fecha que factura NEXO y la que cobra la pasarela se '
  'separaron. Ninguna de las dos está mal por sí sola: el ciclo cuenta desde la '
  'conversión y el proveedor desde la autorización. Lo que no puede pasar es '
  'que nadie lo note.';

-- La bandeja completa. Se reescribe entera porque una vista no se puede
-- extender: `CREATE OR REPLACE` exige repetir la lista, y omitir una rama la
-- haría desaparecer de la bandeja sin que nada falle.
--
-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la bandeja de una empresa aparecería en la de otra.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios
UNION ALL SELECT * FROM work_queue_cheques
UNION ALL SELECT * FROM work_queue_lotes
UNION ALL SELECT * FROM work_queue_caja
UNION ALL SELECT * FROM work_queue_crm
UNION ALL SELECT * FROM work_queue_proyectos
UNION ALL SELECT * FROM work_queue_comisiones
UNION ALL SELECT * FROM work_queue_sucursales
UNION ALL SELECT * FROM work_queue_suscripcion
UNION ALL SELECT * FROM work_queue_mapeo
UNION ALL SELECT * FROM work_queue_arranque
UNION ALL SELECT * FROM work_queue_valuacion
UNION ALL SELECT * FROM work_queue_pagos
UNION ALL SELECT * FROM work_queue_correcciones
UNION ALL SELECT * FROM work_queue_solicitudes
UNION ALL SELECT * FROM work_queue_arca
UNION ALL SELECT * FROM work_queue_emision
UNION ALL SELECT * FROM work_queue_pasarela
UNION ALL SELECT * FROM work_queue_cargos
UNION ALL SELECT * FROM work_queue_calendario;
