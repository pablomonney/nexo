-- ---------------------------------------------------------------------------
-- Puestos predeterminados: cada persona ve los módulos de su trabajo
-- ---------------------------------------------------------------------------
--
-- Hasta acá había seis roles pensados por **nivel de acceso** (administrar, contar, auditar, cargar, consultar). Una empresa real se organiza
-- por **puestos**: quien vende no maneja la caja, quien hace la tesorería no carga el stock, y quien dirige quiere ver todo sin tocar la
-- contabilidad. Esta migración agrega 26 puestos predeterminados, agrupados por área. Cada uno es un rol (el mecanismo de siempre:
-- `user_company_roles`, `grant_company_role`, permisos en `role_permissions`), así que **los módulos de cada persona salen de sus permisos**: la
-- consola ya esconde lo que el rol no puede usar (`aplicarPermisosANav`) y el servidor lo rechaza de todos modos.
--
-- Los puestos y sus permisos están en `infrastructure/db/datos/puestos.json`; **esta migración se generó de ese archivo** y
-- `tests/security/puestos-predeterminados.test.ts` comprueba que la base coincida con él, permiso por permiso. `docs/PUESTOS.md` explica cada uno.
--
-- ## Los criterios (mínimo privilegio)
--
--   · Ningún puesto toca la **contabilidad** (aprobar o revertir asientos, períodos, estados): eso es del Contador. Sólo el Asistente contable
--     carga asientos, y los **propone**: no los aprueba.
--   · Ninguno **administra el sistema** (`user:manage`, secretos, ARCA, suscripción, migraciones): eso es del Administrador.
--   · **Quien propone no aprueba.** Los pedidos de compra los aprueban sólo el Gerente y el Jefe de compras; las órdenes de pago, sólo el Gerente
--     y el Responsable de pagos. Los ajustes de stock (que cambian el inventario contable) son sólo del Jefe de depósito.
--   · Todos pueden entrar (`company:read`) y usar el asistente (`intelligence:ask`).
--   · Los puestos que mueven plata, aprueban o tocan la contabilidad exigen **segundo factor** (`ROLES_REQUIRING_MFA`).
--
-- Los roles se suman: una misma persona puede ser Vendedora y Compradora en una empresa chica.
-- ---------------------------------------------------------------------------

ALTER TABLE roles DROP CONSTRAINT roles_code_check;
ALTER TABLE roles ADD CONSTRAINT roles_code_check CHECK (code IN (
  'ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'CARGADOR', 'SOLO_LECTURA', 'GERENTE', 'SOCIO', 'ANALISTA_DE_GESTION', 'JEFE_DE_VENTAS', 'VENDEDOR', 'EJECUTIVO_DE_CUENTAS', 'ATENCION_AL_CLIENTE', 'RESPONSABLE_DE_COMISIONES', 'RESPONSABLE_DE_PRECIOS', 'ENCARGADO_DE_SUCURSAL', 'CAJERO', 'COBRANZAS', 'JEFE_DE_COMPRAS', 'COMPRADOR', 'RECEPCION_DE_MERCADERIA', 'DEPOSITO', 'JEFE_DE_DEPOSITO', 'RESPONSABLE_DE_PAGOS', 'TESORERO', 'CONCILIADOR_BANCARIO', 'RESPONSABLE_DE_CHEQUES', 'RESPONSABLE_DE_PROYECTOS', 'RESPONSABLE_DE_BIENES_DE_USO', 'RESPONSABLE_DE_ECOMMERCE', 'ASISTENTE_CONTABLE', 'RESPONSABLE_DE_IMPUESTOS'));

-- El área agrupa los puestos en las pantallas y en la documentación.
ALTER TABLE roles ADD COLUMN area text NOT NULL DEFAULT 'Operación';
ALTER TABLE roles ALTER COLUMN area DROP DEFAULT;
UPDATE roles SET area = 'Administración del sistema' WHERE code = 'ADMINISTRADOR';
UPDATE roles SET area = 'Contabilidad' WHERE code = 'CONTADOR';
UPDATE roles SET area = 'Control' WHERE code = 'AUDITOR';
UPDATE roles SET area = 'Operación' WHERE code = 'USUARIO_EMPRESA';
UPDATE roles SET area = 'Operación' WHERE code = 'CARGADOR';
UPDATE roles SET area = 'Consulta' WHERE code = 'SOLO_LECTURA';

INSERT INTO roles (code, name, area, description) VALUES
  ('GERENTE', 'Gerente', 'Dirección', 'Dirección: ve todo el negocio, aprueba pedidos de compra y órdenes de pago y registra decisiones. No toca la contabilidad'),
  ('SOCIO', 'Socio o inversor', 'Dirección', 'Consulta los resultados del negocio: estados contables, libros, analítica y señales. Solo lectura, no opera nada'),
  ('ANALISTA_DE_GESTION', 'Analista de gestión', 'Dirección', 'Control de gestión: analiza el negocio (analítica, señales y escenarios), reconoce alertas y sigue indicadores de ventas, caja y stock. No opera ni toca la contabilidad'),
  ('JEFE_DE_VENTAS', 'Jefe de ventas', 'Ventas', 'Dirige al equipo comercial: vende, define las comisiones y sigue las cifras de ventas y el CRM'),
  ('VENDEDOR', 'Vendedor', 'Ventas', 'Ventas: presupuestos y pedidos, clientes, productos y precios, CRM y sus comisiones'),
  ('EJECUTIVO_DE_CUENTAS', 'Ejecutivo de cuentas', 'Ventas', 'Lleva el seguimiento comercial de sus clientes: oportunidades en el CRM y fichas de clientes. Ve los pedidos, no los modifica'),
  ('ATENCION_AL_CLIENTE', 'Atención al cliente', 'Ventas', 'Consulta clientes, pedidos y productos para responder, y deja constancia de cada contacto en el CRM. No modifica pedidos ni precios'),
  ('RESPONSABLE_DE_COMISIONES', 'Responsable de comisiones', 'Ventas', 'Define los esquemas de comisiones y controla lo que gana cada vendedor por sus ventas'),
  ('RESPONSABLE_DE_PRECIOS', 'Responsable de productos y precios', 'Ventas', 'Mantiene el catálogo de productos y las listas de precios con su vigencia'),
  ('ENCARGADO_DE_SUCURSAL', 'Encargado de sucursal', 'Ventas', 'Maneja una sucursal: vende, cobra en su caja y ve su stock y sus números'),
  ('CAJERO', 'Cajero', 'Ventas', 'Abre y cierra la caja, registra cobros y pagos chicos y consulta pedidos, clientes y productos'),
  ('COBRANZAS', 'Cobranzas', 'Ventas', 'Sigue la cuenta corriente de los clientes (cuánto deben y desde cuándo), registra cobros en caja y deja constancia de cada gestión en el CRM'),
  ('JEFE_DE_COMPRAS', 'Jefe de compras', 'Compras y depósito', 'Dirige las compras: pide y aprueba los pedidos de compra de su equipo, y ve proveedores, recepciones y órdenes de pago'),
  ('COMPRADOR', 'Comprador', 'Compras y depósito', 'Compras: pedidos de compra, proveedores y recepciones. Pide, no aprueba'),
  ('RECEPCION_DE_MERCADERIA', 'Recepción de mercadería', 'Compras y depósito', 'Recibe la mercadería y la registra contra el pedido de compra. No mueve ni ajusta stock'),
  ('DEPOSITO', 'Encargado de depósito', 'Compras y depósito', 'Depósito: stock, recuentos y recepciones de mercadería. No hace ajustes de stock'),
  ('JEFE_DE_DEPOSITO', 'Jefe de depósito', 'Compras y depósito', 'Dirige el depósito: todo lo del encargado y además hace ajustes de stock (que cambian el inventario contable, por eso pide segundo factor)'),
  ('RESPONSABLE_DE_PAGOS', 'Responsable de pagos', 'Tesorería', 'Aprueba las órdenes de pago que arma el Tesorero y lleva caja, bancos y cheques. Quien arma un pago no lo aprueba: eso lo hace esta persona'),
  ('TESORERO', 'Tesorero', 'Tesorería', 'Tesorería: caja, bancos, cheques y órdenes de pago. Arma los pagos, no los aprueba'),
  ('CONCILIADOR_BANCARIO', 'Conciliador bancario', 'Tesorería', 'Importa los extractos del banco y los concilia con la caja y los cheques. No arma ni aprueba pagos'),
  ('RESPONSABLE_DE_CHEQUES', 'Responsable de cheques', 'Tesorería', 'Lleva la cartera de cheques propios y de terceros: recibe, deposita, entrega y registra sus movimientos'),
  ('RESPONSABLE_DE_PROYECTOS', 'Responsable de proyectos', 'Operación', 'Lleva los proyectos y sus costos: qué proyecto deja plata y cuál no'),
  ('RESPONSABLE_DE_BIENES_DE_USO', 'Responsable de bienes de uso', 'Operación', 'Da de alta y mantiene los bienes de uso (activos fijos). La amortización la calcula el Contador'),
  ('RESPONSABLE_DE_ECOMMERCE', 'Responsable de e-commerce', 'Operación', 'Maneja la tienda online y los canales de venta: carga lo que llega de afuera, lo resuelve contra clientes y productos y mantiene el catálogo'),
  ('ASISTENTE_CONTABLE', 'Asistente contable', 'Contabilidad', 'Carga asientos (los propone, no los aprueba) y prepara la documentación para el Contador. No cierra períodos ni emite estados'),
  ('RESPONSABLE_DE_IMPUESTOS', 'Responsable de impuestos', 'Contabilidad', 'Prepara el IVA y la parte fiscal: arma los subdiarios y los libros de IVA, declara las afectaciones y constata los comprobantes');

-- Una fila por (puesto, permiso). Si un permiso no existe la migración se cae: no queda un puesto a medias.
WITH asignacion(puesto, permiso) AS (VALUES
  ('GERENTE','account:read'), ('GERENTE','alert:acknowledge'), ('GERENTE','alert:read'), ('GERENTE','allocation:read'),
  ('GERENTE','analysis:read'), ('GERENTE','analytics:read'), ('GERENTE','asset:read'), ('GERENTE','audit:read'),
  ('GERENTE','bank:read'), ('GERENTE','billing:read'), ('GERENTE','branch:read'), ('GERENTE','cash:read'),
  ('GERENTE','check:read'), ('GERENTE','commercial:read'), ('GERENTE','commission:read'), ('GERENTE','company:read'),
  ('GERENTE','cost_center:read'), ('GERENTE','crm:read'), ('GERENTE','decision:approve'), ('GERENTE','decision:read'),
  ('GERENTE','decision:write'), ('GERENTE','document:read'), ('GERENTE','intelligence:ask'), ('GERENTE','journal_entry:read'),
  ('GERENTE','party:read'), ('GERENTE','payment_order:approve'), ('GERENTE','payment_order:read'), ('GERENTE','period:read'),
  ('GERENTE','prediction:read'), ('GERENTE','product:read'), ('GERENTE','project:read'), ('GERENTE','purchase_request:approve'),
  ('GERENTE','purchase_request:read'), ('GERENTE','receipt:read'), ('GERENTE','report:read'), ('GERENTE','statement:read'),
  ('GERENTE','stock:read'), ('GERENTE','vat_book:read'), ('SOCIO','analysis:read'), ('SOCIO','analytics:read'),
  ('SOCIO','company:read'), ('SOCIO','intelligence:ask'), ('SOCIO','period:read'), ('SOCIO','report:read'),
  ('SOCIO','statement:read'), ('ANALISTA_DE_GESTION','alert:acknowledge'), ('ANALISTA_DE_GESTION','alert:read'), ('ANALISTA_DE_GESTION','analysis:read'),
  ('ANALISTA_DE_GESTION','analytics:read'), ('ANALISTA_DE_GESTION','bank:read'), ('ANALISTA_DE_GESTION','branch:read'), ('ANALISTA_DE_GESTION','cash:read'),
  ('ANALISTA_DE_GESTION','check:read'), ('ANALISTA_DE_GESTION','commercial:read'), ('ANALISTA_DE_GESTION','commission:read'), ('ANALISTA_DE_GESTION','company:read'),
  ('ANALISTA_DE_GESTION','cost_center:read'), ('ANALISTA_DE_GESTION','crm:read'), ('ANALISTA_DE_GESTION','decision:read'), ('ANALISTA_DE_GESTION','document:read'),
  ('ANALISTA_DE_GESTION','intelligence:ask'), ('ANALISTA_DE_GESTION','party:read'), ('ANALISTA_DE_GESTION','period:read'), ('ANALISTA_DE_GESTION','prediction:read'),
  ('ANALISTA_DE_GESTION','product:read'), ('ANALISTA_DE_GESTION','project:read'), ('ANALISTA_DE_GESTION','stock:read'), ('JEFE_DE_VENTAS','alert:read'),
  ('JEFE_DE_VENTAS','analysis:read'), ('JEFE_DE_VENTAS','analytics:read'), ('JEFE_DE_VENTAS','branch:read'), ('JEFE_DE_VENTAS','commercial:read'),
  ('JEFE_DE_VENTAS','commercial:write'), ('JEFE_DE_VENTAS','commission:read'), ('JEFE_DE_VENTAS','commission:write'), ('JEFE_DE_VENTAS','company:read'),
  ('JEFE_DE_VENTAS','crm:read'), ('JEFE_DE_VENTAS','crm:write'), ('JEFE_DE_VENTAS','document:read'), ('JEFE_DE_VENTAS','intelligence:ask'),
  ('JEFE_DE_VENTAS','party:read'), ('JEFE_DE_VENTAS','party:write'), ('JEFE_DE_VENTAS','product:read'), ('VENDEDOR','branch:read'),
  ('VENDEDOR','commercial:read'), ('VENDEDOR','commercial:write'), ('VENDEDOR','commission:read'), ('VENDEDOR','company:read'),
  ('VENDEDOR','crm:read'), ('VENDEDOR','crm:write'), ('VENDEDOR','document:read'), ('VENDEDOR','intelligence:ask'),
  ('VENDEDOR','party:read'), ('VENDEDOR','party:write'), ('VENDEDOR','product:read'), ('EJECUTIVO_DE_CUENTAS','commercial:read'),
  ('EJECUTIVO_DE_CUENTAS','company:read'), ('EJECUTIVO_DE_CUENTAS','crm:read'), ('EJECUTIVO_DE_CUENTAS','crm:write'), ('EJECUTIVO_DE_CUENTAS','document:read'),
  ('EJECUTIVO_DE_CUENTAS','intelligence:ask'), ('EJECUTIVO_DE_CUENTAS','party:read'), ('EJECUTIVO_DE_CUENTAS','party:write'), ('EJECUTIVO_DE_CUENTAS','product:read'),
  ('ATENCION_AL_CLIENTE','commercial:read'), ('ATENCION_AL_CLIENTE','company:read'), ('ATENCION_AL_CLIENTE','crm:read'), ('ATENCION_AL_CLIENTE','crm:write'),
  ('ATENCION_AL_CLIENTE','document:read'), ('ATENCION_AL_CLIENTE','intelligence:ask'), ('ATENCION_AL_CLIENTE','party:read'), ('ATENCION_AL_CLIENTE','product:read'),
  ('RESPONSABLE_DE_COMISIONES','commercial:read'), ('RESPONSABLE_DE_COMISIONES','commission:read'), ('RESPONSABLE_DE_COMISIONES','commission:write'), ('RESPONSABLE_DE_COMISIONES','company:read'),
  ('RESPONSABLE_DE_COMISIONES','crm:read'), ('RESPONSABLE_DE_COMISIONES','intelligence:ask'), ('RESPONSABLE_DE_COMISIONES','party:read'), ('RESPONSABLE_DE_PRECIOS','branch:read'),
  ('RESPONSABLE_DE_PRECIOS','commercial:read'), ('RESPONSABLE_DE_PRECIOS','company:read'), ('RESPONSABLE_DE_PRECIOS','document:read'), ('RESPONSABLE_DE_PRECIOS','intelligence:ask'),
  ('RESPONSABLE_DE_PRECIOS','product:read'), ('RESPONSABLE_DE_PRECIOS','product:write'), ('ENCARGADO_DE_SUCURSAL','analytics:read'), ('ENCARGADO_DE_SUCURSAL','branch:read'),
  ('ENCARGADO_DE_SUCURSAL','cash:read'), ('ENCARGADO_DE_SUCURSAL','cash:write'), ('ENCARGADO_DE_SUCURSAL','commercial:read'), ('ENCARGADO_DE_SUCURSAL','commercial:write'),
  ('ENCARGADO_DE_SUCURSAL','commission:read'), ('ENCARGADO_DE_SUCURSAL','company:read'), ('ENCARGADO_DE_SUCURSAL','crm:read'), ('ENCARGADO_DE_SUCURSAL','document:read'),
  ('ENCARGADO_DE_SUCURSAL','intelligence:ask'), ('ENCARGADO_DE_SUCURSAL','party:read'), ('ENCARGADO_DE_SUCURSAL','party:write'), ('ENCARGADO_DE_SUCURSAL','product:read'),
  ('ENCARGADO_DE_SUCURSAL','stock:read'), ('CAJERO','cash:read'), ('CAJERO','cash:write'), ('CAJERO','commercial:read'),
  ('CAJERO','company:read'), ('CAJERO','intelligence:ask'), ('CAJERO','party:read'), ('CAJERO','product:read'),
  ('COBRANZAS','allocation:read'), ('COBRANZAS','bank:read'), ('COBRANZAS','cash:read'), ('COBRANZAS','cash:write'),
  ('COBRANZAS','commercial:read'), ('COBRANZAS','company:read'), ('COBRANZAS','crm:read'), ('COBRANZAS','crm:write'),
  ('COBRANZAS','document:read'), ('COBRANZAS','intelligence:ask'), ('COBRANZAS','party:read'), ('JEFE_DE_COMPRAS','company:read'),
  ('JEFE_DE_COMPRAS','document:read'), ('JEFE_DE_COMPRAS','document:upload'), ('JEFE_DE_COMPRAS','intelligence:ask'), ('JEFE_DE_COMPRAS','party:read'),
  ('JEFE_DE_COMPRAS','party:write'), ('JEFE_DE_COMPRAS','payment_order:read'), ('JEFE_DE_COMPRAS','product:read'), ('JEFE_DE_COMPRAS','purchase_request:approve'),
  ('JEFE_DE_COMPRAS','purchase_request:read'), ('JEFE_DE_COMPRAS','purchase_request:write'), ('JEFE_DE_COMPRAS','receipt:read'), ('JEFE_DE_COMPRAS','stock:read'),
  ('COMPRADOR','company:read'), ('COMPRADOR','document:read'), ('COMPRADOR','document:upload'), ('COMPRADOR','intelligence:ask'),
  ('COMPRADOR','party:read'), ('COMPRADOR','party:write'), ('COMPRADOR','payment_order:read'), ('COMPRADOR','product:read'),
  ('COMPRADOR','purchase_request:read'), ('COMPRADOR','purchase_request:write'), ('COMPRADOR','receipt:read'), ('COMPRADOR','stock:read'),
  ('RECEPCION_DE_MERCADERIA','company:read'), ('RECEPCION_DE_MERCADERIA','document:read'), ('RECEPCION_DE_MERCADERIA','document:upload'), ('RECEPCION_DE_MERCADERIA','intelligence:ask'),
  ('RECEPCION_DE_MERCADERIA','product:read'), ('RECEPCION_DE_MERCADERIA','purchase_request:read'), ('RECEPCION_DE_MERCADERIA','receipt:read'), ('RECEPCION_DE_MERCADERIA','receipt:write'),
  ('RECEPCION_DE_MERCADERIA','stock:read'), ('DEPOSITO','company:read'), ('DEPOSITO','document:read'), ('DEPOSITO','intelligence:ask'),
  ('DEPOSITO','product:read'), ('DEPOSITO','purchase_request:read'), ('DEPOSITO','receipt:read'), ('DEPOSITO','receipt:write'),
  ('DEPOSITO','stock:count'), ('DEPOSITO','stock:read'), ('DEPOSITO','stock:write'), ('JEFE_DE_DEPOSITO','company:read'),
  ('JEFE_DE_DEPOSITO','document:read'), ('JEFE_DE_DEPOSITO','document:upload'), ('JEFE_DE_DEPOSITO','intelligence:ask'), ('JEFE_DE_DEPOSITO','product:read'),
  ('JEFE_DE_DEPOSITO','purchase_request:read'), ('JEFE_DE_DEPOSITO','receipt:read'), ('JEFE_DE_DEPOSITO','receipt:write'), ('JEFE_DE_DEPOSITO','stock:adjust'),
  ('JEFE_DE_DEPOSITO','stock:count'), ('JEFE_DE_DEPOSITO','stock:read'), ('JEFE_DE_DEPOSITO','stock:write'), ('RESPONSABLE_DE_PAGOS','bank:import'),
  ('RESPONSABLE_DE_PAGOS','bank:read'), ('RESPONSABLE_DE_PAGOS','bank:reconcile'), ('RESPONSABLE_DE_PAGOS','cash:read'), ('RESPONSABLE_DE_PAGOS','cash:write'),
  ('RESPONSABLE_DE_PAGOS','check:read'), ('RESPONSABLE_DE_PAGOS','check:write'), ('RESPONSABLE_DE_PAGOS','company:read'), ('RESPONSABLE_DE_PAGOS','document:read'),
  ('RESPONSABLE_DE_PAGOS','intelligence:ask'), ('RESPONSABLE_DE_PAGOS','party:read'), ('RESPONSABLE_DE_PAGOS','payment_order:approve'), ('RESPONSABLE_DE_PAGOS','payment_order:read'),
  ('RESPONSABLE_DE_PAGOS','payment_order:write'), ('TESORERO','bank:import'), ('TESORERO','bank:read'), ('TESORERO','bank:reconcile'),
  ('TESORERO','cash:read'), ('TESORERO','cash:write'), ('TESORERO','check:read'), ('TESORERO','check:write'),
  ('TESORERO','company:read'), ('TESORERO','document:read'), ('TESORERO','intelligence:ask'), ('TESORERO','party:read'),
  ('TESORERO','payment_order:read'), ('TESORERO','payment_order:write'), ('CONCILIADOR_BANCARIO','bank:import'), ('CONCILIADOR_BANCARIO','bank:read'),
  ('CONCILIADOR_BANCARIO','bank:reconcile'), ('CONCILIADOR_BANCARIO','cash:read'), ('CONCILIADOR_BANCARIO','check:read'), ('CONCILIADOR_BANCARIO','company:read'),
  ('CONCILIADOR_BANCARIO','document:read'), ('CONCILIADOR_BANCARIO','document:upload'), ('CONCILIADOR_BANCARIO','intelligence:ask'), ('CONCILIADOR_BANCARIO','party:read'),
  ('RESPONSABLE_DE_CHEQUES','bank:read'), ('RESPONSABLE_DE_CHEQUES','check:read'), ('RESPONSABLE_DE_CHEQUES','check:write'), ('RESPONSABLE_DE_CHEQUES','company:read'),
  ('RESPONSABLE_DE_CHEQUES','document:read'), ('RESPONSABLE_DE_CHEQUES','intelligence:ask'), ('RESPONSABLE_DE_CHEQUES','party:read'), ('RESPONSABLE_DE_PROYECTOS','analytics:read'),
  ('RESPONSABLE_DE_PROYECTOS','commercial:read'), ('RESPONSABLE_DE_PROYECTOS','company:read'), ('RESPONSABLE_DE_PROYECTOS','cost_center:read'), ('RESPONSABLE_DE_PROYECTOS','document:read'),
  ('RESPONSABLE_DE_PROYECTOS','intelligence:ask'), ('RESPONSABLE_DE_PROYECTOS','party:read'), ('RESPONSABLE_DE_PROYECTOS','project:read'), ('RESPONSABLE_DE_PROYECTOS','project:write'),
  ('RESPONSABLE_DE_BIENES_DE_USO','asset:read'), ('RESPONSABLE_DE_BIENES_DE_USO','asset:write'), ('RESPONSABLE_DE_BIENES_DE_USO','branch:read'), ('RESPONSABLE_DE_BIENES_DE_USO','company:read'),
  ('RESPONSABLE_DE_BIENES_DE_USO','cost_center:read'), ('RESPONSABLE_DE_BIENES_DE_USO','document:read'), ('RESPONSABLE_DE_BIENES_DE_USO','document:upload'), ('RESPONSABLE_DE_BIENES_DE_USO','intelligence:ask'),
  ('RESPONSABLE_DE_ECOMMERCE','commercial:read'), ('RESPONSABLE_DE_ECOMMERCE','company:read'), ('RESPONSABLE_DE_ECOMMERCE','document:read'), ('RESPONSABLE_DE_ECOMMERCE','document:upload'),
  ('RESPONSABLE_DE_ECOMMERCE','integration:ingest'), ('RESPONSABLE_DE_ECOMMERCE','integration:read'), ('RESPONSABLE_DE_ECOMMERCE','integration:resolve'), ('RESPONSABLE_DE_ECOMMERCE','intelligence:ask'),
  ('RESPONSABLE_DE_ECOMMERCE','party:read'), ('RESPONSABLE_DE_ECOMMERCE','party:write'), ('RESPONSABLE_DE_ECOMMERCE','product:read'), ('RESPONSABLE_DE_ECOMMERCE','product:write'),
  ('RESPONSABLE_DE_ECOMMERCE','stock:read'), ('ASISTENTE_CONTABLE','account:read'), ('ASISTENTE_CONTABLE','allocation:read'), ('ASISTENTE_CONTABLE','bank:read'),
  ('ASISTENTE_CONTABLE','company:read'), ('ASISTENTE_CONTABLE','document:read'), ('ASISTENTE_CONTABLE','document:upload'), ('ASISTENTE_CONTABLE','intelligence:ask'),
  ('ASISTENTE_CONTABLE','journal_entry:create'), ('ASISTENTE_CONTABLE','journal_entry:read'), ('ASISTENTE_CONTABLE','party:read'), ('ASISTENTE_CONTABLE','period:read'),
  ('ASISTENTE_CONTABLE','report:read'), ('ASISTENTE_CONTABLE','statement:read'), ('ASISTENTE_CONTABLE','vat_book:read'), ('RESPONSABLE_DE_IMPUESTOS','account:read'),
  ('RESPONSABLE_DE_IMPUESTOS','company:read'), ('RESPONSABLE_DE_IMPUESTOS','document:read'), ('RESPONSABLE_DE_IMPUESTOS','intelligence:ask'), ('RESPONSABLE_DE_IMPUESTOS','journal_entry:read'),
  ('RESPONSABLE_DE_IMPUESTOS','party:read'), ('RESPONSABLE_DE_IMPUESTOS','period:read'), ('RESPONSABLE_DE_IMPUESTOS','report:read'), ('RESPONSABLE_DE_IMPUESTOS','tax_affectation:declare'),
  ('RESPONSABLE_DE_IMPUESTOS','tax_transaction:constatar'), ('RESPONSABLE_DE_IMPUESTOS','vat_book:generate'), ('RESPONSABLE_DE_IMPUESTOS','vat_book:read')
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
   WHERE r.code IN ('GERENTE', 'SOCIO', 'ANALISTA_DE_GESTION', 'JEFE_DE_VENTAS', 'VENDEDOR', 'EJECUTIVO_DE_CUENTAS', 'ATENCION_AL_CLIENTE', 'RESPONSABLE_DE_COMISIONES', 'RESPONSABLE_DE_PRECIOS', 'ENCARGADO_DE_SUCURSAL', 'CAJERO', 'COBRANZAS', 'JEFE_DE_COMPRAS', 'COMPRADOR', 'RECEPCION_DE_MERCADERIA', 'DEPOSITO', 'JEFE_DE_DEPOSITO', 'RESPONSABLE_DE_PAGOS', 'TESORERO', 'CONCILIADOR_BANCARIO', 'RESPONSABLE_DE_CHEQUES', 'RESPONSABLE_DE_PROYECTOS', 'RESPONSABLE_DE_BIENES_DE_USO', 'RESPONSABLE_DE_ECOMMERCE', 'ASISTENTE_CONTABLE', 'RESPONSABLE_DE_IMPUESTOS')
     AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id);
  IF faltante IS NOT NULL THEN
    RAISE EXCEPTION 'Puestos sin permisos (algún permiso del listado no existe): %', faltante;
  END IF;
END
$$;
