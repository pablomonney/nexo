# NEXO ↔ Mercado Pago — decisiones y arquitectura

**Decidido el 2026-09-15.** Este documento es la respuesta a «¿por qué está
hecho así?», no un manual de uso. Lo operativo vive en
`NEXO_MERCADO_PAGO_STATUS.md`.

---

## La decisión que ordena todo lo demás

**Los catorce días de prueba viven en NEXO. Mercado Pago no los conoce.**

Había dos diseños posibles y son incompatibles entre sí:

| | **A — la prueba vive en NEXO** ← elegido | B — la prueba vive en Mercado Pago |
|---|---|---|
| Tarjeta para empezar | no se pide | se pide |
| `free_trial` en el plan del proveedor | no se manda | `14 days` |
| Quién decide el primer cobro | NEXO emite, el proveedor debita | el proveedor, el día 15 |
| Estado al probar | `PRUEBA`, sin pasarela conectada | `PRUEBA` ya conectada |

### Por qué A

Porque B **duplica la prueba**, y la duplicación no es visible hasta que se
cuenta la plata. En NEXO la prueba *es* la suscripción (`estado = 'PRUEBA'`,
`vigencia_hasta` en el día que termina) y se convierte cuando el cliente decide
contratar. Recién ahí se conecta la pasarela. Si el plan del proveedor además
tuviera `free_trial`, el reloj arrancaría **de nuevo** en el momento de
autorizar: catorce días más de gracia mientras el ciclo de NEXO ya está
emitiendo el cargo. Serían dos semanas de servicio facturado que nadie paga, por
cliente y por plan, y ningún sistema daría error.

Y porque B **cambia el producto**: pedir tarjeta para probar baja el alta, y eso
es una decisión comercial con consecuencias medibles que no se toma de costado
mientras se elige una API.

### Lo que A cuesta, dicho de frente

El ciclo de NEXO avanza `proxima_facturacion` contando desde la conversión. El
proveedor debita contando desde el día en que el cliente autorizó. **No tienen
por qué coincidir**, y cuando se separan no falla nada: los dos sistemas
funcionan bien, cada uno con su calendario.

Se resuelve como la 0118 resolvió lo mismo para los importes — guardando lo que
el proveedor informa y comparando:

```
company_subscriptions.proxima_facturacion            ← lo que factura NEXO
company_subscriptions.proxima_facturacion_pasarela   ← next_payment_date del proveedor
work_queue_calendario                                ← la diferencia, en la bandeja
```

`bloquea = false`: cobrar un día distinto no impide operar. Lo que hace es no
desaparecer hasta que alguien lo mire.

### `free_trial` está soportado y apagado

El adaptador sabe mandarlo (`PlanParaProveedor.diasDePruebaDelProveedor` →
`auto_recurring.free_trial`, con `frequency_type: "days"`). No lo usa nadie.
`tests/unit/pasarela-de-pagos.test.ts` comprueba las dos mitades: que el cuerpo
salga **sin** `free_trial` por defecto, y que salga bien cuando se pide. Si
alguien lo activa «porque Mercado Pago lo soporta», el test se pone en rojo y lo
manda a leer esto.

---

## Los planes

Cinco disponibles. Los cuatro comerciales que se están trabajando más
`ESTUDIO`, que **se conserva**: su historial no se toca y no se decide nada
sobre su precio ni su posicionamiento.

```
CONTABLE     NEXO Contable
GESTION      NEXO Gestión
ESTUDIO      NEXO Estudio      ← se conserva, sin decisiones nuevas
EMPRESA_B1   NEXO Empresa      ← el código NO es EMPRESA
COMPLETO     NEXO Completo
```

`EMPRESA_B1` se llama así porque `EMPRESA` lo ocupa un plan de la generación
anterior, discontinuado y conservado para que las suscripciones históricas
sigan encontrando su plan. En pantalla se lee «NEXO Empresa»; en los comandos va
`EMPRESA_B1`.

### Todo lo del plan es dato, nada es código

| Atributo | Dónde vive |
|---|---|
| nombre, descripción, orden, estado | `subscription_plans` |
| precio, moneda, periodicidad | `plan_prices` — con vigencia y motivo |
| **días de prueba** | `subscription_plans.dias_de_prueba` (0121) |
| límites | `plan_limits` |
| funcionalidades | `plan_features` → `product_features` |
| identificador del plan del proveedor | `payment_plan_map.referencia_externa` |
| metadata de sincronización | `payment_plan_map`: ambiente, periodicidad, moneda, importe declarado, quién y por qué |

`dias_de_prueba IS NULL` significa **«este plan no declaró nada, vale el valor
por defecto del producto»** — hoy 14, en `DIAS_DE_PRUEBA`. No significa cero: un
cero le sacaría la prueba a todo el que contrate ese plan. Es la misma
distinción que la tabla de topes hace desde la 0073.

---

## El circuito, de punta a punta

```
alta de la empresa
  └─ POST /onboarding/empresa ......... crea estudio, empresa, rol y PRUEBA
                                        sin pedir tarjeta

durante la prueba
  └─ el acceso lo gobierna plan_features; el ciclo no emite nada

el cliente decide contratar
  └─ POST /subscription/convertir ..... PRUEBA → ACTIVA
                                        el importe sale de plan_prices,
                                        NO del cuerpo del pedido

conectar el medio de pago
  └─ POST /subscription/pasarela ...... crea el preapproval (status: pending)
                                        devuelve init_point
  └─ el cliente autoriza EN EL SITIO DEL PROVEEDOR
                                        NEXO nunca ve la tarjeta

de ahí en más
  └─ el proveedor debita solo, cada mes
  └─ POST /webhooks/pagos ............. guarda en payment_webhook_inbox
                                        y NO aplica nada
  └─ npm run pagos:bandeja ............ le pregunta al proveedor con la
                                        credencial de NEXO y recién ahí aplica
```

### La regla que sostiene el diseño

**NEXO nunca le cree a lo que llega por la puerta.** La ruta pública del webhook
guarda una fila y no mueve un cobro; del cuerpo usa **un solo campo**: qué
recurso hay que ir a consultar. Lo que mueve plata es la respuesta del proveedor
a una pregunta que hizo NEXO con su propia credencial.

No es una precaución de estilo: `aai_app` tiene `SELECT` sobre `payment_intents`
y **nada** sobre `payment_events`. Ese candado es lo que impide que el
administrador de una empresa cliente se marque un cargo como pagado, y darle
`INSERT` para que el webhook funcionara se lo habría dado **a todas las demás
rutas**.

---

## Estados

```
PRUEBA ──► ACTIVA ──► SUSPENDIDA ──► CANCELADA
   │          │            │              ▲
   └──────────┴────────────┴──────────────┘   de CANCELADA no se vuelve
```

Del lado del proveedor: `pending`, `authorized`, `paused`, `cancelled`.

**La traducción no es simétrica, y esa asimetría es la decisión de negocio más
importante del módulo:** `cancelled` del proveedor se traduce a `SUSPENDIDA` en
NEXO, no a `CANCELADA`. Que una tarjeta venza no es que el cliente haya decidido
irse, y de `CANCELADA` no se vuelve. Pero cancelar *en NEXO* sí pide cancelar
allá.

### Sincronización NEXO → proveedor

`sincronizarEstadoConLaPasarela` corre **antes** de escribir en la base. Si el
proveedor no confirma, no se cambia nada y se puede reintentar. La consecuencia
es que **una pasarela caída impide cancelar**, y es lo correcto: entre «probá de
nuevo» y «te dimos de baja y te seguimos cobrando», la segunda es un cargo
indebido.

Es idempotente porque consulta antes de pedir: si el proveedor ya está en el
estado buscado, no se le pide nada.

**La suspensión por falta de pago no pausa al proveedor**, y es deliberado:
pausarlo cortaría sus propios reintentos, que son lo único que puede cobrar la
deuda. Se suspendería el acceso *y* se cerraría la vía de recuperarlo.

---

## Idempotencia, en tres capas

| Capa | Candado | Qué impide |
|---|---|---|
| Notificación | `UNIQUE (proveedor, evento_externo)` en la bandeja | que el mismo aviso entre dos veces |
| Cobro | `UNIQUE (proveedor, referencia_externa)` en `payment_intents` | que un pago genere dos intentos |
| Cobranza | `UNIQUE NULLS NOT DISTINCT (document_id, tipo, numero)` en `collection_steps` | que un paso se ejecute dos veces |
| Hacia afuera | `x-idempotency-key` estable (`sub:<id de la suscripción>`) | que un reintento cree dos suscripciones |

Y `procesarEventoDePago` distingue cinco desenlaces —`APLICADO`, `REPETIDO`,
`ATRASADO`, `DESCONOCIDO`, `CONFLICTO`— en vez de dos. Colapsarlos borraría la
diferencia entre «se aplicó» y «llegó tarde y no se aplicó», que es justo lo que
alguien va a querer saber dentro de seis meses.

---

## Pagos rechazados

El proveedor informa el rechazo → la bandeja consulta → el intento queda
`FALLIDO` **con el motivo del proveedor** (`status_detail`, sin traducir; si no
lo da, se escribe que no lo dio). Ese `FALLIDO` es lo que enciende
`avanzarCobranza`, que ejecuta el calendario de `collection_policies`:
reintentos, aviso, suspensión. Un paso por corrida, el más viejo primero, sin
repetir ninguno.

Sin política declarada **no dispara nada** — que no es «cero reintentos», es que
nadie dijo cuántos.

---

## Separación TEST / PRODUCCIÓN

Mercado Pago **usa la misma URL para las dos** y solo las distingue el prefijo
del token. No hay barrera de red entre probar y cobrar. Las barreras son tres,
todas de este lado:

1. `PAYMENTS_ENV` se declara explícitamente y el arranque lo compara contra el
   prefijo del token (`TEST-` / `APP_USR-`). Si no coinciden, **no arranca**.
2. `payment_plan_map` tiene el ambiente en la clave: el plan de prueba y el real
   son dos filas distintas y no se pueden confundir.
3. `company_subscriptions.ambiente_pago`: una referencia creada en sandbox no
   existe en producción, y consultarla allá daría un 404 que se leería como «el
   cliente nunca autorizó nada». Por eso, si no coincide, **no se consulta**.

`npm run pagos:ensayo` se niega a correr con `PAYMENTS_ENV=production`.

---

## Lo que el MCP de Mercado Pago es y no es

Sirve para **diagnóstico asistido**: consultar la cuenta, listar planes, mirar
una suscripción mientras se prueba.

**No es parte del camino de ejecución.** La facturación corre desatendida, desde
un cron, sin nadie mirando: NEXO habla con la API REST con su propia credencial.
El MCP no reemplaza al adaptador y no debe aparecer en ninguna ruta.

---

## Lo que falta, y de qué depende

| | Depende de |
|---|---|
| Precios definitivos | decisión comercial |
| Política de cobranza | decisión comercial |
| Planes creados en sandbox | que haya precios |
| `PAYMENTS_WEBHOOK_SECRET`, `PAYMENTS_BACK_URL` | **que el dominio resuelva** — el proveedor tiene que poder llegar al webhook |
| Ensayo completo con navegador | todo lo anterior |
| Paso a producción | ensayo completo aprobado |

El tope `EMPRESAS` sigue aceptándose en `plan_limits` y **no lo mide ninguna
vista**: declararlo guarda un número que nunca produce un exceso. Está anotado
acá para que no se prometa comercialmente hasta que se implemente.
