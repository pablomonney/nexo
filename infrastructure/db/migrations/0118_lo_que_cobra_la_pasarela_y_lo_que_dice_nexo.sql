-- ---------------------------------------------------------------------------
-- Lo que cobra la pasarela y lo que dice NEXO
-- ---------------------------------------------------------------------------
--
-- El vínculo entre el catálogo de planes de NEXO y los planes que viven del
-- lado de una pasarela de pagos. **No conecta ninguna cuenta**: nace vacía, y
-- mientras esté vacía el sistema sigue exactamente como está —emitiendo, con la
-- cobranza al día y los cobros por transferencia registrados a mano—.
--
-- ## Por qué hace falta una tabla y no una columna
--
-- Un plan de NEXO no tiene *un* plan del otro lado: tiene uno por cada
-- combinación de proveedor, ambiente, periodicidad y moneda. El plan COMPLETO
-- mensual en pesos de la cuenta de prueba y el mismo plan en la cuenta real son
-- dos recursos distintos, con dos identificadores distintos, y confundirlos
-- significa cobrarle a alguien contra la cuenta equivocada.
--
-- El ambiente entra en la clave por el mismo motivo que en la emisión fiscal, y
-- acá aprieta más: Mercado Pago **usa la misma URL para prueba y producción** y
-- los distingue solo por el prefijo del access token. No hay barrera de red que
-- ataje un error de configuración; la única barrera es que los identificadores
-- estén guardados por separado y que nadie use uno donde va el otro.
--
-- ## Por qué la escribe un comando y no la aplicación
--
-- `aai_app` recibe `SELECT` y nada más. Crear un plan del lado de una pasarela
-- es un acto comercial —define lo que se le va a cobrar a alguien todos los
-- meses— y ocurre una vez por plan, no en el medio de una petición HTTP. Es la
-- misma decisión que ya se tomó con `plan_prices`: los precios los declara una
-- persona con un comando que deja quién y por qué.
--
-- Si la aplicación pudiera insertar acá, un reintento de una petición cualquiera
-- podría crear un segundo plan en la pasarela sin que nadie lo pidiera.
--
-- ## El defecto que esta migración existe para hacer visible
--
--     alguien actualiza el precio del plan en `plan_prices`
--     la pasarela sigue cobrando el importe con el que se creó el plan
--     nadie se entera hasta que alguien compara dos números a mano
--
-- No es hipotético: es lo que pasa siempre que el precio vive en dos lugares.
-- Como no se puede impedir —el plan externo ya existe y su importe es del otro
-- lado—, se hace **ruidoso**: la divergencia sale en la bandeja de trabajo de
-- cada empresa afectada, con el número que se acordó y el que se está cobrando.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · El mapeo
-- ---------------------------------------------------------------------------

CREATE TABLE payment_plan_map (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  plan_id        uuid NOT NULL REFERENCES subscription_plans (id),

  -- El nombre del proveedor como texto y no como enum, igual que en
  -- `payment_intents` (0096): agregar una pasarela no debería requerir una
  -- migración de tipo, y el valor tiene que seguir siendo legible dentro de diez
  -- años sin consultar un catálogo.
  proveedor      text NOT NULL CHECK (length(btrim(proveedor)) > 0),

  -- Contra qué cuenta. Los dos únicos valores posibles, y ninguno por defecto:
  -- suponerlo es exactamente el error que esta columna existe para impedir.
  ambiente       text NOT NULL CHECK (ambiente IN ('sandbox', 'production')),

  periodicidad   text NOT NULL CHECK (periodicidad IN ('MENSUAL', 'ANUAL')),
  moneda         text NOT NULL CHECK (length(moneda) = 3),

  -- El identificador del plan del lado del proveedor. Opaco: conocerlo no da
  -- acceso a nada, y por eso puede vivir en una tabla que la aplicación lee.
  referencia_externa text NOT NULL CHECK (length(btrim(referencia_externa)) > 0),

  -- El importe con el que se creó el plan **allá**. No es el precio de NEXO: es
  -- la copia que quedó del otro lado, y guardarla es lo único que permite
  -- después preguntar si los dos siguen coincidiendo. Sin esta columna la
  -- divergencia sería invisible desde la base.
  importe_declarado numeric(18, 2) NOT NULL CHECK (importe_declarado >= 0),

  declarado_por  text NOT NULL CHECK (length(btrim(declarado_por)) > 0),
  declarado_el   timestamptz NOT NULL DEFAULT now(),
  motivo         text NOT NULL CHECK (length(btrim(motivo)) >= 5)
);

-- Un solo plan externo por combinación. Dos dejarían al sistema eligiendo, y la
-- elección sería por orden de inserción: es decir, por azar — y el azar acá
-- decide contra qué plan se le cobra a una empresa.
CREATE UNIQUE INDEX payment_plan_map_unico
  ON payment_plan_map (plan_id, proveedor, ambiente, periodicidad, moneda);

-- Y al revés: un plan del proveedor pertenece a un solo plan de NEXO. Sin este
-- índice, dos planes de NEXO podrían apuntar al mismo `preapproval_plan_id` y
-- un cobro entrante sería imposible de atribuir.
CREATE UNIQUE INDEX payment_plan_map_referencia_unica
  ON payment_plan_map (proveedor, ambiente, referencia_externa);

-- Global, no por empresa: es la oferta del producto del lado de la pasarela, no
-- un dato de ningún cliente. Sin RLS por inquilino, igual que `plan_prices`.
--
-- **Solo lectura para la aplicación.** El motivo está en el encabezado.
GRANT SELECT ON payment_plan_map TO aai_app;

COMMENT ON TABLE payment_plan_map IS
  'Qué plan de la pasarela corresponde a cada plan de NEXO, por ambiente, '
  'periodicidad y moneda. Nace vacía: sin filas no hay pasarela conectada y el '
  'ciclo cobra por transferencia, que es lo que hace hoy. La escribe un '
  'comando, no la aplicación: crear un plan del otro lado es un acto comercial.';

COMMENT ON COLUMN payment_plan_map.importe_declarado IS
  'El importe con el que se creó el plan del lado del proveedor. Se guarda para '
  'poder detectar que el precio de NEXO cambió y el del proveedor no.';

-- ---------------------------------------------------------------------------
-- 2 · De qué pasarela y de qué ambiente es una suscripción
-- ---------------------------------------------------------------------------
--
-- `company_subscriptions.referencia_externa` existe desde la 0073 y guarda el
-- identificador opaco del proveedor. Lo que le faltaba es **de quién es ese
-- identificador**.
--
-- Sin estas dos columnas, una instalación que cambia de ambiente —o de
-- pasarela— se queda con referencias que parecen válidas y apuntan a un recurso
-- de otra cuenta. Consultar esa suscripción devolvería 404 y el sistema
-- concluiría que la empresa no tiene medio de pago, cuando lo que pasó es que
-- se está preguntando en el lugar equivocado.

ALTER TABLE company_subscriptions
  ADD COLUMN proveedor_pago text CHECK (length(btrim(proveedor_pago)) > 0),
  ADD COLUMN ambiente_pago  text CHECK (ambiente_pago IN ('sandbox', 'production'));

-- Las tres van juntas o no va ninguna. Una referencia sin proveedor es un
-- identificador huérfano; un proveedor sin referencia no dice nada.
ALTER TABLE company_subscriptions
  ADD CONSTRAINT cs_pasarela_completa CHECK (
    (referencia_externa IS NULL AND proveedor_pago IS NULL AND ambiente_pago IS NULL)
    OR
    (referencia_externa IS NOT NULL AND proveedor_pago IS NOT NULL AND ambiente_pago IS NOT NULL)
  );

COMMENT ON COLUMN company_subscriptions.ambiente_pago IS
  'Contra qué cuenta del proveedor vale referencia_externa. Una suscripción '
  'creada en sandbox no existe en production: usar su referencia allá devuelve '
  '404, que se leería como «no tiene medio de pago».';

-- ---------------------------------------------------------------------------
-- 3 · La divergencia, a la vista
-- ---------------------------------------------------------------------------
--
-- Una empresa conectada a la pasarela cuyo importe acordado no coincide con el
-- que el plan externo declara. Es trabajo real de alguien: hay que decidir si se
-- corrige el precio de acá o se recrea el plan de allá.
--
-- `bloquea = false` a propósito. Cobrar de menos no es una urgencia operativa
-- —el servicio funciona, la plata entra— y marcar bloqueante algo que no impide
-- trabajar entrena a la gente a ignorar la bandeja. Lo que sí hace es no
-- desaparecer hasta que los dos números coincidan.

CREATE VIEW work_queue_pasarela WITH (security_invoker = true) AS
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
   AND s.estado IN ('ACTIVA', 'SUSPENDIDA')
   AND s.importe_acordado IS NOT NULL
   AND m.importe_declarado <> s.importe_acordado
) q;

GRANT SELECT ON work_queue_pasarela TO aai_app;

-- La bandeja completa. Se reescribe entera porque una vista no se puede
-- extender: `CREATE OR REPLACE` exige repetir la lista, y omitir una rama la
-- haría desaparecer de la bandeja sin que nada falle.
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
UNION ALL SELECT * FROM work_queue_pasarela;
