# S-19 — Los flujos de punta a punta

**Fecha:** 2026-09-03 · **Estado del árbol:** `verify` en verde (116 archivos,
1877 tests, 421 objetos estructurales).

Los barridos anteriores miran **una pieza por vez**: S-16 pregunta si una
función exportada tiene consumidor, S-17 si una tabla tiene escritor, S-18 si
una ruta de escritura exige permiso. Ninguno puede ver lo que pregunta este:
**si una capa está conectada con la de al lado**.

El síntoma que lo motivó: cada eslabón estaba probado con su propio fixture. El
ciclo comercial llegaba hasta la operación fiscal y ahí paraba; la imputación de
cobros arrancaba de una factura creada a mano; la salida de stock se probaba
contra un comprobante que nadie había facturado. Todo verde, y nadie recorría la
cadena entera con **la misma operación**.

---

## 1. Cómo se lee esta tabla

| Estado | Qué significa |
|---|---|
| **VERIFICADO** | Existe un test que recorre el cruce por HTTP, sin INSERT que saltee la API |
| **IMPLEMENTADO** | El camino existe y está probado por partes; nadie lo recorre entero |
| **PARCIAL** | Falta un tramo, y está dicho cuál |
| **BLOQUEADO** | Depende de una fuente externa o de una decisión, con su motivo |

«Existe el endpoint» no es ninguno de los cuatro.

---

## 2. VENTAS

```
CLIENTE → PRESUPUESTO → FACTURA → STOCK → CUENTA CORRIENTE → ASIENTO
        → MAYOR → COBRANZA → IMPUTACIÓN → COSTO DE LO VENDIDO
        → BANCO → CONCILIACIÓN
```

**VERIFICADO** — `tests/integration/cadena-de-ventas.test.ts` (10 pasos).

| Cruce | Qué se comprueba |
|---|---|
| Comercial → fiscal | Se factura lo que el cliente **aceptó**; los importes salen de los renglones, no del cuerpo del pedido |
| Fiscal → stock | La salida cita el comprobante (`origen_tipo = 'VENTA'`) y las existencias bajan |
| Fiscal → cuenta corriente | La deuda aparece sola: es una vista, no una fila que alguien escribe |
| Fiscal → Mayor | El asiento sale del mapeo declarado y entra por `POST /journal-entries`, el único escritor |
| Mayor → cobranza | La imputación cancela **la factura**, no «el saldo» |
| Stock → Mayor | El costo de lo vendido se propone por mes y se asienta, con el método de valuación declarado |
| Mayor → banco | El extracto se concilia contra el Mayor de la cuenta bancaria, y el acta confirmada se vuelve a verificar |
| Vuelta | Del asiento al comprobante, del comprobante al presupuesto |

**Lo que encontró.** La existencia inicial de una empresa entra por ajuste —no
hay endpoint de «entrada», y es deliberado: la mercadería entra por una
recepción de compra o por un ajuste con motivo—. Pero el ajuste **no dejaba
declarar el costo unitario**, aunque la base lo admite desde la 0077. Sin costo
de entrada ninguna salida se puede costear, y sin salidas costeadas no hay CMV
que asentar: el último eslabón era inalcanzable para toda empresa que no hubiera
comprado nunca. Corregido.

---

## 3. COMPRAS

```
SOLICITUD → APROBACIÓN → ORDEN → RECEPCIÓN → FACTURA
          → CUENTA CORRIENTE → ORDEN DE PAGO → ASIENTO → IMPUTACIÓN
```

**VERIFICADO** — `tests/integration/ciclo-compras.test.ts`, «de la necesidad al
pago». La cadena cierra en cero y cada documento muestra de qué se colgó.

**Lo que faltaba y se cerró en esta vuelta:** la factura de compra **no se
asentaba** dentro de la cadena. La deuda salía de `invoice_settlement`
—derivada de la operación fiscal— y el Mayor veía la operación recién al
pagarla: la cuenta del proveedor recibía el débito del pago sin haber recibido
nunca su crédito. Ahora el paso 4b pide el asiento propuesto, lo carga por el
único escritor y comprueba los tres renglones (neto a compras, IVA a su crédito
fiscal, total al proveedor).

---

## 4. TESORERÍA

```
FACTURA → VENCIMIENTO → COBRO/PAGO → BANCO/CAJA → CONCILIACIÓN → CONTABILIDAD
```

**VERIFICADO por tramos, que se tocan en el Mayor:**

- Vencimiento y mora: `imputacion-de-cobros`. Sin condición de pago declarada
  **no se afirma mora** — `diasDeMora` es `null` y nada figura vencido.
- Cobro y pago contra la caja: `cadena-de-ventas` (paso 7) y `ciclo-compras`.
- Banco y conciliación: `conciliacion-por-http`, incluida la verificación de un
  acta ya confirmada — un asiento nuevo en el período la hace dejar de coincidir,
  y el endpoint lo dice en vez de suponer.
- El alta de la cuenta bancaria y del mapeo de extracto existen desde hoy: hasta
  esta semana el módulo entero empezaba en dos filas que solo se podían crear
  por SQL.

**Cerrado en esta vuelta.** `cadena-de-ventas` cobra en la **cuenta bancaria**,
importa el extracto donde el banco acredita esa cobranza y concilia: la
conciliación compara el extracto contra el Mayor de la cuenta, así que cierra
si —y solo si— el asiento de la cobranza llegó bien. Después se confirma el
acta y se la vuelve a verificar.

---

## 5. STOCK

**VERIFICADO** — `stock` (29 tests) + el cruce con ventas en `cadena-de-ventas`.

| Aspecto | Estado |
|---|---|
| Entradas | Por recepción (la escribe un trigger) o por ajuste con motivo. **No hay alta suelta de existencias**, y es deliberado |
| Salidas | Por comprobante, en una sola transacción, citando el depósito — que el comprobante no sabe |
| Ajustes | Con motivo obligatorio; el positivo puede declarar costo, el negativo no |
| Transferencias | Dos movimientos en una transacción |
| Recuentos | `recuentos` (28 tests con lotes y vencimientos) |
| Costos | PPP calculado al escribir (0086), verificado contra su derivación (ADR-022) |
| Trazabilidad | El libro solo crece; deshacer es un movimiento nuevo |
| Impacto contable | El CMV se **propone** por mes; cuándo asentarlo es política contable y está anotado como decisión pendiente |

---

## 6. CONTABILIDAD

**VERIFICADO** — los eventos de los módulos operativos llegan al Mayor por el
único escritor, y se puede volver de cada asiento a lo que lo fundó:

- Comprobante → decisión → asiento: `circuito-mvp-e2e`, por las interfaces
  reales, sin un solo INSERT directo.
- Venta y compra → asiento: `cadena-de-ventas`, `ciclo-compras`.
- Mayor como proyección del Diario: `ledger-projection` y `npm run ledger:verify`
  en cada `verify`.
- Cierre y apertura: `cierre-de-ejercicio`. La apertura **no recalcula** los
  saldos: los toma del cierre archivado.

---

## 7. CENTROS DE COSTO

**TERMINADO en esta vuelta.** La dimensión se capturaba fila por fila desde la
0003 y solo se leía desde adentro de Proyectos. Desde la 0088 hay
`cost_center_results` y `GET /reports/cost-centers`, con su pantalla.

Lo que el reporte **no** hace, y lo dice: no reparte las líneas sin centro
—salen como `SIN_CENTRO`, y esa fila es la diferencia contra el estado de
resultados— ni distribuye gastos indirectos, que exige un método de costeo
declarado que no está relevado.

---

## 8. ACTIVOS

**VERIFICADO** — `bienes-de-uso` (15 tests).

| Cruce | Qué se comprueba |
|---|---|
| Alta → plan | El plan se **calcula**; no hay tabla con las cuotas |
| Mejora → plan | Cambia la base y el plan se recalcula solo |
| Depreciación → Mayor | El asiento se vincula y el importe tiene que ser **el calculado**; un asiento sin aprobar no amortiza |
| Ejercicio | No se amortiza dos veces, y lo pendiente bloquea el cierre |
| Baja | Exige motivo y **avisa que no produce asiento** — la negativa es explícita, no un olvido |

---

## 9. Lo que sigue

Los dos tramos que esta auditoría encontró abiertos se cerraron en la misma
vuelta: el asiento de la factura de compra y la cobranza bancaria conciliada.

Lo que queda no es un hueco de flujo sino la capa de arriba: que estos hechos
—ya trazables de punta a punta— alimenten Intelligence y el Decision Engine
(S-20 en adelante). Las decisiones pendientes de `NEXO_ROADMAP.md` no bloquean
ese trabajo.
