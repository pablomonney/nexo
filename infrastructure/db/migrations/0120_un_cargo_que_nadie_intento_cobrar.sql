-- ---------------------------------------------------------------------------
-- Un cargo que nadie intentó cobrar
-- ---------------------------------------------------------------------------
--
-- Dos cosas que faltaban para que el camino PRUEBA → PAGA → PASARELA →
-- COBRANZA se pueda recorrer entero sin que nada se pierda en silencio.
--
-- ## 1 · Una referencia de pasarela pertenece a una sola suscripción
--
-- La 0118 puso ese candado sobre `payment_plan_map`
-- (`payment_plan_map_referencia_unica`) con un argumento que vale igual acá y
-- que no se aplicó: si dos filas comparten el identificador del proveedor, lo
-- que llega desde afuera **no se puede atribuir**.
--
-- Concretamente: `pagos/bandeja.ts` busca la suscripción con
--
--     WHERE referencia_externa = $1 AND proveedor_pago = $2
--
-- y se queda con la primera fila. Con dos candidatas, a qué empresa se le aplica
-- un cobro lo decide el orden de lectura — es decir, el azar. Y el azar acá
-- decide de quién es la plata que entró.
--
-- El índice es **parcial**: solo sobre las filas conectadas. Sin esa condición,
-- todas las suscripciones sin pasarela —que hoy son todas— colisionarían entre
-- sí en `(NULL, NULL, NULL)`.
--
-- No hay `UNIQUE` posible sobre `referencia_externa` sola, y no es un descuido:
-- dos instalaciones de NEXO pueden compartir una cuenta de Mercado Pago, y el
-- ambiente forma parte de la identidad del recurso por lo mismo que en la 0118.
--
-- ## 2 · El hueco por el que se caía un documento impago
--
-- La cobranza automática existe desde la 0096 y **arranca con un intento
-- fallido**:
--
--     avanzarCobranza → JOIN payment_intents i ON ... i.estado = 'FALLIDO'
--
-- Es correcto para lo que se escribió: un documento que nunca se intentó cobrar
-- no está en mora por culpa del cliente. Pero deja un caso afuera, y con la
-- pasarela conectada ese caso pasa a ser el importante:
--
--     la empresa convierte la prueba          → queda ACTIVA, con importe
--     el ciclo emite el cargo                 → documento EMITIDO
--     nadie autoriza el medio de pago         → la pasarela no debita
--     no hay ningún intento, ni fallido       → la cobranza no arranca
--     el documento vence                      → y no lo mira nadie
--
-- No hay error en ninguna línea. Cada parte hace lo que debe y el resultado es
-- una empresa usando el producto con un cargo vencido que ningún proceso
-- menciona.
--
-- ## Se hace visible, no se bloquea
--
-- `bloquea = false`, como todas las ramas comerciales. Suspender a alguien
-- porque un cargo venció es una decisión de política de cobranza, y vive donde
-- viven las decisiones de cobranza: en `collection_policies`, declarada por una
-- persona con su vigencia y su motivo. Esta rama no la toma — dice el hecho y lo
-- deja a la vista, que es lo que el sistema hace con todo lo que no le
-- corresponde decidir.
--
-- Tampoco inventa un plazo. La condición es `vence_el < current_date`: la fecha
-- de vencimiento ya está en el documento, puesta cuando se emitió. Agregarle
-- «más de N días» sería escribir acá una tolerancia que nadie declaró.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · La referencia, única entre las conectadas
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX company_subscriptions_referencia_unica
  ON company_subscriptions (proveedor_pago, ambiente_pago, referencia_externa)
  WHERE referencia_externa IS NOT NULL;

COMMENT ON INDEX company_subscriptions_referencia_unica IS
  'Una referencia del proveedor pertenece a una sola suscripción. Sin esto, un '
  'cobro entrante con dos candidatas se atribuye por orden de lectura, que es '
  'azar disfrazado de regla. Parcial porque las no conectadas son todas NULL.';

-- ---------------------------------------------------------------------------
-- 2 · La acción de auditoría que faltaba declarar
-- ---------------------------------------------------------------------------
--
-- `audit_actions` es un catálogo cerrado: una acción que no está ahí no se
-- registra, y el trigger lo impide con nombre y apellido
-- (`E_AUDIT_ACTION_DESCONOCIDA`). Es lo correcto —un vocabulario de auditoría
-- que cada quien amplía desde el código deja de servir para buscar— y significa
-- que conectar una pasarela **no se podía auditar** hasta esta línea.
--
-- `requiere_motivo` en verdadero: conectar una suscripción a una pasarela es lo
-- que habilita que a una empresa se le debite todos los meses. Que quede
-- escrito por qué se hizo no es burocracia, es lo único que dentro de un año
-- explica de dónde salió un débito.

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('CONECTAR_PASARELA', 'suscripcion', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;

-- ---------------------------------------------------------------------------
-- 3 · El cargo vencido que nadie intentó cobrar
-- ---------------------------------------------------------------------------

CREATE VIEW work_queue_cargos WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id, q.*
  FROM (
SELECT d.company_id,
       'CARGO_VENCIDO_SIN_INTENTO'::text             AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'billing_documents'::text                     AS entidad,
       d.id                                          AS entity_id,
       d.estado                                      AS estado,
       'El cargo ' || d.numero || ' venció el ' || d.vence_el ||
         ' y no tiene ningún intento de cobro registrado. La cobranza automática ' ||
         'arranca con un intento fallido, así que este documento no entra en ninguna ' ||
         'política: o se cobró por transferencia y falta registrarlo, o falta conectar ' ||
         'el medio de pago'                          AS motivo,
       false                                         AS bloquea,
       ARRAY['INTENTO_DE_COBRO']::text[]             AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       d.created_at                                  AS creado_en,
       d.created_at                                  AS actualizado_en,
       d.vence_el                                    AS fecha_limite,
       '/facturacion/' || d.id                       AS traza_ref
  FROM billing_documents d
 WHERE d.estado = 'EMITIDO'
   AND d.tipo = 'CARGO'
   AND d.vence_el IS NOT NULL
   AND d.vence_el < current_date
   -- Ningún intento, de ningún estado. Con uno fallido la política de cobranza
   -- ya se hace cargo y esta rama estorbaría; con uno pendiente hay un cobro en
   -- curso y tampoco hay nada que revisar.
   AND NOT EXISTS (
     SELECT 1 FROM payment_intents i WHERE i.document_id = d.id
   )
) q;

GRANT SELECT ON work_queue_cargos TO aai_app;

COMMENT ON VIEW work_queue_cargos IS
  'Cargos de NEXO vencidos que nunca se intentaron cobrar. La cobranza '
  'automática arranca con un intento fallido, así que sin ningún intento el '
  'documento no entra en ninguna política y vence sin que nada lo mencione.';

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
UNION ALL SELECT * FROM work_queue_cargos;
