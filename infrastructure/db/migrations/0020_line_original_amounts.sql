-- 0020_line_original_amounts.sql — separar el importe registrado del importe original.
--
-- CORRIGE UN DEFECTO DE LA FASE 5.
--
-- `journal_entry_lines.debit` guardaba el importe **original** de la línea, en la
-- moneda en la que se pactó la operación, mientras `journal_entries.total_debit`
-- guardaba el **convertido** a moneda de contabilidad. Con todas las líneas en
-- pesos los dos números coinciden y no se nota. Con una línea en dólares:
--
--   * `assert_entry_consistent` compara la suma de las líneas contra el total de
--     la cabecera y aborta la transacción con E_UNBALANCED al COMMIT;
--   * `/reports/trial-balance` sumaba centavos de dólar como si fueran pesos;
--   * y el Mayor de la 0019, que copia `l.debit`, habría heredado la mezcla.
--
-- El error de fondo era pedirle a una columna que significara dos cosas. Acá se
-- separan: `debit`/`credit` son lo que el libro registra —moneda de
-- contabilidad, CCyC art. 325— y `original_*` es la operación tal como ocurrió.
--
-- Ninguno de los dos sobra. Sin el convertido el libro no suma; sin el original
-- la conversión no se puede rehacer y el importe pasa a ser un número que hay
-- que creer.

ALTER TABLE journal_entry_lines
  ADD COLUMN original_currency text,
  ADD COLUMN original_debit    numeric(18, 2),
  ADD COLUMN original_credit   numeric(18, 2);

COMMENT ON COLUMN journal_entry_lines.debit IS
  'Importe registrado, en la moneda de la contabilidad (columna `currency`). Es lo que suma el libro.';
COMMENT ON COLUMN journal_entry_lines.currency IS
  'Moneda de registro. CCyC art. 325: los libros se llevan en moneda nacional.';
COMMENT ON COLUMN journal_entry_lines.original_currency IS
  'Moneda en la que se pactó la operación, si no es la de registro. NULL cuando coinciden.';

-- El constraint viejo leía `currency` como la moneda de la operación. Ahora esa
-- es `original_currency`, así que la exigencia se muda entera.
ALTER TABLE journal_entry_lines DROP CONSTRAINT jel_fx_complete;

-- E_MISSING_FX: si la operación fue en otra moneda, tiene que estar todo lo que
-- hace falta para rehacer la conversión — importe original, cotización, fuente y
-- fecha. La RG ARCA 5616/2024 exige consignar el tipo de cambio; sin fuente no
-- es auditable.
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT jel_fx_complete
    CHECK (original_currency IS NULL
           OR (fx_rate IS NOT NULL AND fx_source IS NOT NULL AND fx_date IS NOT NULL
               AND original_debit IS NOT NULL AND original_credit IS NOT NULL));

-- Guardar un "original" idéntico al registrado no agrega información y sí agrega
-- una segunda copia que puede desincronizarse.
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT jel_original_es_otra_moneda
    CHECK (original_currency IS NULL OR original_currency <> currency);

-- El original no puede estar de un lado y el registrado del otro. Una línea que
-- en dólares es débito y en pesos es crédito no describe ninguna operación.
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT jel_original_mismo_lado
    CHECK (original_debit IS NULL
           OR ((original_debit > 0) = (debit > 0) AND (original_credit > 0) = (credit > 0)));

-- Los importes originales no son negativos, igual que los registrados.
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT jel_original_no_negativo
    CHECK ((original_debit IS NULL OR original_debit >= 0)
       AND (original_credit IS NULL OR original_credit >= 0));

-- ---------------------------------------------------------------------------
-- Coherencia con la moneda del asiento
-- ---------------------------------------------------------------------------
-- La cabecera declara en qué moneda está el asiento; las líneas tienen que
-- registrar en esa misma. Es la versión por asiento del art. 325: un libro no
-- puede sumar dos monedas en la misma columna.
CREATE OR REPLACE FUNCTION assert_line_currency_matches_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_currency text;
BEGIN
  SELECT currency INTO entry_currency FROM journal_entries WHERE id = NEW.entry_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.currency <> entry_currency THEN
    RAISE EXCEPTION 'E_CURRENCY_MISMATCH: la línea % registra en % y el asiento está en %. El importe original va en original_currency, no acá.',
      NEW.line_no, NEW.currency, entry_currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER jel_currency_matches_entry
  BEFORE INSERT OR UPDATE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_currency_matches_entry();
