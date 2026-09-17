# Conectar Resend — la parte que hace el operador

**Escrito:** 2026-09-17, al cerrar la revisión del código de correo.
**Estado del código:** listo. **Estado de la conexión:** no conectada.

Este documento **no conecta nada**. Dice qué falta hacer afuera del repositorio,
qué variables hay que poner, dónde, cómo se comprueba que quedaron bien y qué
prueba se corre después. El código no necesita ningún cambio para que esto
funcione: lo que falta es una cuenta, un dominio verificado y tres variables.

---

## 0 · Qué está listo y cómo se sabe

| Pieza | Dónde | Comprobado |
|---|---|---|
| Adaptador HTTP contra Resend | `apps/api/src/correo/resend.ts` | 25 pruebas unitarias del proveedor |
| Elección del proveedor, en un solo lugar | `apps/api/src/correo/fabrica.ts` | Con las tres variables puestas, el estado pasa a `CONFIGURADO` y la fábrica devuelve el proveedor real |
| Un `EMAIL_PROVIDER` desconocido **no arranca** | `verificarProveedorDeCorreo`, llamado antes de escuchar | Falla el arranque con el nombre de los valores admitidos |
| Cola con estado por mensaje | `email_outbox` (`PENDIENTE`, `SIN_PROVEEDOR`, `ENVIADO`, `FALLIDO`) | Migración 0103/0104 |
| Drenado de la cola | `scripts/correo-bandeja.mjs`, timer `nexo-correo` cada 5 min | `infrastructure/systemd/README.md` |
| Reintentos | 429, 5xx y fallos de red. **Un timeout no se reintenta** | `resend.ts` — un reintento de un envío produce un correo de más |
| El banner del arranque nombra el modo | `arranque.ts` → `modoDeCorreo` | Hoy imprime `correo    none   · simulado o apagado`; con las tres variables imprime `correo    resend` y el remitente debajo |

**Nada de esto prueba que Resend conteste.** Que haya credencial no prueba que
sirva: lo único que prueba una conexión es un envío que volvió, y eso lo dice
`email_outbox`, no una variable de entorno. Por eso el §4 comprueba la
configuración y el §5 comprueba el envío, y son dos cosas distintas.

---

## 1 · Qué hay que hacer en Resend

1. **Crear la cuenta** en resend.com. Qué plan contratar es una decisión
   comercial que este documento no toma: lo que el código necesita es una clave
   con permiso de envío y un dominio verificado.
2. **Agregar el dominio `nexointelligence.com.ar`** en *Domains → Add Domain*.
   Resend no acepta un remitente de un dominio que no esté verificado en la
   cuenta: sin este paso, cada envío vuelve con un 422.
3. **Publicar los registros DNS que Resend indique**, en la zona del dominio
   (NIC Argentina / donde esté delegada). Son los de la tabla de
   `docs/DESPLIEGUE.md` §3.3:
   - un `TXT` de SPF (Resend da el `include:`),
   - tres `CNAME` de DKIM (los da Resend, con sus nombres exactos),
   - opcionalmente un `TXT` en `_dmarc`, empezando por `p=none`.

   Los valores **los da Resend**; acá no están escritos a propósito, porque
   escribir un valor de ejemplo sería inventar la mitad del trabajo.
4. **Esperar a que el dominio figure como verificado** en el panel. Hasta que lo
   esté, no tiene sentido poner las variables: el estado sería `CONFIGURADO` y
   todos los envíos `FALLIDO`.
5. **Crear una API key** en *API Keys*, con permiso de **envío** (`Sending
   access`). Se copia una sola vez.
6. **Decidir el remitente.** Tiene que ser una casilla del dominio verificado.
   Sugerido: `NEXO <no-reply@nexointelligence.com.ar>`. Si se quiere que alguien
   pueda *responder* ese correo, hace falta además un `MX` y una casilla real —
   para que NEXO **mande** no hace falta.

---

## 2 · Qué variables hay que proporcionar

Tres obligatorias y dos opcionales:

| Variable | Valor | Qué pasa si falta |
|---|---|---|
| `EMAIL_PROVIDER` | `resend` | Con `none` no sale ningún correo: lo encolado queda `SIN_PROVEEDOR`. Con cualquier otro valor **el servidor no arranca** |
| `EMAIL_API_KEY` | la clave de Resend, empieza con `re_` | Estado «preparado, no conectado»: el arranque lo dice nombrando la variable que falta, y el alta sigue funcionando contra la bandeja |
| `EMAIL_FROM` | `NEXO <no-reply@nexointelligence.com.ar>` | Igual que arriba. No tiene valor por defecto y no puede tenerlo: un ejemplo produciría un 422 en cada envío |
| `EMAIL_TIMEOUT_MS` | opcional, por defecto `10000` | Se usa el defecto |
| `EMAIL_MAX_RETRIES` | opcional, por defecto `2` | Se usa el defecto. Son reintentos **además** del primer intento, y solo sobre 429, 5xx y fallos de red |

`EMAIL_API_KEY_REF` existe y **no hace falta tocarla**: poniendo solo
`EMAIL_API_KEY`, el arranque deduce `env:EMAIL_API_KEY`. La forma con referencia
es para el día que haya un gestor de secretos, y ese día lo único que cambia es
el prefijo (`kms:`).

---

## 3 · Dónde se configuran

**En `/opt/nexo/.env`, en el servidor. En ningún otro lado.**

- Es el archivo que `docker-compose.prod.yml` declara como `env_file`, y es el
  mismo que los timers de systemd pasan con `--env-file`. Poner las variables
  ahí las hace llegar a la aplicación **y** al drenado de la cola de una sola
  vez.
- **No van al repositorio ni a la imagen.** `.dockerignore` excluye el `.env` y
  el control S-43 lo comprueba.
- El archivo tiene que quedar con permisos restrictivos (`chmod 600`, dueño
  `root`), como el resto de su contenido.
- En la máquina de desarrollo **no hace falta ponerlas**: con `EMAIL_PROVIDER`
  ausente el modo es `none`, que es un modo de operación legítimo y no un error.

Después de editar el archivo **hay que recrear el contenedor**: las variables de
entorno se leen al crearlo, no en caliente.

```bash
cd /opt/nexo && BUILD_ID=$(git rev-parse --short HEAD) docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d --force-recreate nexo
```

Volver a correr `bash scripts/desplegar.sh` también sirve y además vuelve a
pasar las sondas; es el camino preferible si no hay apuro.

---

## 4 · Cómo se comprueba que quedaron bien

Tres comprobaciones, en este orden. Ninguna manda un correo.

**4.1 · El banner del arranque dice el modo.**

```bash
docker logs nexo-app 2>&1 | grep -A1 "^  correo" | tail -4
```

El banner imprime el modo en una línea y su detalle en la siguiente:

| Lo que dice | Qué significa |
|---|---|
| `correo    none   · simulado o apagado` | El archivo no llegó al contenedor, o `EMAIL_PROVIDER` quedó sin cambiar |
| `correo    resend   · simulado o apagado` y debajo `preparado, no conectado: falta EMAIL_FROM` | Falta exactamente la variable que nombra |
| `correo    resend` **sin** la marca de apagado, y debajo `remitente NEXO <no-reply@...>` | Las tres variables llegaron. **Todavía no prueba que Resend conteste** |

**4.2 · La aplicación sigue sana.**

```bash
curl -fsS https://nexointelligence.com.ar/health/db
```

Tiene que contestar `status: ok` con las migraciones aplicadas. Un
`EMAIL_PROVIDER` mal escrito impide arrancar, y ese es el síntoma.

**4.3 · La bandeja se puede leer, y está como estaba.**

```bash
sudo systemctl start nexo-correo && journalctl -u nexo-correo -n 40 --no-pager
```

Se corre el mismo timer que ya está agendado. Lo que muestra es el resumen por
estado de `email_outbox`. Antes de la prueba del §5, lo esperable es que no haya
nada nuevo: el timer **solo entrega lo `PENDIENTE`**, y lo `PENDIENTE` de hoy
son avisos de cobranza, no altas.

> La aplicación **no puede leer `email_outbox`** —`aai_app` tiene `INSERT` y no
> tiene `SELECT`, porque el cuerpo de un mensaje de verificación lleva el
> token—. Por eso esto se mira desde el servidor y no desde una pantalla.

---

## 5 · La prueba end-to-end, después

Se corre **una vez**, con una dirección real que vos puedas abrir. No usa la
cuenta de nadie más y no toca datos de clientes.

1. **Registro.** En `https://nexointelligence.com.ar/consola.html`, alta con una
   dirección real. La respuesta del alta tiene que decir **«El mensaje de
   verificación salió.»** — ese texto sale de que el proveedor aceptó el
   mensaje. Si dice «no hay proveedor de correo configurado», el §4 mintió y hay
   que volver ahí. Si dice «no se pudo entregar», el proveedor rechazó: el
   motivo está en la bandeja.
2. **Constancia del lado del servidor.**
   ```bash
   sudo systemctl start nexo-correo && journalctl -u nexo-correo -n 40 --no-pager
   ```
   Tiene que aparecer una fila `VERIFICACION_DE_ALTA` en estado `ENVIADO`, con
   su referencia de Resend.
3. **El correo llega.** Asunto: *«Confirmá tu dirección para entrar a NEXO»*.
   El cuerpo trae un **código para copiar**, no un enlace — el token no viaja
   como link a propósito. Mirar también la carpeta de correo no deseado: si cae
   ahí, el problema es de DNS (SPF/DKIM), no del código.
4. **Verificación.** En la consola, pantalla *«Ya tengo el código de
   confirmación»*, pegar el código. Tiene que contestar **«Listo: ya podés
   entrar.»**
5. **Ingreso y onboarding.** Entrar con esa cuenta y recorrer alta de empresa →
   plan → prueba de 14 días. Es el circuito que `npm run verify:arranque` ya
   recorre sin correo; lo que esta prueba agrega es el tramo que hoy no existe.
6. **La rama de «no me llegó».** Pedir un reenvío desde la consola y comprobar
   dos cosas: que llega un código nuevo, y que **el anterior deja de servir**.
   Es la mitad que protege de tener dos vías abiertas hacia la misma cuenta.

### 5.1 · Cómo se lee un fallo

Si un mensaje queda `FALLIDO`, el detalle de la bandeja empieza con un código, y
cada uno lleva a una acción distinta:

| Código | Qué pasó | Quién lo arregla |
|---|---|---|
| `CREDENCIAL_RECHAZADA` | 401/403: la clave no sirve o no tiene permiso de envío | El operador: clave nueva en Resend y de vuelta al §3 |
| `MENSAJE_RECHAZADO` | 4xx, típicamente 422: **el remitente no está verificado** o la dirección de destino no sirve | El operador si es el remitente (§1, pasos 2 a 4); quien se registró si es su dirección |
| `LIMITE_DE_TASA` | 429: se pasó el cupo del plan | Se reintenta solo, hasta `EMAIL_MAX_RETRIES` |
| `PROVEEDOR_CAIDO` | 5xx de Resend | Se reintenta solo |
| `TIMEOUT` | No contestó a tiempo | **No se reintenta**, a propósito: no dice que el mensaje fue rechazado, y reintentarlo podría mandarlo dos veces. Hay que mirar si llegó |
| `RED` | No se llegó a Resend | Se reintenta solo |

La credencial no aparece en ningún detalle: se tapa antes de escribirlo. El
destinatario y el asunto sí, porque hacen falta para saber de qué mensaje se
habla.

**Criterio de terminado:** los seis pasos, con el paso 2 mostrando `ENVIADO`.
Si el paso 3 no llega pero el paso 2 dice `ENVIADO`, el mensaje salió y el
problema está en la entrega —reputación del dominio, DNS, filtro del
destinatario—: se mira en el panel de Resend, no en el código.

---

## 6 · Lo que conectar Resend **no** arregla

Tres cosas, y conviene saberlas antes y no durante:

1. **«Olvidé mi contraseña» sigue sin existir.** El tipo de mensaje
   `RECUPERACION` está declarado y **ninguna ruta lo usa**: no hay endpoint de
   recuperación. Con Resend conectado se puede escribir; hoy la recuperación
   sigue siendo el procedimiento manual de `NEXO_LEGAL_Y_SOPORTE.md` §2.
2. **Un alta que falla no se reintenta sola.** El mensaje de verificación se
   manda **en línea** con el registro (`encolar`), así que un rechazo queda
   `FALLIDO` y el timer no lo vuelve a intentar: reintentar un rebote sin mirar
   por qué rebotó es la forma más rápida de que un proveedor marque el dominio
   como spam. La salida para la persona es pedir un reenvío.
3. **El timer entrega lo `PENDIENTE`, que hoy es la cobranza.** No es el camino
   del alta. Que el timer corra bien no dice nada sobre si un alta salió.
