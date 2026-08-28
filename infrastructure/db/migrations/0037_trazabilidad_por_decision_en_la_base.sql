-- 0037_trazabilidad_por_decision_en_la_base.sql
--
-- La fase anterior (`d350405`) hizo de `decision_id` una tercera vía de
-- trazabilidad **en el motor**. No la hizo en la base, y nadie lo notó porque
-- todos los asientos fundados en una decisión que se probaron traían además un
-- comprobante.
--
-- ## El agujero, exacto
--
-- `je_trazabilidad_obligatoria` (migración 0025) es el candado duro del
-- invariante A-3 y conoce dos caminos: `source_id` o `manual_justification`.
-- Un ajuste de cierre fundado solo en una decisión no tiene ninguno de los dos.
--
-- El CHECK solo muerde en APROBADO y ANULADO, así que el asiento **entra** como
-- PROPUESTO —el motor lo acepta, y con razón— y revienta recién al aprobarlo,
-- con un 500. Reproducido: `source_type = 'CLOSING'`, `source_id` nulo,
-- `manual_justification` nula, `decision_id` presente.
--
-- Es el peor momento posible para enterarse: el asiento ya está en el libro,
-- numerado, y lo que falla es el acto del profesional que lo firma.
--
-- La regla de la fase anterior era «si el motor y la base divergen, gana la
-- base». Gana — con un error interno. Lo que corresponde no es que el motor
-- retroceda: es que la base reconozca la misma tercera vía, porque una decisión
-- contable con su justificación **es** origen demostrable en el sentido del
-- art. 321 y del §24 del pliego. Lo que no puede haber sigue siendo un asiento
-- sin ninguna de las tres.
--
-- ## Lo que NO cambia
--
-- - El CHECK sigue aplicando solo a APROBADO y ANULADO: un borrador se está
--   armando y todavía puede no tener nada.
-- - Los candados de la 0034 y la 0036 siguen intactos. `decision_id` solo cuenta
--   como respaldo porque esos triggers ya garantizaron que la decisión existe,
--   es de esta empresa, no es de ambiente PRUEBA y corresponde a este
--   comprobante. Sin ellos, admitir un uuid cualquiera sería trazabilidad falsa.

ALTER TABLE journal_entries DROP CONSTRAINT je_trazabilidad_obligatoria;

ALTER TABLE journal_entries
  ADD CONSTRAINT je_trazabilidad_obligatoria
    CHECK (status NOT IN ('APROBADO', 'ANULADO')
           OR source_id IS NOT NULL
           OR length(btrim(coalesce(manual_justification, ''))) > 0
           OR decision_id IS NOT NULL);

COMMENT ON CONSTRAINT je_trazabilidad_obligatoria ON journal_entries IS
  'Invariante A-3: un asiento registrado tiene comprobante, justificación firmada '
  'o decisión contable. Las mismas tres vías que E_NO_TRACEABILITY en el motor: '
  'si divergieran, un asiento pasaría una capa y moriría en la otra.';

-- ---------------------------------------------------------------------------
-- La traza llega hasta la decisión
-- ---------------------------------------------------------------------------
-- `ledger_trace` es el camino del punto 8 del MVP: de cualquier número al
-- comprobante. Desde que la decisión es una vía de trazabilidad por sí sola, un
-- movimiento cuyo asiento se funda en una decisión llegaba hasta el asiento y
-- ahí se cortaba — la vista traía `source_id`, `ai_prediction_id` y ninguna
-- referencia a la decisión.
--
-- Se agrega la columna al final para no alterar el orden de las que ya estaban.
DROP VIEW ledger_trace;

CREATE VIEW ledger_trace AS
SELECT m.id                AS movement_id,
       m.company_id,
       m.account_id,
       a.code              AS account_code,
       a.name              AS account_name,
       m.movement_date,
       m.debit,
       m.credit,
       l.id                AS entry_line_id,
       l.line_no,
       l.description       AS line_description,
       e.id                AS entry_id,
       e.journal_code,
       e.entry_number,
       e.entry_date,
       e.description       AS entry_description,
       e.kind,
       e.status,
       e.source_type,
       e.source_id,
       e.ai_prediction_id,
       e.reverses_entry_id,
       d.id                AS document_id,
       d.original_name     AS document_name,
       d.sha256            AS document_sha256,
       e.decision_id,
       -- El origen de la decisión viaja con ella: DETERMINISTICA manda a leer la
       -- regla aplicada, MANUAL manda a leer la justificación. Sin este dato hay
       -- que consultar la decisión solo para saber por dónde seguir.
       dec.origen          AS decision_origen,
       dec.resultado       AS decision_resultado
  FROM ledger_movements m
  JOIN journal_entry_lines l ON l.id = m.entry_line_id
  JOIN journal_entries e     ON e.id = l.entry_id
  JOIN accounts a            ON a.id = m.account_id
  -- El JOIN se acota por source_type: un asiento MANUAL o de CIERRE no tiene
  -- documento detrás, y un `source_id` que coincidiera por casualidad con el id
  -- de un documento haría aparecer un respaldo que nunca existió.
  LEFT JOIN documents d      ON d.id = e.source_id
                            AND e.source_type IN ('INVOICE', 'RECEIPT', 'BANK')
  LEFT JOIN accounting_decisions dec ON dec.id = e.decision_id;

-- `security_invoker` explícito, como fijó la 0032: una vista que se define sin
-- él corre con los permisos de quien la creó y saltea el RLS de las tablas de
-- abajo. `ledger_trace` ya lo tenía por el ALTER de aquella migración, y al
-- recrearla acá volvería al valor por defecto —`off`— si no se lo repusiera.
ALTER VIEW ledger_trace SET (security_invoker = true);

GRANT SELECT ON ledger_trace TO aai_app;
