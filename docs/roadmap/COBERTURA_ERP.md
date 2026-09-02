# Cobertura ERP — qué hay, qué falta y por qué

**Fecha:** 2026-09-02 (revisada al cerrar los ocho bloques LIBRE del orden de ejecución)
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
| **Sucursales** | HECHO | Depósito, centro de costo y puntos de venta con vigencia. La venta se atribuye por el punto de venta que regía el día del comprobante: no hay columna de sucursal en la factura. |
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
| **Notas de crédito y débito** | PARCIAL — desde la 0080 **restan y suman correctamente** en la cuenta corriente, con el signo tomado del catálogo de ARCA. Lo que sigue faltando es el flujo que las vincule a la factura puntual que corrigen: hoy afectan el saldo del tercero, no un comprobante en particular. |
| **Remitos y entregas parciales** | DECISIÓN — hay que decidir si NEXO admite facturación parcial y con qué reglas. |
| **Devoluciones** | DECISIÓN — depende de la anterior. |
| **Descuentos y promociones** | DECISIÓN — una lista tiene precios, no reglas. «10 % desde la quinta unidad» no se puede expresar. |
| **Vendedores y comisiones** | HECHO — el vendedor es un atributo del comprobante; el porcentaje y la base se declaran con vigencia y se aplican los del día de la venta. Devengado, no pagado. |
| **CRM: prospectos, oportunidades, embudo** | HECHO — el prospecto no ensucia el maestro de terceros, la etapa sale del libro de transiciones, y el embudo pondera **solo** donde la empresa declaró la probabilidad. NEXO no trae un embudo por defecto. |

## 5 · Compras

| Área | Estado |
|---|---|
| Proveedores, recepciones, conciliación de tres puntas | HECHO |
| Cuenta corriente y antigüedad de deuda | HECHO |
| **Órdenes de compra** | HECHO |
| **Solicitudes de compra** | LIBRE |
| **Pagos y órdenes de pago** | HECHO — la orden se arma sobre el pendiente real, se aprueba y cita el asiento del pago. Marcarla pagada exige que ese asiento esté imputado a cada uno de sus comprobantes: sin eso, la orden diría pagada y la cuenta del proveedor seguiría entera. |

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
| **Valuación de existencias** | HECHO para promedio ponderado móvil — el método lo **declara la empresa** y el catálogo dice de cada uno si se calcula. FIFO y costo de reposición siguen PLANIFICADOS, con el motivo escrito (ADR-020). |
| **Costo de mercadería vendida** | HECHO — se calcula por mes y el sistema **propone su asiento** contra las cuentas declaradas. El asiento lo firma una persona: automatizar el momento es una política contable sin declarar. |
| **Margen real por producto** | HECHO — venta menos costo, mes a mes. No se afirma cuando lo facturado no coincide con lo que salió del depósito: el margen sobre menos unidades es más grande que el real. |

## 7 · Tesorería

| Área | Estado |
|---|---|
| Cuentas bancarias, extractos, conciliación | HECHO |
| Proyección de cobranzas | HECHO |
| **Cheques propios y de terceros** | HECHO — cartera, ciclo derivado del libro, y flujo por fecha de pago. |
| **Caja y arqueo** | HECHO — el saldo teórico se deriva de los movimientos, lo contado es lo único declarado, y la diferencia va a la bandeja sin umbral: es aritmética, no criterio. |
| **Flujo de fondos proyectado** | HECHO — entradas (cobranzas y cheques) y salidas (pagos y órdenes comprometidas), sin doble conteo, y **desde un punto de partida**: efectivo en cajas abiertas más saldo contable de bancos. |

## 8 · Activos fijos

Alta, mejoras, baja, plan de amortización derivado y valor de libros: HECHO.
**Métodos distintos de `LINEAL`: DECISIÓN** — cada uno tiene consecuencias sobre
la RT que lo admite y sobre el impuesto.

## 9 · Proyectos y servicios

| Área | Estado |
|---|---|
| Proyectos, tareas y partes de horas | HECHO — el libro de horas es append-only y un proyecto cerrado no recibe horas nuevas. |
| Rentabilidad por proyecto | HECHO — ingresos y costos **leídos del Mayor** por el centro de costo del proyecto, menos las horas valuadas. Ninguna cifra se guarda en el módulo. |
| Valuación de las horas | HECHO con tarifa **declarada** por proyecto y con vigencia. El costo real de una hora sale de la liquidación de sueldos, que está BLOQUEADA: inventarlo sería inventar el sueldo de alguien. Sin tarifa para la fecha, el margen no se afirma. |
| **Horas por persona y su costo real** | BLOQUEADO — depende de RRHH (ADR-012 §8). |
| **Facturación por avance** | DECISIÓN — exige definir si se factura por hito, por porcentaje o por horas, y cada opción tiene su tratamiento contable. |

## 10 · Lo que no existe en absoluto

| Módulo | Estado | Qué falta exactamente |
|---|---|---|
| **Producción** | DECISIÓN | BOM, órdenes, consumos y mermas se pueden modelar. El costo del producto terminado ya tiene de dónde salir —la valuación existe desde la 0077— pero exige decidir cómo se absorben los costos indirectos, que es otra política contable. |
| **RRHH** | BLOQUEADO | ADR-012 §8 deja tres preguntas abiertas y ninguna es técnica: qué convenios se soportan, si se emite el recibo (Ley 27.555) y quién firma la liquidación. Inventar una escala violaría §30. |
| **Suscripciones del propio NEXO** | PARCIAL | La arquitectura está: catálogo de planes, topes declarados, plan por empresa con vigencia y uso contado en el momento. **Precios: DECISIÓN** —no está tomada, y escribir un número la tomaría—. **Cobro: BLOQUEADO** por credenciales del proveedor de pagos. |

## 11 · Contra el mercado

Al abrir esta auditoría, lo que los ERP argentinos tenían y NEXO no era:
cheques, órdenes de compra, remitos, lotes, recuento físico, CRM, sueldos y
valuación de stock.

De esos ocho, **cinco se cerraron**: cheques, lotes/recuento y CRM se
construyeron; las órdenes de compra ya existían y lo que faltaba era
recorrerlas; y el flujo de fondos pasó a tener sus dos lados. Quedan
**remitos**, **valuación de stock** y **sueldos**, y los tres exigen una
decisión o una norma que no se puede inventar.

El CRM entró con la misma disciplina que el resto y eso lo hace distinto de lo
que ofrece el mercado: no trae un embudo por defecto —un embudo es cómo vende
cada empresa— y **no pondera lo que nadie declaró**. Un pipeline con
probabilidades inventadas produce un número que parece plata y no lo es; acá
las etapas sin probabilidad se informan aparte y quedan fuera del total. Y el
embudo no se suma al flujo de fondos: una oportunidad no es un crédito.

Con proyectos pasó algo parecido. Todo ERP de servicios promete «rentabilidad
por proyecto», y casi siempre la calcula con un costo horario que el sistema se
inventó o que quedó cargado una vez y nadie volvió a mirar. Acá la tarifa se
declara con vigencia y se aplica **la del día en que se trabajó**; si falta,
el margen no se calcula mal: **no se afirma**, y la bandeja dice qué falta para
poder afirmarlo. Los ingresos y los costos no se cargan en el módulo — se leen
del Mayor por el centro de costo—, así que la rentabilidad del proyecto y el
balance no pueden divergir.

A eso se sumó **caja y arqueo**, que no estaba en la lista porque ningún ERP lo
publicita: lo tienen todos. La diferencia está en qué se hace con la diferencia
de arqueo. Acá no hay forma de hacerla desaparecer —no existe el campo que la
ajuste— y queda en la bandeja hasta que alguien escriba por qué. Un arqueo que
se puede cuadrar tipeando no es un arqueo.

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

## 12 · Orden de ejecución

Por dependencia y por valor, entre lo LIBRE:

~~1. Cheques~~ · ~~2. Órdenes de compra~~ · ~~3. Lotes y recuento~~ ·
~~4. Caja y arqueo~~ · ~~5. CRM~~ · ~~6. Proyectos~~ ·
~~7. Vendedores y comisiones~~ · ~~8. Sucursales~~ · ~~9. Suscripciones~~ — hechos.

**No queda ningún módulo LIBRE en esta lista.** Lo que sigue exige una decisión
de producto o una fuente externa: retenciones, remitos, valuación de existencias,
métodos de amortización, producción, RRHH, el layout del Libro IVA Digital y las
credenciales de los conectores. Cada uno está clasificado arriba con el motivo.

Cada uno entra con su lado de decisión, por ADR-018: un módulo que registra y no
alimenta la decisión está sin terminar.
