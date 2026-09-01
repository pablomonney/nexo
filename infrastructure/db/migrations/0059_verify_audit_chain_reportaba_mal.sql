-- ============================================================================
-- 0059 — El detector de adulteraciones no podía reportar una adulteración
-- ============================================================================
--
-- `verify_audit_chain()` está desde la 0008 y se corrigió en la 0025 para
-- encadenar por `seq`. La fórmula estaba bien, el orden estaba bien, y la
-- función **se caía con un error de tipos en el instante exacto en que
-- encontraba algo**.
--
-- La causa: uno de sus parámetros de salida se llama `found`.
--
--   RETURNS TABLE (broken_at uuid, expected char(64), found char(64))
--   ...
--   found := row_record.hash;
--
-- `FOUND` es una **variable booleana propia de PL/pgSQL**, que el lenguaje
-- define en toda función y que dice si la última sentencia devolvió filas. El
-- nombre del parámetro de salida no la tapa: gana la del lenguaje. Así que esa
-- asignación intenta meter un SHA-256 de 64 caracteres en un booleano y termina
-- en:
--
--   error: la sintaxis de entrada no es válida para tipo boolean: «0265f71f…»
--
-- El recorrido de la cadena sana nunca llega a esa línea. Por eso el defecto
-- sobrevivió a dos migraciones y a un test de integración: **la única rama que
-- alguien había ejercitado era la verde**. El test decía «no reporta roturas en
-- una cadena sana», y era cierto — también habría pasado si la función no
-- verificara nada.
--
-- Lo encontró `scripts/verify-audit-chain.mjs` en su primera corrida, al
-- adulterar una entrada a propósito para comprobar que el verificador la
-- señalara. Es exactamente la forma del defecto que este proyecto persigue:
-- estructura correcta, regla escrita, y nadie recorriendo el camino entre las
-- dos.
--
-- ## Qué cambia
--
-- Los tres parámetros de salida pasan a nombres en castellano, como el resto de
-- lo que se escribió después, y ninguno colisiona con una variable del lenguaje.
-- La fórmula del hash **no se toca**: sigue siendo idéntica a la del trigger
-- `audit_chain_link()`, que es la condición para que el verificador sirva.
--
-- No hay dato que migrar: es una función.
-- ============================================================================

-- El tipo de retorno cambia, así que no alcanza `CREATE OR REPLACE`.
DROP FUNCTION IF EXISTS verify_audit_chain(uuid);

CREATE FUNCTION verify_audit_chain(p_company_id uuid)
RETURNS TABLE (roto_en uuid, hash_esperado char(64), hash_guardado char(64))
LANGUAGE plpgsql STABLE
AS $verificador$
DECLARE
  row_record record;
  running char(64) := repeat('0', 64);
  payload text;
  computed char(64);
BEGIN
  FOR row_record IN
    SELECT * FROM audit_logs
     WHERE company_id = p_company_id
     ORDER BY seq ASC
  LOOP
    -- Idéntico a `audit_chain_link()`, campo por campo y en el mismo orden. Un
    -- verificador que calcula distinto reporta rupturas donde no las hay y —lo
    -- que importa— deja de reportar las que sí.
    payload := concat_ws('|',
      running, row_record.seq::text, row_record.company_id::text, row_record.actor_type,
      row_record.actor_id, row_record.action, row_record.object_type, row_record.object_id,
      COALESCE(row_record.old_value::text, ''), COALESCE(row_record.new_value::text, ''),
      COALESCE(row_record.motivo, ''), row_record.occurred_at::text);
    computed := encode(digest(payload, 'sha256'), 'hex');

    IF row_record.prev_hash <> running OR row_record.hash <> computed THEN
      roto_en := row_record.id;
      hash_esperado := computed;
      hash_guardado := row_record.hash;
      RETURN NEXT;
      RETURN;
    END IF;

    running := row_record.hash;
  END LOOP;
END;
$verificador$;

COMMENT ON FUNCTION verify_audit_chain(uuid) IS
  'Recorre la bitácora de una empresa y devuelve la primera entrada adulterada, o ninguna fila si la cadena está íntegra. Los parámetros de salida NO pueden llamarse `found`: es una variable booleana de PL/pgSQL y la asignación falla con un error de tipos justo cuando hay algo que reportar (ver 0059).';
