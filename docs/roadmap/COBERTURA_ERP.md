# Cobertura ERP — qué hay, qué falta y por qué

**Fecha:** 2026-09-02
**Método:** inventario de las 108 tablas del esquema, las rutas registradas en
`server.ts` y las pantallas de la consola. No se consultó ningún README para
armar esta tabla: los documentos ya mintieron una vez y el código es la fuente.

Clasificación:

| | Significado |
|---|---|
| **HECHO** | Modelo, API, permisos, aislamiento, tests, pantalla y flujo real. |
| **PARCIAL** | Existe una parte utilizable; falta otra identificada. |
| **LIBRE** | No existe y **no depende de nada externo**: se puede construir. |
| **DECISIÓN** | No existe y exige una definición de producto que no se puede inferir. |
| **BLOQUEADO** | No existe y falta algo externo: credencial, norma publicada o infraestructura. |

---

## 1 · Núcleo

| Área | Estado | Nota |
|---|---|---|
| Empresas, usuarios, roles, permisos | HECHO | |
| Multiempresa con RLS `FORCE` | HECHO | Y verificado por barrido sobre `pg_policies`. |
| MFA y sesiones | HECHO | |
| Auditoría encadenada | HECHO | Con detector probado en rojo (0059). |
| Centros de costo y de resultado | HECHO | `cost_centers`, `profit_centers`. |
| **Sucursales** | LIBRE | No existe. Hoy se puede aproximar con centro de costo, que no es lo mismo: una sucursal tiene depósito, punto de venta y personal. |
| Configuración por empresa | PARCIAL | `system_settings` y marco de reporte; no hay pantalla de preferencias. |

## 2 · Contabilidad

Todo HECHO: plan de cuentas, Diario, Mayor, períodos, ejercicios, cierre y
apertura, estados contables, notas, cuenta corriente, imputación, antigüedad de
saldos, conciliación bancaria. Es el núcleo maduro del producto.

## 3 · Fiscal

| Área | Estado | Nota |
|---|---|---|
| IVA, débito y crédito fiscal | HECHO | |
| Subdiarios y Libro IVA Digital | PARCIAL | Se arman y se generan. **Exportar y presentar: BLOQUEADO** — los diseños de registro no están en la RG; el art. 8° los remite a un micrositio no archivado. Inventar el layout daría un archivo rechazado o, peor, aceptado con los campos corridos. |
| ARCA: WSAA, WSFE, constatación | HECHO | En homologación. |
| Percepciones | PARCIAL | Es una columna del comprobante. No hay certificado ni régimen. |
| **Retenciones** | DECISIÓN | No existe. Exige elegir qué regímenes se soportan (Ganancias, IVA, SUSS, IIBB por jurisdicción) y archivar sus normas. Cada uno tiene su cálculo, su mínimo no sujeto y su certificado. |
| **Vencimientos impositivos** | BLOQUEADO | El calendario de ARCA cambia por resolución y no está archivado. Sin fuente oficial no se puede afirmar una fecha. |

## 4 · Ventas

| Área | Estado |
|---|---|
| Clientes, presupuestos, pedidos, facturación | HECHO |
| Listas de precios con vigencia, por cliente y cantidad | HECHO |
| Cuenta corriente, cobranzas, imputación | HECHO |
| Plan de cuotas por comprobante | HECHO |
| **Notas de crédito y débito** | PARCIAL — el tipo de comprobante existe y entra por el circuito fiscal; no hay flujo propio que las vincule a la factura que corrigen. |
| **Remitos y entregas parciales** | DECISIÓN — hay que decidir si NEXO admite facturación parcial y con qué reglas. |
| **Devoluciones** | DECISIÓN — depende de la anterior. |
| **Descuentos y promociones** | DECISIÓN — una lista tiene precios, no reglas. «10 % desde la quinta unidad» no se puede expresar. |
| **Vendedores y comisiones** | LIBRE |

## 5 · Compras

| Área | Estado |
|---|---|
| Proveedores, recepciones, conciliación de tres puntas | HECHO |
| Cuenta corriente y antigüedad de deuda | HECHO |
| **Órdenes de compra** | HECHO |
| **Solicitudes de compra** | LIBRE |
| **Pagos y órdenes de pago** | PARCIAL — el pago es un asiento imputado; no hay orden de pago como documento. |

> **Corrección.** La primera versión de esta tabla decía que las órdenes de
> compra eran LIBRE, «porque la recepción cita una orden que no existe como
> entidad». **Era falso.** La orden de compra existe desde la 0050: es un
> `commercial_document` con `direction = 'COMPRAS'` y `kind = 'PEDIDO'`, la
> recepción la cita por `commercial_document_id` desde la 0052, y la factura del
> proveedor se vincula con `link-invoice`.
>
> El error fue de método: busqué una tabla llamada `purchase_orders` en vez de
> mirar si el ciclo comercial era bidireccional. Auditar por nombre de tabla es
> exactamente la clase de atajo que esta auditoría existía para no cometer.
>
> Lo que **sí** faltaba era que alguien recorriera ese camino: la suite del ciclo
> comercial no mencionaba `COMPRAS` ni una vez. Ahora lo hace
> `tests/integration/ciclo-compras.test.ts`, y el circuito cierra entero.

## 6 · Stock

| Área | Estado |
|---|---|
| Productos, depósitos, movimientos, existencias derivadas | HECHO |
| Transferencias, ajustes, stock mínimo declarado | HECHO |
| Salida por comprobante con depósito declarado | HECHO |
| **Lotes y vencimientos** | HECHO |
| **Inventario físico (recuento)** | HECHO |
| **Valuación de existencias** | DECISIÓN — PPP, FIFO o costo de reposición es una decisión contable con norma detrás. Sin ella no hay costo de mercadería vendida ni margen. |

## 7 · Tesorería

| Área | Estado |
|---|---|
| Cuentas bancarias, extractos, conciliación | HECHO |
| Proyección de cobranzas | HECHO |
| **Cheques propios y de terceros** | LIBRE — **no existe nada**. En Argentina es una parte central del capital de trabajo y todos los competidores lo tienen. |
| **Caja** | LIBRE — apertura, cierre, arqueo. |
| **Flujo de fondos proyectado** | PARCIAL — hay cobranzas; falta el lado de los pagos y los cheques. |

## 8 · Activos fijos

Alta, mejoras, baja, plan de amortización derivado y valor de libros: HECHO.
**Métodos distintos de `LINEAL`: DECISIÓN** — cada uno tiene consecuencias sobre
la RT que lo admite y sobre el impuesto.

## 9 · Lo que no existe en absoluto

| Módulo | Estado | Qué falta exactamente |
|---|---|---|
| **CRM** | LIBRE | Prospectos, oportunidades con etapa, actividades, embudo, conversión a presupuesto. Las etapas se declaran por empresa, no se inventan. |
| **Proyectos y servicios** | LIBRE | Proyectos, tareas, horas, costo y rentabilidad. Se apoya en centros de costo, que ya existen. |
| **Producción** | DECISIÓN | BOM, órdenes, consumos y mermas se pueden modelar; **el costo del producto terminado no**, porque depende de la valuación de existencias, que está sin decidir. |
| **RRHH** | BLOQUEADO | ADR-012 §8 deja tres preguntas abiertas y ninguna es técnica: qué convenios se soportan, si se emite el recibo (Ley 27.555) y quién firma la liquidación. Inventar una escala violaría §30. |
| **Suscripciones del propio NEXO** | PARCIAL/LIBRE | La arquitectura —plan, estado, período, límites— es construible sin precios. Conectar un proveedor de pagos está BLOQUEADO por credenciales. |

## 10 · Contra el mercado

Lo que los ERP argentinos tienen y NEXO no: **cheques**, órdenes de compra,
remitos, lotes, recuento físico, CRM, sueldos, y valuación de stock. De esos,
cinco son LIBRE y tres exigen una decisión o una norma.

Lo que NEXO tiene y los ERP tradicionales normalmente no:

- **Trazabilidad hasta la fila.** Cada cifra de la analítica abre los
  comprobantes que la formaron; no hay una sola cifra almacenada.
- **La distinción entre dato constatado y dato declarado**, sostenida por el
  esquema: un `OK` de ARCA y un `OK` que escribió una persona no valen lo mismo
  y no se pueden confundir.
- **Los cuatro estados de verificación.** «No encontré nada» y «no miré» se
  informan distinto. Es lo que impide el falso verde.
- **Umbrales declarados.** El sistema no llama desvío a nada que la empresa no
  haya definido como desvío, y cuando propone uno dice de qué serie lo sacó.
- **Aritmética reproducible.** Detectar, proyectar y simular no usan modelo:
  son cuentas que un contador puede rehacer a mano (ADR-017).
- **La bitácora encadenada con su detector probado en rojo.**

La conclusión para el producto: el diferencial no está en tener más módulos que
Tango, sino en que **cada número se pueda defender**. Los módulos que faltan hay
que construirlos igual — un ERP sin cheques no compite en Argentina — pero
construirlos con esa misma disciplina es lo que hace que valga la pena elegirlo.

## 11 · Orden de ejecución

Por dependencia y por valor, entre lo LIBRE:

1. **Cheques** — no existe nada, es central en Argentina, y se apoya en
   tesorería, cuenta corriente y flujo de fondos, todos ya construidos.
2. **Órdenes de compra** — la recepción ya cita una orden que no existe.
3. **Lotes, vencimientos y recuento físico** — el mecanismo de ajuste ya está.
4. **Caja y arqueo.**
5. **CRM** — se apoya en terceros y desemboca en el presupuesto, que existe.
6. **Proyectos** — se apoya en centros de costo.
7. **Vendedores y comisiones** — necesita CRM o al menos el vendedor en la venta.
8. **Suscripciones** — la arquitectura, sin precios ni pasarela.
