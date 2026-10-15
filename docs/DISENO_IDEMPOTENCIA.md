# Idempotencia de caja y stock, y transiciones que resisten la concurrencia

**Estado: IMPLEMENTADO Y PROBADO LOCALMENTE (`aai_test`). NO DESPLEGADO. Nada de esto se verificó en el VPS.**
Fecha: 2026-10-15. Aprobado por el titular: clave en la fila con restricciones únicas, clave obligatoria, `200` con el
mismo cuerpo en la repetición, corrección de transiciones inseguras, despliegue separado del de zona horaria.

> **Qué está probado y dónde.** Todo lo que dice «probado» salió de correr las suites contra la base local `aai_test`
> (PostgreSQL de esta máquina, 133 migraciones). **Producción sigue en la migración 0132, sin la 0133 y sin este código.**
> El camino de despliegue (migración, imagen, reversión) está escrito en §11 y **no se ejecutó**.

## Índice

1. El problema, medido
2. La decisión: el árbitro es la base de datos
3. La clave: cómo se genera, se conserva y se reutiliza
4. Compatibilidad con clientes existentes
5. Cambios en la base (migración 0133)
6. Qué hace cada operación
7. Concurrencia, fallas y resultado incierto
8. Transiciones de estado: defectos hallados, invariantes y pruebas
9. La consola
10. Pruebas y mutaciones
11. Puesta en producción y reversión
12. Lo que este diseño no cubre

## 1 · El problema, medido

Un cliente de red puede reintentar una petición **que el servidor ya procesó**: la respuesta se perdió, el navegador
cortó por tiempo de espera, la persona volvió a tocar «Guardar» sin saber si había funcionado. Antes de este trabajo cada
intento creaba un movimiento nuevo:

| Endpoint | Qué crea | Qué lo frenaba ante un reintento |
|---|---|---|
| `POST /cash-sessions/:id/movimientos` | un ingreso o egreso de caja | **Nada** |
| `POST /stock-movements/salida` | una salida de mercadería | **Nada** (una venta admite salidas parciales: `origen_id` no puede ser único) |
| `POST /stock-movements/ajuste` | un ajuste de existencia | **Nada** |
| `POST /stock-movements/transferencia` | **dos** filas: salida y entrada | **Nada** |
| `POST /tax-transactions/:id/salida` | **N** salidas (una por línea), en una transacción | Un `SELECT count(*)` previo: no resistía dos pedidos simultáneos |
| `POST /cash-sessions` (abrir) | una sesión | El índice `cs_una_abierta_por_caja`: el reintento daba 409 en lugar de la misma sesión |

Esto no es solo un doble clic: es un **reintento de red**, que ningún control de la interfaz puede ver. Duplicar un
movimiento de caja es plata que no existe; duplicar una salida de stock desvaloriza el inventario.

## 2 · La decisión: el árbitro es la base de datos

Hay dos formas de hacerlo: (1) una tabla genérica de claves con un estado `EN_CURSO` que puede quedar colgado si el
proceso muere, o (2) **la clave vive en la propia fila del movimiento, con un índice único**, y el `INSERT … ON CONFLICT
DO NOTHING` es el árbitro. Se eligió la 2 (aprobada):

- «Una misma operación no puede generar dos movimientos» es una **restricción de la tabla**, no una disciplina del código:
  aunque la API tuviera un error, la base rechaza el segundo `INSERT`.
- **No hay estado intermedio**: la fila existe o no existe, dentro de la misma transacción (`withCompany`). Un proceso que
  muere antes de confirmar no deja nada que limpiar.
- No hay tarea de limpieza ni vencimiento de claves: la clave dura lo que dura la fila.

## 3 · La clave: cómo se genera, se conserva y se reutiliza

**Forma.** Encabezado `Idempotency-Key`, de 16 a 128 caracteres `[A-Za-z0-9_-]`. La base lo impone con un `CHECK`, no solo la API.

**Una clave por intención de la persona, no por clic.** La regla, que la consola implementa y prueba:

| Momento | Qué pasa con la clave |
|---|---|
| La persona confirma una operación | Se **genera** (`crypto.randomUUID()`, con respaldo de `getRandomValues`) y viaja en el encabezado |
| La respuesta se pierde, hay corte de red, tiempo agotado, 5xx | Se **conserva** y se **reutiliza** en el reintento de *esa misma* operación con *esos mismos* datos |
| La API responde un error de validación (4xx) | Se conserva mientras no cambien los datos (no se escribió nada, así que reutilizarla es inocuo) |
| La operación salió bien (`201` o `200` repetido) | Se **descarta**: la próxima operación, aunque tenga los mismos datos, es otra y lleva otra clave |
| La persona cambia algún dato tras un fallo | Se **renueva**: es otra operación (la misma clave con otros datos daría `422`) |
| Se recarga la página | Se pierde (vive en memoria). Es seguro: la pantalla se vuelve a leer y la persona ve si el movimiento ya está |

**Para quien integre la API** (no hay integradores registrados hoy):

- Generá un UUID por intención y reutilizalo **solo** para reintentar la misma operación. No lo derives de la hora.
- Una clave natural (por ejemplo `cobro-<id del sistema origen>`) sirve si identifica una única intención.
- La clave **no es secreta** pero se guarda en la fila: no pongas datos personales ni credenciales.
- Una clave vale **por empresa y por tabla**: la misma clave en dos empresas son dos operaciones; la misma clave en caja y en stock, también.

**Retención.** Indefinida (es parte de la fila del movimiento, que es un libro append-only). Reusar una clave meses después
sigue devolviendo el mismo movimiento.

## 4 · Compatibilidad con clientes existentes

La clave es **obligatoria** en las seis operaciones de §6 (decisión aprobada: una clave opcional deja el riesgo en manos de cada cliente).

| Situación | Qué ocurre | Por qué es seguro |
|---|---|---|
| Código viejo (versión anterior de la aplicación) contra la base ya migrada | Sigue funcionando: inserta con las columnas nuevas en `NULL` y los índices únicos son parciales | Las columnas son anulables y los índices parciales: la 0133 es **aditiva** |
| Código nuevo contra una base sin migrar | **No arranca bien**: las columnas no existen | Por eso la migración va **antes** que la imagen (§11) |
| Una pestaña de la consola abierta ANTES del despliegue | Su JavaScript viejo no manda la clave: la API responde `400 «Falta el encabezado Idempotency-Key…»`, **sin escribir nada** | El mensaje le dice a la persona que recargue. No hay movimientos perdidos ni duplicados |
| Un cliente que no es la consola | Recibe el mismo `400`; tiene que agregar el encabezado | No se conoce ninguno: la API no es pública |
| Scripts y fixtures que insertan por SQL | Siguen funcionando | No pasan por la API y la base no exige clave (§5) |
| Reversión del código | Funciona sin tocar la base | Ver §11 |

## 5 · Cambios en la base (migración `0133`, aditiva)

`infrastructure/db/migrations/0133_idempotencia_y_transiciones_de_caja_y_stock.sql`. Para `cash_movements`, `stock_movements`
(y `cash_sessions`, sin parte):

- `idempotency_key text`, `idempotency_part smallint NOT NULL DEFAULT 0`, `request_hash char(64)`.
- `CHECK` de forma de la clave (`*_clave_valida`), de forma de la huella (`*_huella_valida`) y de que **vayan juntas**
  (`*_clave_con_huella`: una clave sin huella no distingue un reintento de un error de uso).
- Índice único **parcial**: `cmv_clave_unica`, `sm_clave_unica` sobre `(company_id, idempotency_key, idempotency_part) WHERE idempotency_key IS NOT NULL`; `cs_clave_unica` sobre `(company_id, idempotency_key)`.

`idempotency_part` distingue las filas de **una misma operación**: una transferencia crea dos (0 = salida, 1 = entrada) y la
salida de un comprobante crea una por línea (0 … N−1). `request_hash` es el SHA-256 de la operación y sus datos
canonizados (claves de objeto ordenadas): sirve para una sola cosa, distinguir un **reintento** (mismo hash) de un **error de uso** (misma clave, otros datos).

Las filas existentes quedan con `NULL`: **no hay nada que migrar ni reescribir**. No se agrega una restricción que obligue a
tener clave en toda fila nueva (los fixtures y scripts que insertan directo seguirían rotos sin motivo): la obligatoriedad se exige en la API.

La misma migración corrige las transiciones de §8 (triggers `cs_transicion`, `sc_transicion`, `assert_sesion_abierta` con
`FOR SHARE`, `assert_movimiento_de_cheque` con un candado de aviso por cheque, y la rama de «mismo estado» de `assert_transicion_de_orden`).
`scripts/check-structure.mjs` declara los objetos nuevos (`audit:estructura`).

## 6 · Qué hace cada operación

Dentro de **una sola transacción**:

```text
1. validar el encabezado y calcular request_hash (SHA-256 de operación + empresa + datos canonizados)
2. INSERT ... (idempotency_key, request_hash, ...)
   ON CONFLICT (company_id, idempotency_key[, idempotency_part]) WHERE idempotency_key IS NOT NULL DO NOTHING
   RETURNING id
3a. devolvió fila  → primera vez: auditar y responder 201 con el cuerpo de siempre
3b. no devolvió    → ya existía: leer la(s) fila(s) por clave
      · huella igual   → 200, el MISMO cuerpo y el encabezado  Idempotent-Replayed: true. No se escribe nada
      · huella distinta → 422 IDEMPOTENCIA_CONFLICTO. No se escribe nada
```

| Operación | Filas | Cuerpo de la repetición |
|---|---|---|
| `POST /cash-sessions` (abrir) | 1 | `{ id }` |
| `POST /cash-sessions/:id/movimientos` | 1 | `{ id }` |
| `POST /stock-movements/salida`, `/ajuste` | 1 | `{ id }` |
| `POST /stock-movements/transferencia` | 2 (partes 0 y 1) | `{ salida, entrada }` |
| `POST /tax-transactions/:id/salida` | N (una por línea) | `{ movimientos, ids }` en el mismo orden |

**Lo que NO hace una repetición:** no escribe una segunda fila de auditoría (la acción ocurrió una vez), no vuelve a validar
saldos ni existencias contra el estado actual (devuelve lo que ya se hizo — por eso una repetición funciona aunque la sesión
se haya cerrado entre el original y el reintento), y no toca ninguna otra tabla.

**Misma clave, otros datos → `422 IDEMPOTENCIA_CONFLICTO`.** Entran en la huella la empresa, los identificadores de la URL
(sesión, comprobante) y todo el cuerpo; no entran el orden de los campos, el usuario ni los encabezados.

## 7 · Concurrencia, fallas y resultado incierto

| Caso | Qué pasa | Por qué es seguro |
|---|---|---|
| Dos pedidos idénticos en el mismo instante | El segundo espera en el índice único hasta que el primero confirma, y recién entonces recibe `DO NOTHING`. Un `201` y un `200` | Comportamiento de PostgreSQL para un índice único |
| Lo mismo en la **apertura de sesión** | Además toma un candado de aviso (`pg_advisory_xact_lock`) sobre `(empresa, clave)` | La tabla tiene **dos** índices únicos (la clave y «una abierta por caja»): sin el candado, 2 de cada 320 reintentos simultáneos recibían `409 «ya hay una sesión abierta»` en lugar de la repetición (defecto D9, medido) |
| La respuesta se pierde y el cliente reintenta | `200` con el mismo cuerpo | La fila ya está confirmada |
| El servidor muere antes de confirmar | No existe la fila; el reintento hace la operación normal | No hay estado intermedio |
| El servidor muere después de confirmar y antes de responder | Igual que «la respuesta se pierde» | |
| La auditoría falla después del `INSERT` | Se revierte todo; **la clave no queda consumida** | Es la misma transacción (probado con un trigger que hace fallar la auditoría) |
| Una transferencia falla en la entrada | Se revierte también la salida; no queda una mitad | Idem |
| Misma clave, otros datos (también en paralelo) | Gana uno; los demás reciben `422`; no queda mezcla | `request_hash` |
| Dos empresas, misma clave | Dos operaciones independientes | El índice incluye `company_id` |
| Dos operaciones **distintas** sobre el mismo comprobante (claves distintas) | Una sola salida: la otra recibe `409 «ya tiene salida»` | La salida bloquea la fila del comprobante (`FOR NO KEY UPDATE`) antes de mirar si ya hay salida (defecto D4) |

**Operaciones cuyo resultado quedó incierto.** Si el cliente no sabe qué pasó (corte de red, tiempo agotado, `5xx`), la regla
es única: **reintentar con la misma clave y los mismos datos**. Hay exactamente dos desenlaces: `201` (la operación no había
ocurrido y ahora ocurrió) o `200` + `Idempotent-Replayed: true` (ya había ocurrido y se devuelve lo mismo). No hay un tercero en
el que quede a medias. El código `422 IDEMPOTENCIA_RESULTADO_INCIERTO` existe como defensa: se emitiría si la fila que
provocó el conflicto desapareciera entre dos lecturas, lo que en un libro append-only no puede ocurrir; el mensaje manda reintentar.

**Lo que no cubre el reintento:** un movimiento de cheque (`POST /checks/:id/movimientos`). Su máquina de estados rechaza
repetir el mismo hecho (`422`), pero un reintento tras perder la respuesta recibe ese rechazo y no la repetición; la persona
ve el cheque ya movido en la lista. Está serializado (D5), no es idempotente.

## 8 · Transiciones de estado: defectos hallados, invariantes y pruebas

Una transición («cerrar», «confirmar», «pagar», «anular») cambia el estado de una fila existente. El código leía el estado con
un `SELECT` suelto y escribía después, y entre las dos cosas puede entrar otra petición. La auditoría encontró lo siguiente
(cada defecto se reprodujo **antes** de corregirlo: 5 de las 8 pruebas de concurrencia de caja y stock fallaban con el código anterior).

| # | Defecto | Invariante contable que protege | Corrección | Prueba que la demuestra |
|---|---|---|---|---|
| D1 | Dos cierres de caja simultáneos pasaban los dos; el segundo **pisaba** el arqueo (saldo contado, quién, cuándo) y duplicaba la bitácora | **I1** Un arqueo ocurre una vez; una sesión cerrada no vuelve a cambiar | Trigger `cs_transicion` + `UPDATE … AND status = 'ABIERTA'`; el reintento idéntico recibe `200` repetido | `transiciones-concurrentes` I1, `idempotencia` «cierre de caja» |
| D2 | Un movimiento y el cierre que se cruzaban: el movimiento entraba a una sesión que terminaba cerrada y cambiaba el saldo teórico contra el que se contó | **I2** El teórico contra el que se contó no cambia después de contar | `assert_sesion_abierta` con `FOR SHARE`: el cierre espera al movimiento (y al revés) | `transiciones-concurrentes` I2 (dos interleavings determinísticos con `lock_timeout`) |
| D3 | Dos cierres de un recuento de stock duplicaban los ajustes (medido: seis cierres → seis `200`). El libro es append-only: un ajuste duplicado no se deshace, se compensa | **I3** Un recuento se cierra una vez; sus ajustes se aplican una vez | Trigger `sc_transicion` | `transiciones-concurrentes` I3 |
| D4 | La salida de un comprobante usaba `SELECT count(*)` para saber si ya existía: dos pedidos con claves distintas registraban las dos | **I4** La salida de una venta se registra una vez (el costo de ventas no se duplica) | `FOR NO KEY UPDATE` sobre el comprobante antes de mirar | `transiciones-concurrentes` I4 y `idempotencia` (8 claves distintas + candado determinístico) |
| D5 | El trigger de movimientos de cheque miraba el movimiento anterior sin candado: dos «DEPOSITADO» simultáneos pasaban los dos | **I5** Un cheque se deposita una vez | Candado de aviso por cheque (`pg_advisory_xact_lock`). **Primero se usó `FOR UPDATE` y la prueba lo delató:** el disparador es `AFTER INSERT`, la clave foránea ya tomó `KEY SHARE` sobre la fila, y dos inserciones que piden `FOR UPDATE` se bloquean entre sí (deadlock, 2 de 6 terminaban en 500) | `cheques` «se serializan» (determinístico + 6 depósitos por la API); mutación DB-9 reintroduce el `FOR UPDATE` y falla |
| D6 | La máquina de estados de la 0082 dejaba pasar `PAGADA → PAGADA`, `APROBADA → APROBADA`: repetir «pagar» con otro asiento **pisaba el asiento del pago**; repetir «aprobar» pisaba quién y cuándo aprobó | **I6** Una orden pagada nombra un asiento y esa referencia no cambia; la firma de una transición es un hecho | Rama de «mismo estado» rechaza cambiar `aprobada_at/por`, `entry_id`, `pagada_at`, `motivo_anulacion` (`E_OP_YA_FIRMADA`) + `UPDATE` condicional por estado en `aprobar/anular/pagar` | `ordenes-de-pago` «transiciones: reintento y concurrencia» (6 pruebas) |
| D7 | `goods-receipts/:id/confirm` y `/cancel` no eran condicionales: dos confirmaciones auditaban dos veces; dos anulaciones **pisaban el motivo** de la primera (la 0052 deja pasar `ANULADA → ANULADA`) | Lo que firma una anulación (el motivo) no se reescribe; la entrada a stock ocurre una vez | `UPDATE … AND status = …` en una sola sentencia (depósito + confirmación) | `recepcion-de-compras` «reintento y concurrencia» (3 pruebas) |
| D8 | `party-allocations/:id/cancel`: dos anulaciones simultáneas pisaban el motivo y duplicaban la bitácora | Una imputación se anula una vez | `UPDATE … AND status = 'ACTIVA'`; la segunda recibe `409` | `imputacion-de-cobros` «6 anulaciones simultáneas» |
| D9 | `POST /cash-sessions` con la misma clave en paralelo: 2 de 320 recibían `409 «ya hay una sesión abierta»` en lugar de la repetición | Una operación, una sesión | Candado de aviso por `(empresa, clave)` | `idempotencia` (15 rondas × 8 + candado determinístico) |

**Semántica de las transiciones repetidas** (decisión coherente con la aprobada: «cuando se repite una solicitud ya completada, `200` y el cuerpo original»):

- Misma persona, mismos datos, estado ya alcanzado → **`200` + `Idempotent-Replayed: true`**, sin escribir ni auditar de nuevo
  (cierre de caja con el mismo arqueo; aprobar por la misma persona; anular con el mismo motivo; pagar con el mismo asiento; confirmar/anular una recepción).
- Estado ya alcanzado con **otros datos** → se rechaza y lo firmado **no se pisa**: `409` o `422 TRANSICION_INVALIDA`.
- Dos transiciones distintas a la vez (aprobar y anular) → gana la primera; la otra recibe `TRANSICION_INVALIDA`; el estado final es coherente.
- Los cierres de recuento de stock siguen respondiendo `409` al repetirse (el cuerpo no se deriva del pedido); es un estado final y el mensaje dice qué pasó.

## 9 · La consola

- `claveDeOperacion(intención, cuerpo)` + `apiIdempotente(...)`: aplican la regla de §3. `api()` manda el encabezado cuando recibe una clave.
- Los seis llamadores (abrir caja, movimiento de caja, salida / ajuste / transferencia de stock, salida de un comprobante) pasan por `apiIdempotente`.
- Se prueba ejecutando el **código real** de la consola con `node:vm` (`tests/security/consola-clave-de-idempotencia.test.ts`): reutiliza ante el fallo, renueva al salir bien y al cambiar los datos, y ningún llamador vuelve a `api()` a secas.

## 10 · Pruebas y mutaciones

> Todo contra `aai_test` (local). Comando: `DATABASE_URL` y `TEST_DATABASE_URL` apuntando a `aai_test`, `npx vitest run`.

**Qué se agregó.**

| Archivo | Pruebas | Qué demuestra |
|---|---|---|
| `tests/integration/idempotencia.test.ts` | 38 | Restricciones de la base por SQL directo (incluye **50 inserciones simultáneas** → 1 fila); contrato de la API (400 / 201 / 200 repetido / 422); respuesta perdida; sesión cerrada entre el original y el reintento; transferencia; salida de comprobante; 8 pedidos idénticos en paralelo en cada operación; **200 operaciones en paralelo con claves repetidas** (filas == claves distintas y saldo == suma de las únicas); auditoría que falla a mitad de camino (la clave no se consume); aperturas de sesión idénticas en 15 rondas; candados esperados de forma determinística |
| `tests/integration/transiciones-concurrentes.test.ts` | 8 | I1–I4, con dos interleavings determinísticos (`lock_timeout`) |
| `tests/integration/cheques.test.ts` | +2 | I5: el siguiente movimiento espera (determinístico) y 6 depósitos simultáneos → uno |
| `tests/integration/ordenes-de-pago.test.ts` | +6 | I6 y la semántica de aprobar / anular / pagar repetidos y simultáneos |
| `tests/integration/recepcion-de-compras.test.ts` | +3 | confirmar / anular una recepción, repetido y simultáneo |
| `tests/integration/imputacion-de-cobros.test.ts` | +2 | anulación simultánea (determinística y con 6 pedidos) |
| `tests/unit/idempotencia-huella.test.ts` | 9 | Huella estable ante el orden y los `undefined`, sensible a todo lo demás; forma de la clave |
| `tests/security/consola-clave-de-idempotencia.test.ts` | 20 | La regla de la clave de la consola, ejecutando su código real, y que los seis llamadores la usan |

Las suites que ya llamaban a estos endpoints (`caja`, `stock`, `valuacion`, `cadena-de-ventas`) mandan una clave nueva por pedido (`tests/integration/helpers/clave-de-idempotencia.ts`); su contenido no cambió.

Dos lectores estáticos de la consola (`consola-contrato`, `helpers/consola`) no reconocían la forma `apiIdempotente(…)` y dieron cuatro rojos (S-12, S-25 y, por el guion de siembra nuevo, S-37 y S-38). Se corrigieron enseñándoles la forma nueva (el mismo defecto de ceguera de instrumento que ya había pasado con `bajarCsv`), no relajando los controles.

**Defectos que encontraron las propias pruebas** (no la auditoría previa):

- **D9** — la carrera de la apertura de sesión (2 de 320 reintentos simultáneos con `409`). La reprodujo una prueba de estrés escrita para otra cosa.
- **Deadlock de cheques** — el primer diseño de D5 (`FOR UPDATE`) lo disparaba la prueba de 6 depósitos simultáneos (2 de 6 en `500`). Se cambió por un candado de aviso y se dejó una mutación que reintroduce el `FOR UPDATE`.

**Mutaciones.** Cada una rompe a propósito una pieza del diseño y comprueba que **alguna** prueba falla; el código se restaura y se verifica byte a byte (los objetos de la base, por `pg_get_functiondef` / `pg_get_indexdef`).

- **Código — 28 mutantes, todos detectados.** En la primera pasada, 4 no se detectaron y se resolvieron mejorando las pruebas, no el mutante:
  - *huella dependiente del orden de los campos* — equivalente a nivel de API (zod ya normaliza el orden del cuerpo antes de calcular la huella); se mató con pruebas unitarias directas de `huellaDeLaOperacion`;
  - *anular una imputación sin condición de estado* — la prueba de 6 pedidos no garantizaba que se superpusieran; se agregó una determinística con la fila bloqueada;
  - *el cierre repetido no compara quién cerró* — se agregó el caso «mismo arqueo, otra persona → 409»;
  - *la consola muestra una repetición como éxito nuevo* — se agregaron el marcado `repetida` y su texto.
- **Base — 10 mutantes, todos detectados**, corridos sobre una **copia descartable** (`aai_mut_test`): quitar cada uno de los tres índices únicos, hacer el índice de sesiones sin `company_id`, quitar `cs_transicion` / `sc_transicion`, quitar el `FOR SHARE`, quitar el candado de cheques, volver al `FOR UPDATE` (deadlock), y dejar reescribir la firma de la orden.
- *Incidente de proceso:* la primera corrida de las mutaciones de base fue sobre `aai_test` y, al quitar un índice único, las propias pruebas dejaron filas con clave duplicada que impidieron recrearlo. Se reparó (50 filas duplicadas de prueba borradas con los triggers de usuario deshabilitados solo dentro de la transacción, índice recreado, verificación) y las mutaciones se rehicieron sobre una copia. No tocó ninguna otra base.

**Verificación completa.** `typecheck`, `lint`, `lint:arch` y `check:no-float` en verde; `audit:estructura`: **456 objetos declarados presentes** (442 + 14); suite completa (`npx vitest run`), una sola corrida limpia por zona y después de la última modificación: **210 archivos / 3436 pruebas, todas verdes, con la base en hora de Argentina y con la base en UTC** (2026-10-15).

> Dos cosas que las corridas completas mostraron y se corrigieron, ajenas a la idempotencia pero halladas en el camino: una carrera de `scripts/desplegar.sh` (`docker ps | grep -q` bajo `set -o pipefail` daba «NO está corriendo» de forma intermitente; ahora se captura la salida antes de buscar, con una prueba determinística y 3 mutaciones) y dos pruebas de `respaldar` que comparaban «las bases descartables de antes» contra «las de después» y fallaban cuando otro archivo de prueba creaba la suya en el medio (ahora comprueban que ninguna NUEVA sobreviva).
> También se descubrió que dos corridas completas simultáneas se pisan entre sí (una prueba crea un archivo de sonda en el árbol): **nunca lanzar dos a la vez**.

## 11 · Puesta en producción y reversión

> **Nada de esto se ejecutó. Requiere autorización específica antes de tocar el VPS.** Es un despliegue **separado** del de zona horaria (aprobado).

**Orden.** (1) Copia de resguardo verificada y restaurada (la compuerta de `scripts/desplegar.sh`). (2) Ensayo de la 0133 sobre
una restauración de esa copia (como se hizo con la 0132), con `audit:estructura` y la cadena de auditoría. (3) Migración 0133 en producción (aditiva; el código viejo sigue
funcionando). (4) Imagen nueva (API + consola juntas, para que la consola servida ya mande la clave). (5) Verificación.

**Verificación posterior (V-I1 … V-I5), a ejecutar en el VPS y registrar con su salida:**

1. `audit:estructura` verde con los 14 objetos nuevos presentes (**456 declarados**; eran 442 antes de la 0133).
2. `POST /cash-sessions/:id/movimientos` sin encabezado → `400` (sin escribir).
3. El mismo movimiento dos veces con la misma clave → `201` y `200` con el mismo `id`; una sola fila.
4. La misma clave con otro importe → `422 IDEMPOTENCIA_CONFLICTO`.
5. Cerrar una sesión de prueba dos veces → `200` y `200` repetido; una sola entrada `ARQUEAR_CAJA` en la bitácora.

**Reversión.**

- *Del código:* volver a la imagen anterior (`desplegar.sh --revertir`). La base queda como está: las columnas son anulables, los
  índices parciales, y el código viejo no los toca. No hay que revertir la migración.
- *Efecto de dejar la 0133 con el código viejo:* los triggers nuevos siguen activos. Un doble cierre simultáneo de caja o de recuento
  deja de pisar (el segundo recibe un error de base en lugar de pisar); no afecta ningún flujo secuencial.
- *De la migración (solo si hiciera falta, sin `CASCADE`):* `DROP TRIGGER cs_transicion ON cash_sessions; DROP TRIGGER sc_transicion ON stock_counts;`
  y después las funciones `assert_transicion_de_sesion_de_caja()` y `assert_transicion_de_recuento()`; los índices `cmv_clave_unica`, `sm_clave_unica`, `cs_clave_unica`; y
  las columnas. `assert_sesion_abierta`, `assert_movimiento_de_cheque` y `assert_transicion_de_orden` se restauran con su definición de la 0068, 0064 y 0082 respectivamente.
  Un `CASCADE` se lleva objetos ajenos en silencio: después de cualquier reversión manual, reconstruir una base limpia y correr `audit:estructura`.

## 12 · Lo que este diseño no cubre

- Una operación enviada **dos veces con claves distintas** (dos intenciones de la persona) es, para el sistema, dos operaciones. No hay forma de saber que eran una; lo ve la persona en la lista de movimientos.
- Inserciones directas por SQL o desde scripts: no pasan por la API y no llevan clave.
- El stock negativo y los saldos no se validan en la repetición: devuelve lo que ya se hizo.
- Los movimientos de cheque están serializados pero no son idempotentes (§7).
- Otras creaciones de la API (alta de comprobantes, terceros, productos…) tienen sus propias claves naturales (unicidad por documento, CUIT, número); este trabajo no las toca.
- Nada de esto se verificó en el VPS.
