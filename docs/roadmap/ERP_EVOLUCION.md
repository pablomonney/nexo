# De motor contable a ERP — auditoría, clasificación y orden de trabajo

**Fecha:** 2026-09-01. **Base auditada:** 46 migraciones aplicadas, 84 tablas,
14 vistas, 19 archivos de rutas, 71 archivos de test.

Este documento no propone reconstruir NEXO. Clasifica lo que hay y dice en qué
orden se lo extiende, con el criterio de que **el orden lo fijan las
dependencias reales, no el atractivo de cada módulo**.

---

## A · Clasificación de lo existente

Cinco categorías: CONSERVAR, EXTENDER, REFACTORIZAR, MIGRAR, REEMPLAZAR.

### CONSERVAR — funciona y no se toca

| Componente | Por qué |
|---|---|
| Núcleo transaccional `documento → operación → decisión → asiento` | Probado de punta a punta. Es la ventaja competitiva real: trazabilidad hasta el papel |
| Candados del Diario (`CONSTRAINT TRIGGER` diferidos) | Debe = Haber verificado en el `COMMIT`. Ningún ERP del mercado local lo garantiza en la base |
| RLS `FORCE` + `aai_app` `NOBYPASSRLS` | El aislamiento no depende de que la aplicación se acuerde de filtrar |
| Motor normativo versionado | Resuelve la norma **por fecha de la operación**, no por la de hoy |
| ADR-001 (la IA no escribe) | Verificado mecánicamente, no prometido |
| Bitácora encadenada por hash | `audit_logs` con `prev_hash`/`hash` |
| Paginación por keyset | Sin `OFFSET`. Correcta bajo inserciones concurrentes |

### EXTENDER — la base está bien y le falta alcance

| Componente | Qué le falta |
|---|---|
| `parties` | **HECHO** (0047). Falta: condiciones comerciales, límite de crédito, antigüedad de saldos |
| `accounts` | Dimensiones adicionales más allá de centro de costo y tercero |
| `tax_transactions` | Renglones. Hoy guarda totales por comprobante, no líneas de detalle |
| `work_queue` | Ramas nuevas por cada módulo que se agregue |
| Consola web | Es un cliente de verificación, no el producto final |
| `banks` | Existe conciliación; falta tesorería (cajas, medios de pago, cash flow) |

### REFACTORIZAR — funciona, la forma estorba

| Componente | Qué |
|---|---|
| 17 valores de estado muertos | Clasificados en la FASE 4, no removidos. Se limpian cuando cada módulo que los tocaba tenga escritor productivo |
| `alerts`, `audit_findings` | Tablas sin escritores. O se conectan o se retiran; hoy son ruido estructural |

### MIGRAR — nada

No hay componente que exija cambio de tecnología o de modelo de datos.

### REEMPLAZAR — nada

Ningún subsistema auditado justifica reescritura. La consola HTML es el
candidato más obvio y **no** califica: hace lo que debe hacer, y reemplazarla
antes de tener los módulos que tiene que mostrar sería trabajo perdido.

---

## B · El hueco que la auditoría encontró primero

`journal_entry_lines.party_id` existía desde la migración 0005, un trigger lo
**exigía**, y no apuntaba a ninguna tabla. Ver [ADR-013](../adr/ADR-013-maestro-de-terceros.md).

Es el patrón recurrente del proyecto y conviene nombrarlo, porque va a volver a
aparecer en cada módulo nuevo:

> **estructura correcta + regla escrita + nadie recorriendo el camino entre las
> dos = hueco invisible.**

La defensa contra eso no es más revisión: es que cada bloque termine con un
test que recorra el camino completo por HTTP, y con el objeto declarado en
`audit:estructura`. Los dos gates encontraron defectos reales durante esta
misma sesión (el barrido S-12 rechazó una URL de la consola que yo acababa de
escribir).

---

## C · Orden de trabajo por dependencias

Cada nivel necesita el anterior. Dentro de un nivel, el orden es indistinto.

```
NIVEL 0  (hecho)   núcleo contable · fiscal · normativo · auditoría
NIVEL 1  (hecho)   maestro de terceros                        0047
NIVEL 2  (hecho)   maestro de productos y servicios           0048
NIVEL 2b (hecho)   renglones de comprobante — une 1 y 2       0049
NIVEL 3  (hecho)   ciclo comercial: presupuesto → pedido → factura  0050
         (hecho)   la bandeja pasa a ser extensible por dominio     0051
NIVEL 3b           compras: recepción de mercadería  ← habilita stock
NIVEL 4            tesorería y cuenta corriente ← necesita 3
NIVEL 5            stock                        ← necesita 2 y 3b
NIVEL 6            activos fijos · producción · RRHH
NIVEL 7            Integration Hub · conectores
NIVEL 8            BI · analítica · IA sobre datos reales
NIVEL 9            suscripciones y control interno del propio NEXO
```

**Por qué BI va al final y no al principio:** una capa analítica sobre datos
que todavía no existen produce tableros vacíos y decisiones de diseño tomadas
sobre supuestos. El orden inverso —módulos primero, analítica después— produce
menos trabajo tirado.

**Por qué las integraciones van después de los módulos:** un conector de
Tiendanube tiene que escribir una venta. Si la venta no existe como entidad de
NEXO, el conector inventaría una, y esa entidad inventada sería la que después
hay que migrar.

---

## D · Principios que gobiernan cada bloque nuevo

Salen de lo que ya funciona, no de teoría:

1. **Preguntar por el hecho, no por la etiqueta.** Antes de agregar una
   columna de estado, ver si el estado se deriva de algo que ya se sabe. Se
   aplicó al candado de anulación, a la bandeja y a la cuenta corriente.
2. **Una sola verdad.** Un saldo almacenado obliga algún día a decidir cuál de
   dos cifras manda, y esa pregunta no tiene respuesta buena.
3. **La empresa va dentro de la clave.** RLS no protege las restricciones
   foráneas: se verifican con privilegios del sistema.
4. **Un botón que la API va a rechazar no es una funcionalidad.** La consola
   consulta el permiso antes de ofrecer la acción.
5. **Ningún gate que pueda estar verde sin ejercitar nada.**
6. **La evidencia dice lo que dice.** Un comprobante no se corrige: se
   resuelve, se anula o se contraasienta.

---

## E · Benchmark: qué mirar y qué no copiar

Los ERP del mercado argentino (Tango, Bejerman, Xubio, Colppy, DUX, Finnegans,
Contabilium) y los internacionales (Odoo, SAP B1, NetSuite, Zoho) son
**referencias funcionales**: qué problema resuelven y en cuántos pasos. No se
copia código, arquitectura interna ni propiedad intelectual.

La comparación se mantiene por capacidad, no por producto, y se registra cuando
produce una decisión — no como inventario. Una matriz competitiva que nadie
consulta es documentación que envejece sola.

**Dónde NEXO ya está por delante y conviene no perderlo:** trazabilidad
obligatoria hasta el documento, normativa versionada por fecha de operación,
separación explícita entre validación fiscal, contable y económica, y una IA
que propone sin poder escribir. Ninguno de esos cuatro es una funcionalidad que
se agregue después: son propiedades de la arquitectura, y sobreviven solo si
cada módulo nuevo las respeta.
