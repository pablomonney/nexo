# NEXO — Pagos recurrentes con Mercado Pago

**Fase B2.5.5 · 2026-09-10**

---

## La respuesta, en un párrafo

La integración está **cerrada técnicamente y no conectada**. El estado
`SIN_PASARELA` dejó de ser un agujero en el diseño y pasó a ser un **modo de
operación declarado**: hoy `PAYMENTS_PROVIDER=none`, y el día que Pablo cree la
cuenta de Mercado Pago, conectarla son cinco variables de entorno y un comando.
No hace falta tocar una línea de código.

Lo que **no** se puede afirmar, y este documento no afirma en ningún lado:

- No existe una cuenta de Mercado Pago de NEXO.
- **No se hizo ningún cobro real.** Ni uno de prueba.
- No se llamó nunca a `api.mercadopago.com`.
- No hay ningún `preapproval_plan_id` real guardado en ninguna parte.

Todo lo que se ejercitó corre contra un `fetch` inyectado y un doble del
proveedor. Eso prueba el contrato y **no prueba la conexión**. Lo único que
prueba una conexión es un cobro que volvió, y eso lo va a decir
`payment_intents`, no este documento.

---

## ¿Y hacerlo por MCP? — verificado el 2026-09-12

**No existe un MCP de Mercado Pago.** Ni conectado a esta sesión, ni en el
registro de conectores.

Lo que hay conectado acá: `higgsfield`, `visualize`, `scheduled-tasks`. Ninguno
toca pagos.

Lo que hay en el registro, buscando por «mercado pago», «mercadopago»,
«payments», «subscriptions», «preapproval», «checkout pro», «latam payments»:

| Pasarela con MCP | ¿Sirve? |
|---|---|
| PayPal | No es Mercado Pago |
| Razorpay (India) | No |
| Paytm (India) | No |
| Pine Labs (India) | No |
| Chargebee, Tabs, Rillet (facturación) | No cobran en Argentina |

**Ninguno es Mercado Pago.** Y aunque apareciera uno mañana, no reemplazaría a
esta integración, por una razón de arquitectura que conviene dejar escrita:

> Un MCP es una herramienta para que **un asistente** consulte o dispare algo
> durante una conversación. El cobro de NEXO ocurre **sin nadie mirando**: lo
> dispara el ciclo de facturación agendado, y la respuesta llega por webhook a
> las tres de la mañana. Eso necesita un adaptador HTTP dentro del proceso, no
> una herramienta conversacional.

Un MCP de Mercado Pago sería útil para *operar* —«¿cuántos cobros fallaron esta
semana?»— y ese lugar ya lo ocupa `npm run pagos:bandeja`. No para cobrar.

La arquitectura correcta es la que ya está construida, y es exactamente la que
se pidió:

```
NEXO → puerto de pagos → adaptador Mercado Pago → API de MP
MP → webhook → /webhooks/pagos → bandeja → payment_events → motor de billing
```

---

## Lo que ya existía, y por qué no se reconstruyó nada

La auditoría previa encontró que el billing estaba **excepcionalmente
preparado**. No era una capa a medio hacer: era un sistema terminado al que le
faltaba exactamente una pieza.

| Ya estaba | Desde | Qué hace |
|---|---|---|
| `payment_intents` | 0096 | Intentos de cobro, con `proveedor`, `referencia_externa`, `idempotency_key`, `medio_referencia`, `medio_ultimos4` |
| `payment_events` | 0096 | Diario de eventos con `UNIQUE (proveedor, evento_externo)` |
| `procesarEventoDePago()` | — | El punto de entrada del webhook, **ya idempotente**, con cinco desenlaces |
| `SIGUIENTES_PAGO`, `esRepeticion`, `esAtrasado` | — | La máquina de estados de un cobro, con reenvíos y desorden contemplados |
| `collection_policies` / `collection_steps` | 0096 | La política de cobranza, declarada con vigencia |
| `company_subscriptions.referencia_externa` | 0073 | El lugar donde va el id de la suscripción externa |
| Prueba de 14 días | — | La autoridad comercial, que sigue siendo de NEXO |

**Lo único que faltaba era el proveedor.** `intentarCobro()` era un stub que
devolvía `SIN_PASARELA` sin más.

Ninguna de esas piezas se tocó salvo `intentarCobro()`, y ninguna fila se migra.

---

## Lo que se construyó

### El puerto, que no nombra a Mercado Pago

`apps/api/src/pagos/puerto.ts` está escrito en los términos que **el billing de
NEXO** necesita —asegurar un plan, suscribir, pausar, cancelar, consultar— y no
en los de la API de un proveedor. Ocho operaciones, ninguna de más.

```
NEXO Billing → Puerto → Mercado Pago        ← lo que se hizo
NEXO Billing → Mercado Pago en todas partes ← lo que había que evitar
```

Es la misma forma que ya resolvieron el correo (`correo/puerto.ts`), el
proveedor de modelo y el gestor de secretos.

### La decisión comercial vive en el motor puro

`packages/billing-engine/src/pasarela.ts` traduce lo que dice una pasarela a lo
que significa para NEXO. Vive en el motor y no en el adaptador porque **no es
transporte, es una regla del negocio**: si viviera en el adaptador, cambiar de
proveedor obligaría a volver a tomarla.

Siendo pura, se ejercita entera. `pasarela.test.ts` la cubre al **100 %**, y eso
importa más de lo habitual: los estados que se prueban ahí aparecen en
producción una vez cada mil cobros y no se pueden provocar a pedido.

### El adaptador

`apps/api/src/pagos/mercadopago.ts`, sobre `/preapproval_plan`, `/preapproval` y
`/v1/payments`. Sin dependencias nuevas: Node trae `fetch` y `node:crypto`. El
SDK oficial además trae su propia política de reintentos, que es justamente la
decisión que no conviene delegar.

### La fábrica

`apps/api/src/pagos/fabrica.ts`, con el patrón cerrado de siempre:
`none | mercadopago`, tres estados, y un arranque que se niega a levantar con un
valor desconocido.

---

## Las cinco decisiones que conviene revisar

### 1 · `intentarCobro()` no cobra, y no puede

Es la consecuencia menos obvia de cobrar con suscripciones, y cambia el diseño:

> En un esquema `preapproval`, **el débito lo ejecuta la pasarela**. NEXO
> autoriza el medio de pago una vez y después Mercado Pago debita solo, cada mes.
> **No existe ninguna operación «cobrale ahora a esta suscripción»** en la API.

Inventarla habría significado escribir una llamada que no existe, o —peor— crear
un cobro suelto por fuera de la suscripción, que le cobraría al cliente un cargo
*adicional* en vez de reintentar el que falló.

Lo que sí se puede hacer es preguntar, y de ahí salen cuatro respuestas que son
distintas para quien lee la cobranza:

| | Qué significa |
|---|---|
| `SIN_PASARELA` | Esta suscripción no está conectada. Se cobra por transferencia. |
| `A_CARGO_DEL_PROVEEDOR` | Sigue autorizada: el reintento lo hace la pasarela. No hay nada que apurar. |
| `MEDIO_NO_AUTORIZADO` | **Ningún reintento va a entrar.** Hay que escribirle al cliente. |
| `NO_SE_PUDO_CONSULTAR` | No se sabe. Volvé a preguntar mañana. |

La diferencia entre las dos últimas es la que más importa. Colapsarlas haría que
una caída de veinte minutos del proveedor se leyera como una cartera entera de
tarjetas vencidas.

### 2 · Una notificación no mueve plata

El camino corto —que el webhook actualice el cobro ahí mismo— **no se puede**, y
resulta ser una buena noticia.

`aai_app` tiene `SELECT` y nada más sobre `payment_intents`, y sobre
`payment_events` no tiene ni eso. Ese candado es lo que impide que el
administrador de una empresa cliente se marque un cargo como pagado. Abrirlo para
que el webhook funcione **lo abriría para toda la API**.

Así que el webhook hace lo mismo que hace el alta con el correo:

```
pasarela → POST /webhooks/pagos → payment_webhook_inbox     (la API, aai_app)
                                  ↓ después, otro proceso
                                  le pregunta a la pasarela
                                  ↓
                                  procesarEventoDePago      (el operador)
```

Del cuerpo que llegó por internet se usa **un solo dato**: qué recurso hay que ir
a consultar. Lo que mueve un cobro es la respuesta de la pasarela a una pregunta
que hizo NEXO con su propia credencial.

El precio es la latencia: un cobro se registra cuando corre `npm run
pagos:bandeja`, no en el instante del webhook. Para una suscripción mensual es
irrelevante.

### 3 · Una suscripción cancelada del otro lado **no** cancela la de NEXO

La traducción obvia —`cancelled` → `CANCELADA`— es incorrecta, y además es
irreversible.

Que el medio de pago deje de estar autorizado —una tarjeta vencida, un cliente
que la dio de baja en la app del banco— **no es que el cliente haya decidido irse
de NEXO**. `NEXO_BILLING.md` §9 es explícito: cancelar es una decisión de la
empresa cliente, no la consecuencia automática de no haber pagado, y de
`CANCELADA` no se vuelve.

Así que se suspende. `SUSPENDIDA → ACTIVA` existe en la máquina de estados;
`CANCELADA → ACTIVA` no. Si el cliente efectivamente se quiere ir, alguien lo
cancela a mano y queda registrado quién.

Y al revés: una suscripción ya `CANCELADA` en NEXO **no la reactiva ningún
webhook**. Devolverle el servicio a quien se dio de baja sería lo contrario de lo
que pidió.

### 4 · Leer y escribir no se reintentan igual

Un `TIMEOUT` no se reintenta nunca: no dice que la operación no haya ocurrido,
dice que no se sabe. Pero además:

| | Lectura | Escritura |
|---|---|---|
| `429` límite de tasa | reintenta | reintenta — se rechaza **antes** de procesar |
| `RED` | reintenta | reintenta — la conexión no se abrió |
| `5xx` proveedor caído | reintenta | **NO** |
| `TIMEOUT` | NO | NO |

Un 500 al *consultar* no hizo nada. Un 500 al *crear* una suscripción es
ambiguo: el error pudo ocurrir después de haberla creado, mientras el proveedor
armaba la respuesta. Repetirlo deja **dos suscripciones cobrándole a la misma
empresa todos los meses**.

### 5 · El ambiente se declara, porque la URL no lo distingue

Esta es la asimetría incómoda con ARCA, y la que más vale mirar antes de conectar
la cuenta real:

> ARCA tiene dos hosts. Apuntar mal se nota porque el certificado no valida.
> **Mercado Pago usa la misma URL para prueba y producción** y los distingue solo
> por el prefijo del access token.

No hay ninguna barrera de red entre probar y cobrar. Lo único que separa una
prueba de un cobro real es el prefijo de una cadena en un archivo de entorno, y
esa clase de barrera no aguanta un copiar-pegar a las once de la noche.

Por eso `PAYMENTS_ENV` se declara aparte y el arranque lo compara contra el
prefijo del token que encuentra. Declarar `sandbox` con un token `APP_USR-`
**impide arrancar**, y al revés también. El mismo par viaja a la base:
`company_subscriptions.ambiente_pago` y `payment_plan_map.ambiente`, para que una
referencia de una cuenta nunca se use contra la otra.

---

## Los defectos que los controles encontraron en este trabajo

Vale registrarlos porque son la medida de para qué sirven los controles.

| Control | Qué encontró |
|---|---|
| **S-29** (a través de la 0119) | La migración 0118 decía «solo lectura para la aplicación» y escribía `GRANT SELECT`, **que no quita nada**: la 0009 deja `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE`, así que toda tabla nueva nace escribible. El comentario decía una cosa y la base hacía otra. Es la cuarta vez que este repositorio comete el mismo error. |
| **S-17** | `payment_plan_map` no tenía ningún `INSERT` fuera de los tests. Yo había escrito que «la escribe un comando» y el comando no existía. |
| **S-16** | `esProblemaDeConfiguracion` se exportaba y no la usaba nadie. |
| **S-25 / S-12 / S-18** | `/webhooks/pagos` no tenía excepción declarada: una ruta pública sin pantalla y sin `requirePermission` no pasa sola. |
| **`solo-lectura-de-verdad`** | El propio S-29 no vio el defecto de la 0118 **porque nadie había declarado la tabla**. El control comprueba lo declarado; lo no declarado es invisible para él. |

El más instructivo es el último. Se corrigieron las dos mitades —el `REVOKE` en
la base y la declaración en el test— porque arreglar solo la base dejaba el mismo
agujero abierto para la próxima tabla.

### Y uno que no encontró ningún control

`apps/api/src/billing/ciclo.ts` y `apps/api/src/routes/facturacion.ts` decían los
dos, desde hacía meses, que *«`tests/security/facturacion-sin-ruta.test.ts`
comprueba que ninguna ruta importe el ciclo de facturación»*.

**Ese archivo no existía.** La regla era cierta y no estaba comprobada por nada:
las dos afirmaciones se escribieron con la intención de escribir el control, y el
control nunca se escribió. Es la forma más incómoda de este defecto — no había un
agujero, había la *creencia* de que el agujero estaba tapado, que es lo que hace
que nadie vuelva a mirar.

Apareció ahora porque acá la regla dejó de ser gratis: un webhook necesita
registrar cobros, y el camino corto es que la ruta llame a
`procesarEventoDePago`. Se escribió el control (**S-44**), y recorre el grafo de
imports entero, no los directos: un import indirecto abre exactamente el mismo
camino.

---

## Cobertura de controles nuevos

| | Qué defiende |
|---|---|
| **S-44** `facturacion-sin-ruta` | Ninguna ruta alcanza `billing/ciclo.ts` ni `pagos/bandeja.ts`, ni siquiera indirectamente |
| **S-29** ampliado | Tercera categoría: una **bandeja** se escribe y no se lee (`email_outbox`, `payment_webhook_inbox`) |
| `pasarela.test.ts` | 19 casos, 100 % del motor de traducción |
| `pasarela-de-pagos.test.ts` | 43 casos: adaptador, clasificación de fallos, reintentos, firma HMAC, fábrica, ambiente |
| `webhook-de-pagos.test.ts` | 12 casos: firma válida / inválida / ausente, duplicado, malformado, query, permisos |
| `bandeja-de-pagos.test.ts` | 14 casos: creación del intento, atribución, transiciones, repetido, atrasado, ambiente cruzado |

Los dos controles nuevos se **vieron fallar** antes de darlos por buenos:

- S-29 bandejas: con un `GRANT SELECT` de más → rojo. Sin el `INSERT` → rojo.
- S-44: con un `import '../billing/ciclo.js'` en `routes/alertas.ts` → rojo,
  nombrando el archivo.

`npm run verify` → **EXIT=0**, 175 suites, 2 686 casos.

---

## Qué falta para cobrar de verdad

Todo lo que falta es **externo**. No hay una sola línea de código pendiente.

### Lo que falta, dónde se saca, y dónde va

Nada de esto lo puedo obtener yo. Cada fila es un valor que solo sale de una
cuenta que controla Pablo.

| Qué falta | Dónde se saca | Dónde va en NEXO |
|---|---|---|
| **Cuenta de Mercado Pago** a nombre de NEXO | mercadopago.com.ar → alta de cuenta de vendedor | — (es el prerrequisito de todo lo demás) |
| **Aplicación** en el panel de desarrolladores | <https://www.mercadopago.com.ar/developers/panel/app> → *Crear aplicación* → producto **Suscripciones** | — |
| **Access token de prueba** (`TEST-…`) | Panel → tu app → *Credenciales de prueba* → Access token | `/opt/nexo/.env` → `PAYMENTS_ACCESS_TOKEN` |
| **Secreto de firma del webhook** | Panel → tu app → *Webhooks* → *Configurar notificaciones* → **Firma secreta** | `/opt/nexo/.env` → `PAYMENTS_WEBHOOK_SECRET` |
| **URL del webhook dada de alta** | Mismo lugar. Pegar: `https://nexointelligence.com.ar/webhooks/pagos`, eventos **`payment`** y **`subscription_preapproval`** | — (la ruta ya existe en el código) |
| **Precios de los planes** | Decisión comercial tuya | Se declaran con `npm run plan:precio`, quedan en `plan_prices` con vigencia y motivo |

Y las tres que se completan solas una vez que están las de arriba:

```
PAYMENTS_PROVIDER=mercadopago
PAYMENTS_ENV=sandbox                       # production recién cuando pruebe bien
PAYMENTS_BACK_URL=https://nexointelligence.com.ar/suscripcion/volver
```

> **El secreto de firma no es el access token.** Son dos valores distintos, de
> dos pantallas distintas del mismo panel. Con el token pero sin la firma, NEXO
> **cobra igual** —Mercado Pago debita sola cada mes— pero **no se entera**: las
> notificaciones llegan sin poder verificarse y el webhook las rechaza con 503.
> El banner del arranque lo dice con todas las letras.

> ⚠ **Empezá por `sandbox`.** Mercado Pago usa la misma URL para prueba y
> producción y las distingue solo por el prefijo del token. NEXO se niega a
> arrancar si `PAYMENTS_ENV` y el prefijo no coinciden, pero esa red está puesta
> justamente porque el error es fácil de cometer.

> 🔒 Los valores van **al archivo del servidor**, nunca a Git, nunca a un commit,
> nunca pegados en un chat.

> ⚠ El dominio `nexointelligence.com.ar` sigue en NXDOMAIN (trámite abierto ante
> NIC Argentina). Es el mismo bloqueante externo que ya estaba en B2.5.2, y el
> webhook lo necesita resuelto: Mercado Pago tiene que poder llegar.

### Lo que hace el operador después

```bash
# 1 · las variables, en /opt/nexo/.env — nunca en Git
PAYMENTS_PROVIDER=mercadopago
PAYMENTS_ENV=sandbox
PAYMENTS_ACCESS_TOKEN=TEST-...
PAYMENTS_WEBHOOK_SECRET=...
PAYMENTS_BACK_URL=https://nexointelligence.com.ar/suscripcion/volver
```

```bash
# 2 · crear el plan del lado de la pasarela (una vez por plan y periodicidad)
npm run pagos:plan -- COMPLETO MENSUAL ARS "Alta de la cuenta de prueba" --ensayo
npm run pagos:plan -- COMPLETO MENSUAL ARS "Alta de la cuenta de prueba"
```

```bash
# 3 · agendar el drenado de la bandeja, cada pocos minutos
npm run pagos:bandeja
```

El banner del arranque va a decir en qué modo quedó, y `--ensayo` en los dos
comandos dice qué harían sin escribir nada.

### El paso a producción

Cambiar `PAYMENTS_ENV` **y** el token, juntos. Si se cambia uno solo, NEXO se
niega a arrancar y dice cuál de los dos está mal. Los planes de `sandbox` no
sirven en `production`: hay que volver a correr `pagos:plan`, y el mapeo los
guarda por separado justamente para eso.

---

## B2.5.6 — lo que esta auditoría encontró que faltaba

**Auditado el 2026-09-15.** La matriz de más abajo decía «integración cerrada» y
no lo estaba. Tres cosas que este documento daba por hechas no existían, y
ninguna se veía desde los tests: cada pieza estaba probada por separado y ninguna
prueba recorría el camino entero.

### 1 · `crearSuscripcion()` no la llamaba nadie

El adaptador sabía crear el `preapproval` y devolver el `init_point` desde
B2.5.5. No había ruta, ni comando, ni paso del ciclo que lo invocara. Con la
cuenta conectada y todo configurado, **ninguna empresa podía suscribirse**.

Ahora: `POST /subscription/pasarela` → `apps/api/src/pagos/suscripcion.ts`.

### 2 · `convertirPrueba()` tampoco

Y es peor, porque es la **única** función del sistema que escribe
`periodicidad`, `moneda`, `importe_acordado` y `proxima_facturacion`. El ciclo de
facturación solo levanta suscripciones que tengan las cuatro
(`proxima_facturacion IS NOT NULL`), así que una empresa podía contratar y **no
ser facturada nunca**. No fallaba nada: simplemente no se emitía el cargo.

Ahora: `POST /subscription/convertir`. El importe **no viene en el cuerpo**: sale
de `plan_prices`. Recibirlo del cliente dejaría al administrador de una empresa
eligiendo cuánto paga.

### 3 · Un pago rechazado rompía el drenaje entero

`payment_intents_fallo_con_detalle` (0096) exige `detalle_error` en todo intento
`FALLIDO`. `procesarEventoDePago` pasaba el intento a `FALLIDO` sin escribirlo,
así que la primera notificación de un rechazo tiraba una violación de `CHECK`
**dentro de la transacción de `pagos:bandeja`**: no fallaba ese evento, fallaba
la corrida y todo lo que venía detrás quedaba sin procesar.

Lo encontró un test nuevo, no una corrida real. `PagoExterno` ahora trae
`detalleDelFallo` (el `status_detail` de Mercado Pago, sin traducir) y cuando el
proveedor no dice por qué se escribe eso mismo, que es feo y es cierto.

### 4 · La 0118 había dejado `POST /subscription` roto

Esa ruta aceptaba `referenciaExterna` y la escribía sola; `cs_pasarela_completa`
exige las tres columnas juntas. Cualquier valor no nulo daba un 23514 sin
traducir, o sea un 500. **No se debilitó la restricción**: se sacó el campo del
cuerpo. Una referencia escrita a mano apunta a un recurso que no existe del otro
lado, y completar el proveedor y el ambiente con supuestos habría sido peor.

### 5 · Cancelar en NEXO no cancelaba nada en la pasarela

`pausarSuscripcion`, `reactivarSuscripcion` y `cancelarSuscripcion` estaban
implementadas en el adaptador y **no las llamaba nadie**.
`POST /subscription/:id/estado` escribía el estado en la base y se terminaba ahí.

Con una cuenta conectada, eso es un cliente que se da de baja, ve «CANCELADA» en
la consola y **sigue viendo el débito en su resumen todos los meses**. No es un
defecto de software: es un cargo indebido.

`sincronizarEstadoConLaPasarela` (en `pagos/suscripcion.ts`) cierra el hueco:

| En NEXO | Se le pide a la pasarela |
|---|---|
| `CANCELADA` | `cancelled` |
| `SUSPENDIDA` **decidida por una persona** | `paused` |
| `ACTIVA` (reactivar) | `authorized` |

Tres decisiones que conviene entender:

- **Se le pide a la pasarela ANTES de escribir en NEXO.** Si falla, no cambia
  nada y se puede reintentar. Al revés quedaría el estado que esto viene a
  impedir, y quedaría en silencio.
- **Una pasarela caída impide cancelar**, y está bien: entre «probá de nuevo» y
  «te dimos de baja y te seguimos cobrando», la segunda es plata ajena.
- **La suspensión por falta de pago NO pausa la pasarela.** Pausarla cortaría
  los reintentos del propio proveedor, que son lo único que puede cobrar la
  deuda: se suspendería el acceso *y* se cerraría la vía de recuperarlo.

La dirección inversa —pasarela → NEXO, por webhook— ya era idempotente y sigue
igual: `consecuenciaDeSuscripcion` traduce, `puedeTransicionar` manda sobre la
pasarela, y el `UPDATE` lleva el estado anterior en el `WHERE`.

### Lo que quedó documentado y no se tocó

`SIN_PRECIO_VIGENTE` figuraba en el tipo `Omision` de `billing/ciclo.ts` y **no
lo emitía nadie**. El ciclo no mira `plan_prices`: factura contra el importe
congelado. Se sacó de ahí y el nombre pasó a ser el código de conflicto de
`POST /subscription/convertir`, que es donde el control existe de verdad.

---

## Matriz de componentes

| Componente | Estado | Evidencia |
|---|---|---|
| Puerto de pagos | ✅ Terminado | `apps/api/src/pagos/puerto.ts` |
| **Conversión prueba → paga** | ✅ **B2.5.6** | `POST /subscription/convertir` |
| **Alta de suscripción en la pasarela** | ✅ **B2.5.6** | `POST /subscription/pasarela` |
| **Precio como dato, no como parámetro** | ✅ **B2.5.6** | `billing/precios.ts` |
| **Motivo del rechazo persistido** | ✅ **B2.5.6** | `detalleDelFallo`, 0096 |
| **Referencia única por suscripción** | ✅ **B2.5.6** | migración 0120 |
| **Cargo vencido sin intento, visible** | ✅ **B2.5.6** | `work_queue_cargos`, 0120 |
| **Cancelar / pausar / reactivar sincronizado** | ✅ **B2.5.6** | `sincronizarEstadoConLaPasarela` |
| Traducción de estados | ✅ Terminado, 100 % cubierto | `packages/billing-engine/src/pasarela.ts` |
| Adaptador Mercado Pago | ✅ Terminado, **no conectado** | `apps/api/src/pagos/mercadopago.ts` |
| Fábrica + 3 estados | ✅ Terminado | `apps/api/src/pagos/fabrica.ts` |
| Guardia de ambiente | ✅ Terminado | `problemaDeAmbiente`, arranque |
| Mapeo plan NEXO ↔ pasarela | ✅ Terminado | migración 0118, `payment_plan_map` |
| Bandeja de webhooks | ✅ Terminado | migración 0119, `payment_webhook_inbox` |
| Ruta del webhook | ✅ Terminada | `POST /webhooks/pagos` |
| Verificación de firma HMAC | ✅ Terminada | `verificarFirma`, tiempo constante |
| Drenado + registro de cobros | ✅ Terminado | `apps/api/src/pagos/bandeja.ts`, `npm run pagos:bandeja` |
| Comando de alta de plan | ✅ Terminado | `npm run pagos:plan` |
| `intentarCobro` conectado | ✅ Terminado (consulta, no cobra) | `billing/ciclo.ts` |
| Política de cobranza | ✅ Ya existía, sin tocar | `collection_policies` |
| Prueba de 14 días | ✅ Ya existía, sigue siendo la autoridad | `billing/prueba.ts` |
| Divergencia de precios visible | ✅ Terminada | `work_queue_pasarela` |
| Variables declaradas | ✅ | `.env.example`, `secrets/inventario.ts` |
| **Cuenta de Mercado Pago** | ⛔ **No existe** | — |
| **Cobro real verificado** | ⛔ **No ocurrió** | — |
| **Dominio resuelto** | ⛔ NXDOMAIN | trámite NIC Argentina |

---

## Veredicto

🟡 **CAMINO COMPLETO — ESPERANDO CUENTA REAL Y PRECIOS**

Actualizado el 2026-09-15. La versión anterior de esta línea decía «integración
cerrada» sobre un sistema en el que nadie podía contratar: ver B2.5.6 más arriba.
Lo que se puede afirmar ahora es distinto y más chico — **el camino existe de
punta a punta y está recorrido por tests**, desde la prueba de catorce días hasta
el cargo emitido. Lo que falta no es código: es una cuenta, un precio y una
decisión.

`SIN_PASARELA` dejó de ser un agujero y es un modo de operación declarado, que el
banner del arranque nombra y que el ciclo de facturación sobrevive sin
degradarse: se emite, se lleva la cobranza y los cobros por transferencia se
registran a mano, exactamente igual que antes.

Conectar la cuenta no requiere programar. Y cuando se conecte, lo que va a probar
que funciona no va a ser este documento: va a ser una fila en `payment_intents`
con estado `PAGADO`.
