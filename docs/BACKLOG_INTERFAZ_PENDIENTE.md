# Backlog de interfaz pendiente — los 19 ítems de S-25

2026-10-01. Fuente única de verdad de **qué pantalla/botón falta de verdad**:
`tests/security/capacidades-con-puerta.test.ts` (mapa `SIN_PUERTA`) — un test
que falla si la lista se desactualiza, no una foto fija. Este documento es el
análisis de negocio detrás de cada entrada: qué puede y no puede hacer hoy
quien usa NEXO, por qué, y qué prioridad real tiene cerrarlo.

**Actualización 2026-10-01 (segunda pasada):** se implementaron los dos ítems
sin ninguna alternativa funcional — **8/15** (ver y desimputar cobros/pagos) y
**9/10** (ver y anular correcciones).

**Actualización 2026-10-01 (tercera pasada):** se revisaron los 17 ítems
restantes uno por uno contra el backend real (no contra lo que este
documento decía). De esos 17: **11 se implementaron** (1, 3 parcial, 4
parcial, 5, 6/7, 11, 14, 16/17, 18, 19, 20); **3 quedan explícitamente
bloqueados** sin código nuevo porque dependen de una decisión de producto o
una credencial externa que no cambió (2, 12, 13); y **2 de los 11
"implementados" (3 y 4) sólo se cerraron en su caso de uso real, con el
caso restante documentado como no construible sin un endpoint nuevo** — ver
el detalle de cada uno.

De paso, revisando el backend de IVA para el ítem 5, apareció un bug real y
no relacionado con ninguna pantalla: `GET /vat/credito-fiscal/:txId`
devolvía `ivaDiscriminado` como un `Money` con `amount: bigint` sin pasarlo
por `toDecimalString` (que el resto del archivo sí usa para cada Money) —
`JSON.stringify` no sabe serializar un `bigint`, así que la ruta respondía
**500 ante cualquier comprobante de compra, siempre**, sin excepción. Se
corrigió en `apps/api/src/routes/vat.ts` y se probó con un test de
integración nuevo que falla contra el código viejo y pasa contra el
corregido (`tests/integration/credito-fiscal-iva.test.ts`).

El navegador seguía desconectado durante toda esta pasada, así que **no hay
confirmación visual** de ninguna de las pantallas nuevas; en su lugar se
siguió al milímetro el HTML/CSS de pantallas gemelas ya verificadas
visualmente, y se corrió la batería que sí detecta sin navegador: S-12 (la
consola solo llama rutas que existen), S-25 (cada capacidad tiene puerta —
bajó de 19 a 3 excepciones reales, cada una con su motivo), y la batería
completa de seguridad e integración (**497 pruebas, 50 archivos, todas en
verde**), incluidas las que ya cubrían cada ruta tocada, sin modificarlas.

**Convención de prioridad** (justificada caso por caso, no asignada por
plantilla):
- **BLOQUEANTE** — impide completar una operación de negocio real sin un
  rodeo que la propia aplicación no ofrece.
- **IMPORTANTE** — el dato o la acción existen por otro camino (otra
  pantalla, otro permiso, un paso manual), pero el camino que falta es el
  que el flujo normal espera.
- **MEJORA POSTERIOR** — conveniencia, o depende de una decisión de
  producto / credencial externa que todavía no existe, así que construir la
  pantalla ahora no destraba nada.

---

## 1 · `PUT /salespeople/:salespersonId` — RESUELTO 2026-10-01

- **Módulo / proceso:** Comisiones — ficha de un vendedor.
- **Implementado:** la ficha del vendedor (`cms-detalle`) suma un campo de
  nombre y un selector de estado (ACTIVO/INACTIVO) con botón «Guardar»,
  gateado por `commission:write`, mismo patrón que la ficha de tercero y
  de producto.
- **Evidencia de cierre:** S-25 ya no lista esta ruta como sin puerta; S-12
  en verde.

---

## 2 · `POST /comprobantes/:taxTransactionId/decision`

- **Módulo / proceso:** Afectación fiscal de un comprobante.
- **Hoy se puede:** registrar el comprobante, verlo, y cargar el asiento
  completo a mano desde Asientos (video 16) — el camino que el propio
  guion del curso usa y da por bueno.
- **Hoy NO se puede:** declarar la decisión de afectación desde la
  pantalla del comprobante mismo.
- **Alternativa funcional: sí, real y ya usada.** `journal_entry:create`
  manual cubre el mismo resultado contable.
- **Roles/permisos:** `journal_entry:create` — `CONTADOR` (no
  `ADMINISTRADOR`: cargar y aprobar asientos es exclusivo del profesional
  matriculado, por diseño del propio proyecto).
- **Consecuencia de no implementarlo:** ninguna operativa — es un atajo de
  menos clics, no una capacidad ausente.
- **Prioridad: MEJORA POSTERIOR.**

---

## 3 · `GET /statements/trace/:lineId` — PARCIALMENTE RESUELTO 2026-10-01

- **Módulo / proceso:** Estados contables y notas — trazabilidad de una
  cifra.
- **Lo que de verdad hacía falta ya estaba en la respuesta, sin esta
  ruta:** cada renglón de `GET /statements` (el estado recién armado, que
  es el caso que se mira el 99% de las veces) ya trae su `origen` —las
  cuentas que lo componen y el aporte de cada una— en la misma respuesta.
  La consola lo mostraba como JSON crudo detrás de «de dónde sale»; ahora
  lo muestra como una tabla (cuenta, aporte). No hizo falta llamar a
  ninguna ruta nueva: el dato ya viaja.
- **Por qué la ruta en sí sigue sin pantalla, y no es solo falta de
  tiempo:** `GET /statements/trace/:lineId` lee `financial_statement_lines`,
  que solo se llena cuando un estado se **emite** (`POST /statements/issue`).
  Para un renglón ya emitido hace falta su `line_id` persistido, y **ningún
  endpoint de este archivo lo devuelve** — ni el paquete de notas, ni
  ninguna otra lectura de un estado emitido. Construir un formulario que
  pida ese id sería pedirle a una persona un UUID que no tiene de dónde
  sacar — exactamente lo que el mandato prohíbe («no inventar una pantalla
  que la API no sostiene»).
- **Lo que destrabaría el resto:** un endpoint que liste los renglones
  persistidos de un estado ya emitido, con su `id`. Es una decisión de API
  (qué forma tiene esa lista), no una decisión de producto — queda
  anotado para que quien toque `statements.ts` lo sume si lo necesita.
- **Roles/permisos:** `statement:read`.

---

## 4 · `GET /banks/trace/:matchId` — PARCIALMENTE RESUELTO 2026-10-01

- **Módulo / proceso:** Conciliación bancaria.
- **Implementado para el caso alcanzable:** al confirmar una coincidencia
  propuesta (`POST /banks/reconciliations/:id/matches`), el propio
  endpoint devuelve el `matchId` recién creado — y con ese id ya en mano,
  la consola llama a `GET /banks/trace/:matchId` y muestra el movimiento
  del banco junto con el asiento que lo sostiene, en el momento.
- **Lo que queda sin cubrir, y por qué:** una coincidencia confirmada en
  una sesión **anterior** no tiene forma de recuperar su `matchId` desde
  ninguna pantalla — `GET /banks/reconciliations` solo trae un conteo
  (`coincidencias`), no la lista de matches con su id. Mismo patrón que el
  ítem 3: faltaría un endpoint que liste los matches de una conciliación
  con su id para poder trazarlos retroactivamente.
- **Roles/permisos:** `bank:read` / `bank:reconcile`.

---

## 5 · `GET /vat/credito-fiscal/:txId` — RESUELTO 2026-10-01

- **Módulo / proceso:** IVA — subdiario y crédito fiscal.
- **Implementado:** dentro de la nueva pantalla de comprobante (ítem 6/7),
  un botón «Evaluar» que muestra el estado (`NO_DETERMINABLE` /
  `IMPEDIDO_POR_FORMA`), el IVA discriminado, cada hallazgo de forma (con
  si bloquea o no) y la lista fija de lo que falta relevar para la
  cuestión de fondo — nunca "computable".
- **El endpoint tenía un bug real, encontrado al leerlo para esta
  pantalla:** devolvía 500 ante cualquier llamada por un `bigint` sin
  serializar — ver la nota al principio de este documento y
  `apps/api/src/routes/vat.ts`. Se corrigió antes de construir la UI
  encima; construirla sin corregirlo hubiera significado entregar un
  botón que siempre rompe.
- **Roles/permisos:** `vat_book:read`.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; test
  de integración nuevo (`credito-fiscal-iva.test.ts`) prueba 200 con
  `ivaDiscriminado` como string, donde antes daba 500.

---

## 6 y 7 · `GET`/`PUT /tax-transactions/:taxTransactionId/lines` — RESUELTO 2026-10-01

- **Módulo / proceso:** Detalle de un comprobante fiscal — sus renglones.
- **Implementado:** nueva sección «Renglones del comprobante» dentro de
  Operaciones fiscales (`op-lineas`), que es la primera ficha de
  comprobante individual que tiene la consola — y donde también se
  cuelgan los ítems 5, 11 y 14. Muestra la cabecera (neto/IVA/exento/no
  gravado/total) y la tabla de renglones; con `journal_entry:create`
  ofrece además un editor que reemplaza la lista completa.
- **Nada inventado sobre cuándo se puede editar:** el backend ya rechaza
  el reemplazo si los renglones no cierran contra la cabecera o si el
  comprobante ya funda un asiento aprobado (la corrección en ese caso va
  por contraasiento) — la UI solo muestra esos dos mensajes de error tal
  cual los devuelve la API, no agrega ninguna regla propia.
- **Roles/permisos:** `journal_entry:read` (ver) / `journal_entry:create`
  (editar).
- **Evidencia de cierre:** S-25 ya no lista ninguna de las dos rutas como
  sin puerta; S-12 en verde.

---

## 8 · `GET /tax-transactions/:taxTransactionId/allocations` — RESUELTO 2026-10-01

- **Módulo / proceso:** Imputaciones, vistas desde el comprobante.
- **Implementado:** nueva sección «Imputaciones de un comprobante»
  (`ter-imp` en `consola.html`, Terceros → cuenta corriente). Se elige un
  comprobante del tercero abierto y se listan sus imputaciones (fecha,
  asiento, importe, estado), con la anulación del ítem 15 en la misma
  pantalla.
- **Por qué quedó ahí y no en una pantalla propia del comprobante:** no
  existe todavía una ficha individual de comprobante en la consola (los
  ítems 6/7, detalle de renglones, siguen sin pantalla) — construirla solo
  para esto hubiera sido una pantalla nueva sin nada que la sostenga
  alrededor. Se usó el mismo punto de entrada que ya tenía la alternativa
  funcional (el lado del tercero), ahora con la vista oficial por
  comprobante en vez de inferirla de la cuenta corriente completa.
- **Roles/permisos:** `allocation:read` — `ADMINISTRADOR`, `CONTADOR`,
  `AUDITOR`, `USUARIO_EMPRESA`, `SOLO_LECTURA`. Gate verificado: la
  sección se oculta con `!puede('allocation:read')`, igual que `ter-plan`.
- **Evidencia de cierre:** S-25 ya no lista esta ruta como sin puerta
  (antes: `GET /tax-transactions/:taxTransactionId/allocations` en la
  excepción; ahora falla si alguien la vuelve a agregar ahí sin motivo).
  S-12 confirma que la llamada de la consola resuelve contra la ruta real.

---

## 9 y 10 · `GET /tax-transactions/:taxTransactionId/correcciones` + `POST /tax-transaction-corrections/:correccionId/cancel` — RESUELTO 2026-10-01

- **Módulo / proceso:** Notas de crédito/débito que corrigen un
  comprobante.
- **Implementado:** nueva sección «Correcciones de un comprobante»
  (`ter-corr` en `consola.html`, junto a «Aplicar una nota de crédito o de
  débito», que ya existía). Lista las correcciones de un comprobante
  elegido (sirve para los dos lados: si se elige la factura, muestra qué
  nota la corrigió; si se elige la nota, a qué factura se aplicó) y anula
  una activa con motivo obligatorio (≥3 caracteres), mismo patrón que el
  ítem 15.
- **Semántica de "anular" confirmada contra el trigger** (migración 0083,
  `assert_correccion`): anular **no revierte saldo manualmente** — solo
  cambia `status` a `ANULADA`, y es la vista `invoice_settlement` (filtro
  `WHERE c.status = 'ACTIVA'`) la que deja de sumar la corrección. La
  factura vuelve a figurar con lo que debía y la nota vuelve a aparecer
  sin aplicar, ambas automáticamente, sin tocar el Mayor. No se inventó
  ninguna semántica: es exactamente lo que el backend ya hacía.
- **Roles/permisos:** `allocation:read` (ver) / `allocation:write`
  (anular, botón «cancelar» solo visible con ese permiso y con la
  corrección en estado `ACTIVA`) — `ADMINISTRADOR`, `CONTADOR` para
  escribir.
- **Evidencia de cierre:** S-25 ya no lista ninguna de las dos rutas como
  sin puerta. S-12 confirma que las llamadas resuelven contra rutas
  reales. Las pruebas de integración que ya cubrían el trigger y la vista
  (`tests/integration/notas-aplicadas.test.ts`, 10 casos) siguen en verde,
  sin modificarse — la UI se construyó sobre un backend ya probado, no al
  revés.

---

## 11 · `POST /tax-transactions/:taxTransactionId/party` — RESUELTO 2026-10-01

- **Módulo / proceso:** Vincular un comprobante (que llegó con CUIT y
  razón social sueltos, típicamente desde un documento subido) a un
  tercero ya dado de alta en el padrón.
- **Implementado:** sección «Vincular a un tercero del padrón» en la
  misma pantalla de comprobante del ítem 6/7, con un selector de tercero
  (vacío = desvincular) y botón «Vincular». No se intentó precargar el
  tercero ya vinculado: ningún endpoint de este archivo expone el
  `party_id` actual de un comprobante individual, así que la pantalla
  ofrece la acción sin mostrar el estado previo — es un límite real del
  backend, no una omisión de la UI.
- **Roles/permisos:** `tax_affectation:declare` (**solo `CONTADOR`**) +
  `party:read`.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## 12 · `POST /documents/:documentId/classify`

- **Módulo / proceso:** Clasificación asistida por IA.
- **Depende de:** `AI_PROVIDER` real configurado — hoy `none` en todos
  los entornos verificados. Sin proveedor, el botón llamaría a un
  endpoint que hoy contestaría `SIN_PROVEEDOR` igual.
- **Prioridad: MEJORA POSTERIOR**, bloqueada además por una credencial
  externa (NEXO_ROADMAP.md P1 ya lo declara así, independientemente de
  esta auditoría).

---

## 13 · `POST /commercial-documents/:documentId/link-invoice`

- **Módulo / proceso:** Vincular un remito/pedido con la factura que lo
  cubre — relevante para facturación parcial.
- **Depende de:** una decisión de producto que NEXO_ROADMAP.md (P4) ya
  marca como `REQUIERE_DECISION` — si NEXO admite facturar en partes y
  con qué reglas. Construir la pantalla antes de esa decisión arriesga
  construir para un flujo que todavía puede cambiar.
- **Prioridad: MEJORA POSTERIOR**, bloqueada por decisión de producto,
  no por código.

---

## 14 · `POST /comprobantes/:taxTransactionId/decision/supersede` — RESUELTO 2026-10-01

- **Módulo / proceso:** Corregir una decisión de afectación ya tomada,
  conservando la anterior (no editarla ni borrarla).
- **Implementado:** sección «Corregir la decisión vigente» en la misma
  pantalla de comprobante, visible solo si hay una decisión vigente
  (`d.id` de `GET /comprobantes/:id/decision`) y con `decision:supersede`.
  Pide el nuevo resultado y un motivo de al menos 30 caracteres —el mismo
  mínimo que exige el backend, no uno inventado por la UI— y al guardar
  recarga la operación, que ya mostraba el historial de decisiones
  superadas.
- **Roles/permisos:** `decision:supersede` — **exclusivo de `CONTADOR`**.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## 15 · `POST /party-allocations/:allocationId/cancel` — RESUELTO 2026-10-01

- **Módulo / proceso:** Imputaciones de cobros/pagos.
- **Implementado:** dentro de la misma sección `ter-imp` del ítem 8 — cada
  imputación `ACTIVA` muestra un «cancelar» (solo con
  `allocation:write`), pide motivo (≥3 caracteres, igual que el patrón de
  anulación ya usado en Recepción), llama al endpoint, y al confirmar
  refresca tanto la lista de imputaciones como el saldo del tercero (el
  importe cancelado vuelve a sumar al pendiente).
- **Confirmado por lectura de código antes de construir, no asumido:**
  `party_allocations` es una capa de seguimiento independiente del Mayor
  — anular una imputación no toca `journal_entries`, por diseño. La UI no
  inventa una operación contable nueva, solo expone la que ya existía.
- **Roles/permisos:** `allocation:write` — `ADMINISTRADOR`, `CONTADOR`.
- **Evidencia de cierre:** igual que el ítem 8 — S-25 ya no lista
  `POST /party-allocations/:allocationId/cancel` como sin puerta; S-12
  en verde; `tests/integration/imputacion-de-cobros.test.ts` (16 casos)
  sin modificar, sigue en verde.

---

## 16 y 17 · `GET`/`POST /parties/:partyId/price-lists` — RESUELTO 2026-10-01

- **Módulo / proceso:** Asignar una lista de precios a un cliente
  puntual.
- **Implementado:** sección «Lista de precios asignada» en la ficha del
  tercero, con tabla de asignaciones (lista, desde, hasta, vigente hoy) y
  un formulario para asignar una nueva. El selector de listas solo se
  carga con `product:read` además de `party:write` — es el permiso real
  que exige `GET /price-lists`, no uno supuesto.
- **Sigue sin reemplazar, a propósito, traer o escribir el precio a mano
  al facturar:** esto solo evita elegir la lista cada vez, no cambia esa
  alternativa ya confirmada.
- **Roles/permisos:** `party:read` / `party:write` + `product:read`.
- **Evidencia de cierre:** S-25 ya no lista ninguna de las dos rutas como
  sin puerta; S-12 en verde.

---

## 18 · `POST /parties/:partyId/roles` — RESUELTO 2026-10-01

- **Módulo / proceso:** Agregar un rol (Cliente/Proveedor) a un tercero
  ya existente.
- **Implementado:** en la ficha del tercero, un selector que solo ofrece
  los roles que todavía le faltan (si ya tiene los dos, se dice y el
  botón queda deshabilitado — no se ofrece una acción que la API
  rechazaría con 409) y un botón «Agregar».
- **Roles/permisos:** `party:write`.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## 19 · `GET /products/:productId/movimientos` — RESUELTO 2026-10-01

- **Módulo / proceso:** Ficha de movimientos de un producto.
- **La duda de la pasada anterior se confirmó, leyendo el código: NO es
  el mismo dato.** El enlace "movimientos" de Existencias llama a
  `GET /products/:id/stock` (el libro de depósitos, ajustes y
  transferencias). Este otro endpoint es un agregado distinto: lo
  facturado por dirección (compras/ventas), con cantidad, neto y
  primera/última fecha — el propio comentario del backend dice **"no es
  stock"**. Eran dos preguntas distintas y solo una tenía pantalla.
- **Implementado:** dentro del mismo panel de "Movimientos" de un
  producto, una segunda tabla «Facturado» con ese agregado, aclarando
  explícitamente que no es stock.
- **Roles/permisos:** `product:read` + `journal_entry:read` (el mismo
  detalle que el subdiario, visto por producto).
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## 20 · `PUT /crm/stages/:stageId` — RESUELTO 2026-10-01

- **Módulo / proceso:** CRM — embudo de oportunidades.
- **Implementado:** «Editar etapas declaradas», una tabla con cada etapa
  (orden y código fijos — no se editan, cambian la forma del embudo) y
  nombre/probabilidad/estado editables en la fila, con «guardar» por
  renglón.
- **Reordenar no se implementó:** el backend no expone una operación de
  reordenamiento (`PUT` solo cambia nombre, probabilidad y estado);
  inventar un "orden" en la UI sin que el backend lo sostenga hubiera sido
  la pantalla fantasma que el mandato prohíbe. Queda como un gap real pero
  menor: archivar y volver a declarar con otro número ya lo resuelve.
- **Roles/permisos:** `crm:write`.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## 21 · `PUT /payment-orders/:ordenId/renglones` — RESUELTO 2026-10-01

- **Módulo / proceso:** Pagos — orden en borrador.
- **Implementado:** dentro del detalle de una orden en estado `BORRADOR`,
  «Editar los renglones del borrador» reutiliza el mismo selector de
  comprobantes pagables que arma una orden nueva, mostrando los ya
  incluidos tildados con su importe actual. Guardar reemplaza la lista
  completa, tal como el backend lo espera (`DELETE` + `INSERT`, no un
  PATCH incremental).
- **Nada corre si la orden ya no es borrador:** el trigger de la base
  (`pol_reglas`, migración 0082) rechaza el reemplazo fuera de
  `BORRADOR`; la UI solo oculta el control fuera de ese estado, no
  duplica la regla.
- **Roles/permisos:** `payment_order:write`.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## 22 · `PUT /purchase-requests/:solicitudId/renglones` — RESUELTO 2026-10-01

- **Módulo / proceso:** Compras — solicitud.
- **Implementado:** mismo patrón que el ítem 21, reutilizando el
  constructor de renglones que ya existía para el alta (producto del
  maestro opcional, descripción, cantidad, unidad), visible solo cuando
  la solicitud está en `BORRADOR`.
- **Roles/permisos:** `purchase_request:write`.
- **Evidencia de cierre:** S-25 ya no lista la ruta como sin puerta; S-12
  en verde.

---

## Resumen de prioridad

| Estado | Ítems |
|---|---|
| **BLOQUEANTE** | Ninguno — en los 19, siempre hubo al menos un camino (manual, por API, o diferido a una decisión de producto) para no perder la operación de negocio en sí |
| **RESUELTO (2026-10-01)** | 1, 3 (parcial), 4 (parcial), 5, 6/7, 8, 9/10, 11, 14, 15, 16/17, 18, 19, 20, 21, 22 — **16 de 19** |
| **BLOQUEADO — decisión de producto o credencial externa** | 2, 12, 13 |
| **GAP REAL SIN CERRAR, por falta de un endpoint** | 3 (trazar un renglón ya **emitido**), 4 (trazar un match confirmado en **otra sesión**), 20 (reordenar etapas, no solo renombrarlas) |

De los 19 ítems originales, los únicos tres que siguen sin ningún código
nuevo son los tres que ya estaban correctamente clasificados como
bloqueados por algo que no es trabajo de interfaz: el 12 depende de un
proveedor de IA real configurado (`AI_PROVIDER` sigue en `none`), el 13
depende de que el equipo decida si NEXO factura en partes y con qué
reglas, y el 2 tiene una alternativa ya usada y confirmada (cargar el
asiento a mano) que no amerita apurar una pantalla nueva. Ninguno de los
tres se tocó por iniciativa propia: tocarlos sin esa decisión o esa
credencial habría sido inventar la respuesta en lugar de esperarla.

## Revisión de permisos de punta a punta (contrastado, no solo leído)

Se contrastaron los permisos declarados contra su uso real en
`consola.html` (`puede('xxx')`) y contra quién los otorga cada migración.
**No se encontró ninguna inconsistencia, ni antes ni después de esta
pasada.** `tax_affectation:declare` y `decision:supersede` ya tienen su
`puede()` real (ítems 11 y 14); el único permiso que sigue sin ninguna
pantalla es `prediction:run`, que no formaba parte de estos 19 ítems. Se
confirmó además que `prediction:run`, `tax_affectation:declare` y
`decision:supersede` son exclusivos de `CONTADOR` (ni siquiera
`ADMINISTRADOR` los tiene) — mismo principio de "administrar el sistema
no es firmar la contabilidad" que ya regía para `journal_entry:approve` —
y que las 16 pantallas nuevas de esta pasada piden exactamente el permiso
que su endpoint ya exigía, sin ampliar ninguno para que la UI quedara más
cómoda.

**Actualización de esta pasada: se implementaron 13 pantallas/botones
nuevos** (los 16 ítems resueltos, descontando los 3 que ya estaban
resueltos en la pasada anterior), más una corrección de un bug de
serialización encontrado al leer el backend de uno de ellos (ítem 5). No
se tocó ninguna migración, ningún trigger, ninguna regla de permisos ni
ninguna semántica contable: cada pantalla expone un endpoint que ya
existía, ya estaba probado, y cuya regla de negocio se leyó del código
antes de construir encima — nunca se adivinó.
