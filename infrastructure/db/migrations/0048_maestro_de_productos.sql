-- 0048_maestro_de_productos.sql — qué vende y qué compra la empresa.
--
-- Segundo maestro. Lo necesitan ventas, compras, stock, producción, POS y los
-- conectores de e-commerce: todos empiezan por saber **qué** se movió.
--
-- ## La alícuota NO se guarda acá
--
-- La tentación evidente es una columna `alicuota_iva numeric` con 21 adentro.
-- Sería exactamente el error que §6 prohíbe: usar la norma de hoy para una
-- operación de ayer. Las alícuotas viven en `tax_rates`, versionadas por fecha
-- y con la norma que las funda citada en la propia fila.
--
-- Lo que sí es un atributo estable del producto es **cómo está tratado frente
-- al impuesto**: un libro está exento hoy y lo estaba el año pasado, y si algún
-- día deja de estarlo eso es un cambio de la norma, no del libro. Por eso:
--
--   tax_treatment  GRAVADO / EXENTO / NO_GRAVADO   ← atributo del producto
--   tax_id         qué impuesto le aplica          ← atributo del producto
--   la alícuota    la resuelve el motor por fecha  ← NO vive acá
--
-- ## El precio de lista es una sugerencia, no un hecho
--
-- `list_price` es el precio vigente para proponer. **El precio de una venta es
-- el de esa venta** y se guarda en su propio renglón: si mañana sube la lista,
-- la factura de ayer no cambia. Por eso acá no hay historial de precios — el
-- historial que importa es el de lo que efectivamente se cobró, y ese lo lleva
-- el comprobante.
--
-- ## Las cuentas por defecto
--
-- `sales_account_id` y `purchase_account_id` son la imputación **sugerida**
-- cuando este producto entre en un asiento. No la imponen: quien firma el
-- asiento sigue siendo una persona, y ADR-001 no cambia por tener un maestro.

-- ---------------------------------------------------------------------------
-- 1 · La clave que permite referenciar una cuenta con su empresa
-- ---------------------------------------------------------------------------
-- Mismo argumento que en la 0047 para `parties`: una FK simple a
-- `accounts (id)` dejaría que un producto de una empresa apunte a la cuenta de
-- otra. RLS no lo impide —las restricciones foráneas se verifican con
-- privilegios del sistema— y el error sería silencioso hasta el balance.
ALTER TABLE accounts ADD CONSTRAINT accounts_id_empresa UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 2 · El maestro
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),

  code                text NOT NULL CHECK (length(btrim(code)) > 0),
  name                text NOT NULL CHECK (length(btrim(name)) > 0),
  description         text,

  kind                text NOT NULL DEFAULT 'PRODUCTO'
                        CHECK (kind IN ('PRODUCTO', 'SERVICIO')),

  -- Unidad en la que se mide. La lista es corta y controlada a propósito: la
  -- traducción a los códigos de unidad de ARCA para facturación electrónica es
  -- trabajo del adaptador, no del maestro. Un maestro que hablara el
  -- vocabulario de ARCA quedaría atado a una versión de su tabla de parámetros.
  unit                text NOT NULL DEFAULT 'UNIDAD'
                        CHECK (unit IN ('UNIDAD', 'KILOGRAMO', 'GRAMO', 'TONELADA',
                                        'LITRO', 'MILILITRO', 'METRO', 'METRO_CUADRADO',
                                        'METRO_CUBICO', 'HORA', 'DIA', 'MES',
                                        'DOCENA', 'CAJA', 'PAQUETE', 'OTRA')),

  tax_treatment       text NOT NULL DEFAULT 'GRAVADO'
                        CHECK (tax_treatment IN ('GRAVADO', 'EXENTO', 'NO_GRAVADO')),
  tax_id              uuid REFERENCES taxes (id),

  sales_account_id    uuid,
  purchase_account_id uuid,

  -- Si lleva stock. Un servicio nunca lo lleva, y el CHECK de abajo lo impide
  -- en vez de confiar en que nadie lo marque.
  tracks_stock        boolean NOT NULL DEFAULT false,

  -- Cuatro decimales: un precio unitario de lista admite más precisión que un
  -- importe contable, y redondear acá arrastraría el error a cada renglón.
  list_price          numeric(18, 4) CHECK (list_price IS NULL OR list_price >= 0),
  currency            text NOT NULL DEFAULT 'ARS',

  status              text NOT NULL DEFAULT 'ACTIVO'
                        CHECK (status IN ('ACTIVO', 'ARCHIVADO')),

  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Un producto gravado sin impuesto declarado no se puede facturar: faltaría
  -- justo el dato que hace falta para calcular. Se corta en el alta, no en la
  -- factura, que es donde el error costaría caro.
  CONSTRAINT products_gravado_con_impuesto
    CHECK (tax_treatment <> 'GRAVADO' OR tax_id IS NOT NULL),

  -- Un servicio no tiene existencias. Marcar lo contrario produciría un
  -- movimiento de stock de algo que no ocupa lugar en ningún depósito.
  CONSTRAINT products_servicio_sin_stock
    CHECK (kind <> 'SERVICIO' OR tracks_stock = false),

  CONSTRAINT products_id_empresa UNIQUE (company_id, id),

  CONSTRAINT products_cuenta_venta_fk
    FOREIGN KEY (company_id, sales_account_id) REFERENCES accounts (company_id, id),
  CONSTRAINT products_cuenta_compra_fk
    FOREIGN KEY (company_id, purchase_account_id) REFERENCES accounts (company_id, id)
);

-- El código es la referencia que usa la gente. Sin distinguir mayúsculas: quien
-- carga "sku-001" y quien carga "SKU-001" está hablando del mismo producto.
CREATE UNIQUE INDEX products_code_unico ON products (company_id, lower(code));
CREATE INDEX products_name_idx ON products (company_id, lower(name));
CREATE INDEX products_status_idx ON products (company_id, status, kind);

COMMENT ON TABLE products IS
  'Maestro de productos y servicios por empresa. No guarda alícuotas: el '
  'tratamiento frente al impuesto es del producto, la alícuota la resuelve el '
  'motor normativo por fecha de la operación (§6).';
COMMENT ON COLUMN products.list_price IS
  'Precio vigente para proponer. El precio de una venta es el de esa venta y '
  'se guarda en su renglón: cambiar esta columna no altera nada ya facturado.';
COMMENT ON COLUMN products.sales_account_id IS
  'Imputación sugerida, no impuesta. Quien firma el asiento sigue siendo una '
  'persona (ADR-001).';

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER products_no_delete
  BEFORE DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 3 · Coherencia de la cuenta sugerida
-- ---------------------------------------------------------------------------
-- Que la cuenta exista y sea de la empresa no alcanza. Una cuenta de venta
-- tiene que poder recibir una venta: si no es imputable, el asiento va a
-- fallar recién al armarlo, cuando ya hay una factura emitida esperando.
CREATE OR REPLACE FUNCTION assert_cuentas_del_producto() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imputable boolean;
  tipo text;
BEGIN
  IF NEW.sales_account_id IS NOT NULL THEN
    SELECT a.is_postable, a.type INTO imputable, tipo
      FROM accounts a WHERE a.id = NEW.sales_account_id;
    IF NOT imputable THEN
      RAISE EXCEPTION 'La cuenta de venta no es imputable: un asiento no puede apoyarse en ella'
        USING ERRCODE = 'check_violation';
    END IF;
    IF tipo NOT IN ('INGRESO', 'ACTIVO') THEN
      RAISE EXCEPTION 'La cuenta de venta es de tipo %: se esperaba INGRESO', tipo
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.purchase_account_id IS NOT NULL THEN
    SELECT a.is_postable, a.type INTO imputable, tipo
      FROM accounts a WHERE a.id = NEW.purchase_account_id;
    IF NOT imputable THEN
      RAISE EXCEPTION 'La cuenta de compra no es imputable: un asiento no puede apoyarse en ella'
        USING ERRCODE = 'check_violation';
    END IF;
    -- ACTIVO es legítimo: una compra de mercadería para reventa va a bienes de
    -- cambio, no a resultado. COSTO y GASTO también. PASIVO no.
    IF tipo NOT IN ('COSTO', 'GASTO', 'ACTIVO') THEN
      RAISE EXCEPTION 'La cuenta de compra es de tipo %: se esperaba COSTO, GASTO o ACTIVO', tipo
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER products_cuentas_coherentes
  BEFORE INSERT OR UPDATE OF sales_account_id, purchase_account_id ON products
  FOR EACH ROW EXECUTE FUNCTION assert_cuentas_del_producto();

-- ---------------------------------------------------------------------------
-- 4 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('product:read',  'Consultar el maestro de productos y servicios'),
  ('product:write', 'Dar de alta, editar y archivar productos');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'product:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
  AND p.code = 'product:write';

-- ---------------------------------------------------------------------------
-- 5 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON products TO aai_app;
