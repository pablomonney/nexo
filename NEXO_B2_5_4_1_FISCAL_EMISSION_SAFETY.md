# NEXO — B2.5.4.1 FISCAL EMISSION SAFETY

**Fecha:** 2026-09-10
**Método:** inspección y ejecución del repositorio real. La concurrencia y las
transiciones se ejercitan **contra PostgreSQL**, no contra una función.

---

## 1. Veredicto

# 🟡 PREPARADO — SEGURIDAD CONSTRUIDA, EMISIÓN CERRADA

Los quince criterios de cierre de §35 se cumplen **salvo uno**, y ese uno
depende de una capacidad externa: la reconciliación puede determinar **si** un
comprobante quedó autorizado y **no puede recuperar su CAE**, porque
`FECompConsultar` no está implementado y escribirlo de memoria sería inventar el
contrato de un servicio ajeno.

Eso es exactamente el estado que §35 nombra:

> 🟡 PREPARADO — RECONCILIACIÓN EXTERNA PENDIENTE

**La emisión sigue cerrada**, y no por olvido: `EMISION_HABILITADA` es una
constante en `false`, `@aai/arca-emision` sigue fuera del grafo de la aplicación,
y la puerta exige siete condiciones que hoy no se cumplen.

---

## 2. Estado anterior

`tax_transactions` **no tenía ninguna columna de emisión**: sin CAE, sin
vencimiento, sin estado, sin clave de idempotencia. No era una omisión — era
coherente con que la emisión estuviera fuera del MVP.

La idempotencia que sí existía (`tax_transactions_un_documento`, 0035) es de otra
cosa: identifica una operación fiscal **recibida** por su documento archivado. Un
comprobante que se emite no tiene documento previo; el documento es el resultado.

Así que no había nada que reutilizar, y no había nada que romper.

---

## 3. Arquitectura final

Tres piezas, cada una donde corresponde:

| Pieza | Dónde | Qué hace |
|---|---|---|
| **Las reglas** | `packages/tax-engine/src/emision.ts` | Máquina de estados, clasificación de desenlaces, verificación de evidencia, clave de intención. **Puro**: sin base, sin red |
| **Las garantías** | migración `0117` | Índices únicos, `CHECK`, trigger de transiciones, contador de numeración |
| **Los puertos** | `apps/api/src/fiscal/` | `reconciliador.ts` (interfaz, sin implementación) y `puerta.ts` (el gate) |

**No se creó ningún paquete nuevo, ni outbox, ni cola, ni worker.** El modelo
actual resuelve la emisión segura sin ellos: la intención se persiste antes de
llamar y sobrevive a un reinicio, que es lo que un outbox habría aportado.

---

## 4. Máquina de estados

| Estado | Significado | Retry | Reconciliación | ¿CAE nuevo? |
|---|---|---|---|---|
| `BORRADOR` | Intención declarada, sin número | — | — | No |
| `LISTA` | Número reservado, datos completos | — | — | **Sí** |
| `EMITIENDO` | Llamada en curso | No | — | No |
| `AUTORIZADA` | ARCA autorizó, con CAE | No · **terminal** | — | No |
| `RECHAZADA` | ARCA rechazó, con código | No · **terminal** | — | No |
| `DESCONOCIDA` | **Se mandó y no se sabe qué pasó** | **NUNCA** | Obligatoria | **No** |
| `RECONCILIANDO` | Averiguando contra ARCA | No | En curso | No |
| `ANULADA` | Abandonada antes de autorizar | — · terminal | — | No |

**La transición que no existe es la que define la fase: `DESCONOCIDA → EMITIENDO`.**
No está en el mapa de TypeScript ni en el `CASE` del trigger, así que la base la
rechaza con `23514`.

`AUTORIZADA` y `RECHAZADA` son terminales. Corregir un rechazo es una intención
**nueva**, con número nuevo: el reservado ya se consumió ante ARCA aunque el
comprobante no exista.

---

## 5. Idempotencia

**Clave:** `(company_id, ambiente, origen_tipo, origen_id)`.

Identifica la **operación comercial**, no la petición HTTP. La misma venta pedida
dos veces es una sola intención; dos ventas son dos.

No entran: sello de tiempo, uuid por reintento, IP ni sesión — todos cambian
entre dos intentos de emitir *lo mismo*, que es justo cuando la clave debe
coincidir.

El ambiente entra a propósito: la misma venta en homologación y en producción son
dos hechos distintos ante el organismo.

**La garantía es un índice único parcial**, no un `if`:

```sql
CREATE UNIQUE INDEX fiscal_emissions_una_por_intencion
  ON fiscal_emissions (company_id, ambiente, origen_tipo, origen_id)
  WHERE estado <> 'ANULADA';
```

Se excluye `ANULADA` porque abandonar y volver a empezar es legítimo; sin esa
exclusión, un error corregible dejaría la venta sin poder facturarse nunca.

---

## 6. Numeración

**Se reserva ANTES de llamar, y no hay alternativa:** el número lo pone el
emisor, `FECAESolicitar` lo lleva en el pedido. Reservar después es imposible.

**Los huecos existen y se declaran.** Si ARCA rechaza, ese número se consumió. Si
queda en `DESCONOCIDA`, no se reusa hasta saber qué pasó — y si resultó
autorizado, nunca.

> Pretender que los huecos son imposibles llevaría a reusar un número que ARCA
> pudo haber autorizado, que es la doble emisión por otro camino.

La correlatividad ante el organismo se resuelve **preguntándole a ARCA por dónde
va** (`FECompUltimoAutorizado`), no adivinando localmente.

Se usa `UPDATE ... RETURNING` sobre `fiscal_counters` —candado de fila— y no
`MAX(numero)+1`, que bajo concurrencia da el mismo número a dos lectores. Es el
patrón que `next_commercial_number` (0050) ya había resuelto.

`reservar_numero_fiscal()` es **idempotente**: si la intención ya tiene número, lo
devuelve sin consumir otro.

---

## 7–8. Concurrencia, timeout y UNKNOWN

Los seis casos de §8, probados contra la base:

| Caso | Resultado |
|---|---|
| Dos pedidos simultáneos, misma venta | 1 creada, 1 con `23505` |
| Misma venta, otro ambiente | 2 intenciones (correcto) |
| Misma venta, otra empresa | 2 intenciones (correcto) |
| Reserva doble | Mismo número, no consume otro |
| Dos reservas simultáneas | Números distintos |
| Retry desde `DESCONOCIDA` | **`23514` — la base lo rechaza** |

**La clasificación del desenlace no es por tipo de error técnico, sino por si el
pedido pudo haber llegado.** Un timeout de conexión y uno de lectura son el mismo
error para un cliente HTTP y cosas opuestas para una emisión.

| Desenlace | Estado | ¿Reintento solo? |
|---|---|---|
| `NO_SE_ENVIO` | `LISTA` | **Sí** — consta que no salió |
| `AUTORIZO` | `AUTORIZADA` | No |
| `RECHAZO` | `RECHAZADA` | No |
| `SIN_RESPUESTA` | `DESCONOCIDA` | **Nunca** |

Preguntar de más cuesta una consulta; emitir de más cuesta una factura.

---

## 9–10. Reconciliación

`FECompUltimoAutorizado` es el mecanismo oficial, ya implementado, con manual
archivado:

| Último autorizado | Conclusión |
|---|---|
| ≥ reservado | El comprobante **existe** |
| = reservado − 1 | Nunca se autorizó |
| < reservado − 1 | **Inconsistente** — no se adivina |

**Lo que falta:** `FECompConsultar`, que trae el CAE. Sin él, una intención que
resultó existir queda esperando a que alguien la complete a mano — preferible a
inventarle un CAE.

`SinReconciliador` contesta `SIN_RECONCILIADOR`, **no** `NO_AUTORIZADO`. La
diferencia decide si se factura de nuevo.

---

## 11–13. Contabilización, multiempresa, seguridad

**No toqué la contabilidad.** No hay emisión, así que no hay asiento que
reordenar. El modelo correcto —operación → intención → autorización → impacto
definitivo— queda escrito y sin implementar, porque implementarlo sin emisión
sería mover asientos existentes sin evidencia.

**Multiempresa:** RLS `FORCE` + política por `company_id`; el `company_id` es
parte de la clave de idempotencia; el trigger impide cambiar la identidad de una
intención (empresa, ambiente, origen) — que sería la forma de esquivar el índice.

**Seguridad:** `DELETE` revocado; `AUTORIZADA` exige CAE por `CHECK`; el CAE solo
existe en `AUTORIZADA`; el número no se cambia una vez reservado.

---

## 14. Auditoría

Cinco acciones en el vocabulario existente: `DECLARAR_INTENCION_FISCAL`,
`RESERVAR_NUMERO_FISCAL`, `EMITIR_COMPROBANTE`, `RECONCILIAR_EMISION` (exige
motivo), `ANULAR_INTENCION_FISCAL` (exige motivo). No se creó ningún sistema
paralelo.

Una intención en duda aparece en `work_queue` con `bloquea = true`.

---

## 15. Tests

**S-42, 31 casos.** Mutaciones observadas:

| Mutación | Detectada por |
|---|---|
| `DESCONOCIDA → EMITIENDO` permitido | 1 caso |
| Índice de idempotencia eliminado | 2 casos |
| *(hallado por el propio control)* trigger dejaba cambiar el número | 1 caso |

El tercero es un defecto que S-42 encontró **en mi propio trigger** al primer
intento: el retorno temprano cuando el estado no cambiaba dejaba pasar un
`UPDATE ... SET cbte_numero = 999`. Corregido moviendo la comprobación antes del
retorno, y extendida a la identidad completa de la intención.

---

## 16. Riesgos restantes

1. **`FECompConsultar` sin implementar.** Una intención que resultó autorizada no
   recupera su CAE sola.
2. **El extremo de producción de wsfev1 sin confirmar** (heredado de B2.5.4).
3. **El impacto contable de una emisión no está diseñado**, porque no hay emisión.

---

## 17. Qué falta para producción

1. Implementar `FECompConsultar` **leyendo el manual archivado**, no de memoria.
2. Confirmar el extremo de producción de wsfev1 y archivarlo con hash.
3. Diseñar el impacto contable de una emisión autorizada.
4. Sacar la regla `la-emision-no-llega-a-la-aplicacion` **a sabiendas**.
5. Poner `EMISION_HABILITADA` en `true`.
6. Certificado de producción + `wsfe` autorizado en WSASS.
7. Smoke test en homologación, de punta a punta.

---

## 18. Próximo paso

**Implementar `FECompConsultar` contra el manual archivado.** Es lo único que
convierte la reconciliación de «sé si existe» en «puedo cerrarlo solo», y es
interno: no depende de ningún trámite.

---

## 19. Matriz determinística

| Control | Estado | Evidencia | Riesgo | Tipo |
|---|---|---|---|---|
| Idempotency key | 🟢 | Clave derivada de la operación comercial; 4 casos | — | CODE |
| DB uniqueness | 🟢 | Índice único parcial; mutación detectada por 2 casos | — | TEST |
| Concurrency | 🟢 | 2 pedidos y 2 reservas simultáneos contra la base | — | TEST |
| Numbering | 🟢 | `UPDATE ... RETURNING`; reserva idempotente | Huecos, declarados | CODE |
| Timeout | 🟢 | Clasificación por «pudo haber llegado» | — | CODE |
| UNKNOWN state | 🟢 | Sin arista a `EMITIENDO`, en TS **y** en el trigger | — | TEST |
| Reconciliation | 🟡 | `FECompUltimoAutorizado` concluye si existe | Falta el CAE | EXTERNAL |
| Retry policy | 🟢 | Solo `NO_SE_ENVIO` se reintenta solo | — | CODE |
| Crash recovery | 🟢 | La intención se persiste antes de llamar | — | CODE |
| Multi-company | 🟢 | RLS + clave + trigger de identidad | — | TEST |
| Environment isolation | 🟢 | Heredado de S-41; ambiente en la clave | — | TEST |
| Production gate | 🟢 | 7 condiciones; `EMISION_HABILITADA = false` | — | CODE |
| Audit trail | 🟢 | 5 acciones en el vocabulario existente | — | CODE |
| Secret redaction | 🟢 | Heredado; la tabla no guarda material | — | TEST |
| Accounting consistency | 🟡 | Sin diseñar | Depende de que haya emisión | DECISION |
| PDF state | 🟢 | Sin QR imprime la ausencia declarada | — | CODE |
| Frontend state | 🔴 | **No hay UI de emisión** | Construirla con los 8 estados | CODE |
