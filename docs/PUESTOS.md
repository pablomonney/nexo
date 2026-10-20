# Puestos predeterminados y los módulos de cada persona

**Migración 0143, 2026-10-19, a pedido del titular.** Este archivo se **genera**: `npm run docs:puestos` lo escribe desde `infrastructure/db/datos/puestos.json` y desde la consola. No se edita a mano.

Hasta entonces los roles estaban pensados por nivel de acceso (administrar, contar, auditar, cargar, consultar). Una empresa se organiza por **puestos**: quien vende no maneja la caja, quien hace la tesorería no carga el stock, y quien dirige quiere ver todo sin tocar la contabilidad.

## Cómo funciona

- Un **puesto es un rol**: el mecanismo de siempre (`user_company_roles`, `grant_company_role`, `role_permissions`). Se da desde Configuración → «Dar un puesto» (o `POST /companies/:id/roles`).
- **Los módulos de cada persona salen de los permisos de su puesto.** La consola esconde lo que el rol no puede usar (`aplicarPermisosANav`) y el servidor lo rechaza de todos modos. La tabla permiso→pantalla es **una sola** (`PERMISO_DE_LA_PANTALLA` en `consola.html`): la usan el menú y «Dar un puesto» para decir, antes de darlo, qué va a ver la persona. `GET /puestos` los lista con sus permisos y su área.
- **Los puestos se suman:** una misma persona puede ser vendedora y compradora.
- Dentro de lo que el **plan** incluye: si el plan de la empresa no trae un módulo, ningún puesto lo ve.
- **Todos** ven además Inicio, Pendientes, el Asistente, Preguntar y Configuración (lo mínimo para entrar y trabajar).

## Los criterios (mínimo privilegio)

- **Ningún puesto toca la contabilidad** (aprobar o revertir asientos, períodos, estados, libros emitidos): eso es del Contador. Sólo el **Asistente contable** carga asientos, y los propone: no los aprueba.
- **Ninguno administra el sistema** (usuarios, secretos, ARCA, suscripción, migraciones): eso es del Administrador.
- **Quien propone no aprueba:** los pedidos de compra los aprueban sólo el **Gerente** y el **Jefe de compras**; las órdenes de pago, sólo el **Gerente** y el **Responsable de pagos**. El Tesorero y el Comprador arman, no aprueban.
- Los **ajustes de stock** (que cambian el inventario contable) son sólo del **Jefe de depósito**.
- Todos entran (`company:read`) y usan el asistente de IA (`intelligence:ask`).
- Los puestos que mueven plata, aprueban o tocan la contabilidad exigen **segundo factor**, como Administrador, Contador y Auditor.

## Los puestos, por área

### Dirección

| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |
|---|---|---|---|
| **Gerente** `GERENTE` | Dirección: ve todo el negocio, aprueba pedidos de compra y órdenes de pago y registra decisiones. No toca la contabilidad | Presupuestos y pedidos, Facturas y comprobantes, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Pedidos de compra, Recepciones, Órdenes de pago, Caja, Bancos, Cheques, Stock, Bienes de uso, Proyectos, Sucursales, Asientos, Libros, IVA, Estados y notas, Cierre de períodos, Analítica, Señales y escenarios, Auditoría | **Sí** |
| **Socio o inversor** `SOCIO` | Consulta los resultados del negocio: estados contables, libros, analítica y señales. Solo lectura, no opera nada | Libros, Estados y notas, Cierre de períodos, Analítica, Señales y escenarios | No |
| **Analista de gestión** `ANALISTA_DE_GESTION` | Control de gestión: analiza el negocio (analítica, señales y escenarios), reconoce alertas y sigue indicadores de ventas, caja y stock. No opera ni toca la contabilidad | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Caja, Bancos, Cheques, Stock, Proyectos, Sucursales, Cierre de períodos, Analítica, Señales y escenarios | No |

### Ventas

| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |
|---|---|---|---|
| **Jefe de ventas** `JEFE_DE_VENTAS` | Dirige al equipo comercial: vende, define las comisiones y sigue las cifras de ventas y el CRM | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Sucursales, Analítica, Señales y escenarios | No |
| **Vendedor** `VENDEDOR` | Ventas: presupuestos y pedidos, clientes, productos y precios, CRM y sus comisiones | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Sucursales | No |
| **Ejecutivo de cuentas** `EJECUTIVO_DE_CUENTAS` | Lleva el seguimiento comercial de sus clientes: oportunidades en el CRM y fichas de clientes. Ve los pedidos, no los modifica | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Documentos | No |
| **Atención al cliente** `ATENCION_AL_CLIENTE` | Consulta clientes, pedidos y productos para responder, y deja constancia de cada contacto en el CRM. No modifica pedidos ni precios | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Documentos | No |
| **Responsable de comisiones** `RESPONSABLE_DE_COMISIONES` | Define los esquemas de comisiones y controla lo que gana cada vendedor por sus ventas | Presupuestos y pedidos, Clientes y proveedores, CRM, Comisiones | No |
| **Responsable de productos y precios** `RESPONSABLE_DE_PRECIOS` | Mantiene el catálogo de productos y las listas de precios con su vigencia | Presupuestos y pedidos, Productos, Precios, Documentos, Sucursales | No |
| **Encargado de sucursal** `ENCARGADO_DE_SUCURSAL` | Maneja una sucursal: vende, cobra en su caja y ve su stock y sus números | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Caja, Stock, Sucursales, Analítica | No |
| **Cajero** `CAJERO` | Abre y cierra la caja, registra cobros y pagos chicos y consulta pedidos, clientes y productos | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, Caja | No |
| **Cobranzas** `COBRANZAS` | Sigue la cuenta corriente de los clientes (cuánto deben y desde cuándo), registra cobros en caja y deja constancia de cada gestión en el CRM | Presupuestos y pedidos, Clientes y proveedores, CRM, Documentos, Caja, Bancos | No |

### Compras y depósito

| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |
|---|---|---|---|
| **Jefe de compras** `JEFE_DE_COMPRAS` | Dirige las compras: pide y aprueba los pedidos de compra de su equipo, y ve proveedores, recepciones y órdenes de pago | Clientes y proveedores, Productos, Precios, Documentos, Pedidos de compra, Recepciones, Órdenes de pago, Stock | **Sí** |
| **Comprador** `COMPRADOR` | Compras: pedidos de compra, proveedores y recepciones. Pide, no aprueba | Clientes y proveedores, Productos, Precios, Documentos, Pedidos de compra, Recepciones, Órdenes de pago, Stock | No |
| **Recepción de mercadería** `RECEPCION_DE_MERCADERIA` | Recibe la mercadería y la registra contra el pedido de compra. No mueve ni ajusta stock | Productos, Precios, Documentos, Pedidos de compra, Recepciones, Stock | No |
| **Encargado de depósito** `DEPOSITO` | Depósito: stock, recuentos y recepciones de mercadería. No hace ajustes de stock | Productos, Precios, Documentos, Pedidos de compra, Recepciones, Stock | No |
| **Jefe de depósito** `JEFE_DE_DEPOSITO` | Dirige el depósito: todo lo del encargado y además hace ajustes de stock (que cambian el inventario contable, por eso pide segundo factor) | Productos, Precios, Documentos, Pedidos de compra, Recepciones, Stock | **Sí** |

### Tesorería

| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |
|---|---|---|---|
| **Responsable de pagos** `RESPONSABLE_DE_PAGOS` | Aprueba las órdenes de pago que arma el Tesorero y lleva caja, bancos y cheques. Quien arma un pago no lo aprueba: eso lo hace esta persona | Clientes y proveedores, Documentos, Órdenes de pago, Caja, Bancos, Cheques | **Sí** |
| **Tesorero** `TESORERO` | Tesorería: caja, bancos, cheques y órdenes de pago. Arma los pagos, no los aprueba | Clientes y proveedores, Documentos, Órdenes de pago, Caja, Bancos, Cheques | **Sí** |
| **Conciliador bancario** `CONCILIADOR_BANCARIO` | Importa los extractos del banco y los concilia con la caja y los cheques. No arma ni aprueba pagos | Clientes y proveedores, Documentos, Caja, Bancos, Cheques | No |
| **Responsable de cheques** `RESPONSABLE_DE_CHEQUES` | Lleva la cartera de cheques propios y de terceros: recibe, deposita, entrega y registra sus movimientos | Clientes y proveedores, Documentos, Bancos, Cheques | No |

### Operación

| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |
|---|---|---|---|
| **Responsable de proyectos** `RESPONSABLE_DE_PROYECTOS` | Lleva los proyectos y sus costos: qué proyecto deja plata y cuál no | Presupuestos y pedidos, Clientes y proveedores, Documentos, Proyectos, Analítica | No |
| **Responsable de bienes de uso** `RESPONSABLE_DE_BIENES_DE_USO` | Da de alta y mantiene los bienes de uso (activos fijos). La amortización la calcula el Contador | Documentos, Bienes de uso, Sucursales | No |
| **Responsable de e-commerce** `RESPONSABLE_DE_ECOMMERCE` | Maneja la tienda online y los canales de venta: carga lo que llega de afuera, lo resuelve contra clientes y productos y mantiene el catálogo | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, Documentos, Stock, Integraciones | No |

### Contabilidad

| Puesto | Qué hace | Módulos que ve (además de los básicos) | 2.º factor |
|---|---|---|---|
| **Asistente contable** `ASISTENTE_CONTABLE` | Carga asientos (los propone, no los aprueba) y prepara la documentación para el Contador. No cierra períodos ni emite estados | Facturas y comprobantes, Clientes y proveedores, Documentos, Bancos, Asientos, Libros, IVA, Estados y notas, Cierre de períodos | **Sí** |
| **Responsable de impuestos** `RESPONSABLE_DE_IMPUESTOS` | Prepara el IVA y la parte fiscal: arma los subdiarios y los libros de IVA, declara las afectaciones y constata los comprobantes | Facturas y comprobantes, Clientes y proveedores, Documentos, Asientos, Libros, IVA, Cierre de períodos | **Sí** |

### Los roles de siempre

| Rol | Qué hace |
|---|---|
| **Administrador** `ADMINISTRADOR` | Configuración, usuarios y reapertura de períodos con segunda firma. No firma la contabilidad |
| **Contador** `CONTADOR` | Aprueba, modifica, rechaza, reclasifica, cierra períodos y emite estados |
| **Auditor** `AUDITOR` | Lectura total más acceso completo a la bitácora. No modifica nada |
| **Usuario de empresa** `USUARIO_EMPRESA` | Ve su empresa, carga documentación y consulta reportes autorizados |
| **Cargador de documentación** `CARGADOR` | Sube documentos y ve el estado de su procesamiento |
| **Solo lectura** `SOLO_LECTURA` | Consulta |

## Qué lo comprueba

- `tests/security/puestos-predeterminados.test.ts` (S-50): la base tiene **exactamente** los permisos de `puestos.json` para cada puesto, ninguno tiene lo prohibido (contabilidad, administración), y cada permiso sensible —aprobar compras o pagos, ajustar stock, cargar asientos, el IVA— está sólo en los puestos que corresponde. Dar un permiso de más a un puesto pone el test en rojo.
- `tests/integration/puestos.test.ts`: contra la API real, una persona por puesto: lo permitido responde y lo que no le toca es 403; el segundo factor se exige donde corresponde; un puesto inexistente o dado a alguien de otro estudio se rechaza.
- `tests/security/documentacion-veraz.test.ts`: este documento coincide con lo que genera `npm run docs:puestos`.

## Qué falta

- Puestos propios de cada empresa, y agregar o quitar módulos y funciones a un puesto o a una persona: **a construir** (la siguiente entrega).
- Un puesto no limita por sucursal.
- «Facturas y comprobantes» y «Asientos» comparten el permiso de lectura de asientos (`journal_entry:read`): quien ve las facturas ve también el libro de asientos en lectura.
