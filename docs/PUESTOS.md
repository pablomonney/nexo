# Puestos predeterminados y los módulos de cada persona

**Migración 0143, 2026-10-19, a pedido del titular.** Hasta entonces los roles estaban pensados por nivel de acceso (administrar, contar, auditar, cargar, consultar). Una empresa se organiza por **puestos**: quien vende no maneja la caja, quien hace la tesorería no carga el stock, y quien dirige quiere ver todo sin tocar la contabilidad.

## Cómo funciona

- Un **puesto es un rol**: el mecanismo de siempre (`user_company_roles`, `grant_company_role`, `role_permissions`). Se da desde Configuración → «Dar un puesto» (o `POST /companies/:id/roles`).
- **Los módulos de cada persona salen de los permisos de su puesto.** La consola esconde lo que el rol no puede usar (`aplicarPermisosANav`) y el servidor lo rechaza de todos modos. La tabla permiso→pantalla es **una sola** (`PERMISO_DE_LA_PANTALLA` en `consola.html`): la usan el menú y «Dar un puesto» para decir, antes de darlo, qué va a ver la persona. `GET /puestos` lista los once con sus permisos.
- **Los puestos se suman:** una misma persona puede ser vendedora y compradora. Los puestos son los mismos para todas las empresas (datos de referencia, no de una empresa).
- Dentro de lo que el **plan** incluye: si el plan de la empresa no trae un módulo, ningún puesto lo ve.

## Los cinco puestos nuevos

| Puesto | Código | Qué hace | Módulos que ve (además de Inicio, Pendientes, Asistente y Preguntar) | Segundo factor |
|---|---|---|---|---|
| **Gerente** | `GERENTE` | Dirección: ve todo el negocio, aprueba pedidos de compra y órdenes de pago y registra decisiones. No toca la contabilidad | Presupuestos y pedidos, Facturas y comprobantes, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Pedidos de compra, Recepciones, Órdenes de pago, Caja, Bancos, Cheques, Stock, Bienes de uso, Proyectos, Sucursales, Asientos, Libros, IVA, Estados y notas, Cierre de períodos, Analítica, Señales y escenarios, Auditoría (todo en lectura, salvo lo que aprueba) | **Sí** |
| **Vendedor** | `VENDEDOR` | Ventas: presupuestos y pedidos, clientes, productos y precios, CRM y sus comisiones | Presupuestos y pedidos, Clientes y proveedores, Productos, Precios, CRM, Comisiones, Documentos, Sucursales | No |
| **Comprador** | `COMPRADOR` | Compras: pedidos de compra, proveedores y recepciones. Pide, no aprueba | Clientes y proveedores, Productos, Precios, Documentos, Pedidos de compra, Recepciones, Órdenes de pago, Stock | No |
| **Tesorero** | `TESORERO` | Tesorería: caja, bancos, cheques y órdenes de pago. Arma los pagos, no los aprueba | Clientes y proveedores, Documentos, Órdenes de pago, Caja, Bancos, Cheques | **Sí** |
| **Encargado de depósito** | `DEPOSITO` | Depósito: stock, recuentos y recepciones de mercadería. No hace ajustes de stock | Productos, Precios, Documentos, Pedidos de compra, Recepciones, Stock | No |

Los seis roles de siempre siguen: **Administrador, Contador, Auditor, Usuario de empresa, Cargador de documentación** y **Solo lectura**.

## Los criterios (mínimo privilegio)

- **Ningún puesto nuevo toca la contabilidad** (`journal_entry:create/approve/reverse`, períodos, estados, libros emitidos): eso es del Contador.
- **Ninguno administra el sistema** (usuarios, secretos, ARCA, suscripción, migraciones): eso es del Administrador.
- **Quien propone no aprueba:** el Tesorero arma las órdenes de pago y no las aprueba; el Comprador pide y no aprueba; **sólo el Gerente** aprueba pedidos de compra y órdenes de pago. El Encargado de depósito cuenta y mueve stock pero no ajusta (`stock:adjust`).
- Todos entran (`company:read`: sin él no hay sesión de empresa) y usan el asistente de IA (`intelligence:ask`).
- Los puestos que mueven plata o aprueban (Gerente y Tesorero) exigen **segundo factor**, como Administrador, Contador y Auditor.

## Qué lo comprueba

- `tests/security/puestos-predeterminados.test.ts` (S-50): cada puesto tiene **exactamente** los permisos escritos ahí, ninguno tiene lo prohibido (contabilidad, administración, ajuste de stock) y sólo el Gerente aprueba. Dar un permiso de más a un puesto pone el test en rojo.
- `tests/integration/puestos.test.ts`: contra la API real, una persona por puesto: lo permitido responde y lo que no le toca es 403; el segundo factor se exige donde corresponde; un puesto inexistente o dado a alguien de otro estudio se rechaza.

## Qué no hace (todavía)

- No hay puestos propios de cada empresa: los cinco son los mismos para todas. Armar uno a medida es una migración o, a futuro, una pantalla.
- Un puesto no restringe **qué empresa** ve la persona (eso lo hace el rol por empresa, como siempre) ni limita por sucursal.
- «Facturas y comprobantes» y «Asientos» comparten el permiso de lectura de asientos (`journal_entry:read`): quien ve las facturas ve también el libro de asientos en lectura. Por eso el Vendedor no ve «Facturas y comprobantes», sólo «Presupuestos y pedidos».
