-- 0049_renglones_de_comprobante.sql — el detalle de qué se compró o vendió.
--
-- Hasta acá `tax_transactions` guarda **totales por comprobante**: neto, IVA,
-- exento, total. Alcanza para el subdiario de IVA y para el asiento, que es
-- exactamente para lo que se lo diseñó. No alcanza para nada de lo que viene
-- después:
--
--   - no se puede saber qué producto se vendió;
--   - no se puede calcular un margen, porque no hay costo por línea;
--   - no se puede mover stock, porque no se sabe cuántas unidades salieron;
--   - los conectores de e-commerce no tienen dónde escribir el detalle que
--     traen de la tienda.
--
-- ## Por qué se extiende y no se crea un documento comercial nuevo
--
-- La tentación es una tabla `facturas` con sus renglones, paralela a
-- `tax_transactions`. Sería una segunda verdad sobre el mismo hecho: dos filas
-- que describen la misma factura y que algún día no van a coincidir. La
-- operación fiscal **ya es** el comprobante; lo que le falta es el detalle.
--
-- ## Los renglones son opcionales, y cuando están tienen que cerrar
--
-- Un comprobante sin renglones sigue siendo válido: es lo que pasa con todo lo
-- cargado hasta hoy y con lo que llega por OCR sin detalle legible. Pero si hay
-- renglones, **la suma tiene que dar los totales de la cabecera**, y se verifica
-- al `COMMIT` con un `CONSTRAINT TRIGGER` diferido — igual que `Debe = Haber`.
--
-- Sin diferir sería imposible: los renglones se insertan después de la
-- cabecera, y el primero encontraría la suma incompleta.
--
-- Cada tratamiento suma en su propia columna. Un renglón exento no engrosa el
-- neto gravado: si lo hiciera, el subdiario de IVA saldría mal por un dato que
-- se cargó bien.
--
--   GRAVADO     → neto        + su iva
--   EXENTO      → exento
--   NO_GRAVADO  → no_gravado

-- ---------------------------------------------------------------------------
-- 1 · La clave que permite referenciar el comprobante con su empresa
-- ---------------------------------------------------------------------------
ALTER TABLE tax_transactions ADD CONSTRAINT tax_transactions_id_empresa UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 2 · Los renglones
-- ---------------------------------------------------------------------------
CREATE TABLE tax_transaction_lines (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),
  tax_transaction_id uuid NOT NULL,
  line_no            integer NOT NULL CHECK (line_no > 0),

  -- `NULL` es legítimo y frecuente: el comprobante de un proveedor describe
  -- cosas que no están en el maestro de esta empresa, y obligar a darlas de
  -- alta para poder registrar la factura invertiría la prioridad — primero se
  -- registra lo que pasó, después se ordena el maestro.
  product_id         uuid,

  -- Lo que dice el renglón del comprobante. Se guarda aunque haya producto:
  -- el papel describe con sus palabras y esas son las que hay que poder leer
  -- dentro de tres años.
  descripcion        text NOT NULL CHECK (length(btrim(descripcion)) > 0),

  cantidad           numeric(18, 4) NOT NULL CHECK (cantidad > 0),
  unidad             text NOT NULL DEFAULT 'UNIDAD',
  precio_unitario    numeric(18, 4) NOT NULL CHECK (precio_unitario >= 0),
  descuento          numeric(18, 2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),

  tratamiento        text NOT NULL DEFAULT 'GRAVADO'
                       CHECK (tratamiento IN ('GRAVADO', 'EXENTO', 'NO_GRAVADO')),

  -- Importes ya resueltos, sin signo, como en la cabecera. El signo lo pone la
  -- clase del comprobante al armar el subdiario.
  neto               numeric(18, 2) NOT NULL CHECK (neto >= 0),
  iva                numeric(18, 2) NOT NULL DEFAULT 0 CHECK (iva >= 0),

  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tax_transaction_id, line_no),

  -- Un renglón no gravado con IVA es una contradicción, no un caso raro.
  CONSTRAINT ttl_iva_solo_si_grava
    CHECK (tratamiento = 'GRAVADO' OR iva = 0),

  CONSTRAINT ttl_comprobante_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id),

  CONSTRAINT ttl_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id)
);

CREATE INDEX ttl_comprobante_idx ON tax_transaction_lines (tax_transaction_id, line_no);
CREATE INDEX ttl_producto_idx ON tax_transaction_lines (company_id, product_id)
  WHERE product_id IS NOT NULL;

COMMENT ON TABLE tax_transaction_lines IS
  'Detalle de una operación fiscal. Opcional: un comprobante sin renglones es '
  'válido. Si los tiene, la suma por tratamiento tiene que dar los totales de '
  'la cabecera, verificado al COMMIT.';
COMMENT ON COLUMN tax_transaction_lines.product_id IS
  'NULL cuando lo facturado no está en el maestro. Registrar lo que pasó tiene '
  'prioridad sobre ordenar el maestro.';

-- ---------------------------------------------------------------------------
-- 3 · Los renglones se reemplazan mientras el comprobante no fundó un asiento
-- ---------------------------------------------------------------------------
-- A diferencia del resto del sistema, acá el borrado **sí** se permite: la
-- forma natural de corregir el detalle es reemplazarlo entero. Lo que no se
-- permite es tocarlo una vez que hay un asiento aprobado apoyado en él.
-- Corregir el detalle de un comprobante todavía no imputado es trabajo normal:
-- alguien tipeó mal una cantidad. Corregirlo cuando ya hay un asiento aprobado
-- que se apoya en él no lo es — ahí el camino es el contraasiento (ADR-003).
CREATE OR REPLACE FUNCTION assert_renglones_editables() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fila tax_transaction_lines%ROWTYPE;
  imputado boolean;
BEGIN
  fila := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;

  SELECT EXISTS (
    SELECT 1 FROM journal_entries e
     WHERE e.company_id = fila.company_id
       AND e.source_id = fila.tax_transaction_id
       AND e.status = 'APROBADO')
    INTO imputado;

  IF imputado THEN
    RAISE EXCEPTION
      'El comprobante % ya funda un asiento aprobado: su detalle no se edita. Corregí por contraasiento.',
      fila.tax_transaction_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN fila;
END;
$$;

CREATE TRIGGER ttl_editables
  BEFORE INSERT OR UPDATE OR DELETE ON tax_transaction_lines
  FOR EACH ROW EXECUTE FUNCTION assert_renglones_editables();

-- ---------------------------------------------------------------------------
-- 4 · Si hay renglones, cierran contra la cabecera
-- ---------------------------------------------------------------------------
-- Mismo diseño que `je_entry_consistent`: diferido al `COMMIT`, porque los
-- renglones llegan después de la cabecera y una verificación inmediata vería
-- siempre una suma incompleta.
--
-- Sin tolerancia. Un peso de diferencia significa que hay un concepto que nadie
-- está leyendo, y ese peso multiplicado por un año de comprobantes es lo que
-- después no cuadra en la declaración jurada.
CREATE OR REPLACE FUNCTION assert_renglones_cierran() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  comprobante uuid;
  cab tax_transactions%ROWTYPE;
  cantidad integer;
  s_neto numeric(18, 2);
  s_iva numeric(18, 2);
  s_exento numeric(18, 2);
  s_no_gravado numeric(18, 2);
BEGIN
  -- Dos ramas y no un `CASE`: PL/pgSQL prepara la expresión entera antes de
  -- evaluarla, y `NEW.tax_transaction_id` no existe cuando el disparo viene de
  -- `tax_transactions`. Con `IF` cada rama se compila recién al ejecutarse.
  -- Es el mismo motivo por el que `assert_period_open` está escrito así.
  IF TG_TABLE_NAME = 'tax_transactions' THEN
    comprobante := NEW.id;
  ELSE
    comprobante := NEW.tax_transaction_id;
  END IF;

  SELECT * INTO cab FROM tax_transactions WHERE id = comprobante;
  -- El comprobante puede haber desaparecido dentro de la misma transacción.
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*),
         coalesce(sum(l.neto) FILTER (WHERE l.tratamiento = 'GRAVADO'), 0),
         coalesce(sum(l.iva), 0),
         coalesce(sum(l.neto) FILTER (WHERE l.tratamiento = 'EXENTO'), 0),
         coalesce(sum(l.neto) FILTER (WHERE l.tratamiento = 'NO_GRAVADO'), 0)
    INTO cantidad, s_neto, s_iva, s_exento, s_no_gravado
    FROM tax_transaction_lines l
   WHERE l.tax_transaction_id = comprobante;

  -- Sin renglones no hay nada que verificar. Es el estado de todo lo cargado
  -- antes de esta migración y de lo que llega sin detalle legible.
  IF cantidad = 0 THEN RETURN NULL; END IF;

  IF s_neto <> cab.neto OR s_iva <> cab.iva
     OR s_exento <> cab.exento OR s_no_gravado <> cab.no_gravado THEN
    RAISE EXCEPTION
      'Los renglones no cierran con la cabecera. Renglones: neto %, iva %, exento %, no gravado %. Cabecera: neto %, iva %, exento %, no gravado %.',
      s_neto, s_iva, s_exento, s_no_gravado, cab.neto, cab.iva, cab.exento, cab.no_gravado
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ttl_renglones_cierran
  AFTER INSERT OR UPDATE ON tax_transaction_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_renglones_cierran();

CREATE CONSTRAINT TRIGGER tt_renglones_cierran
  AFTER INSERT OR UPDATE ON tax_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_renglones_cierran();

-- ---------------------------------------------------------------------------
-- 5 · Qué se vendió de cada producto
-- ---------------------------------------------------------------------------
-- La primera lectura que los renglones habilitan, y la que justifica el
-- trabajo: cuánto se movió de cada producto y por cuánta plata. Derivada, como
-- la cuenta corriente — no hay un acumulado que mantener al día.
CREATE VIEW product_movements WITH (security_invoker = true) AS
SELECT p.company_id,
       p.id                       AS product_id,
       p.code                     AS codigo,
       p.name                     AS nombre,
       t.direction                AS direccion,
       count(*)::int              AS comprobantes,
       sum(l.cantidad)            AS cantidad,
       sum(l.neto)                AS neto,
       min(t.cbte_fecha)          AS primera,
       max(t.cbte_fecha)          AS ultima
  FROM tax_transaction_lines l
  JOIN products p
    ON p.id = l.product_id AND p.company_id = l.company_id
  JOIN tax_transactions t
    ON t.id = l.tax_transaction_id AND t.company_id = l.company_id
 GROUP BY p.company_id, p.id, p.code, p.name, t.direction;

COMMENT ON VIEW product_movements IS
  'Qué se compró y qué se vendió de cada producto, derivado de los renglones. '
  'No es stock: es movimiento facturado. El stock necesita depósitos y '
  'movimientos que no sean comprobantes, y todavía no existen.';

-- ---------------------------------------------------------------------------
-- 6 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE tax_transaction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_transaction_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_transaction_lines
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tax_transaction_lines TO aai_app;
GRANT SELECT ON product_movements TO aai_app;
