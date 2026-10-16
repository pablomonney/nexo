# Mercado Pago: de cero a cobrar suscripciones — paso a paso

**Estado (2026-10-16): el adaptador está construido y probado con dobles (`apps/api/src/pagos/mercadopago.ts`); NO hay cuenta de aplicación, NO hay credenciales y NO se probó contra Mercado Pago de verdad.** `PAYMENTS_PROVIDER=none` en producción: hoy se cobra por transferencia manual (`docs/COBRO_MANUAL_POR_TRANSFERENCIA.md`).

## Avance real (2026-10-16)

- **Aplicación «Nexo intelligence»** (N.° 2701982030240212, tipo «Otra plataforma») ya existe en la cuenta del titular.
- **Credencial de PRUEBA** cargada en el `.env` local por el titular y **comprobada**: `npm run pagos:ensayo` → «la credencial sirve: la pasarela contestó», prefijo `TEST-` coincide con `PAYMENTS_ENV=sandbox`. Ningún valor pasó por el chat. (El sistema de permisos bloqueó leer la pantalla de credenciales; no se rodeó.)
- **Webhook en modo prueba** configurado en el panel: `https://nexointelligence.com.ar/webhooks/pagos`, eventos «Pagos» y «Planes y suscripciones». **Modo productivo: sin configurar.**
- **Secreto de firma** copiado por el titular a `PAYMENTS_WEBHOOK_SECRET` (local). **No probado** que sea el correcto: eso sólo lo confirma una notificación firmada real por Mercado Pago, y el endpoint `/webhooks/pagos` recién existe en el servidor tras el segundo lanzamiento.
- **Credenciales de PRODUCCIÓN ACTIVADAS el 2026-10-16** por el titular (industria «Servicio de informática», sitio `https://nexointelligence.com.ar`, consentimiento y captcha hechos por él). Verificado sólo por la presencia de los campos (Public Key, Access Token, Client ID, Client Secret); **ningún valor se leyó ni se guardó en ningún lado**. Siguen sin cargarse en el servidor: `PAYMENTS_PROVIDER` queda en `none` y el cobro automático NO está encendido. Falta también configurar el webhook en **modo productivo** (tiene su propio secreto).
- **Falta:** política de cobranza vigente (decisión del titular: `scripts/declarar-politica-de-cobranza.mjs`), crear los planes en la pasarela (`npm run pagos:plan`; precio vigente p. ej. COMPLETO ARS 449.900/mes), usuarios de prueba (vendedor y comprador), la prueba de punta a punta (`pagos:ensayo` §5) y, para producción, todo el Paso 3.
- **Dónde se prueba el webhook:** **decidido por el titular (2026-10-16): en el servidor real**, tras el segundo lanzamiento, con credenciales de PRUEBA y la empresa de prueba. Implica poner `PAYMENTS_PROVIDER=mercadopago`, `PAYMENTS_ENV=sandbox`, el token `TEST-` y el secreto en el `.env` del servidor (sin imprimirlos) y **volver a `none` al terminar**.

## Qué es el «MCP de Mercado Pago» y qué NO es

Mercado Pago publica un servidor MCP oficial (`https://mcp.mercadopago.com/mcp`, remoto, con OAuth). Según [su documentación](https://www.mercadopago.com.ar/developers/en/docs/mcp-server/overview) sirve para **armar la integración**: buscar en su documentación, **crear aplicaciones y obtener sus credenciales** (sólo por OAuth), configurar y monitorear webhooks, crear usuarios de prueba con saldo y correr la medición de calidad antes de salir a producción.

**No es parte de NEXO en funcionamiento.** NEXO cobra hablando directo con la API REST de Mercado Pago (suscripciones `preapproval`); el MCP es una herramienta para que yo configure la cuenta con vos, una vez. Cuando termina, se puede desconectar.

## Paso 1 · Conectar el MCP (lo hacés vos, ~3 minutos)

Hace falta una **cuenta de Mercado Pago** tuya (la que va a cobrar). No puedo iniciar sesión ni crearla por vos.

1. En Claude Desktop: **Configuración → Conectores → Agregar conector personalizado**.
2. URL: `https://mcp.mercadopago.com/mcp` → **Conectar**.
3. Se abre Mercado Pago: iniciás sesión, **elegís Argentina** y **autorizás**. Volvés a Claude y queda conectado.
4. Avisame. Yo listo las herramientas disponibles (sus nombres exactos no figuran en la página que pude leer) y sigo.

*(Si usás Claude Code por terminal, el equivalente es agregar ese mismo URL como servidor MCP remoto y autenticarlo con `/mcp`; el sitio de Mercado Pago sólo documenta Cursor, así que verificalo en la pestaña de Claude de su guía.)*

## Paso 2 · Sandbox: lo hago yo con el MCP

1. Crear la **aplicación** «NEXO» (tipo suscripciones) y obtener las credenciales de **prueba** (`TEST-…`).
2. Crear **dos usuarios de prueba**: vendedor y comprador (con saldo).
3. Configurar el **webhook** a `https://nexointelligence.com.ar/webhooks/pagos` (eventos de suscripción y de pago) y obtener el **secreto de firma** (es distinto del access token; sin él, NEXO contesta 503 a las notificaciones, a propósito).
4. Guardar todo en el `.env` **local** (git lo ignora), **sin escribirlo en el chat**:
   `PAYMENTS_PROVIDER=mercadopago`, `PAYMENTS_ENV=sandbox`, `PAYMENTS_ACCESS_TOKEN=TEST-…`, `PAYMENTS_WEBHOOK_SECRET=…`, `PAYMENTS_BACK_URL=https://nexointelligence.com.ar/…`.
5. `npm run pagos:ensayo` (se niega a correr con credenciales de producción) y `node scripts/declarar-plan-de-pasarela.mjs COMPLETO MENSUAL ARS "Alta" --ensayo` para ver el pedido antes de crear el plan.
6. El único paso que no puedo hacer solo: **el comprador de prueba autoriza la tarjeta** en el `init_point` (una pantalla de Mercado Pago). Lo hacés vos en el navegador con el usuario de prueba; yo miro que llegue la notificación y que NEXO marque la suscripción.

**Dónde probar el webhook:** Mercado Pago tiene que alcanzar el servidor, así que el webhook real se prueba contra el servidor público, **después del segundo lanzamiento**, con las credenciales de prueba y la empresa de prueba. Eso deja filas de prueba en la base de producción (en la empresa de prueba, que ya existe). Alternativa sin tocar producción: un túnel desde esta PC (otra herramienta a instalar).

## Paso 3 · Producción: lo que sólo podés hacer vos

1. **Activar la cuenta de Mercado Pago para cobrar** (identidad verificada, datos fiscales, cuenta bancaria de retiro).
2. Crear las credenciales de **producción** (`APP_USR-…`). El arranque de NEXO **se niega a iniciar** si el ambiente declarado no coincide con el prefijo del token.
3. **Antes de encender:** actualizar la política de privacidad y los términos (la tabla de terceros dice hoy «pasarela: ninguna»; los borradores ya lo anticipan «se actualiza antes») — y la revisión legal (B8) sigue pendiente.
4. Declarar el precio (`declarar-precio-de-plan.mjs`) y crear el plan en la pasarela **sin `--ensayo`**: eso define lo que se cobra todos los meses.
5. Primera suscripción real con tu propia tarjeta por el mínimo, ver que el cobro entre y la notificación llegue, y reintegrarlo.
6. Recién ahí, `PAYMENTS_PROVIDER=mercadopago` + `PAYMENTS_ENV=production` en el `.env` del **servidor**.

## Seguridad y qué NO se hace

- Las credenciales pasan por mi contexto al obtenerlas por el MCP. No las escribo en el chat ni en el repositorio; van al `.env` (o a un gestor de secretos). Si alguna se expone, se rota en el panel de Mercado Pago.
- El token de **producción** va al servidor sólo con tu orden expresa en ese momento.
- NEXO no recibe ni guarda datos de tarjeta: la autorización ocurre en el dominio de Mercado Pago.
- Una escritura a la pasarela **no se reintenta** ante un 5xx (podría duplicar una suscripción). Ver `docs/NEXO_BILLING.md`.

## Qué necesito de vos, en orden

1. Conectar el MCP (Paso 1) y avisarme.
2. Más adelante: autorizar la tarjeta del comprador de prueba (Paso 2.6).
3. Activar la cuenta para cobrar y decidir la fecha de salida (Paso 3).
