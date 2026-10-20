-- ---------------------------------------------------------------------------
-- Puestos predeterminados: cada persona ve los módulos de su trabajo
-- ---------------------------------------------------------------------------
--
-- Hasta acá había seis roles pensados por **nivel de acceso** (administrar, contar, auditar, cargar, consultar). Una empresa real se organiza
-- por **puestos**: quien vende no maneja la caja, quien hace la tesorería no carga el stock, y quien dirige quiere ver todo sin tocar la
-- contabilidad. Esta migración agrega cinco puestos predeterminados. Cada uno es un rol (el mecanismo de siempre: `user_company_roles`,
-- `grant_company_role`, permisos en `role_permissions`), así que **los módulos de cada persona salen de sus permisos**: la consola ya esconde
-- lo que el rol no puede usar (`aplicarPermisosANav`) y el servidor lo rechaza de todos modos.
--
-- ## Los criterios (mínimo privilegio)
--
--   · Ningún puesto nuevo toca la **contabilidad** (`journal_entry:*`, períodos, estados, libros): eso es del Contador.
--   · Ninguno **administra el sistema** (`user:manage`, secretos, ARCA, suscripción): eso es del Administrador.
--   · **Quien propone no aprueba.** El Tesorero arma las órdenes de pago y no las aprueba; el Comprador pide y no aprueba; sólo el Gerente
--     aprueba pedidos de compra y órdenes de pago. El Encargado de depósito cuenta y mueve stock, pero no hace ajustes (`stock:adjust`).
--   · Todos pueden entrar (`company:read`), ver los documentos de su área y usar el asistente (`intelligence:ask`).
--   · Los puestos que mueven plata o aprueban (Gerente, Tesorero) exigen **segundo factor**, como Administrador, Contador y Auditor.
--
-- Los roles se suman: una misma persona puede ser Vendedora y Compradora en una empresa chica.
-- ---------------------------------------------------------------------------

ALTER TABLE roles DROP CONSTRAINT roles_code_check;
ALTER TABLE roles ADD CONSTRAINT roles_code_check CHECK (code IN (
  'ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'CARGADOR', 'SOLO_LECTURA',
  'GERENTE', 'VENDEDOR', 'COMPRADOR', 'TESORERO', 'DEPOSITO'));

INSERT INTO roles (code, name, description) VALUES
  ('GERENTE',   'Gerente',                'Dirección: ve todo el negocio, aprueba pedidos de compra y órdenes de pago y registra decisiones. No toca la contabilidad'),
  ('VENDEDOR',  'Vendedor',               'Ventas: presupuestos y pedidos, clientes, productos y precios, CRM y sus comisiones'),
  ('COMPRADOR', 'Comprador',              'Compras: pedidos de compra, proveedores y recepciones. Pide, no aprueba'),
  ('TESORERO',  'Tesorero',               'Tesorería: caja, bancos, cheques y órdenes de pago. Arma los pagos, no los aprueba'),
  ('DEPOSITO',  'Encargado de depósito',  'Depósito: stock, recuentos y recepciones de mercadería. No hace ajustes de stock');

-- Una fila por (puesto, permiso). Si un permiso no existe la migración se cae: no queda un puesto a medias.
WITH asignacion(puesto, permiso) AS (VALUES
  -- GERENTE ------------------------------------------------------------------
  ('GERENTE','company:read'), ('GERENTE','account:read'), ('GERENTE','alert:read'), ('GERENTE','alert:acknowledge'),
  ('GERENTE','allocation:read'), ('GERENTE','analysis:read'), ('GERENTE','analytics:read'), ('GERENTE','asset:read'),
  ('GERENTE','audit:read'), ('GERENTE','bank:read'), ('GERENTE','billing:read'), ('GERENTE','branch:read'),
  ('GERENTE','cash:read'), ('GERENTE','check:read'), ('GERENTE','commercial:read'), ('GERENTE','commission:read'),
  ('GERENTE','cost_center:read'), ('GERENTE','crm:read'), ('GERENTE','decision:read'), ('GERENTE','decision:write'),
  ('GERENTE','decision:approve'), ('GERENTE','document:read'), ('GERENTE','intelligence:ask'), ('GERENTE','journal_entry:read'),
  ('GERENTE','party:read'), ('GERENTE','payment_order:read'), ('GERENTE','payment_order:approve'), ('GERENTE','period:read'),
  ('GERENTE','prediction:read'), ('GERENTE','product:read'), ('GERENTE','project:read'), ('GERENTE','purchase_request:read'),
  ('GERENTE','purchase_request:approve'), ('GERENTE','receipt:read'), ('GERENTE','report:read'), ('GERENTE','statement:read'),
  ('GERENTE','stock:read'), ('GERENTE','vat_book:read'),
  -- VENDEDOR -----------------------------------------------------------------
  ('VENDEDOR','company:read'), ('VENDEDOR','branch:read'), ('VENDEDOR','commercial:read'), ('VENDEDOR','commercial:write'),
  ('VENDEDOR','commission:read'), ('VENDEDOR','crm:read'), ('VENDEDOR','crm:write'), ('VENDEDOR','document:read'),
  ('VENDEDOR','intelligence:ask'), ('VENDEDOR','party:read'), ('VENDEDOR','party:write'), ('VENDEDOR','product:read'),
  -- COMPRADOR ----------------------------------------------------------------
  ('COMPRADOR','company:read'), ('COMPRADOR','document:read'), ('COMPRADOR','document:upload'), ('COMPRADOR','intelligence:ask'),
  ('COMPRADOR','party:read'), ('COMPRADOR','party:write'), ('COMPRADOR','payment_order:read'), ('COMPRADOR','product:read'),
  ('COMPRADOR','purchase_request:read'), ('COMPRADOR','purchase_request:write'), ('COMPRADOR','receipt:read'), ('COMPRADOR','stock:read'),
  -- TESORERO -----------------------------------------------------------------
  ('TESORERO','company:read'), ('TESORERO','bank:read'), ('TESORERO','bank:import'), ('TESORERO','bank:reconcile'),
  ('TESORERO','cash:read'), ('TESORERO','cash:write'), ('TESORERO','check:read'), ('TESORERO','check:write'),
  ('TESORERO','document:read'), ('TESORERO','intelligence:ask'), ('TESORERO','party:read'), ('TESORERO','payment_order:read'),
  ('TESORERO','payment_order:write'),
  -- DEPOSITO -----------------------------------------------------------------
  ('DEPOSITO','company:read'), ('DEPOSITO','document:read'), ('DEPOSITO','intelligence:ask'), ('DEPOSITO','product:read'),
  ('DEPOSITO','purchase_request:read'), ('DEPOSITO','receipt:read'), ('DEPOSITO','receipt:write'), ('DEPOSITO','stock:count'),
  ('DEPOSITO','stock:read'), ('DEPOSITO','stock:write')
),
faltan AS (
  SELECT a.puesto, a.permiso FROM asignacion a LEFT JOIN permissions p ON p.code = a.permiso WHERE p.id IS NULL
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM asignacion a
  JOIN roles r ON r.code = a.puesto
  JOIN permissions p ON p.code = a.permiso
 WHERE NOT EXISTS (SELECT 1 FROM faltan);

DO $$
DECLARE faltante text;
BEGIN
  SELECT string_agg(r.code, ', ') INTO faltante
    FROM roles r
   WHERE r.code IN ('GERENTE', 'VENDEDOR', 'COMPRADOR', 'TESORERO', 'DEPOSITO')
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id);
  IF faltante IS NOT NULL THEN
    RAISE EXCEPTION 'Puestos sin permisos (algún permiso del listado no existe): %', faltante;
  END IF;
END
$$;
