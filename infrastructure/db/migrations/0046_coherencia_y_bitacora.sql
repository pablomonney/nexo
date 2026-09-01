-- 0046_coherencia_y_bitacora.sql — que ningún estado afirme lo que los hechos niegan.
--
-- FASE 4, bloques A y B. Cuatro cosas, ninguna tabla nueva:
--
--   1. El candado de anulación de documentos pasa a preguntar por el HECHO
--      —¿existe una operación fiscal?— en vez de por una columna que nadie
--      escribe. Y pasa a vivir en un trigger, para que valga también por SQL.
--   2. `users.created_by` y `organization_members.created_by`: quién dio de alta
--      a una persona es un hecho de la fila, no un evento que haya que recordar
--      escribir en otro lado.
--   3. El permiso `ledger:verify`, porque verificar el Mayor **escribe** una
--      constancia firmada y hasta hoy alcanzaba con un permiso de lectura.
--   4. `work_queue` gana la rama del balance que no cuadra y una columna que
--      dice si el ítem se puede resolver desde la bandeja.

-- ---------------------------------------------------------------------------
-- 1 · Un documento con operación fiscal no se anula
-- ---------------------------------------------------------------------------
-- ## El defecto
--
-- `POST /documents/:id/duplicates/:dupId` anulaba con
-- `WHERE id = $1 AND status <> 'IMPUTADO'`. El valor `IMPUTADO` está en el CHECK
-- de `documents.status` desde la 0016 y **ningún código productivo lo escribe**:
-- la condición nunca era falsa. El candado estaba apagado desde el día uno y se
-- podía anular un documento que funda una operación fiscal — y con ella una
-- decisión y un asiento.
--
-- ## Por qué no se arregla escribiendo la columna
--
-- Sería la solución rápida y crea dos verdades sobre el mismo hecho: la columna
-- y la existencia de la fila en `tax_transactions`. Si una transacción falla a
-- medias, o alguien inserta por otro camino, discrepan — y la que mienten los
-- reportes es la columna.
--
-- La pregunta correcta es la que ya usa `work_queue`: **¿existe la operación?**
--
-- ## Por qué un trigger y no un WHERE
--
-- Un `WHERE` en el handler protege a quien pasa por el handler. El pliego pide
-- que la base impida lo prohibido, no que lo impida la aplicación. Con el
-- trigger, el candado vale por HTTP, por `psql` y por cualquier camino futuro.

CREATE OR REPLACE FUNCTION assert_documento_anulable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ANULADO' AND OLD.status IS DISTINCT FROM 'ANULADO' THEN
    IF EXISTS (
      SELECT 1 FROM tax_transactions t
       WHERE t.document_id = OLD.id
         AND t.company_id = OLD.company_id
    ) THEN
      RAISE EXCEPTION
        'El documento % ya funda una operación fiscal: no se anula. Corregí la operación.',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_anulacion_sin_operacion
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION assert_documento_anulable();

COMMENT ON FUNCTION assert_documento_anulable() IS
  'Impide anular un documento que ya produjo una operación fiscal. Pregunta por '
  'la existencia de la fila y no por documents.status: la columna IMPUTADO no la '
  'escribe nadie, y mantenerla al día sería una segunda verdad sobre el mismo hecho.';

-- ---------------------------------------------------------------------------
-- 2 · Quién dio de alta a una persona
-- ---------------------------------------------------------------------------
-- El alta de un usuario no se puede registrar en `audit_logs`: esa tabla exige
-- `company_id NOT NULL` y un usuario recién creado no pertenece a ninguna
-- empresa todavía. Es el mismo problema que resolvió la 0041 para las reglas.
--
-- Pero acá no hace falta una bitácora nueva. El dato que se quiere —quién lo
-- creó y cuándo— es **un hecho de la fila**, y `created_at` ya está. Se agrega
-- el actor al lado, y no un evento que alguien tenga que acordarse de escribir.
--
-- El acceso a la contabilidad de una empresa —que es lo que de verdad importa
-- auditar— ya lo registra el trigger `audit_company_role` de la 0043 con
-- `ROL_OTORGADO` / `ROL_REVOCADO`, y ese sí lleva `company_id`. No se duplica.
--
-- Nullable porque `POST /auth/register-first-admin` crea al primer usuario
-- cuando todavía no hay nadie que pueda ser el actor. NULL ahí significa
-- exactamente eso, y no "se perdió el dato".

ALTER TABLE users ADD COLUMN created_by text;
ALTER TABLE organization_members ADD COLUMN created_by text;

COMMENT ON COLUMN users.created_by IS
  'Actor que dio de alta a esta persona (`user:<uuid>`). NULL solo para el primer '
  'usuario del sistema, cuando todavía no existe nadie que pueda crearlo.';

-- ---------------------------------------------------------------------------
-- 3 · Verificar el Mayor es escribir, no leer
-- ---------------------------------------------------------------------------
-- `POST /books/ledger-verification` inserta una fila en `ledger_verifications`
-- con `ran_by`: una constancia firmada de que alguien comparó el Mayor contra el
-- Diario. Exigía `report:read`, que tienen SOLO_LECTURA y USUARIO_EMPRESA.
--
-- Es la única frontera de esta fase que los cincuenta permisos existentes no
-- expresaban: entre mirar un reporte y dejar una constancia con tu nombre.

INSERT INTO permissions (code, description) VALUES
  ('ledger:verify', 'Ejecutar la verificación del Mayor y dejar su constancia firmada');

-- CONTADOR porque es quien responde por los libros; AUDITOR porque verificar sin
-- poder modificar es exactamente su trabajo. Ni ADMINISTRADOR —que administra el
-- sistema, no la contabilidad— ni los roles de lectura.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('CONTADOR', 'AUDITOR') AND p.code = 'ledger:verify';

-- ---------------------------------------------------------------------------
-- 4 · La bandeja: el balance que no cuadra, y qué se puede hacer con cada ítem
-- ---------------------------------------------------------------------------
-- ## `BALANCE_NO_CUADRA`
--
-- `evaluarChecklist()` lo llama «el único que no admite discusión: si el balance
-- no cuadra, no hay cierre». Hasta hoy solo se veía al intentar cerrar: un libro
-- roto en marzo era invisible hasta diciembre.
--
-- La rama **no reimplementa el control**: usa la misma consulta que
-- `apps/api/src/routes/closures.ts` usa para `diferenciaSumasYSaldosEnMenor`
-- —suma de Debe menos Haber sobre los asientos APROBADO y ANULADO del
-- ejercicio, en unidades menores—. Si el día de mañana el control cambia, tienen
-- que cambiar los dos, y este comentario es dónde se entera quien lo toque.
--
-- ## `disponibilidad`
--
-- Un ítem puede aparecer y no ser resoluble. El caso conocido: un asiento en
-- BORRADOR cuyo período se bloqueó o se cerró después. `assert_period_open`
-- impide aprobarlo, con razón, y la bandeja lo listaba mudo.
--
-- Tres valores, y ninguno inventa una acción que no exista:
--
--   ACCIONABLE            hay un camino productivo hoy
--   INFORMATIVO           nadie de adentro puede resolverlo (falta una fuente)
--   BLOQUEADO_POR_ESTADO  hay acción, pero el estado del período la impide
--
-- La consola usa esto para no ofrecer un botón que terminaría en 422.

DROP VIEW work_queue;

CREATE VIEW work_queue WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 0 · El balance del ejercicio no cierra.
--     Va primero porque es el único que dice que el libro está roto: mientras
--     esté encendido, todo lo demás se apoya en números que no cierran.
SELECT fy.company_id,
       'BALANCE_NO_CUADRA'::text                    AS rama,
       'BLOQUEADO'::text                            AS categoria,
       'fiscal_years'::text                         AS entidad,
       fy.id                                        AS entity_id,
       fy.status                                    AS estado,
       'El balance de sumas y saldos no cierra: diferencia de ' || b.dif ||
         ' en unidades menores'                     AS motivo,
       true                                         AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       fy.created_at                                AS creado_en,
       fy.created_at                                AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/reports/trial-balance?desde=' || fy.start_date || '&hasta=' || fy.end_date
                                                    AS traza_ref
  FROM fiscal_years fy
  JOIN LATERAL (
         SELECT round((sum(l.debit) - sum(l.credit)) * 100)::bigint AS dif
           FROM journal_entry_lines l
           JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
          WHERE e.company_id = fy.company_id
            AND e.fiscal_year_id = fy.id
            AND e.status IN ('APROBADO', 'ANULADO')) b ON true
 WHERE b.dif IS NOT NULL AND b.dif <> 0

UNION ALL

-- 1 · Documento archivado que todavía no produjo una operación fiscal.
--     Por inclusión y por el hecho, no por el estado: ver la 0045.
SELECT d.company_id,
       'DOCUMENTO_SIN_OPERACION',
       'REQUIERE_REVISION',
       'documents',
       d.id,
       d.status,
       'Documento archivado sin operación fiscal registrada',
       false,
       NULL::text[],
       'SISTEMA',
       'ACCIONABLE',
       d.received_at,
       d.received_at,
       NULL::date,
       '/documents/' || d.id
  FROM documents d
 WHERE d.status IN ('RECIBIDO', 'EXTRAIDO')
   AND NOT EXISTS (
         SELECT 1 FROM tax_transactions t
          WHERE t.document_id = d.id AND t.company_id = d.company_id)

UNION ALL

-- 2 · No se pudo leer el documento. INFORMATIVO: sin motor de OCR no hay nada
--     que una persona pueda hacer desde acá, y ofrecer un botón sería mentir.
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
       'INFORMATIVO',
       e.started_at,
       coalesce(e.finished_at, e.started_at),
       NULL::date,
       '/documents/' || e.document_id
  FROM document_extractions e
  JOIN documents d ON d.id = e.document_id AND d.company_id = e.company_id
 WHERE e.available IS NOT TRUE
   AND d.status IN ('RECIBIDO', 'EXTRAIDO')
   AND NOT EXISTS (
         SELECT 1 FROM tax_transactions t
          WHERE t.document_id = d.id AND t.company_id = d.company_id)

UNION ALL

-- 3 · Hallazgo bloqueante sobre la lectura.
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
       'ACCIONABLE',
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

-- 4 · Duplicado bloqueante sin resolver.
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
       'ACCIONABLE',
       dup.detected_at,
       dup.detected_at,
       NULL::date,
       '/documents/' || dup.document_id
  FROM document_duplicates dup
 WHERE dup.bloquea AND dup.resolucion IS NULL

UNION ALL

-- 5 · Comprobante que nadie constató.
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
       'ACCIONABLE',
       t.created_at,
       t.created_at,
       NULL::date,
       coalesce('/documents/' || t.document_id || '/tax-transaction',
                '/tax-transactions/' || t.id || '/afectacion')
  FROM tax_transactions t
 WHERE t.constatacion_origen = 'NO_CONSULTADO'

UNION ALL

-- 6 · Constatación anterior a la 0043: hay resultado y no se sabe quién lo puso.
--     INFORMATIVO: el trigger `constatacion_no_degrada` impide reescribir la
--     procedencia de una fila que ya tiene resultado, así que no hay acción.
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
       'INFORMATIVO',
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
       'ACCIONABLE',
       coalesce(t.constatacion_at, t.created_at),
       coalesce(t.constatacion_at, t.created_at),
       NULL::date,
       coalesce('/documents/' || t.document_id || '/tax-transaction',
                '/tax-transactions/' || t.id || '/afectacion')
  FROM tax_transactions t
 WHERE t.constatacion IN ('FAIL', 'WARN')

UNION ALL

-- 8 · Operación sin afectación.
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
       'ACCIONABLE',
       t.created_at,
       t.created_at,
       NULL::date,
       '/tax-transactions/' || t.id || '/afectacion'
  FROM tax_transactions t
 WHERE NOT EXISTS (
         SELECT 1 FROM tax_affectations a
          WHERE a.tax_transaction_id = t.id AND a.company_id = t.company_id)

UNION ALL

-- 9 · Afectación sugerida por precedente, sin declarar.
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
       'ACCIONABLE',
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
       'ACCIONABLE',
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

-- 11 · La decisión ya dijo que hace falta una persona.
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
       'ACCIONABLE',
       ad.created_at,
       ad.updated_at,
       NULL::date,
       '/comprobantes/' || ad.tax_transaction_id || '/decision'
  FROM accounting_decisions ad
 WHERE ad.resultado = 'REQUIERE_REVISION'
   AND ad.estado <> 'SUPERSEDIDA'
   AND ad.tax_transaction_id IS NOT NULL

UNION ALL

-- 12 · Decisión con propuesta de asiento que todavía no lo produjo.
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
       'ACCIONABLE',
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

-- 13 · Asiento cargado y sin aprobar.
--
--      Acá vive el caso de `disponibilidad` que motivó la columna: si el período
--      se cerró después, `assert_period_open` impide aprobarlo y no hay nada que
--      el usuario pueda hacer desde la bandeja. Si está BLOQUEADO, depende del
--      tipo de asiento — la 0042 admite AJUSTE, REFUNDICION y CIERRE.
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
       CASE
         WHEN p.status = 'CERRADO' THEN 'BLOQUEADO_POR_ESTADO'
         WHEN p.status = 'BLOQUEADO'
              AND je.kind NOT IN ('AJUSTE', 'REFUNDICION', 'CIERRE')
           THEN 'BLOQUEADO_POR_ESTADO'
         ELSE 'ACCIONABLE'
       END,
       je.created_at,
       je.updated_at,
       NULL::date,
       '/journal-entries'
  FROM journal_entries je
  JOIN periods p ON p.id = je.period_id AND p.company_id = je.company_id
 WHERE je.status IN ('BORRADOR', 'PROPUESTO')

UNION ALL

-- 14 · Predicción de IA sin revisar, etiquetada como IA (ADR-001).
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
       'ACCIONABLE',
       p.created_at,
       p.created_at,
       NULL::date,
       '/predictions'
  FROM ai_predictions p
 WHERE NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.prediction_id = p.id
                                                AND r.company_id = p.company_id)

UNION ALL

-- 15 · Nota en borrador.
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
       'ACCIONABLE',
       n.created_at,
       n.updated_at,
       NULL::date,
       '/statements/' || n.statement_id || '/notes/verify'
  FROM notes n
 WHERE n.status = 'BORRADOR'

UNION ALL

-- 16 · Nota con evidencia insuficiente.
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
       'ACCIONABLE',
       n.created_at,
       n.updated_at,
       NULL::date,
       '/statements/' || n.statement_id || '/notes/verify'
  FROM notes n
 WHERE n.evidencia = 'INSUFFICIENT_EVIDENCE'
   AND n.status <> 'SUPERSEDIDA'

UNION ALL

-- 17 · Libro de IVA sin generar.
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
       'ACCIONABLE',
       make_date(v.anio, v.mes, 1)::timestamptz,
       make_date(v.anio, v.mes, 1)::timestamptz,
       v.vencimiento,
       '/vat/books/' || v.anio || '/' || v.mes
  FROM vat_books v
 WHERE v.status = 'PENDIENTE'

UNION ALL

-- 18 · Conciliación bancaria en borrador.
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
       'ACCIONABLE',
       br.created_at,
       br.created_at,
       NULL::date,
       '/banks/accounts'
  FROM bank_reconciliations br
 WHERE br.status = 'BORRADOR'

UNION ALL

-- 19 · Cierre de ejercicio en curso.
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
       'ACCIONABLE',
       ac.performed_at,
       coalesce(ac.closed_at, ac.performed_at),
       NULL::date,
       '/fiscal-years/' || ac.fiscal_year_id || '/closure'
  FROM accounting_closures ac
 WHERE ac.status = 'EN_CURSO'

UNION ALL

-- 20 · Período vencido y todavía abierto.
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
       'ACCIONABLE',
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
  'cuando alguien lo marca. `disponibilidad` dice si se puede resolver desde '
  'acá. Ver docs/OPERACION.md §D y docs/FASE_4_OPERACION.md.';

GRANT SELECT ON work_queue TO aai_app;
