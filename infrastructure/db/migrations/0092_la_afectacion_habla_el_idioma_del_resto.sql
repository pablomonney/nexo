-- ============================================================================
-- 0092 — La afectación habla el idioma del resto
-- ============================================================================
--
-- S-20 normalizó el vocabulario de la bitácora y dejó un barrido que impide que
-- vuelva a derivar. El barrido lee TypeScript, y hay acciones que se emiten
-- desde **triggers SQL**: nunca las vio.
--
-- Dos de esas están en inglés, en un vocabulario que es castellano en todo lo
-- demás: `AFFECTATION_DECLARED` y `AFFECTATION_CHANGED`, del trigger de la 0031.
-- Buscar «qué pasó con las afectaciones» exigía saber que esas dos se escriben
-- distinto que las otras ciento treinta, y nada lo decía.
--
-- ## Cómo se llaman ahora, y por qué así
--
--     AFFECTATION_DECLARED  →  AFECTACION_DECLARADA
--     AFFECTATION_CHANGED   →  AFECTACION_CAMBIADA
--
-- En participio, con el sujeto en la fila. No es una forma nueva: es la que ya
-- usan los otros dos triggers que escriben en la bitácora —`DECISION_EMITIDA`,
-- `DECISION_CAMBIADA` (0034) y `ROL_OTORGADO`, `ROL_REVOCADO` (0043)—. Los
-- verbos en infinitivo son de las acciones que emite un handler HTTP, donde hay
-- alguien que las ejecuta; un trigger describe lo que le pasó a una fila.
--
-- Esa distinción no es de estilo. `DECLARAR_AFECTACION` ya existe y es **otra
-- cosa**: el acto por HTTP —quién lo pidió, desde dónde, con qué motivo—, que el
-- trigger no puede saber. Las dos entradas conviven a propósito desde la 0031, y
-- por eso el nombre del trigger no puede ser el mismo.
--
-- ## Lo que no se toca
--
-- Las filas ya escritas. La bitácora es append-only y está encadenada por hash:
-- reescribir una fila vieja para que diga el nombre nuevo rompería la cadena, y
-- «arreglar» la cadena después sería exactamente lo que la cadena existe para
-- impedir. Los nombres viejos quedan en `audit_actions` como `historico`, que es
-- lo que son.
-- ============================================================================

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('AFECTACION_DECLARADA', 'trigger:0031', false),
  ('AFECTACION_CAMBIADA',  'trigger:0031', false);

-- Los nombres viejos pasan a histórico: los emitía este trigger y ya no.
UPDATE audit_actions SET dominio = 'historico'
 WHERE id IN ('AFFECTATION_DECLARED', 'AFFECTATION_CHANGED');

-- Copia fiel de la 0031 con los dos nombres cambiados, y nada más. El cuerpo se
-- reescribe entero porque `CREATE OR REPLACE FUNCTION` no admite parches: es el
-- lugar donde es fácil perder un campo sin que nadie lo note —`tax_transaction_id`
-- en `new_value`, o el `RETURN NULL` que corresponde a un trigger AFTER—.
CREATE OR REPLACE FUNCTION audit_tax_affectation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_logs
    (company_id, actor_type, actor_id, action, object_type, object_id,
     old_value, new_value, motivo, prev_hash, hash)
  VALUES (
    NEW.company_id,
    'USER',
    coalesce(NEW.declarada_por, current_user),
    CASE TG_OP WHEN 'INSERT' THEN 'AFECTACION_DECLARADA' ELSE 'AFECTACION_CAMBIADA' END,
    'tax_affectations',
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE'
      THEN jsonb_build_object('afectacion', OLD.afectacion, 'origen', OLD.origen,
                              'proporcion_gravada', OLD.proporcion_gravada,
                              'evidencia', OLD.evidencia)
      ELSE NULL END,
    jsonb_build_object('afectacion', NEW.afectacion, 'origen', NEW.origen,
                       'proporcion_gravada', NEW.proporcion_gravada,
                       'evidencia', NEW.evidencia,
                       'tax_transaction_id', NEW.tax_transaction_id),
    NULL, '', ''
  );
  RETURN NULL;
END;
$$;
