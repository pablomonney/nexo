-- ---------------------------------------------------------------------------
-- Cupo de TOKENS por día, además del de preguntas
-- ---------------------------------------------------------------------------
--
-- Hasta acá el único tope diario de IA era «cuántas preguntas por día» (0094). Contar preguntas protege poco el gasto: una
-- pregunta con una foto, o con un historial largo, consume mucho más que una pregunta corta, y el modelo se cobra por tokens.
-- El tope que sigue la plata es el de tokens, igual que el de Claude.
--
-- ## Qué se agrega
--
-- `ai_quotas.tokens_por_dia`: cuántos tokens (entrada + salida) puede consumir el asistente de la empresa en un día. Se cuenta
-- de `assistant_messages` —que ya guarda los tokens de cada turno— y no de un contador aparte: un contador sería un segundo
-- número sobre el mismo hecho, y el día que se desincronizara no habría forma de saber cuál miente (ADR-022).
--
-- ## Dos topes independientes
--
-- Una empresa puede declarar uno, el otro o los dos. Por eso `llamadas_por_dia` deja de ser obligatoria: la fila exige que haya
-- **al menos un** tope declarado (CHECK). Un tope sin declarar sigue sin ser cero ni «ilimitado por diseño»: es que nadie lo decidió.
--
-- ## El turno que cruza el tope
--
-- Los tokens de un turno se conocen **después** de llamar al modelo, así que el tope se mira antes de cada turno contra lo ya
-- consumido: el turno que cruza el límite se completa, y el siguiente se corta. Se puede pasar el tope por un turno, no más.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_quotas
  ADD COLUMN tokens_por_dia bigint CHECK (tokens_por_dia >= 0);

ALTER TABLE ai_quotas
  ALTER COLUMN llamadas_por_dia DROP NOT NULL;

ALTER TABLE ai_quotas
  ADD CONSTRAINT ai_quotas_algun_tope
  CHECK (llamadas_por_dia IS NOT NULL OR tokens_por_dia IS NOT NULL);

COMMENT ON COLUMN ai_quotas.tokens_por_dia IS
  'Tokens (entrada + salida) que el asistente de la empresa puede consumir por día. NULL = la empresa no declaró tope de tokens '
  '(no es cero ni ilimitado por diseño). El consumo se cuenta de assistant_messages, por empresa.';

COMMENT ON COLUMN ai_quotas.llamadas_por_dia IS
  'Preguntas por día. NULL = la empresa no declaró tope de preguntas (puede haber declarado uno de tokens: ver ai_quotas_algun_tope).';

-- El consumo del día se suma por empresa: sin este índice la suma recorre toda la historia de mensajes.
CREATE INDEX assistant_messages_consumo_del_dia_idx
  ON assistant_messages (company_id, created_at)
  WHERE rol = 'asistente' AND tokens_entrada IS NOT NULL;
