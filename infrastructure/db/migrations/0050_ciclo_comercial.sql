-- 0050_ciclo_comercial.sql — presupuesto y pedido, antes de que haya factura.
--
-- ## Qué falta y qué no
--
-- La factura ya existe: es `tax_transactions`. Lo que no existe es lo que pasa
-- **antes** — el presupuesto que se le manda al cliente y el pedido que
-- confirma. Son documentos comerciales sin efecto fiscal: no tienen CAE, no van
-- al subdiario de IVA y no producen asiento. Un presupuesto rechazado no dejó
-- ninguna huella contable, y así tiene que ser.
--
-- ## Por qué NO se crea una tabla `facturas`
--
-- Sería una segunda verdad sobre el mismo hecho: dos filas describiendo la
-- misma factura, que algún día no van a coincidir. Cuando un pedido se factura,
-- **se convierte** en una operación fiscal —con sus renglones, los de la 0049—
-- y el documento comercial guarda a cuál dio lugar. Un vínculo, una dirección.
--
--   PRESUPUESTO ──► PEDIDO ──► tax_transactions ──► decisión ──► asiento
--        (comercial)              (fiscal, ya existía)
--
-- ## VENCIDO no es un estado
--
-- La tentación es agregarlo al CHECK junto a EMITIDO y ACEPTADO. Sería un
-- estado que alguien tiene que acordarse de escribir, y que va a estar mal
-- siempre: un presupuesto no vence porque un usuario abra la pantalla, vence
-- porque pasó la fecha. Se **deriva** en la vista, preguntando por el hecho.
--
-- Es el mismo criterio que ya se aplicó al candado de anulación de documentos,
-- a la bandeja de trabajo y a la cuenta corriente.
--
-- ## Por qué la tabla sirve también para compras
--
-- Una orden de compra es un pedido con la dirección invertida, y un presupuesto
-- de un proveedor es un presupuesto recibido. Mismo vocabulario que
-- `tax_transactions` —COMPRAS / VENTAS— para que las dos mitades del circuito
-- no hablen idiomas distintos. Crear `ordenes_de_compra` aparte habría sido la
-- misma tabla con otro nombre.

-- ---------------------------------------------------------------------------
-- 1 · Numeración propia, por empresa, dirección y tipo
-- ---------------------------------------------------------------------------
-- No es la numeración fiscal: un presupuesto no lleva punto de venta ni CAE.
-- Es la que usa la empresa para referirse a sus propios documentos.
CREATE TABLE commercial_counters (
  company_id  uuid NOT NULL REFERENCES companies (id),
  direction   text NOT NULL CHECK (direction IN ('COMPRAS', 'VENTAS')),
  kind        text NOT NULL CHECK (kind IN ('PRESUPUESTO', 'PEDIDO')),
  last_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, direction, kind)
);

CREATE OR REPLACE FUNCTION next_commercial_number(
  p_company_id uuid,
  p_direction text,
  p_kind text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  next_value integer;
BEGIN
  INSERT INTO commercial_counters (company_id, direction, kind, last_number)
  VALUES (p_company_id, p_direction, p_kind, 0)
  ON CONFLICT DO NOTHING;

  UPDATE commercial_counters
     SET last_number = last_number + 1
   WHERE company_id = p_company_id AND direction = p_direction AND kind = p_kind
  RETURNING last_number INTO next_value;

  RETURN next_value;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 · El documento comercial
-- ---------------------------------------------------------------------------
CREATE TABLE commercial_documents (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id         uuid NOT NULL REFERENCES companies (id),

  direction          text NOT NULL CHECK (direction IN ('COMPRAS', 'VENTAS')),
  kind               text NOT NULL CHECK (kind IN ('PRESUPUESTO', 'PEDIDO')),
  number             integer NOT NULL CHECK (number > 0),

  -- Siempre se sabe a quién. Para el mostrador está el tercero
  -- `SIN_IDENTIFICAR` de la 0047: es un tercero real, no un hueco.
  party_id           uuid NOT NULL,

  issue_date         date NOT NULL,
  -- Solo tiene sentido en un presupuesto. Un pedido confirmado no vence: se
  -- cumple, se anula o se factura.
  valid_until        date,

  currency           text NOT NULL DEFAULT 'ARS',
  notes              text,

  status             text NOT NULL DEFAULT 'BORRADOR'
                       CHECK (status IN ('BORRADOR', 'EMITIDO', 'ACEPTADO',
                                         'RECHAZADO', 'FACTURADO', 'ANULADO')),

  -- La operación fiscal a la que dio lugar. NULL mientras no se facturó.
  tax_transaction_id uuid,

  -- Una revisión reemplaza a la anterior en vez de editarla. Mismo criterio que
  -- las notas complementarias: lo que se le mandó al cliente se mandó, y el
  -- historial de qué se ofreció antes es parte del expediente comercial.
  supersedes_id      uuid,

  motivo_anulacion   text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, direction, kind, number),

  CONSTRAINT cd_vencimiento_solo_presupuesto
    CHECK (valid_until IS NULL OR kind = 'PRESUPUESTO'),
  CONSTRAINT cd_vencimiento_posterior
    CHECK (valid_until IS NULL OR valid_until >= issue_date),

  -- Un documento FACTURADO dice a qué operación dio lugar, y uno que no lo está
  -- no puede señalar ninguna. Las dos mitades: sin la segunda, quedaría un
  -- vínculo colgado si alguien retrocede el estado.
  CONSTRAINT cd_facturado_con_operacion
    CHECK ((status = 'FACTURADO') = (tax_transaction_id IS NOT NULL)),

  CONSTRAINT cd_anulado_con_motivo
    CHECK (status <> 'ANULADO' OR length(btrim(coalesce(motivo_anulacion, ''))) > 2),

  CONSTRAINT cd_id_empresa UNIQUE (company_id, id),

  CONSTRAINT cd_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT cd_tax_transaction_fk
    FOREIGN KEY (company_id, tax_transaction_id)
    REFERENCES tax_transactions (company_id, id),
  CONSTRAINT cd_supersedes_fk
    FOREIGN KEY (company_id, supersedes_id) REFERENCES commercial_documents (company_id, id)
);

-- Un documento reemplaza como mucho a uno anterior, y nadie reemplaza al mismo
-- dos veces: si no, el historial se ramifica y deja de ser un historial.
CREATE UNIQUE INDEX cd_una_sucesora ON commercial_documents (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Una operación fiscal nace de un solo documento comercial.
CREATE UNIQUE INDEX cd_una_operacion ON commercial_documents (tax_transaction_id)
  WHERE tax_transaction_id IS NOT NULL;

CREATE INDEX cd_por_tercero ON commercial_documents (company_id, party_id, issue_date DESC);
CREATE INDEX cd_por_estado ON commercial_documents (company_id, direction, status);

COMMENT ON TABLE commercial_documents IS
  'Presupuestos y pedidos, de venta y de compra. Sin efecto fiscal: no hay CAE, '
  'no van al subdiario y no producen asiento. Al facturarse dan lugar a una '
  'tax_transaction y guardan cuál.';
COMMENT ON COLUMN commercial_documents.valid_until IS
  'Solo en presupuestos. VENCIDO no es un estado almacenado: se deriva de esta '
  'fecha en la vista commercial_document_status.';

CREATE TRIGGER commercial_documents_updated_at
  BEFORE UPDATE ON commercial_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER commercial_documents_no_delete
  BEFORE DELETE ON commercial_documents
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 3 · Los renglones
-- ---------------------------------------------------------------------------
-- Misma forma que `tax_transaction_lines` y tabla distinta a propósito. Comparten
-- la forma porque describen lo mismo; no comparten la fila porque tienen ciclos
-- de vida distintos: un renglón de presupuesto se edita mientras el documento
-- está en borrador y desaparece si el presupuesto se rechaza, y un renglón de
-- comprobante es evidencia de algo que ya pasó.
CREATE TABLE commercial_document_lines (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  document_id     uuid NOT NULL,
  line_no         integer NOT NULL CHECK (line_no > 0),

  product_id      uuid,
  descripcion     text NOT NULL CHECK (length(btrim(descripcion)) > 0),

  cantidad        numeric(18, 4) NOT NULL CHECK (cantidad > 0),
  unidad          text NOT NULL DEFAULT 'UNIDAD',
  precio_unitario numeric(18, 4) NOT NULL CHECK (precio_unitario >= 0),
  descuento       numeric(18, 2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),

  tratamiento     text NOT NULL DEFAULT 'GRAVADO'
                    CHECK (tratamiento IN ('GRAVADO', 'EXENTO', 'NO_GRAVADO')),

  neto            numeric(18, 2) NOT NULL CHECK (neto >= 0),
  iva             numeric(18, 2) NOT NULL DEFAULT 0 CHECK (iva >= 0),

  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (document_id, line_no),

  CONSTRAINT cdl_iva_solo_si_grava CHECK (tratamiento = 'GRAVADO' OR iva = 0),

  CONSTRAINT cdl_documento_fk
    FOREIGN KEY (company_id, document_id) REFERENCES commercial_documents (company_id, id),
  CONSTRAINT cdl_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id)
);

CREATE INDEX cdl_documento_idx ON commercial_document_lines (document_id, line_no);
CREATE INDEX cdl_producto_idx ON commercial_document_lines (company_id, product_id)
  WHERE product_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4 · Lo que se emitió, se emitió
-- ---------------------------------------------------------------------------
-- Los renglones se editan mientras el documento está en BORRADOR. Después no:
-- un presupuesto EMITIDO se le mandó al cliente, y cambiarle el precio sin que
-- se entere convierte el expediente comercial en ficción. Para corregir se
-- emite una revisión que reemplaza a la anterior (`supersedes_id`).
CREATE OR REPLACE FUNCTION assert_renglones_comerciales_editables() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fila commercial_document_lines%ROWTYPE;
  estado text;
BEGIN
  fila := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;

  SELECT d.status INTO estado
    FROM commercial_documents d
   WHERE d.id = fila.document_id AND d.company_id = fila.company_id;

  -- El documento puede haber desaparecido dentro de la misma transacción.
  IF NOT FOUND THEN RETURN fila; END IF;

  IF estado <> 'BORRADOR' THEN
    RAISE EXCEPTION
      'El documento % está en %: su detalle no se edita. Emitilo de nuevo como revisión.',
      fila.document_id, estado
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN fila;
END;
$$;

CREATE TRIGGER cdl_editables
  BEFORE INSERT OR UPDATE OR DELETE ON commercial_document_lines
  FOR EACH ROW EXECUTE FUNCTION assert_renglones_comerciales_editables();

-- ---------------------------------------------------------------------------
-- 5 · La máquina de estados
-- ---------------------------------------------------------------------------
-- En la base y no solo en TypeScript, por el mismo motivo que `periods`: un
-- estado alcanzable por SQL es un estado alcanzable.
CREATE OR REPLACE FUNCTION assert_transicion_comercial() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  permitidas text[];
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  permitidas := CASE OLD.status
    WHEN 'BORRADOR'  THEN ARRAY['EMITIDO', 'ANULADO']
    WHEN 'EMITIDO'   THEN ARRAY['ACEPTADO', 'RECHAZADO', 'ANULADO']
    -- Un pedido aceptado se factura. También puede anularse: el cliente se
    -- arrepintió antes de que saliera la factura, y eso pasa.
    WHEN 'ACEPTADO'  THEN ARRAY['FACTURADO', 'ANULADO']
    -- RECHAZADO, FACTURADO y ANULADO son terminales. Un rechazo que se
    -- «desrechaza» borraría el hecho de que el cliente dijo que no; lo que
    -- corresponde es una revisión nueva.
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (permitidas)) THEN
    RAISE EXCEPTION 'Transición inválida: % → %. Desde % solo se puede ir a %.',
      OLD.status, NEW.status, OLD.status,
      CASE WHEN array_length(permitidas, 1) IS NULL
           THEN 'ningún estado: es terminal'
           ELSE array_to_string(permitidas, ', ') END
      USING ERRCODE = 'check_violation';
  END IF;

  -- Un documento no se emite vacío. El renglón es lo que se está ofreciendo.
  IF NEW.status = 'EMITIDO' THEN
    IF NOT EXISTS (SELECT 1 FROM commercial_document_lines l WHERE l.document_id = NEW.id) THEN
      RAISE EXCEPTION 'No se emite un documento sin renglones: no habría nada ofrecido'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER commercial_documents_transicion
  BEFORE UPDATE ON commercial_documents
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_comercial();

-- ---------------------------------------------------------------------------
-- 6 · Los totales y el vencimiento, derivados
-- ---------------------------------------------------------------------------
-- Ningún total almacenado. Un presupuesto EMITIDO no puede cambiar de importe
-- porque sus renglones son inmutables (punto 4): el total es estable sin
-- necesidad de congelarlo en una columna que después habría que mantener.
CREATE VIEW commercial_document_status WITH (security_invoker = true) AS
SELECT d.company_id,
       d.id,
       d.direction,
       d.kind,
       d.number,
       d.party_id,
       p.razon_social,
       d.issue_date,
       d.valid_until,
       d.status,
       d.currency,
       d.tax_transaction_id,
       d.supersedes_id,

       -- VENCIDO derivado. No es un estado: es una lectura de la fecha. Solo
       -- tiene sentido mientras el documento espera respuesta.
       (d.kind = 'PRESUPUESTO'
        AND d.status = 'EMITIDO'
        AND d.valid_until IS NOT NULL
        AND d.valid_until < current_date)               AS vencido,

       coalesce(t.renglones, 0)                          AS renglones,
       coalesce(t.neto, 0)                               AS neto,
       coalesce(t.iva, 0)                                AS iva,
       coalesce(t.exento, 0)                             AS exento,
       coalesce(t.no_gravado, 0)                         AS no_gravado,
       coalesce(t.neto, 0) + coalesce(t.iva, 0)
         + coalesce(t.exento, 0) + coalesce(t.no_gravado, 0) AS total
  FROM commercial_documents d
  JOIN parties p ON p.id = d.party_id AND p.company_id = d.company_id
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS renglones,
               coalesce(sum(l.neto) FILTER (WHERE l.tratamiento = 'GRAVADO'), 0) AS neto,
               coalesce(sum(l.iva), 0) AS iva,
               coalesce(sum(l.neto) FILTER (WHERE l.tratamiento = 'EXENTO'), 0) AS exento,
               coalesce(sum(l.neto) FILTER (WHERE l.tratamiento = 'NO_GRAVADO'), 0) AS no_gravado
          FROM commercial_document_lines l
         WHERE l.document_id = d.id AND l.company_id = d.company_id
       ) t ON true;

COMMENT ON VIEW commercial_document_status IS
  'Documentos comerciales con sus totales y su vencimiento derivados. No hay '
  'columna de total ni estado VENCIDO: los dos se calculan de los hechos.';

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('commercial:read',  'Consultar presupuestos y pedidos'),
  ('commercial:write', 'Crear, emitir y responder presupuestos y pedidos');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'commercial:read';

-- Un presupuesto es un compromiso comercial, no un acto contable: el usuario de
-- empresa lo hace. Facturarlo sí es un acto contable, y ese permiso es otro
-- (`journal_entry:create`), que este rol no tiene.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code = 'commercial:write';

-- ---------------------------------------------------------------------------
-- 8 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE commercial_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commercial_documents
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE commercial_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_document_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commercial_document_lines
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE commercial_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commercial_counters
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON commercial_documents TO aai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON commercial_document_lines TO aai_app;
GRANT SELECT, INSERT, UPDATE ON commercial_counters TO aai_app;
GRANT SELECT ON commercial_document_status TO aai_app;
