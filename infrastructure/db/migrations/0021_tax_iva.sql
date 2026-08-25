-- 0021_tax_iva.sql — IVA: alícuotas con norma, operaciones, subdiarios y Libro de IVA Digital.
--
-- Fuentes archivadas que gobiernan este archivo:
--   RG AFIP 4597/2019, texto actualizado (Libro de IVA Digital), modificada por
--   RG ARCA 5707/2025. INFOLEG_AFIP_RG_4597_2019_texto_actualizado.htm.
--
-- Lo que NO está archivado, y por eso no se refleja en ninguna regla de acá:
--   Ley 23.349 (IVA). Sin ella no hay alícuotas ni requisitos de cómputo del
--   crédito fiscal. La tabla `tax_rates` existe y está vacía: es la diferencia
--   entre "el sistema no sabe" y "el sistema supone 21%".
--
-- La decisión estructural del archivo es una sola columna:
--
--   tax_rates.norm_version_id  uuid  NOT NULL
--
-- Es ADR-005 hecho constraint. Una alícuota sin norma no se puede insertar, ni
-- por la aplicación ni por un `psql` manual. Es la razón por la que este sistema
-- puede decir de dónde sale cada número de una declaración jurada.

-- ---------------------------------------------------------------------------
-- Impuestos y alícuotas
-- ---------------------------------------------------------------------------
CREATE TABLE taxes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  code         text NOT NULL UNIQUE
                 CHECK (code IN ('IVA', 'IIBB', 'GANANCIAS', 'SUSS', 'INTERNOS')),
  name         text NOT NULL,
  jurisdiction text NOT NULL DEFAULT 'NACION',
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO taxes (code, name) VALUES ('IVA', 'Impuesto al Valor Agregado');

-- Alícuota como razón entera, nunca como decimal.
--
-- `numerator`/`denominator` en vez de `numeric(5,4)` por la misma razón por la
-- que los importes son bigint: 21/100 es exacto, 0.21 no lo es en binario, y una
-- alícuota que se multiplica por millones de pesos no puede tener un error de
-- representación en el factor.
CREATE TABLE tax_rates (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tax_id          uuid NOT NULL REFERENCES taxes (id),
  label           text NOT NULL,
  numerator       bigint NOT NULL CHECK (numerator >= 0),
  denominator     bigint NOT NULL CHECK (denominator > 0),
  valid_from      date NOT NULL,
  valid_to        date,

  -- ADR-005 hecho constraint: toda alícuota cita su norma. Sin esto la tabla
  -- sería un lugar donde alguien escribe 21 porque se acuerda.
  norm_version_id uuid NOT NULL REFERENCES norm_versions (id),
  -- Artículo exacto. La versión de la norma sola no alcanza para volver al texto.
  articulo        text NOT NULL CHECK (length(btrim(articulo)) > 0),

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,

  CONSTRAINT tax_rates_rango CHECK (valid_to IS NULL OR valid_from <= valid_to),
  -- Una alícuota mayor a 1 no es una alícuota: es un error de carga (2100 en vez
  -- de 21/100). El tope no lo fija ninguna norma; lo fija la aritmética.
  CONSTRAINT tax_rates_razonable CHECK (numerator <= denominator)
);

CREATE INDEX tax_rates_vigencia_idx ON tax_rates (tax_id, valid_from, valid_to);

-- Una alícuota publicada no se edita: se cierra con `valid_to` y se carga la
-- nueva. Editarla reescribiría la historia de todas las declaraciones que la
-- usaron.
CREATE OR REPLACE FUNCTION forbid_rate_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.numerator IS DISTINCT FROM OLD.numerator
  OR NEW.denominator IS DISTINCT FROM OLD.denominator
  OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
  OR NEW.norm_version_id IS DISTINCT FROM OLD.norm_version_id THEN
    RAISE EXCEPTION 'Una alícuota vigente no se reescribe: cerrala con valid_to y cargá la nueva. Editarla cambiaría todas las declaraciones que ya la usaron.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_rates_no_rewrite BEFORE UPDATE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_rate_rewrite();

CREATE TRIGGER tax_rates_no_delete BEFORE DELETE ON tax_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- Operaciones con IVA
-- ---------------------------------------------------------------------------
CREATE TABLE tax_transactions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  tax_id          uuid NOT NULL REFERENCES taxes (id),
  document_id     uuid REFERENCES documents (id),
  entry_id        uuid REFERENCES journal_entries (id),
  period_id       uuid NOT NULL REFERENCES periods (id),
  direction       text NOT NULL CHECK (direction IN ('COMPRAS', 'VENTAS')),

  -- Identificación del comprobante. El tipo es un código de ARCA; su clase se
  -- resuelve contra arca_comprobante_types POR FECHA, no contra una constante.
  cbte_tipo       integer NOT NULL,
  punto_venta     integer NOT NULL CHECK (punto_venta >= 0),
  cbte_numero     bigint NOT NULL CHECK (cbte_numero >= 0),
  cbte_fecha      date NOT NULL,
  cuit_contraparte text CHECK (cuit_contraparte IS NULL OR cuit_contraparte ~ '^[0-9]{11}$'),
  razon_social    text,
  condicion_iva   text NOT NULL DEFAULT 'DESCONOCIDA'
                    CHECK (condicion_iva IN ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO',
                                             'CONSUMIDOR_FINAL', 'NO_CATEGORIZADO', 'DESCONOCIDA')),

  -- Importes SIN signo. El signo lo pone la clase del comprobante al armar el
  -- subdiario. Guardarlos ya con signo obligaría a saber la clase al insertar,
  -- que es justo el dato que puede faltar.
  neto            numeric(18, 2) NOT NULL DEFAULT 0 CHECK (neto >= 0),
  iva             numeric(18, 2) NOT NULL DEFAULT 0 CHECK (iva >= 0),
  no_gravado      numeric(18, 2) NOT NULL DEFAULT 0 CHECK (no_gravado >= 0),
  exento          numeric(18, 2) NOT NULL DEFAULT 0 CHECK (exento >= 0),
  percepciones    numeric(18, 2) NOT NULL DEFAULT 0 CHECK (percepciones >= 0),
  total           numeric(18, 2) NOT NULL CHECK (total >= 0),

  -- `NULL` cuando no se pudo identificar. Es un estado legítimo y visible, no un
  -- hueco: la fila SIN IDENTIFICAR del subdiario sale de acá.
  tax_rate_id     uuid REFERENCES tax_rates (id),

  -- §11: los tres sellos, separados.
  constatacion    text NOT NULL DEFAULT 'NO_CONSULTADO'
                    CHECK (constatacion IN ('OK', 'WARN', 'FAIL', 'NO_VERIFICABLE', 'NO_CONSULTADO')),
  emisor_apocrifo boolean,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,

  -- El total declarado es la suma de sus partes. Sin tolerancia: un peso de
  -- diferencia significa que hay un concepto que nadie está leyendo.
  CONSTRAINT tax_tx_total_cierra
    CHECK (total = neto + iva + no_gravado + exento + percepciones)
);

CREATE INDEX tax_transactions_periodo_idx
  ON tax_transactions (company_id, direction, cbte_fecha);
CREATE INDEX tax_transactions_entry_idx ON tax_transactions (entry_id);

-- Un comprobante no entra dos veces al mismo subdiario.
CREATE UNIQUE INDEX tax_transactions_unico
  ON tax_transactions (company_id, direction, cbte_tipo, punto_venta, cbte_numero, cuit_contraparte)
  WHERE cuit_contraparte IS NOT NULL;

CREATE TRIGGER tax_transactions_no_delete BEFORE DELETE ON tax_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Ahora sí, la línea de asiento puede apuntar a su operación fiscal. La columna
-- existía desde la 0005 sin FK; el destino recién existe acá.
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT jel_tax_transaction_fk
    FOREIGN KEY (tax_transaction_id) REFERENCES tax_transactions (id);

-- ---------------------------------------------------------------------------
-- Libro de IVA Digital
-- ---------------------------------------------------------------------------
-- `PRESENTADO_POR_TERCERO` y no `PRESENTADO`: el nombre dice quién lo hizo.
-- El art. 6° de la RG 4597 exige Clave Fiscal Nivel 3 para el PORTAL IVA, y este
-- sistema no la pide ni la guarda. El sistema arma el libro; lo presenta una
-- persona, y acá se registra que dijo haberlo hecho.
CREATE TABLE vat_books (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  anio            integer NOT NULL CHECK (anio BETWEEN 2000 AND 2100),
  mes             integer NOT NULL CHECK (mes BETWEEN 1 AND 12),
  -- Art. 12: quince días corridos del mes inmediato siguiente.
  vencimiento     date NOT NULL,
  status          text NOT NULL DEFAULT 'PENDIENTE'
                    CHECK (status IN ('PENDIENTE', 'GENERADO', 'SIN_MOVIMIENTO',
                                      'PRESENTADO_POR_TERCERO')),
  comprobantes_compras integer NOT NULL DEFAULT 0 CHECK (comprobantes_compras >= 0),
  comprobantes_ventas  integer NOT NULL DEFAULT 0 CHECK (comprobantes_ventas >= 0),
  -- Hash del subdiario emitido. Es lo que hace verificable la referencia que el
  -- art. 327 del CCyC exige para un asiento resumido.
  compras_sha256  char(64),
  ventas_sha256   char(64),
  bloqueos        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Constancia que devuelve el portal. La carga la persona que presentó.
  acuse_recibo    text,
  generated_at    timestamptz,
  generated_by    text,

  UNIQUE (company_id, anio, mes),

  -- Art. 12: la obligación se cumple aun sin operaciones, informando la novedad
  -- SIN MOVIMIENTO. Declarar SIN_MOVIMIENTO con comprobantes cargados sería una
  -- declaración jurada falsa.
  CONSTRAINT vat_books_sin_movimiento_coherente
    CHECK (status <> 'SIN_MOVIMIENTO'
           OR (comprobantes_compras = 0 AND comprobantes_ventas = 0)),

  CONSTRAINT vat_books_generado_firmado
    CHECK (status = 'PENDIENTE' OR (generated_at IS NOT NULL AND generated_by IS NOT NULL))
);

CREATE INDEX vat_books_company_idx ON vat_books (company_id, anio DESC, mes DESC);

CREATE TABLE vat_book_lines (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  vat_book_id    uuid NOT NULL REFERENCES vat_books (id),
  tax_transaction_id uuid NOT NULL REFERENCES tax_transactions (id),
  direction      text NOT NULL CHECK (direction IN ('COMPRAS', 'VENTAS')),
  orden          integer NOT NULL CHECK (orden > 0),
  -- Acá SÍ con signo: una nota de crédito resta del período.
  neto           numeric(18, 2) NOT NULL,
  iva            numeric(18, 2) NOT NULL,
  no_gravado     numeric(18, 2) NOT NULL,
  exento         numeric(18, 2) NOT NULL,
  percepciones   numeric(18, 2) NOT NULL,
  total          numeric(18, 2) NOT NULL,
  hallazgos      jsonb NOT NULL DEFAULT '[]'::jsonb,
  excluido       boolean NOT NULL DEFAULT false,

  UNIQUE (vat_book_id, direction, orden),
  CONSTRAINT vat_line_total_cierra
    CHECK (total = neto + iva + no_gravado + exento + percepciones)
);

CREATE INDEX vat_book_lines_book_idx ON vat_book_lines (vat_book_id, direction, orden);

CREATE TRIGGER vat_book_lines_no_delete BEFORE DELETE ON vat_book_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- RLS y privilegios
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY['tax_transactions', 'vat_books', 'vat_book_lines'];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (company_id = app_company_id())
        WITH CHECK (company_id = app_company_id())
    $p$, scoped_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO aai_app', scoped_table);
  END LOOP;
END
$$;

-- Los impuestos y sus alícuotas son catálogo normativo: la aplicación los lee.
-- Cargarlos exige credenciales de migración y revisión humana, igual que las
-- normas y los prompts.
GRANT SELECT ON taxes, tax_rates TO aai_app;
REVOKE INSERT, UPDATE ON taxes, tax_rates FROM aai_app;

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('vat_book:read',     'Ver los subdiarios de IVA y el Libro de IVA Digital'),
  ('vat_book:generate', 'Generar el Libro de IVA Digital del período');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR' AND p.code IN ('vat_book:read', 'vat_book:generate');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('AUDITOR', 'ADMINISTRADOR') AND p.code = 'vat_book:read';

-- ---------------------------------------------------------------------------
-- Estado declarado de los datos
-- ---------------------------------------------------------------------------
-- `tax_rates` queda VACÍA. No es un olvido: cargar la alícuota general del IVA
-- exige archivar la Ley 23.349 con su texto y su artículo, y hasta que eso pase
-- el motor responde SIN_ALICUOTAS_RELEVADAS.
--
-- Es la diferencia entre un sistema que no sabe y uno que supone. El segundo se
-- ve mejor hasta el día que la operación no es al 21%.
COMMENT ON TABLE tax_rates IS
  'Alícuotas con su norma. VACÍA hasta archivar la Ley 23.349: el motor responde SIN_ALICUOTAS_RELEVADAS en vez de suponer 21%.';
