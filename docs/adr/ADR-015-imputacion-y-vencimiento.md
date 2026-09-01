# ADR-015 — El vencimiento no se deduce, y la imputación no se adivina

**Estado:** ACEPTADO e implementado (migración `0053_imputacion_y_antiguedad_de_saldos.sql`).

---

## 1. Contexto

`party_balances` (ADR-013) dice **cuánto** se le debe a cada tercero, sumando el
Mayor. Es correcto y no alcanza para trabajar. Un neto de $500.000 puede ser una
factura de ayer o doce de hace un año, y las dos situaciones no se parecen: una
es cartera sana y la otra es un problema.

Faltaban las dos preguntas que un contador hace todos los días: **qué facturas**
componen ese saldo y **desde cuándo**.

## 2. Los dos problemas, que son distintos

### 2.1 ¿Qué factura cancela un pago?

Un cliente debe tres facturas de $1.000 y paga $1.000. ¿Cuál pagó?

**No es deducible.** La convención habitual —la más vieja primero— es una
suposición, y suponer acá tiene consecuencias concretas: cambia qué factura
figura vencida, qué se reclama y qué se informa como incobrable.

### 2.2 ¿Cuándo vence una factura?

`tax_transactions` no tiene fecha de vencimiento. Calcularla desde la fecha del
comprobante exigiría conocer el plazo acordado, que NEXO no conoce.

## 3. Decisión

> **Lo que no se puede deducir, se declara. Lo que se puede derivar, no se
> almacena. Y lo que no se sabe, no se afirma.**

Tres reglas, una por problema:

**La imputación se declara.** `party_allocations` registra qué movimiento del
Mayor cancela qué comprobante y por cuánto, firmado y auditado — igual que una
afectación fiscal (0031). Es la única tabla nueva de este bloque, y existe
porque la alternativa era que el sistema adivinara.

**El pendiente se deriva.** No hay columna `saldo_pendiente` en ningún lado; hay
un test que falla si alguien la agrega. `invoice_settlement` lo calcula, y por
lo tanto no puede quedar desactualizado.

**El vencimiento existe solo si alguien lo declaró.** `parties.dias_de_pago` es
la condición comercial acordada. Cuando está, el vencimiento se deriva y la mora
es una afirmación fundada. Cuando no está, `dias_de_mora` viene en `NULL` —que
es distinto de cero— y **el sistema no dice que nada esté vencido**.

La diferencia viaja en cada respuesta (`vencimientoDeclarado`, `alcance`) para
que ninguna pantalla pueda presentar una suposición como un hecho (§42). La
antigüedad desde el comprobante sí se informa siempre: es una cuenta de días,
no una afirmación sobre un acuerdo.

## 4. Los cuatro candados

Cada uno corresponde a una forma concreta de dejar la cartera diciendo algo
falso. No son hipotéticos:

| | Qué impide | Qué pasaría sin él |
|---|---|---|
| Comprobante con tercero resuelto | Imputar a una factura sin dueño | No se sabría de quién es la deuda cancelada |
| Mismo tercero en los dos lados | Pagar la factura de A con el cobro de B | Dos carteras mal, y ninguna suma daría el error |
| Asiento aprobado | Cancelar con un borrador | Un cobro que todavía puede no existir |
| **No es el asiento de la propia factura** | Cancelar la factura con su propio asiento | **Toda la cartera en cero sin que entrara un peso** |

El cuarto es el importante. El asiento que registra una venta también toca al
cliente, así que sin este candado cada factura podría "pagarse" a sí misma y el
sistema informaría cobranza perfecta.

## 5. Los mensajes de error llevan código

Cada `RAISE` de los triggers arranca con `E_ALLOC_*`, como los candados de la
0005. No es decoración: la primera versión reconocía los errores por su prosa y
**se equivocó en dos de cinco casos** —un mensaje decía «no cancela» y otro «no
la cancela», que no lo contiene—. El código es estable; la redacción no.

Lo encontró un test, no una revisión.

## 6. Trade-offs

- **Se aceptó** que el sistema no informe mora para terceros sin condición
  declarada. Es menos vistoso que un tablero lleno de rojo, y es lo correcto:
  ese rojo estaría afirmando un acuerdo que nadie hizo.
- **Se aceptó** una tabla nueva después de tres bloques evitándolas. La regla
  nunca fue «no crear tablas» sino «no crear segundas verdades»: la imputación
  es una verdad primera, no la copia de otra.
- **Se pagó** que imputar sea un paso manual. Una imputación automática por
  antigüedad sería cómoda y sería una suposición firmada por el sistema.

## 7. Qué queda abierto

- **Imputación automática sugerida.** Se podría proponer —no aplicar— una
  imputación por antigüedad y que una persona la confirme. Es exactamente la
  forma que ADR-001 admite para la IA, y es trabajo de producto decidir si se
  quiere.
- **Condiciones de pago por comprobante.** Hoy el plazo es del tercero. Una
  factura con condiciones distintas de las habituales no se puede expresar.
- **Vencimientos múltiples.** Una factura en tres cuotas es un solo vencimiento
  en este modelo.
