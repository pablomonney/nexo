-- 0051_bandeja_extensible_y_comercial.sql — la bandeja deja de ser un bloque.
--
-- ## El problema que aparece recién ahora
--
-- `work_queue` tiene veintiún ramas y quinientas líneas. Agregarle una exigía
-- `DROP VIEW` y volver a escribirla entera en la migración nueva: quinientas
-- líneas copiadas que a partir de ese momento existen dos veces, y que la
-- próxima migración vuelve a copiar. Con un módulo más ya son mil quinientas
-- líneas de la misma consulta en tres archivos, y basta que una copia salga
-- distinta para que la bandeja muestre algo que nadie escribió.
--
-- No era un problema con veintiún ramas de un solo dominio. Lo es ahora que
-- cada módulo nuevo —comercial, tesorería, stock— trae las suyas.
--
-- ## La decisión
--
-- La bandeja pasa a ser la unión de vistas por dominio:
--
--   work_queue            = work_queue_nucleo ∪ work_queue_comercial ∪ …
--
-- `work_queue_nucleo` **es** la vista de la 0046, renombrada. No se copió ni se
-- reescribió una línea de su cuerpo: `ALTER VIEW … RENAME` conserva la
-- definición y las `reloptions`, `security_invoker` incluido.
--
-- Lo que un módulo nuevo agrega ahora es una vista propia y un renglón en la
-- unión. Lo que ya funcionaba no se toca, que es la regla de todo este trabajo.
--
-- ## `security_invoker` en toda la cadena
--
-- Las tres vistas lo llevan. Una sola sin él en cualquier eslabón evaluaría con
-- los permisos de quien la creó y saltearía el RLS de las tablas de abajo: la
-- bandeja repartiría el trabajo pendiente de todas las empresas. Es la fuga que
-- encontró la 0032 y no se vuelve a abrir por una vista intermedia.

-- ---------------------------------------------------------------------------
-- 1 · El núcleo, intacto y renombrado
-- ---------------------------------------------------------------------------
ALTER VIEW work_queue RENAME TO work_queue_nucleo;

COMMENT ON VIEW work_queue_nucleo IS
  'Las ramas del núcleo contable-fiscal (0045, 0046). Es la vista original, '
  'renombrada: su cuerpo no se reescribió.';

-- ---------------------------------------------------------------------------
-- 2 · Las ramas del ciclo comercial
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_comercial WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 22 · Aceptado y sin facturar.
--      El cliente dijo que sí y todavía no hay operación fiscal. Es trabajo
--      pendiente real: la venta ocurrió y no está registrada.
--
--      Se pregunta por el hecho —¿hay `tax_transaction_id`?— y no por un
--      estado paralelo. Desaparece de la bandeja cuando se factura, no cuando
--      alguien la marca como hecha.
SELECT d.company_id,
       'ACEPTADO_SIN_FACTURAR'::text                AS rama,
       'REQUIERE_DECLARACION'::text                 AS categoria,
       'commercial_documents'::text                 AS entidad,
       d.id                                         AS entity_id,
       d.status                                     AS estado,
       d.kind || ' ' || d.number || ' aceptado el ' || d.updated_at::date ||
         ': falta registrar la operación fiscal'    AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'HUMANO'::text                               AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       d.created_at                                 AS creado_en,
       d.updated_at                                 AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/commercial-documents/' || d.id             AS traza_ref
  FROM commercial_documents d
 WHERE d.status = 'ACEPTADO'
   AND d.tax_transaction_id IS NULL

UNION ALL

-- 23 · Presupuesto emitido cuya validez venció.
--      No es un estado: es una lectura de la fecha, la misma que hace la vista
--      `commercial_document_status`. Requiere que alguien decida —rehacerlo o
--      darlo por rechazado—, no que alguien lo marque.
SELECT d.company_id,
       'PRESUPUESTO_VENCIDO'::text                  AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       'commercial_documents'::text                 AS entidad,
       d.id                                         AS entity_id,
       d.status                                     AS estado,
       'El presupuesto ' || d.number || ' venció el ' || d.valid_until ||
         ' y sigue esperando respuesta'             AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       d.created_at                                 AS creado_en,
       d.updated_at                                 AS actualizado_en,
       d.valid_until                                AS fecha_limite,
       '/commercial-documents/' || d.id             AS traza_ref
  FROM commercial_documents d
 WHERE d.kind = 'PRESUPUESTO'
   AND d.status = 'EMITIDO'
   AND d.valid_until IS NOT NULL
   AND d.valid_until < current_date

) q;

COMMENT ON VIEW work_queue_comercial IS
  'Ramas del ciclo comercial. Derivadas de hechos —falta la operación fiscal, '
  'pasó la fecha de validez—, no de estados que alguien tenga que escribir.';

-- ---------------------------------------------------------------------------
-- 3 · La bandeja, ahora una unión
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL
SELECT * FROM work_queue_comercial;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

GRANT SELECT ON work_queue_comercial TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
