-- 0045_lectura_de_empresas_y_bandeja.sql — el camino de lectura que faltaba.
--
-- FASE 3. Dos objetos nuevos y ninguna tabla:
--
--   1. `user_companies()` — qué empresas puede ver el usuario **antes** de tener
--      una empresa en contexto. Sin esto la consola no pasa del login.
--   2. `work_queue` — la bandeja de pendientes, como proyección de estados que
--      ya existen. No hay tabla `tasks`, y no la va a haber: el diseño y sus
--      motivos están en `docs/OPERACION.md` §D.
--
-- Ningún candado se afloja. Ninguna política cambia. Ningún catálogo se amplía.

-- ---------------------------------------------------------------------------
-- 1 · Quién es el actor, en SQL
-- ---------------------------------------------------------------------------
-- `app_actor_id()` ya existe y devuelve el texto crudo: `user:<uuid>`,
-- `system:<proceso>` o `ai:<agente>`. Para autorizar hace falta el uuid, y solo
-- cuando el actor es una persona.
--
-- Devuelve NULL —nunca falla— en los tres casos que importan: sin contexto, con
-- un actor que no es un usuario, y con un uuid mal formado. NULL propaga a
-- `user_id = NULL`, que no iguala a nada: el modo de fallo es cerrado.

CREATE OR REPLACE FUNCTION app_actor_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  actor text := app_actor_id();
BEGIN
  IF actor IS NULL OR left(actor, 5) <> 'user:' THEN
    RETURN NULL;
  END IF;
  RETURN substr(actor, 6)::uuid;
EXCEPTION WHEN others THEN
  -- Un `app.actor_id` con basura después de `user:` no es una excepción de
  -- negocio: es "no hay usuario identificado".
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 · Las empresas del usuario
-- ---------------------------------------------------------------------------
-- El problema, otra vez el de la ADR-010: la política de `companies` exige
-- `id = app_company_id()`, y para elegir empresa todavía no hay empresa. La
-- tentación de siempre es aflojar la política con `app_company_id() IS NULL OR
-- …`; eso convertiría cualquier consulta que olvidara fijar el contexto en un
-- listado de toda la cartera del estudio.
--
-- En cambio: un punto de entrada nominado, SECURITY DEFINER, que hace **una
-- sola cosa**.
--
-- ## Por qué NO recibe el usuario por parámetro
--
-- Las otras funciones privilegiadas —`create_company`, `grant_company_role`—
-- reciben `p_actor_user_id` y verifican la autorización adentro con
-- `organization_level()`. Acá no hay nada que verificar: la pregunta *es* «qué
-- empresas son mías». Si aceptara un uuid, sería un oráculo para preguntar por
-- la cartera de cualquier otro usuario del estudio.
--
-- Así que el usuario sale de `app.actor_id`, que `withoutCompany()` fija por
-- transacción. La función no puede ser interrogada sobre un tercero porque no
-- tiene dónde recibirlo.
--
-- ## Qué protege y qué no
--
-- Fijar `app.actor_id` es una capacidad del rol `aai_app`, igual que fijar
-- `app.company_id`. Quien pueda hacer lo segundo ya puede leer cualquier
-- empresa; esta función no agrega superficie. Lo que sí hace es que el **camino
-- por defecto** —el que usa la aplicación— no pueda devolver de más.

CREATE OR REPLACE FUNCTION user_companies()
RETURNS TABLE (
  id                uuid,
  legal_name        text,
  cuit              text,
  entity_type       text,
  jurisdiction      text,
  regulator         text,
  fiscal_year_end   text,
  status            text,
  organization_id   uuid,
  organization_name text,
  roles             text[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id,
         c.legal_name,
         c.cuit,
         c.entity_type,
         c.jurisdiction,
         c.regulator,
         c.fiscal_year_end,
         c.status,
         o.id,
         o.name,
         array_agg(DISTINCT r.code ORDER BY r.code)
    FROM user_company_roles ucr
    JOIN companies     c ON c.id = ucr.company_id
    JOIN organizations o ON o.id = c.organization_id
    JOIN roles         r ON r.id = ucr.role_id
   WHERE app_actor_user_id() IS NOT NULL
     AND ucr.user_id = app_actor_user_id()
     AND ucr.valid_from <= CURRENT_DATE
     AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)
   GROUP BY c.id, c.legal_name, c.cuit, c.entity_type, c.jurisdiction,
            c.regulator, c.fiscal_year_end, c.status, o.id, o.name;
$$;

COMMENT ON FUNCTION user_companies() IS
  'Empresas donde el actor de la transacción tiene un rol vigente. El usuario '
  'sale de app.actor_id y no se puede pasar por parámetro: preguntar por la '
  'cartera de otro no es una operación que exista. Ver ADR-010.';

GRANT EXECUTE ON FUNCTION app_actor_user_id() TO aai_app;
GRANT EXECUTE ON FUNCTION user_companies() TO aai_app;

-- ---------------------------------------------------------------------------
-- 3 · La bandeja de trabajo
-- ---------------------------------------------------------------------------
-- `work_queue` es una **proyección**, no una tabla. El motivo largo está en
-- `docs/OPERACION.md` §D.1; el corto es que una tabla `tasks` sería una segunda
-- verdad sobre la misma pregunta, y mantenerla sincronizada exigiría agregar
-- escritura a las tablas más protegidas del sistema.
--
-- Consecuencia que conviene tener presente: **un ítem desaparece porque el hecho
-- cambió**, no porque alguien lo marcó. No hay forma de sacar algo de la bandeja
-- sin resolverlo.
--
-- ## Aislamiento
--
-- `security_invoker = true` es obligatorio: sin él la vista corre con los
-- privilegios de su dueño y el RLS de las veinte tablas que consulta no se
-- evalúa. Es el defecto que tenía `documents_pendientes` desde la 0016 y que
-- corrigió la 0032. `tests/security/vistas-rls.test.ts` lo comprueba solo.
--
-- Además, **cada JOIN lleva la igualdad de empresa explícita**. RLS ya filtra;
-- la condición del JOIN hace que una fila cruzada sea imposible aunque no
-- filtrara. Con veinte ramas, la disciplina vale más que el razonamiento caso
-- por caso.
--
-- ## Qué NO está acá
--
-- `alerts` y `audit_findings` **no son ramas de esta vista**, y no por
-- descuido: hoy no las escribe nada en producción. Una rama que solo puede
-- devolver cero filas afirma que la bandeja cubre las alertas, y no las cubre.
-- Entran el día que exista un escritor, con su test.
--
-- Por lo mismo no hay columna `severidad`: su única fuente sería `alerts`.
--
-- Y no hay columna `prioridad`. No existe fundamento objetivo para ordenar un
-- documento sin extraer contra una nota sin evidencia. `fecha_limite` sale
-- únicamente de las tres fechas que el esquema tiene de verdad.

-- ## `rama` e `item_id`: por qué existen los dos
--
-- El cursor de paginación necesita un orden **total**, y `entity_id` no alcanza:
-- la misma operación fiscal aparece en varias ramas a la vez.
--
-- El primer intento usó `(entidad, categoría, entity_id)` como clave natural, y
-- **lo rompió un test**: las ramas 5 y 8 —«sin constatar» y «sin afectación»—
-- son las dos `REQUIERE_DECLARACION` sobre `tax_transactions`, así que dos ítems
-- distintos colapsaban en el mismo `item_id`. La categoría dice *qué falta en
-- general*; no identifica el pendiente.
--
-- Por eso cada rama declara su `rama`: un código corto y estable que **sí** la
-- identifica. `item_id` es el hash de `(rama, entity_id)`, que es la clave
-- natural de verdad. Determinista, estable entre consultas, y sin identidad
-- propia que mantener: no es una fila guardada en ningún lado, se recalcula.

CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Documento archivado que todavía no produjo una operación fiscal.
--
--     Dos condiciones, y las dos hacen falta.
--
--     **Por INCLUSIÓN, no por exclusión.** `documents_pendientes` filtra con
--     `status <> ALL ('ANULADO','IMPUTADO')` y por eso arrastra RECHAZADO: con
--     cinco estados, excluir dos deja tres. Un filtro por inclusión no puede
--     empezar a devolver de más cuando el catálogo crezca.
--
--     **Y por la ausencia real de la operación, no por el estado.** Al escribir
--     esta rama apareció que **nadie escribe nunca `status = 'IMPUTADO'`**: el
--     valor está en el CHECK desde la 0016, `documents_pendientes` lo excluye, y
--     ningún `UPDATE` del repositorio lo asigna. Un documento que ya produjo su
--     operación fiscal se queda en EXTRAIDO para siempre.
--
--     Confiar en el estado habría hecho que la bandeja afirmara «documento sin
--     operación fiscal» sobre documentos que **sí la tienen**. Un pendiente
--     falso es peor que un pendiente que falta: enseña a no mirar la bandeja.
--
--     El `NOT EXISTS` pregunta por el hecho en vez de por el rótulo. El defecto
--     de la transición queda documentado y sin corregir acá: arreglarlo es tocar
--     el camino de escritura, y esta fase es de lectura.
SELECT d.company_id,
       'DOCUMENTO_SIN_OPERACION'::text                       AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       'documents'::text                            AS entidad,
       d.id                                         AS entity_id,
       d.status                                     AS estado,
       'Documento archivado sin operación fiscal registrada'::text AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       d.received_at                                AS creado_en,
       d.received_at                                AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/documents/' || d.id                        AS traza_ref
  FROM documents d
 WHERE d.status IN ('RECIBIDO', 'EXTRAIDO')
   AND NOT EXISTS (
         SELECT 1 FROM tax_transactions t
          WHERE t.document_id = d.id AND t.company_id = d.company_id)

UNION ALL

-- 2 · No se pudo leer el documento. El motivo es el que dio el motor, no una
--     interpretación: `SIN_MOTOR_OCR` significa que no había con qué leerlo.
SELECT e.company_id,
       'LECTURA_NO_DISPONIBLE',
       'REQUIERE_FUENTE_EXTERNA',
       'document_extractions',
       e.id,
       coalesce(e.unavailable_reason, 'NO_DISPONIBLE'),
       'La lectura del documento no está disponible: ' ||
         coalesce(e.unavailable_reason, 'NO_DISPONIBLE'),
       false,
       NULL::text[],
       'SISTEMA',
       e.started_at,
       coalesce(e.finished_at, e.started_at),
       NULL::date,
       '/documents/' || e.document_id
  FROM document_extractions e
  JOIN documents d ON d.id = e.document_id AND d.company_id = e.company_id
 WHERE e.available IS NOT TRUE
   AND d.status IN ('RECIBIDO', 'EXTRAIDO')
   -- Misma condición que la rama 1, y por el mismo motivo: si una persona ya
   -- declaró los importes, que el motor no haya podido leer el archivo dejó de
   -- ser trabajo pendiente. Sin esto, y con `NullOcrEngine` respondiendo
   -- SIN_MOTOR_OCR sobre todo, cada documento del sistema quedaría en la
   -- bandeja para siempre — que es cómo se enseña a no mirarla.
   AND NOT EXISTS (
         SELECT 1 FROM tax_transactions t
          WHERE t.document_id = d.id AND t.company_id = d.company_id)

UNION ALL

-- 3 · Hallazgo bloqueante sobre la lectura. La evidencia faltante son los
--     códigos que el motor levantó, que es información concreta y no un rótulo.
SELECT d.company_id,
       'LECTURA_CON_HALLAZGO_BLOQUEANTE',
       'BLOQUEADO',
       'documents',
       d.id,
       d.status,
       'La lectura del documento tiene hallazgos que bloquean',
       true,
       array_agg(DISTINCT f.codigo ORDER BY f.codigo),
       'SISTEMA',
       min(f.created_at),
       max(f.created_at),
       NULL::date,
       '/documents/' || d.id
  FROM document_findings f
  JOIN document_extractions e ON e.id = f.extraction_id AND e.company_id = f.company_id
  JOIN documents d            ON d.id = e.document_id   AND d.company_id = e.company_id
 WHERE f.bloquea
   AND d.status IN ('RECIBIDO', 'EXTRAIDO')
 GROUP BY d.company_id, d.id, d.status

UNION ALL

-- 4 · Duplicado bloqueante sin resolver. La condición de pendiente **es** la
--     ausencia del dato: se va sola cuando alguien decide.
SELECT dup.company_id,
       'DUPLICADO_SIN_RESOLVER',
       'REQUIERE_CORRECCION',
       'document_duplicates',
       dup.id,
       dup.nivel,
       'Posible duplicado sin resolver: ' || dup.nivel,
       true,
       ARRAY['RESOLUCION_DE_DUPLICADO']::text[],
       'SISTEMA',
       dup.detected_at,
       dup.detected_at,
       NULL::date,
       '/documents/' || dup.document_id
  FROM document_duplicates dup
 WHERE dup.bloquea AND dup.resolucion IS NULL

UNION ALL

-- 5 · Comprobante que nadie constató. Ni ARCA contestó, ni una persona firmó.
SELECT t.company_id,
       'OPERACION_SIN_CONSTATAR',
       'REQUIERE_DECLARACION',
       'tax_transactions',
       t.id,
       t.constatacion_origen,
       'El comprobante no fue constatado: ni ARCA contestó ni hay declaración profesional',
       false,
       ARRAY['CONSTATACION']::text[],
       'SISTEMA',
       t.created_at,
       t.created_at,
       NULL::date,
       coalesce('/documents/' || t.document_id || '/tax-transaction',
                '/tax-transactions/' || t.id || '/afectacion')
  FROM tax_transactions t
 WHERE t.constatacion_origen = 'NO_CONSULTADO'

UNION ALL

-- 6 · Fila anterior a la 0043: hay un resultado de constatación y no se sabe
--     quién lo puso. No falta consultar: falta saber de dónde salió.
SELECT t.company_id,
       'CONSTATACION_SIN_PROCEDENCIA',
       'REQUIERE_CORRECCION',
       'tax_transactions',
       t.id,
       t.constatacion_origen,
       'La constatación existe pero su procedencia no quedó registrada',
       false,
       ARRAY['PROCEDENCIA_DE_CONSTATACION']::text[],
       'SISTEMA',
       t.created_at,
       t.created_at,
       NULL::date,
       coalesce('/documents/' || t.document_id || '/tax-transaction',
                '/tax-transactions/' || t.id || '/afectacion')
  FROM tax_transactions t
 WHERE t.constatacion_origen = 'ORIGEN_NO_REGISTRADO'

UNION ALL

-- 7 · El organismo o el profesional dijeron que algo no cierra.
SELECT t.company_id,
       'CONSTATACION_OBSERVADA',
       'REQUIERE_CORRECCION',
       'tax_transactions',
       t.id,
       t.constatacion,
       'La constatación del comprobante no fue satisfactoria: ' || t.constatacion,
       t.constatacion = 'FAIL',
       NULL::text[],
       CASE WHEN t.constatacion_origen = 'ARCA' THEN 'ARCA' ELSE 'PROFESIONAL' END,
       coalesce(t.constatacion_at, t.created_at),
       coalesce(t.constatacion_at, t.created_at),
       NULL::date,
       coalesce('/documents/' || t.document_id || '/tax-transaction',
                '/tax-transactions/' || t.id || '/afectacion')
  FROM tax_transactions t
 WHERE t.constatacion IN ('FAIL', 'WARN')

UNION ALL

-- 8 · Operación sin afectación. El §11 pide separar validación fiscal de
--     contable: sin afectación declarada, la fiscal está a medias.
SELECT t.company_id,
       'OPERACION_SIN_AFECTACION',
       'REQUIERE_DECLARACION',
       'tax_transactions',
       t.id,
       'SIN_AFECTACION',
       'Falta declarar la afectación fiscal de la operación',
       false,
       ARRAY['AFECTACION']::text[],
       'SISTEMA',
       t.created_at,
       t.created_at,
       NULL::date,
       '/tax-transactions/' || t.id || '/afectacion'
  FROM tax_transactions t
 WHERE NOT EXISTS (
         SELECT 1 FROM tax_affectations a
          WHERE a.tax_transaction_id = t.id AND a.company_id = t.company_id)

UNION ALL

-- 9 · Afectación sugerida por precedente. No es una declaración: la vista
--     `tax_affectations_declaradas` la excluye y el motor solo lee esa vista.
--     Una sugerencia sin confirmar sigue siendo trabajo pendiente.
SELECT a.company_id,
       'AFECTACION_SUGERIDA_SIN_DECLARAR',
       'REQUIERE_DECLARACION',
       'tax_affectations',
       a.id,
       a.afectacion,
       'La afectación es una sugerencia por precedente: falta la declaración profesional',
       false,
       ARRAY['DECLARACION_PROFESIONAL']::text[],
       'PRECEDENTE',
       a.created_at,
       a.updated_at,
       NULL::date,
       '/tax-transactions/' || a.tax_transaction_id || '/afectacion'
  FROM tax_affectations a
 WHERE a.origen = 'SUGERIDA_POR_PRECEDENTE'

UNION ALL

-- 10 · Operación sin decisión vigente.
SELECT t.company_id,
       'OPERACION_SIN_DECISION',
       'REQUIERE_REVISION',
       'tax_transactions',
       t.id,
       'SIN_DECISION',
       'La operación no tiene una decisión contable vigente',
       false,
       ARRAY['DECISION']::text[],
       'SISTEMA',
       t.created_at,
       t.created_at,
       NULL::date,
       '/comprobantes/' || t.id || '/decision'
  FROM tax_transactions t
 WHERE NOT EXISTS (
         SELECT 1 FROM accounting_decisions ad
          WHERE ad.tax_transaction_id = t.id
            AND ad.company_id = t.company_id
            AND ad.estado <> 'SUPERSEDIDA')

UNION ALL

-- 11 · La decisión ya dijo que hace falta una persona. `REQUIERE_REVISION` no
--      es una categoría inventada para la bandeja: es un valor de
--      `accounting_decisions.resultado`.
SELECT ad.company_id,
       'DECISION_REQUIERE_REVISION',
       'REQUIERE_REVISION',
       'accounting_decisions',
       ad.id,
       ad.estado,
       'La decisión quedó en REQUIERE_REVISION y espera intervención profesional',
       false,
       NULL::text[],
       CASE ad.origen
         WHEN 'PROPUESTA_IA' THEN 'IA'
         WHEN 'MANUAL'       THEN 'PROFESIONAL'
         ELSE 'SISTEMA'
       END,
       ad.created_at,
       ad.updated_at,
       NULL::date,
       '/comprobantes/' || ad.tax_transaction_id || '/decision'
  FROM accounting_decisions ad
 WHERE ad.resultado = 'REQUIERE_REVISION'
   AND ad.estado <> 'SUPERSEDIDA'
   AND ad.tax_transaction_id IS NOT NULL

UNION ALL

-- 12 · Decisión con propuesta de asiento que todavía no produjo el asiento.
SELECT ad.company_id,
       'DECISION_SIN_ASIENTO',
       'REQUIERE_APROBACION',
       'accounting_decisions',
       ad.id,
       ad.estado,
       'La decisión propone un asiento que todavía no se registró',
       false,
       ARRAY['ASIENTO']::text[],
       CASE ad.origen
         WHEN 'PROPUESTA_IA' THEN 'IA'
         WHEN 'MANUAL'       THEN 'PROFESIONAL'
         ELSE 'SISTEMA'
       END,
       ad.created_at,
       ad.updated_at,
       NULL::date,
       '/comprobantes/' || ad.tax_transaction_id || '/decision'
  FROM accounting_decisions ad
 WHERE ad.resultado = 'PROPUESTA_DE_ASIENTO'
   AND ad.estado = 'EMITIDA'
   AND ad.tax_transaction_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM journal_entries je
          WHERE je.decision_id = ad.id AND je.company_id = ad.company_id)

UNION ALL

-- 13 · Asiento cargado y sin aprobar. Hasta que se aprueba no se proyecta al
--      Mayor: es trabajo que existe y no tiene efecto todavía.
SELECT je.company_id,
       'ASIENTO_SIN_APROBAR',
       'REQUIERE_APROBACION',
       'journal_entries',
       je.id,
       je.status,
       'Asiento ' || je.journal_code || ' sin aprobar',
       false,
       NULL::text[],
       CASE WHEN je.ai_prediction_id IS NOT NULL THEN 'IA' ELSE 'PROFESIONAL' END,
       je.created_at,
       je.updated_at,
       NULL::date,
       '/journal-entries'
  FROM journal_entries je
 WHERE je.status IN ('BORRADOR', 'PROPUESTO')

UNION ALL

-- 14 · Predicción de IA sin revisar. Se muestra **etiquetada como IA**: una
--      sugerencia no es un hecho, y la bandeja no las mezcla (ADR-001).
SELECT p.company_id,
       'PREDICCION_SIN_REVISAR',
       'REQUIERE_REVISION',
       'ai_predictions',
       p.id,
       coalesce(p.triage_band, 'SIN_BANDA'),
       'Propuesta del agente ' || p.agent || ' sin revisar',
       false,
       NULL::text[],
       'IA',
       p.created_at,
       p.created_at,
       NULL::date,
       '/predictions'
  FROM ai_predictions p
 WHERE NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.prediction_id = p.id
                                                AND r.company_id = p.company_id)

UNION ALL

-- 15 · Nota en borrador. El CHECK de la tabla ya impide que una nota generada
--      por IA salga de BORRADOR sin `approved_by`: la bandeja no agrega reglas,
--      las muestra.
SELECT n.company_id,
       'NOTA_SIN_APROBAR',
       'REQUIERE_APROBACION',
       'notes',
       n.id,
       n.status,
       'Nota ' || n.numero || ' en borrador, sin aprobar',
       false,
       NULL::text[],
       CASE n.generated_by
         WHEN 'AI'    THEN 'IA'
         WHEN 'HUMAN' THEN 'PROFESIONAL'
         ELSE 'SISTEMA'
       END,
       n.created_at,
       n.updated_at,
       NULL::date,
       '/statements/' || n.statement_id || '/notes/verify'
  FROM notes n
 WHERE n.status = 'BORRADOR'

UNION ALL

-- 16 · Nota con evidencia insuficiente. Otra categoría que ya existía con este
--      nombre en el dominio: `notes.evidencia = 'INSUFFICIENT_EVIDENCE'`.
SELECT n.company_id,
       'NOTA_SIN_EVIDENCIA',
       'REQUIERE_EVIDENCIA',
       'notes',
       n.id,
       n.evidencia,
       'Nota ' || n.numero || ' sin evidencia suficiente',
       false,
       NULL::text[],
       CASE n.generated_by
         WHEN 'AI'    THEN 'IA'
         WHEN 'HUMAN' THEN 'PROFESIONAL'
         ELSE 'SISTEMA'
       END,
       n.created_at,
       n.updated_at,
       NULL::date,
       '/statements/' || n.statement_id || '/notes/verify'
  FROM notes n
 WHERE n.evidencia = 'INSUFFICIENT_EVIDENCE'
   AND n.status <> 'SUPERSEDIDA'

UNION ALL

-- 17 · Libro de IVA sin generar. Es la única fuente con vencimiento propio en
--      el esquema, así que es una de las tres que llenan `fecha_limite`.
SELECT v.company_id,
       'LIBRO_IVA_SIN_GENERAR',
       'REQUIERE_APROBACION',
       'vat_books',
       v.id,
       v.status,
       'Libro de IVA ' || lpad(v.mes::text, 2, '0') || '/' || v.anio || ' sin generar',
       false,
       NULL::text[],
       'SISTEMA',
       make_date(v.anio, v.mes, 1)::timestamptz,
       make_date(v.anio, v.mes, 1)::timestamptz,
       v.vencimiento,
       '/vat/books/' || v.anio || '/' || v.mes
  FROM vat_books v
 WHERE v.status = 'PENDIENTE'

UNION ALL

-- 18 · Conciliación bancaria empezada y sin confirmar.
SELECT br.company_id,
       'CONCILIACION_SIN_CONFIRMAR',
       'REQUIERE_APROBACION',
       'bank_reconciliations',
       br.id,
       br.status,
       'Conciliación bancaria en borrador, sin confirmar',
       false,
       NULL::text[],
       'PROFESIONAL',
       br.created_at,
       br.created_at,
       NULL::date,
       '/banks/accounts'
  FROM bank_reconciliations br
 WHERE br.status = 'BORRADOR'

UNION ALL

-- 19 · Cierre de ejercicio empezado y sin terminar.
SELECT ac.company_id,
       'CIERRE_EN_CURSO',
       'REQUIERE_APROBACION',
       'accounting_closures',
       ac.id,
       ac.status,
       'Cierre de ejercicio en curso, sin completar',
       false,
       NULL::text[],
       'PROFESIONAL',
       ac.performed_at,
       coalesce(ac.closed_at, ac.performed_at),
       NULL::date,
       '/fiscal-years/' || ac.fiscal_year_id || '/closure'
  FROM accounting_closures ac
 WHERE ac.status = 'EN_CURSO'

UNION ALL

-- 20 · Período vencido y todavía abierto. No es una opinión sobre cuándo habría
--      que cerrar: es una fecha del propio período que ya pasó.
SELECT p.company_id,
       'PERIODO_VENCIDO_ABIERTO',
       'REQUIERE_APROBACION',
       'periods',
       p.id,
       p.status,
       'El período terminó el ' || p.end_date || ' y sigue abierto',
       false,
       NULL::text[],
       'SISTEMA',
       p.end_date::timestamptz,
       p.end_date::timestamptz,
       p.end_date,
       '/periods'
  FROM periods p
 WHERE p.status = 'ABIERTO'
   AND p.end_date < CURRENT_DATE

) q;

COMMENT ON VIEW work_queue IS
  'Bandeja de trabajo pendiente por empresa. Proyección de estados existentes: '
  'no hay tabla de tareas y un ítem desaparece cuando el hecho cambia, no '
  'cuando alguien lo marca. Ver docs/OPERACION.md §D.';

GRANT SELECT ON work_queue TO aai_app;
