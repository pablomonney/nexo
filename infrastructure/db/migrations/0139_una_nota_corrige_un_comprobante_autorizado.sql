-- ---------------------------------------------------------------------------
-- Una nota de crédito o de débito corrige un comprobante **autorizado**, y la base lo exige
-- ---------------------------------------------------------------------------
--
-- **No habilita emitir.** E6 de `docs/EMISION_DE_FACTURAS_PLAN.md`.
--
-- Una factura autorizada no se edita ni se borra: se corrige con una **nota** que la nombra (`CbtesAsoc` en WSFEv1). Medido en
-- homologación el 2026-10-16: ARCA acepta la nota de crédito C y la de débito C que llevan su comprobante asociado, y rechaza
-- (10197) la que no lo lleva.
--
-- Esta migración deja la regla en la base, donde no la saltea una consulta suelta:
--
--   · una intención cuyo tipo es **nota de crédito o de débito** tiene que declarar `asociada_a`: la intención del comprobante que
--     corrige; una **factura** no puede declararla;
--   · ese comprobante tiene que ser **de la misma empresa y el mismo ambiente**, estar **AUTORIZADO** (no se corrige lo que
--     todavía no existe ni lo que quedó en duda), ser una **factura o una nota de débito** (una nota de crédito no se corrige
--     con otra) y ser **de la misma letra** que la nota (A, B o C);
--   · el comprobante asociado **no se cambia** después.
--
-- Quedan a propósito fuera de la base, porque dependen de importes que `fiscal_emissions` no guarda (están en el documento
-- comercial): que una nota de crédito no supere lo acreditable, y que la suma de las notas no supere la factura. Eso lo
-- verifica quien arma el comprobante (`armarComprobante`, parámetro `acreditable`).
-- ---------------------------------------------------------------------------

ALTER TABLE fiscal_emissions ADD COLUMN asociada_a uuid REFERENCES fiscal_emissions (id);

CREATE INDEX fiscal_emissions_asociada_a ON fiscal_emissions (asociada_a) WHERE asociada_a IS NOT NULL;

COMMENT ON COLUMN fiscal_emissions.asociada_a IS
  'En una nota de crédito o de débito: la intención (AUTORIZADA) del comprobante que corrige. Va en CbtesAsoc de WSFEv1. '
  'En una factura es siempre nula.';

CREATE OR REPLACE FUNCTION assert_asociacion_de_emision() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_clase  text;
  v_letra  text;
  v_aso    record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.asociada_a IS DISTINCT FROM OLD.asociada_a THEN
      RAISE EXCEPTION 'El comprobante asociado de una intención fiscal no se cambia'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT t.clase, t.letra INTO v_clase, v_letra FROM arca_comprobante_types t WHERE t.codigo = NEW.cbte_tipo;

  IF v_clase IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    IF NEW.asociada_a IS NULL THEN
      RAISE EXCEPTION
        'Una nota de crédito o de débito corrige un comprobante, y hay que decir cuál (asociada_a): una factura autorizada no se edita, se corrige con una nota asociada'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT e.company_id, e.ambiente, e.estado, t.clase, t.letra
      INTO v_aso
      FROM fiscal_emissions e
      JOIN arca_comprobante_types t ON t.codigo = e.cbte_tipo
     WHERE e.id = NEW.asociada_a;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'El comprobante asociado % no existe (o es de otra empresa)', NEW.asociada_a
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_aso.company_id <> NEW.company_id OR v_aso.ambiente <> NEW.ambiente THEN
      RAISE EXCEPTION 'El comprobante asociado tiene que ser de la misma empresa y del mismo ambiente'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_aso.estado <> 'AUTORIZADA' THEN
      RAISE EXCEPTION 'Sólo se corrige un comprobante AUTORIZADO, y el asociado está %', v_aso.estado
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_aso.clase NOT IN ('FACTURA', 'NOTA_DEBITO') THEN
      RAISE EXCEPTION 'Una nota corrige una factura o una nota de débito, no una nota de crédito'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_aso.letra <> v_letra THEN
      RAISE EXCEPTION 'Una nota clase % corrige un comprobante de su misma letra, y el asociado es clase %', v_letra, v_aso.letra
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.asociada_a IS NOT NULL THEN
    RAISE EXCEPTION 'Sólo una nota de crédito o de débito lleva comprobante asociado'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER fiscal_emissions_asociacion
  BEFORE INSERT OR UPDATE OF asociada_a ON fiscal_emissions
  FOR EACH ROW EXECUTE FUNCTION assert_asociacion_de_emision();
