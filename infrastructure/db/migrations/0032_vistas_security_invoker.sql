-- 0032_vistas_security_invoker.sql — una fuga entre empresas que estaba desde la 0016.
--
-- ## Qué pasaba
--
-- `documents_pendientes` devolvía documentos de **otras empresas**. La tabla
-- `documents` tiene RLS forzado y aísla bien; la vista, no.
--
-- El motivo es un valor por defecto de PostgreSQL: una vista se ejecuta con los
-- privilegios de **su dueño**, no de quien consulta. Como la crea el usuario
-- dueño del esquema, el RLS del rol `aai_app` no se evalúa. La vista se salta
-- exactamente el candado que la tabla impone.
--
-- Medido antes del arreglo, consultando como la empresa A:
--
--     SELECT count(*) FROM documents           WHERE company_id = <empresa B>  →  0
--     SELECT count(*) FROM documents_pendientes WHERE company_id = <empresa B>  →  1
--
-- ## Cómo apareció
--
-- No lo encontró una auditoría del código: lo encontró el test de aislamiento
-- que se escribió para la vista NUEVA de la 0031. Al comprobar que la vista de
-- afectaciones no filtrara, la misma pregunta aplicada a la vista vieja dio que
-- sí filtraba. El criterio de salida de la FASE 2 —"cero fugas verificadas sobre
-- todos los endpoints"— se cumplía a nivel HTTP, y esta vista no está detrás de
-- un endpoint todavía.
--
-- ## El arreglo, y el candado
--
-- `security_invoker = true` hace que la vista se evalúe con los permisos del que
-- consulta, que es lo que uno supone que hace. Además queda un test que recorre
-- **todas** las vistas del esquema y falla si alguna que toca una tabla con RLS
-- forzado no lo tiene: la próxima vista con este defecto no llega a producción.

-- ## No era una vista: eran ocho
--
-- Al automatizar el control apareció que **todas** las vistas del esquema tenían
-- el mismo defecto, porque todas se escribieron con el `CREATE VIEW` de siempre.
-- La lista incluye `company_arca_credentials_public`, que se llama "public"
-- porque oculta el material sensible de la credencial — y repartía entre
-- empresas la fila que quedaba.
--
-- El arreglo no cambia el comportamiento de ninguna consulta correcta: una
-- sesión con su `app.company_id` puesto ve exactamente lo mismo que antes. Lo
-- único que cambia es que deja de ver lo ajeno.

ALTER VIEW ai_answer_metrics               SET (security_invoker = true);
ALTER VIEW bank_trace                      SET (security_invoker = true);
ALTER VIEW company_arca_credentials_public SET (security_invoker = true);
ALTER VIEW documents_pendientes            SET (security_invoker = true);
ALTER VIEW ledger_trace                    SET (security_invoker = true);
ALTER VIEW note_trace                      SET (security_invoker = true);
ALTER VIEW predictions_pendientes          SET (security_invoker = true);
ALTER VIEW statement_trace                 SET (security_invoker = true);
ALTER VIEW trial_balance                   SET (security_invoker = true);

COMMENT ON VIEW documents_pendientes IS
  'Bandeja de revisión. security_invoker = true: sin eso la vista se evalúa con '
  'los privilegios de su dueño y atraviesa el RLS de documents.';

COMMENT ON VIEW company_arca_credentials_public IS
  'Metadatos de la credencial de ARCA sin el material sensible. '
  'security_invoker = true: sin eso repartía entre empresas la fila que oculta.';
