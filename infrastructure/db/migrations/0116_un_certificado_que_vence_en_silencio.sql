-- ---------------------------------------------------------------------------
-- Un certificado que vence en silencio
-- ---------------------------------------------------------------------------
--
-- ## El defecto que esta migración cierra
--
-- `company_arca_credentials_public` (0015) ya calcula `vencido` y
-- `dias_restantes`. El dato estaba; nadie lo miraba.
--
-- La consecuencia es concreta y no es hipotética: el certificado de ARCA dura
-- dos años. El día que vence, la consulta de `credencialVigente()` deja de
-- devolver fila —filtra por `now() BETWEEN not_before AND not_after`— y la
-- constatación empieza a contestar `NO_VERIFICABLE / SIN_CREDENCIAL`.
--
-- Es la respuesta correcta y es completamente invisible: no hay error, no hay
-- log, no hay pantalla roja. Alguien lo descubre cuando un comprobante que
-- debería constatarse deja de hacerlo, y para entonces ya pasó.
--
-- Renovar un certificado ante ARCA no es instantáneo: hay que entrar al
-- Administrador de Certificados Digitales, generar el pedido, descargarlo y
-- cargarlo. Enterarse el día que venció es enterarse tarde.
--
-- ## Por qué va a la bandeja de pendientes y no a `alerts`
--
-- Porque no es una señal sobre los datos de la empresa: es trabajo que alguien
-- tiene que hacer, con una fecha límite. Eso es exactamente lo que `work_queue`
-- junta, y ya lo hace para veintitrés fuentes. Meterlo en `alerts` —que existe
-- para umbrales sobre la operación— sería un segundo lugar donde mirar.
--
-- ## Los tres tramos, y por qué el aviso empieza a los treinta días
--
--     vencido            bloquea. La constatación ya no funciona.
--     ≤ 30 días          accionable, con fecha límite.
--     > 30 días          no aparece. Un pendiente que no se puede resolver
--                        todavía es ruido, y el ruido enseña a ignorar la
--                        bandeja.
--
-- Treinta días alcanzan para el trámite sin apuro y son pocos como para que el
-- aviso signifique algo. No es un número de ARCA: es una decisión de este
-- repositorio, y por eso está escrita acá y no escondida en el código.
-- ---------------------------------------------------------------------------

CREATE VIEW work_queue_arca WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 34 · El certificado de ARCA venció.
--      La constatación ya está contestando SIN_CREDENCIAL. Bloquea: no es un
--      aviso, es una capacidad que se perdió.
SELECT c.company_id,
       'ARCA_CERTIFICADO_VENCIDO'::text             AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text              AS categoria,
       'company_arca_credentials'::text             AS entidad,
       c.id                                         AS entity_id,
       c.status                                     AS estado,
       'El certificado ' || c.alias || ' (' || c.environment || ', CUIT ' ||
         c.cuit || ') venció el ' || to_char(c.not_after, 'DD/MM/YYYY') ||
         '. La constatación contesta SIN_CREDENCIAL hasta que se cargue uno nuevo'
                                                    AS motivo,
       true                                         AS bloquea,
       ARRAY['certificado renovado en el Administrador de Certificados Digitales de ARCA']::text[]
                                                    AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       c.created_at                                 AS creado_en,
       c.not_after                                  AS actualizado_en,
       c.not_after::date                            AS fecha_limite,
       '/companies/current/arca/credentials'        AS traza_ref
  FROM company_arca_credentials c
 WHERE c.status = 'ACTIVE'
   AND c.not_after < now()
   -- No hace falta preguntar si hay otra vigente que lo reemplace: no puede
   -- haberla. `company_arca_credentials_active` (0015) permite **una sola**
   -- credencial ACTIVE por empresa y ambiente, porque dos certificados vigentes
   -- a la vez hacen impredecible con cuál se firmó cada consulta.
   --
   -- La consecuencia operativa, que conviene tener presente al renovar: la
   -- renovación **no se puede solapar**. Hay que revocar el viejo y recién ahí
   -- cargar el nuevo, con una ventana sin credencial en el medio. Es
   -- exactamente lo que vuelve útil el aviso a treinta días de la rama de
   -- abajo: permite elegir cuándo abrir esa ventana en vez de que la abra el
   -- vencimiento.

UNION ALL

-- 35 · El certificado de ARCA está por vencer.
--      No bloquea todavía: avisa con tiempo para hacer el trámite.
SELECT c.company_id,
       'ARCA_CERTIFICADO_POR_VENCER'::text          AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text              AS categoria,
       'company_arca_credentials'::text             AS entidad,
       c.id                                         AS entity_id,
       c.status                                     AS estado,
       'El certificado ' || c.alias || ' (' || c.environment || ', CUIT ' ||
         c.cuit || ') vence el ' || to_char(c.not_after, 'DD/MM/YYYY') ||
         ', en ' || greatest(0, extract(day FROM c.not_after - now())::int) ||
         ' día(s). Renovarlo antes evita quedarse sin constatación'
                                                    AS motivo,
       false                                        AS bloquea,
       ARRAY['certificado renovado en el Administrador de Certificados Digitales de ARCA']::text[]
                                                    AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       c.created_at                                 AS creado_en,
       c.created_at                                 AS actualizado_en,
       c.not_after::date                            AS fecha_limite,
       '/companies/current/arca/credentials'        AS traza_ref
  FROM company_arca_credentials c
 WHERE c.status = 'ACTIVE'
   AND now() BETWEEN c.not_before AND c.not_after
   AND c.not_after <= now() + interval '30 days'

) q;

GRANT SELECT ON work_queue_arca TO aai_app;

COMMENT ON VIEW work_queue_arca IS
  'El certificado de ARCA, vencido o por vencer. El dato lo calculaba '
  '`company_arca_credentials_public` desde la 0015 y no lo miraba nadie: un '
  'certificado que caduca deja la constatación en SIN_CREDENCIAL sin error ni '
  'log, y renovarlo es un trámite ante el organismo que no es instantáneo.';

-- ---------------------------------------------------------------------------
-- Se suma a la bandeja
-- ---------------------------------------------------------------------------
--
-- `work_queue` se redefine entera: PostgreSQL no permite agregar una rama a un
-- UNION de una vista existente sin reemplazarla, y `CREATE OR REPLACE` exige
-- que las columnas sean las mismas —lo son—.

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
UNION ALL SELECT * FROM work_queue_arca;
