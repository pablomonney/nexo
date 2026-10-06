# Estado de NEXO — misión autónoma de cierre

Documento vivo, actualizado durante la misión (no es el informe final
todavía — ese se escribe cuando la misión termine o llegue a su límite
real). Última actualización: 2026-10-01, en curso.

> **NEXO no está listo para habilitar clientes solo porque esta
> auditoría interna cierre en verde.** Lo que esta auditoría puede decir
> con evidencia real es: el código, los datos, la seguridad y la
> operación ya construidos están en buen estado y verificados. Lo que
> **no** puede decir es que el producto esté completo — quedan 19 ítems
> de interfaz sin pantalla (ninguno bloqueante, todos documentados en
> `BACKLOG_INTERFAZ_PENDIENTE.md`), 6 videos del curso sin capturar, y
> cinco piezas enteras (IA real, email, pagos, KMS, ARCA producción) que
> dependen de una cuenta o un trámite que todavía no existe. "Todo lo que
> se puede verificar sin una cuenta externa está verificado" no es lo
> mismo que "listo para producción" — es la pregunta que falta
> responder, y la responde quien tenga la cuenta, el trámite o la
> decisión de negocio pendiente, no esta auditoría.

---

## Registro de trabajo

### Hecho

1. **Gate A/B verificados en vivo, no asumidos:**
   - Reseteada `aai_test` (arrastraba 551 empresas de corridas viejas,
     riesgo de falsos positivos/timeouts ya documentado).
   - `npm run typecheck`, `npm run lint`, `npm run lint:arch`,
     `npm run check:no-float`, `npm run build`: todos verdes.
   - `npm run test:coverage` (suite completa): **7 tests reales
     fallando**, diagnosticados y corregidos (no silenciados) — ver
     "Bugs corregidos" abajo. Segunda corrida: **todo verde**
     (exit code 0, cobertura por encima de los umbrales declarados).
   - `npm run norms:verify`, `npm run verify:arranque`,
     `npm run ledger:verify`, `npm run audit:cadena`,
     `npm run audit:estructura`, `npm run audit:invariants`,
     `npm run verify:db`: todos verdes.

2. **Backup y restore, probados de punta a punta, no solo leídos:**
   - `npm run db:backup`: generó un backup real de `aai`
     (`aai_20261001_170439.backup`, 1527 KB).
   - `npm run db:restaurar`: lo restauró en una base descartable
     (`aai_restauracion`, creada y destruida por el propio script),
     comparó contenido contra la base viva — **169 tablas, 3326 filas,
     idénticas** — y verificó estructura e invariantes contables sobre
     la copia restaurada. Ventana de pérdida en el momento de la
     prueba: 0.0 horas.
   - `GET /health` y `GET /health/db` contra el servidor real: `ok`,
     130 migraciones, *uptime* ~24.5 h sin caídas.

3. **ARCA, con el certificado real de homologación (`C:\ARCA\`):**
   - `npm run arca:check`: WSAA y WSCDC alcanzables, servicio Dummy
     operativo.
   - `npm run arca:capabilities` (CUIT 20452148324, ambiente
     homologación): **`wsfe` (facturación) HABILITADO**; `wscdc`,
     `ws_sr_padron_a13` y `ws_sr_padron_a100` **NO_DELEGADO** — el
     certificado es válido pero esos tres servicios no están delegados
     desde el portal de ARCA (trámite externo del contribuyente, no
     resoluble por código). Las 4 capacidades reales quedaron
     guardadas para la empresa del curso
     (`01a0cb58-6888-7d59-bc2f-141c531dab88`).

4. **Email (Resend) y Pagos (Mercado Pago):** auditados a nivel de
   código. Ambos ya están **implementados por completo**
   (`correo/fabrica.ts`, `pagos/mercadopago.ts`/`fabrica.ts`), con el
   mismo patrón honesto de 3-4 estados (deshabilitado/preparado/
   configurado, nunca "conectado" sin una llamada real que lo pruebe).
   En este entorno ambos están en modo `none`/sin cuenta real — **no es
   un bug**, es el estado correcto sin una cuenta de Resend ni de
   Mercado Pago contratada. `NEXO_ROADMAP.md` (del propio proyecto)
   confirma independientemente que son los 5 puntos de P2 que
   "ninguno se resuelve escribiendo código" — coincide exacto con esta
   auditoría.

5. **IA:** `ai/proveedor.ts` tiene el mismo patrón de estados honesto;
   `AI_PROVIDER` no está declarado → `DESHABILITADO`. El modo
   `SIMULADO` **se abstiene siempre** (nunca redacta ni elige una
   cuenta), a propósito — ya se había observado esto mismo en vivo, en
   la pantalla real de Preguntar del video 25 ("Sin proveedor de
   modelo"). Confirmado consistente entre código, tests y UI real.

6. **Seguridad multi-tenant (GATE C):** ya cubierta con rigor real
   antes de esta misión — 4 archivos dedicados (1489 líneas):
   `tests/security/tenant-isolation.test.ts` (RLS por SQL directo,
   incluye un barrido de "toda tabla con `company_id` tiene RLS
   FORZADO"), `tests/security/endpoint-isolation.test.ts` (barre
   **todas** las rutas registradas por el propio servidor, no una
   lista a mano, buscando cualquier 2xx entre empresas), además de
   `aislamiento-lectura.test.ts` y `aislamiento-multiempresa.test.ts`.
   No hizo falta agregar nada — ya pasaban, y la cobertura es genuina
   (documentos, bandeja, auditoría, decisiones, notas, cierres, todo
   cruzado).

7. **Curso (videos 10, 11, 12 → `VIDEO_FINAL`):** ver sección aparte
   más abajo.

### Bugs corregidos (con test de regresión)

| # | Problema | Causa | Solución | Test que lo protege |
|---|---|---|---|---|
| 1 | El botón "Dar de alta en el estudio" (alta de persona, agregado en una sesión anterior para el video 07) mostraba su mensaje de éxito/error en la pantalla equivocada | Reusaba `id="est-msg"`, que ya existía en la pantalla de Estados contables — `getElementById` devuelve el primero, así que el mensaje se escribía ahí, invisible | Id propio: `est-alta-msg`, en el HTML y en los dos lugares del JS que lo usan | `tests/security/consola-elementos.test.ts` (ya existía, detectaba la colisión; ahora pasa) |
| 2 | El instrumento de testing S-25/S-12 no podía leer URLs armadas dentro de manejadores `algo.onclick = async () => {...}` (157 pantallas de la consola usan ese patrón) — una URL así figuraba "sin forma de leerla" y la ruta aparecía como inalcanzable aunque tuviera botón | `funcionQueContiene()` solo reconocía `function nombre(...) {}`, no arrow functions asignadas a `.onclick` | Se generalizó para reconocer también el patrón `.onXxx = (async)? (...) => {` | `tests/security/capacidades-con-puerta.test.ts` — además destapó que `GET /books/mayor` nunca se había verificado como alcanzable (sí lo es, con el fix) |
| 3 | 3 excepciones obsoletas en listas de "falta pantalla"/"sin puerta" (`POST /organizations/:organizationId/users`, `POST /companies/current/reporting-framework`, dominio `organizations`) que ya tenían botón real desde sesiones anteriores | Nadie las sacó de la lista al agregar el botón | Se quitaron las 3 entradas | Los mismos 3 archivos de test, que exigen que la lista de excepciones no acumule las que ya se resolvieron |
| 4 | `GET /vat/credito-fiscal/:txId` respondía **500 ante cualquier llamada**, siempre, no en un caso de borde | `ivaDiscriminado` es un `Money` (`amount: bigint`); la ruta lo devolvía tal cual en vez de pasarlo por `toDecimalString`, como hace el resto del archivo con cada Money — `JSON.stringify` no sabe serializar un `bigint` | `apps/api/src/routes/vat.ts`: se envuelve el campo en `toDecimalString` antes de responder | `tests/integration/credito-fiscal-iva.test.ts` (nuevo) — falla contra el código viejo (500), pasa contra el corregido (200) |
| 5 | `POST /banks/accounts/:id/reconciliations/propose` respondía **500 ante cualquier ambigüedad real** (un movimiento con dos candidatos igual de puntuados — el caso normal que esa rama del motor existe para atender, no un caso de borde) | Mismo defecto que el #4: `ambiguos[].candidatos[].importe` es un `Money` anidado dos niveles (array de ambigüedades → array de candidatos), y la ruta lo devolvía sin convertir mientras `propuestas[].importe` sí pasaba por `toDecimalString` tres líneas antes | `apps/api/src/routes/banks.ts`: se mapea `ambiguos` igual que `propuestas`, convirtiendo cada `candidato.importe` | `tests/integration/conciliacion-ambigua.test.ts` (nuevo) — arma dos asientos aprobados del mismo importe contra un movimiento, falla contra el código viejo (500), pasa contra el corregido (200) |

Los bugs #4 y #5 se encontraron por el mismo método: al leer el backend para construir la UI de un ítem del backlog de interfaz (#5 del backlog es justamente el crédito fiscal), apareció que la ruta nunca podía responder con éxito. Un agente de exploración dedicado barrió después todo `apps/api/src/routes/*.ts` buscando la misma clase de defecto (un `Money` sin pasar por `toDecimalString` antes de la respuesta) y no encontró una tercera instancia — los dos casos de arriba son los únicos reales.

**Segunda ronda de búsqueda de defectos (2026-10-01), con dos agentes de exploración dedicados — uno por clase de defecto:**

> **CORRECCIÓN 2026-10-05 — los defectos #6, #7 y #8 de esta tabla (que en
> `CIERRE_INTEGRAL_NEXO.md` figuran como #3, #4 y #5) NO están corregidos en
> producción.** La columna "Solución" describe un intento que depende de que
> PostgreSQL esté en hora argentina; producción está en **UTC** (`SHOW
> timezone` → `UTC`, confirmado el 2026-10-05), así que `CURRENT_DATE` sigue
> devolviendo la fecha de mañana entre las 21:00 y las 24:00 ART. Los tests
> pasaban porque la base de desarrollo está en `America/Buenos_Aires`. El
> despliegue `b412b9e` es correcto; esto es un defecto funcional pendiente. Los
> defectos #1 a #5 de la tabla anterior sí están corregidos. Plan:
> `docs/PLAN_ZONA_HORARIA.md`.

| # | Problema | Causa | Solución | Test que lo protege |
|---|---|---|---|---|
| 6 | La prueba gratuita de una empresa nueva podía arrancar con `desde` fechado **un día después** del alta real | `onboarding.ts` calculaba `hoy` con `new Date().toISOString().slice(0,10)` (forzado a tipo con `as never`, señal de que no encajaba donde se usaba). Argentina es UTC−3: después de las 21 h, ese cálculo ya da el día siguiente — el mismo defecto documentado en S-37 y ya corregido una vez en `suscripciones.ts`, repetido acá sin que nadie lo conectara | **Intento NO efectivo en producción (UTC):** se le pregunta `CURRENT_DATE` a la base, como ya hace `suscripciones.ts` — que tiene el mismo problema latente | Se extendió S-37 (ver abajo); S-37 no detecta la dependencia de la zona de la base |
| 7 | Preguntarle al catálogo de NEXO Intelligence por un mes sin año ("ventas de noviembre") podía resolver el **año equivocado** cerca de un fin de año/mes, después de las 21 h | `mesDe()` en `intelligence/catalogo.ts` inferís el año con `new Date().getUTCMonth()` | `mesDe()` ahora recibe `hoy: CalendarDate` desde quien la llama, nunca lo calcula sola. **La función es correcta; el `hoy` que le llega sale de `CURRENT_DATE` y en producción (UTC) es el de mañana después de las 21 h** | `tests/unit/catalogo-de-preguntas.test.ts` — el caso "mes que todavía no pasó" pasó de depender del reloj real (solo corría, y solo probaba algo, dos meses al año) a una fecha fija |
| 8 | "¿Cómo voy este mes?" y el panorama general podían consultar el **mes equivocado** después de las 21 h | `intelligence.ts` calculaba `mesCorriente()` con `new Date().toISOString().slice(0,7)`, antes de entrar a la transacción | **Intento NO efectivo en producción (UTC):** se mueve adentro de `withCompany` y se pregunta `CURRENT_DATE` a la base (`hoyDeLaBase`) | Misma extensión de S-37 |

**S-37 ya no mira solo `scripts/`:** el control que debería haber atrapado los #6 y #7 solo escaneaba `scripts/*.mjs`, no `apps/api/src`. Se agregó un cuarto caso que recorre `apps/api/src` y `packages/*/src` buscando el mismo patrón (con `calendar-date.ts` como única excepción legítima, justificada); se confirmó que atrapa los dos defectos originales revirtiendo el fix y viendo el test fallar, y que pasa con el fix aplicado. **Límites (2026-10-05):** solo lee TypeScript, así que no ve que `CURRENT_DATE` dependa de la zona de PostgreSQL, y su patrón `slice(0, 10)` no detecta `toISOString().slice(0, 7)` (queda en `intelligence/catalogo.ts:617`) ni `getUTCFullYear` (queda en `document-engine/parsers/fecha.ts:154`).

**Hallados y documentados, sin una solución limpia disponible (no forzados):**

- **Doble clic en "registrar movimiento de caja" o "mover stock" (salida/ajuste/transferencia) puede duplicar el movimiento real.** Ninguna de las dos operaciones tiene una clave natural para que la base distinga un reintento de un movimiento real repetido adrede: un movimiento manual de caja puede ser legítimamente dos veces el mismo importe y concepto, y una salida de stock puede ser legítimamente un despacho parcial de la misma venta en dos tandas. Agregar una restricción de unicidad en la base sería **inventar una regla de negocio que no está pedida** y rompería esos dos casos reales. Se aplicó el único arreglo seguro sin esa decisión: los botones `b-caja-mov` y `b-stk-mover` se deshabilitan mientras el pedido está en vuelo, que evita el doble clic accidental (no un reintento de red, que requeriría una clave de idempotencia — eso sí es una decisión de arquitectura, y queda para quien la tome).
- **Compárese con lo que SÍ tiene guardia real:** `POST /journal-entries` con `source:{type,id}` tiene un índice único (`journal_entries_unique_source`) y la emisión fiscal tiene el suyo (`fiscal_emissions`); ambos ya traducen el 23505 a un 409 legible. `POST /banks/reconciliations/:id/matches` tenía el índice único pero **no** traducía el error — confirmar dos veces la misma coincidencia daba un 500 crudo en vez de un 409 explicando que ya estaba confirmada. Se corrigió la traducción (mismo patrón que el resto del archivo), sin tocar la restricción que ya protegía el dato.

### Problemas encontrados, documentados, NO forzados

- **Inconsistencia real de datos en el bien de uso `BU-01`** (empresa
  del curso): tiene un asiento de amortización `APROBADO` y vinculado
  (`entryId` presente), pero el valor recalculado hoy de "amortización
  del ejercicio 2026" da `$0,00` porque el bien se dio de baja un día
  después de darse de alta (`meses: 0` en el plan recalculado),
  mientras el asiento vinculado es por `$425.000,00`. No se tocó: es
  un dato real de esta empresa de demostración, documentado para la
  producción del video 18 (nota de producción explícita), no
  silenciado ni "corregido" por mi cuenta — corregirlo sería modificar
  un asiento ya aprobado sin autorización puntual.
- **19 ítems reales de "falta botón"/"falta pantalla"** ya documentados
  por el propio `tests/security/capacidades-con-puerta.test.ts`
  (backend existe y está probado; falta la pantalla en `consola.html`).
  **Decisión explícita: no se implementaron en esta pasada.** Son
  construcciones de UI nuevas que no puedo verificar visualmente
  mientras el navegador esté desconectado, y el criterio operativo de
  esta sesión es no declarar terminada una pantalla sin haberla visto
  renderizar. Quedan como backlog P2 explícito, listado abajo.

8. **Operación diaria, probada en modo ensayo (no destructivo):**
   `npm run diario -- --ensayo` corre los tres pasos reales del
   procedimiento productivo (`infrastructure/systemd/nexo-diario`,
   agendado desde 2026-09-16 según `docs/DESPLIEGUE.md`) contra la
   base real, sin escribir nada: ciclo de facturación y cobranza
   (hubiera emitido 1 cargo real de ARS 449.900 para la empresa del
   curso), verificación del Mayor (7 de 8 empresas con asientos
   coinciden; la octava no tiene asientos aprobados, nada que
   comparar) y cadena de auditoría (8 de 8 empresas, íntegra). **Todo
   OK.**

9. **Documentación desactualizada, corregida sin reescribir el
   histórico:**
   - `docs/FASE_4_OPERACION.md` es una foto fija del cierre de la
     FASE 3 (94 rutas, consola en 23%) — hoy la gran mayoría de sus
     "GAP UI" ya tienen pantalla. Se agregó una nota al inicio
     señalando que es un registro histórico y apuntando a la lista
     viva (`capacidades-con-puerta.test.ts`), sin reescribir el
     cuerpo.
   - `docs/MATRIZ-FUNCIONALIDADES-NEXO.md` se midió el 2026-09-21
     contra el mismo control S-25 que tenía el punto ciego real
     corregido en esta misión — se agregó una nota señalando que
     algunas filas podrían estar desactualizadas por esa causa.

### Hallazgo menor, documentado y no tocado

Hay una **segunda empresa con la misma razón social** que la del curso
("Ferretería El Tornillo Feliz S.R.L.", CUIT `99999999990`, distinto
del CUIT real `30712345604`), con solo 3 entradas de auditoría y sin
ningún asiento aprobado — probablemente una empresa huérfana de alguna
prueba de alta anterior. No se tocó: nada en este esquema permite
borrar (`forbid_delete`), no tiene impacto financiero ni de
integridad, y `ledger:verify`/`audit:cadena` ya la manejan
correctamente (la saltean en vez de fallar). Queda documentado para
que alguien decida si vale la pena marcarla inactiva.

---

## Backlog P0/P1/P2 — estado real

- **P0:** `NEXO_ROADMAP.md` (del propio proyecto) ya decía "Nada
  abierto" antes de esta misión, y esta misión lo reconfirmó en vivo
  (RLS, Mayor, bitácora, `verify` completo). **Sigue sin haber nada
  abierto.**
- **P1 — bloqueados por una credencial externa, no por código:**
  adaptador de proveedor de modelo real (falta cuenta de un tercero).
- **P2 — producción, ninguno se resuelve escribiendo código** (ya
  estaba así documentado, reconfirmado en esta auditoría): KMS (falta
  contratar un gestor), ARCA producción (trámite del cliente — y ahora
  además sabemos que homologación además necesita delegar 3 servicios
  más desde el portal de ARCA), alta autoservicio por correo (falta
  cuenta de Resend), cobro de suscripción (falta pasarela de Mercado
  Pago + decidir precios), web comercial (decisión de producto).
- **P2 — UI, sí resoluble con código:** **actualizado 2026-10-01.** De
  los 19 ítems de `capacidades-con-puerta.test.ts`, se implementaron 16
  en la pasada del mismo día (ver `BACKLOG_INTERFAZ_PENDIENTE.md` para el
  detalle y la evidencia de cada uno); quedan 3 explícitamente bloqueados
  por una decisión de producto o una credencial externa, no por código.
  **Corrección a una afirmación anterior de este mismo documento:** el
  párrafo de esta sección decía que "el más caro" de los 19 era el plan
  de cierre de ejercicio (bloquear/reabrir un período, ver el acta) — eso
  es **incorrecto**: esa pantalla (con su checklist de pre-cierre de 8
  controles y su acta) ya está completamente construida en
  `apps/web/consola.html` (sección `v-...` de Períodos y cierre, función
  `listarPeriodos`/`preCerrar`/`cerrarEjercicio`) y nunca formó parte de
  los 19 ítems de `capacidades-con-puerta.test.ts` — no aparece en su
  mapa `SIN_PUERTA`. Sigue sin verificación **visual** (el navegador
  sigue desconectado), pero la afirmación de que faltaba la pantalla era
  errónea y queda corregida acá.

---

## Curso — videos producidos en esta misión

| Video | Antes | Ahora | Evidencia |
|---|---|---|---|
| 10 · Comprobantes | `GUION_VERIFICADO` | **`VIDEO_FINAL`** | `scratchpad/produccion/video10/` |
| 11 · Ventas | `GUION_VERIFICADO` | **`VIDEO_FINAL`** | `scratchpad/produccion/video11/` |
| 12 · Compras | `GUION_VERIFICADO` | **`VIDEO_FINAL`** | `scratchpad/produccion/video12/` (con nota de contenido: la orden a Ferrolux ya está pagada, no solo aprobada — documentado, no fabricado) |

**Conteo actualizado: 17 de 31 en `VIDEO_FINAL`.**

**Narración y audio Piper ya generados y verificados (duración > 0,
volumen normal, sin silencios totales) para los 6 videos que faltan:**
14, 15, 16, 18, 31, 06. Les falta exclusivamente la captura de
pantalla real — bloqueado por el navegador, ver abajo.

**Investigación del punto 10 (capturas sin navegador):** se revisaron
las capturas GIF de la verificación funcional original (previa a esta
fase audiovisual) como posible atajo. **Resultado: no son una fuente
confiable y no se usaron.** Al menos dos casos concretos de datos
desactualizados encontrados por comparación directa contra la base
real (de solo lectura, sin tocar nada):
- Video 06: el GIF más viejo muestra un producto de prueba ya
  **archivado** (`Servicio de corte de madera`, con precio inventado
  de la primera pasada descartada) — usarlo mostraría un dato que ya
  no existe como si fuera el actual.
- Video 16: el GIF muestra dos asientos "Pago a Distribuidora
  Ferrolux..." ambos en estado `APROBADO` — pero uno de los dos ya fue
  anulado por contraasiento después de esa captura. Mostrarlo tal cual
  afirmaría un estado falso.

Se evaluó también crear un usuario nuevo de rol `SOLO_LECTURA` (no
exige MFA) para poder loguearse en el navegador integrado sin tocar la
cuenta de Mariana — **descartado**: crearlo requeriría de todos modos
el token de Mariana (ella es la única `OWNER`/`ADMIN` del estudio), y
conseguir ese token exige su MFA. Hacerlo por una vía que no pase por
el login autenticado normal sería precisamente "eludir el control de
acceso" que se me pidió evitar, aunque técnicamente invocara una
función interna legítima. **Conclusión: no hay atajo seguro — se
necesita el navegador.** Los 6 videos quedan en espera, con todo lo
demás ya preparado.

---

## Bloqueos externos (no resolubles por este agente ahora mismo)

1. **Claude-in-Chrome desconectado** — el usuario está reintentando la
   reconexión de su lado. Bloquea la captura de pantalla real para los
   6 videos restantes del curso y para cualquier item de UI nuevo que
   requiera verificación visual.
2. **MFA de la cuenta de producción** — explícitamente fuera de
   alcance por instrucción directa del usuario (no tocar cuentas, no
   usar secretos/códigos de recuperación).
3. **Credenciales de terceros** (proveedor de modelo real, Resend,
   Mercado Pago, KMS, certificado ARCA de producción) — requieren
   decisión de negocio y/o trámite externo, no código.

---

## Backlog de interfaz — los 19 ítems, auditados uno por uno

Análisis completo (módulo, qué se puede/no se puede hacer, alternativa
funcional real, permisos exactos, consecuencia concreta, prioridad
justificada) en
[`docs/BACKLOG_INTERFAZ_PENDIENTE.md`](BACKLOG_INTERFAZ_PENDIENTE.md).

**Resultado:** ningún ítem es bloqueante — los 19 tienen al menos un
camino para no perder la operación de negocio (manual, por otra
pantalla, por API, o diferido a una decisión de producto todavía no
tomada). Dos son los más urgentes de la categoría "importante", por no
tener ninguna alternativa: anular una imputación
(`party-allocations/:id/cancel`) y ver/anular las notas de corrección
de un comprobante (`tax-transactions/:id/correcciones`).

Un hallazgo que corrigió una suposición antes de clasificar: el ítem
"agregar un rol a un tercero" parecía bloqueante a primera vista, pero
se verificó en el modelo de datos (`party_roles`) y en el formulario de
alta (`consola.html`) que **ya se puede declarar Cliente y Proveedor a
la vez al crear** — el gap real es mucho más angosto (solo agregar el
segundo rol más tarde), y se corrigió la prioridad en consecuencia antes
de publicarla.

**Revisión de permisos de punta a punta:** contrastados los 19 permisos
declarados contra su uso real en `consola.html` y contra qué rol los
otorga cada migración. Sin inconsistencias nuevas. Confirmado que
`prediction:run`, `tax_affectation:declare` y `decision:supersede` son
exclusivos de `CONTADOR` — ni `ADMINISTRADOR` los tiene, coherente con
el principio ya establecido de que administrar el estudio no es firmar
la contabilidad. No se amplió ningún privilegio.

## Clasificación de evidencia (qué tan verificado está cada cosa)

- **Verificado en ejecución** (se corrió de verdad contra la base/app
  real): typecheck, lint, build, suite completa de tests, backup+restore
  de punta a punta, `npm run diario -- --ensayo`, `arca:check` y
  `arca:capabilities` con el certificado real, `GET /health`/`/health/db`
  en vivo, los 3 videos producidos (10/11/12).
- **Verificado mediante pruebas automatizadas** (la prueba existe, pasa,
  y seguiría fallando si alguien rompe esto): aislamiento multiempresa
  (4 archivos dedicados), los 7 bugs de consola corregidos, la cobertura
  de permisos por rol.
- **Confirmado solo por inspección de código** (leído y entendido, no
  ejecutado en esta pasada): el estado de email/pagos/IA como código
  (su comportamiento en runtime sí se infiere de los tests que SÍ
  corrieron), el aislamiento de almacenamiento de documentos, el detalle
  permiso-por-permiso de los 19 ítems del backlog de interfaz.
- **Pendiente de una cuenta, trámite o intervención humana** (no
  resoluble por código): proveedor de IA real, Resend, Mercado Pago, KMS,
  certificado ARCA de producción, delegar `wscdc`/padrón A13/A100 desde
  el portal de ARCA, y la decisión de producto sobre facturación parcial
  (ítem 13 del backlog de interfaz).
- **Pendiente de comprobación visual** (no se puede dar por cerrado sin
  verlo renderizar): los 19 ítems del backlog de interfaz si se deciden
  implementar, el ítem 19 (`products/:id/movimientos`, posible
  duplicado con un enlace ya existente en Existencias — sin confirmar),
  y los 6 videos del curso con audio ya generado (14, 15, 16, 18, 31,
  06).

## Siguiente tarea autónoma

**Bloque cerrado 2026-10-01 (auditoría de interfaz y permisos):**
- Cambios: `docs/BACKLOG_INTERFAZ_PENDIENTE.md` (nuevo, 19 ítems
  analizados uno por uno), actualización de este documento con la
  clasificación de evidencia y el aviso explícito de que la auditoría
  interna en verde no equivale a "listo para producción".
- Pruebas: ninguna suite completa repetida (sin razón técnica nueva para
  hacerlo); se verificaron puntualmente, por grep e inspección directa,
  los 19 permisos contra `consola.html` y contra las migraciones que los
  otorgan.
- Resultados: 0 inconsistencias de permisos nuevas; 0 ítems bloqueantes
  de los 19; 1 suposición corregida antes de publicarse (roles de
  tercero, ver arriba).
- Pendiente: confirmar visualmente el ítem 19
  (`products/:id/movimientos`, posible duplicado de un enlace ya
  existente en Existencias) y los ítems 9/10 una vez haya navegador, para
  decidir si de verdad no tienen alternativa o si se pasó algo por alto
  mirando solo el HTML.
- Bloqueo externo vigente: navegador todavía desconectado.
- **Siguiente tarea concreta:** con el navegador seguir desconectado, no
  queda backlog interno nuevo de alto valor por auditar sin repetir
  controles ya cerrados — pasar a vigilancia espaciada de la reconexión.
  Apenas vuelva: (1) confirmar visualmente el ítem 19 del backlog de
  interfaz, (2) retomar los 6 videos (14, 15, 16, 18, 31, 06) — audio y
  guion ya generados, solo falta capturar pantalla.
