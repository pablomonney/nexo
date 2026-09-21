import { randomBytes } from 'node:crypto';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: required('DATABASE_URL'),

  /**
   * ¿Hay un proxy de confianza adelante?
   *
   * **Por omisión no**, y cambiarlo tiene consecuencias en los dos sentidos.
   *
   * Con `false` detrás de un proxy —que es todo despliegue con TLS terminado
   * afuera—, `request.ip` es la dirección **del proxy** para todo el mundo. El
   * límite de intentos usa esa dirección como clave, así que treinta fallos de
   * cualquiera agotan el cupo de **todos**: un atacante deja al resto afuera con
   * treinta intentos. Es un defecto que solo aparece desplegado, nunca en
   * desarrollo, y por eso hay que decidirlo antes de desplegar y no después.
   *
   * Con `true` sin un proxy adelante, cualquiera manda `X-Forwarded-For` y se
   * inventa la dirección que quiera: el límite deja de servir y la bitácora
   * guarda direcciones falsas.
   *
   * O sea: se activa **si y solo si** hay un proxy que reescriba esa cabecera y
   * no la deje pasar desde afuera. Ver docs/DESPLIEGUE.md §6.
   */
  trustProxy: process.env.TRUST_PROXY === 'true',

  /**
   * Qué versión está corriendo, para la sonda de salud.
   *
   * La pone el despliegue —el hash del commit, la etiqueta de la imagen— y si
   * no está se informa `desconocida`. **No se inventa un valor por defecto**:
   * decir «1.0.0» sobre un despliegue del que no se sabe qué trae es peor que
   * decir que no se sabe, porque el que compara dos entornos concluye que son
   * el mismo.
   */
  buildId: process.env.BUILD_ID ?? null,

  session: {
    /** Expiración por inactividad. */
    idleMinutes: Number(process.env.SESSION_IDLE_MINUTES ?? 30),
    /** Expiración absoluta: una sesión no vive para siempre por más que se use. */
    absoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS ?? 12),
    cookieName: 'aai_session',
  },

  login: {
    maxFailedAttempts: Number(process.env.LOGIN_MAX_FAILED ?? 5),
    lockMinutes: Number(process.env.LOGIN_LOCK_MINUTES ?? 15),

    /**
     * Intentos por minuto y por origen sobre las rutas de autenticación.
     *
     * Es distinto del bloqueo de cuenta: aquel protege **una** cuenta de cinco
     * errores; este ataja al que prueba una contraseña común contra mil
     * direcciones distintas, que nunca falla cinco veces sobre la misma y por
     * eso no dispara el bloqueo ni una vez.
     *
     * El valor por defecto es holgado a propósito: apretarlo de más echa a un
     * usuario legítimo que se equivocó tres veces con el teclado en otro idioma.
     */
    maxPorMinutoPorOrigen: Number(process.env.LOGIN_RATE_PER_MINUTE ?? 30),
  },

  /**
   * Clave para cifrar el secreto TOTP en reposo.
   *
   * En producción esto viene del gestor de secretos (SECURITY.md §5) y la
   * variable debe existir: si falta, el servidor no arranca. En desarrollo se
   * genera una efímera para no obligar a configurar nada, con el costo asumido
   * de que los secretos MFA dejan de validar al reiniciar.
   */
  mfaEncryptionKey: isProduction
    ? Buffer.from(required('MFA_ENCRYPTION_KEY'), 'base64')
    : Buffer.from(process.env.MFA_ENCRYPTION_KEY ?? randomBytes(32).toString('base64'), 'base64'),

  documents: {
    /** Raíz del almacén de documentos. En producción, un volumen dedicado. */
    storagePath: process.env.DOCUMENT_STORAGE_PATH ?? './var/documents',
    maxBytes: Number(process.env.DOCUMENT_MAX_BYTES ?? 25 * 1024 * 1024),
    /**
     * Motor de OCR: `none` (por defecto) o `mock`.
     *
     * No hay caída automática al simulado. Sin motor configurado, los documentos
     * se archivan y la extracción informa `SIN_MOTOR_OCR` — que es la verdad, y
     * no "no se encontró ningún campo".
     */
    ocrEngine: process.env.OCR_ENGINE ?? 'none',
  },

  arca: {
    /**
     * Ambiente de ARCA: `mock` (por defecto), `homologacion` o `produccion`.
     *
     * Mismo criterio que el OCR y que el proveedor de IA, y acá pesa más: el
     * mock se usa **si y solo si** el ambiente es `mock`. La alternativa cómoda
     * —«si no hay credencial, usá el mock»— produciría validaciones fiscales
     * inventadas que el sistema informaría como reales. Sin credencial, el
     * cliente real contesta `NO_VERIFICABLE` con motivo `SIN_CREDENCIAL`, que es
     * lo que corresponde informar (ver `packages/arca/src/factory.ts`).
     */
    environment: process.env.ARCA_ENVIRONMENT ?? 'mock',
    timeoutMs: Number(process.env.ARCA_TIMEOUT_MS ?? 15_000),

    /**
     * La llave con que se envuelve la clave privada del certificado **fuera de
     * producción**.
     *
     * En producción esto no se usa: `desenvolver()` se niega a abrir un sobre
     * `local:` con `NODE_ENV=production`, porque una KEK en una variable de
     * entorno vive en el mismo lugar que el ciphertext y no protege de nada más
     * que de un volcado de la base. El sobre de verdad —DEK por empresa envuelta
     * con la KEK del KMS, SECURITY.md §5— necesita un cliente de KMS que todavía
     * no existe, y hacer de cuenta que sí sería peor que no tenerlo.
     *
     * Se deriva igual que `mfaEncryptionKey`: efímera en desarrollo, para no
     * obligar a configurar nada, con el costo asumido de que las credenciales
     * cargadas dejan de abrirse al reiniciar.
     */
    localKeyEncryptionKey: Buffer.from(
      process.env.ARCA_LOCAL_KEK ?? randomBytes(32).toString('base64'),
      'base64',
    ),
  },

  ai: {
    /**
     * Proveedor de modelo. Tres valores, y ninguno más:
     *
     *   `none`  sin IA externa. Es el valor por defecto y **es un modo de
     *           operación** (§8): el sistema sigue sugiriendo con la historia de
     *           la empresa, sin mandar un solo documento afuera.
     *   `mock`  el simulado, que siempre se abstiene. Para desarrollo y tests.
     *   `http`  el adaptador HTTP contra un proveedor real.
     *
     * Un valor desconocido **no cae a `none`**: `verificarProveedor()` lo
     * rechaza y el servidor no arranca. Un typo que degrada en silencio es peor
     * que un arranque fallido — el sistema diría que tiene IA y no la tendría.
     */
    provider: process.env.AI_PROVIDER ?? 'none',

    /**
     * La credencial. Nunca se loguea, nunca se persiste, nunca sale en un error.
     *
     * `null` con `provider=http` es un estado legítimo y nombrado: **preparado,
     * no conectado**. El arranque lo dice con esas palabras.
     */
    /**
     * **La referencia, no la clave.**
     *
     * `AI_API_KEY` sigue funcionando como antes y es el caso normal: se
     * traduce a la referencia `env:AI_API_KEY`, que es exactamente lo que es.
     * Lo que cambió es que la configuración ya no **es** el secreto: es dónde
     * está, y quien lo resuelve es el gestor de secretos, por llamada.
     *
     * `AI_API_KEY_REF` permite apuntar a otro lado —`kms:<arn>`— sin tocar
     * código, que es lo que hace que conectar un gestor externo no sea un
     * cambio de la aplicación.
     */
    apiKeyRef:
      process.env.AI_API_KEY_REF ??
      (process.env.AI_API_KEY !== undefined && process.env.AI_API_KEY !== ''
        ? 'env:AI_API_KEY'
        : null),

    /** El modelo. Es del proveedor, así que no hay valor por defecto sensato. */
    modelId: process.env.AI_MODEL_ID ?? null,
    baseUrl: process.env.AI_BASE_URL ?? null,

    /**
     * Timeout de cada intento, en milisegundos.
     *
     * Treinta segundos: un modelo tarda más que una API común, y menos que esto
     * corta respuestas legítimas. Toda llamada tiene timeout — no existe un
     * `fetch` sin límite en este camino.
     */
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30_000),

    /**
     * Reintentos **además** del primer intento. Solo para lo que puede salir
     * distinto la próxima vez: 429, 5xx y fallos de red.
     */
    maxRetries: Number(process.env.AI_MAX_RETRIES ?? 2),

    /**
     * Preguntas por minuto y por usuario sobre `POST /intelligence/preguntar`.
     *
     * Es un límite **técnico**, no comercial: ataja el bucle, no el gasto. El
     * gasto lo gobierna el cupo diario por empresa, que la empresa declara.
     */
    preguntasPorMinuto: Number(process.env.AI_PREGUNTAS_POR_MINUTO ?? 20),
  },

  correo: {
    /**
     * Quién manda el correo. Dos valores, y ninguno más:
     *
     *   `none`    sin proveedor. Es el valor por defecto y **es un modo de
     *             operación**: lo que se encola queda en `email_outbox` con
     *             estado `SIN_PROVEEDOR` y el operador lo lee con
     *             `npm run correo:bandeja`. El alta no se completa sola.
     *   `resend`  el adaptador HTTP contra Resend.
     *
     * Un valor desconocido **no cae a `none`**: el servidor no arranca. Es la
     * misma semántica estricta que `AI_PROVIDER` y `SECRETS_PROVIDER`, y por el
     * mismo motivo — un typo que degrada en silencio produce un sistema que
     * dice mandar correos y no manda ninguno, y nadie va a ir a buscar por qué
     * los usuarios no confirman su cuenta.
     */
    provider: process.env.EMAIL_PROVIDER ?? 'none',

    /**
     * La referencia al secreto, no el secreto: `env:EMAIL_API_KEY`, `kms:<arn>`.
     *
     * Igual que `AI_API_KEY_REF`. Poner solo `EMAIL_API_KEY` sigue andando: el
     * arranque deduce `env:EMAIL_API_KEY`. La forma con referencia existe para
     * que el día que haya un gestor de secretos lo único que cambie sea el
     * prefijo.
     */
    apiKeyRef:
      process.env.EMAIL_API_KEY_REF ??
      (process.env.EMAIL_API_KEY !== undefined && process.env.EMAIL_API_KEY !== ''
        ? 'env:EMAIL_API_KEY'
        : null),

    /**
     * De qué dirección salen los mensajes.
     *
     * **No tiene valor por defecto y no puede tenerlo.** Resend solo acepta un
     * remitente de un dominio verificado en la cuenta; inventar uno acá
     * produciría un 422 en cada envío, o —peor— un dominio de otro. Sin esto,
     * el estado es «preparado, no conectado» y el arranque nombra la variable.
     */
    from: process.env.EMAIL_FROM ?? null,

    /** Timeout por intento. No existe un envío sin límite. */
    timeoutMs: Number(process.env.EMAIL_TIMEOUT_MS ?? 10_000),

    /**
     * Reintentos **además** del primero, y solo para lo que puede salir
     * distinto la próxima vez sin arriesgar un duplicado. El detalle de qué se
     * reintenta y qué no está en `correo/resend.ts`.
     */
    maxRetries: Number(process.env.EMAIL_MAX_RETRIES ?? 2),
  },

  pagos: {
    /**
     * Quién cobra. Dos valores, y ninguno más:
     *
     *   `none`          sin pasarela. Es el valor por defecto y **es un modo de
     *                   operación**: el ciclo emite los documentos, lleva la
     *                   cobranza y registra los cobros por transferencia a
     *                   mano. `intentarCobro` contesta `SIN_PASARELA`.
     *   `mercadopago`   el adaptador contra la API de suscripciones.
     *
     * Un valor desconocido **no cae a `none`**: el servidor no arranca. Mismo
     * criterio que `EMAIL_PROVIDER`, y acá la consecuencia de degradar en
     * silencio es más cara: un sistema que cree tener pasarela deja de facturar
     * sin que nadie reciba un error.
     */
    provider: process.env.PAYMENTS_PROVIDER ?? 'none',

    /**
     * Contra qué cuenta se cobra. **La variable más peligrosa del archivo.**
     *
     *   `sandbox`     credenciales de prueba (`TEST-…`). No mueve plata.
     *   `production`  credenciales reales (`APP_USR-…`). Mueve plata de verdad.
     *
     * A diferencia de ARCA, Mercado Pago **no tiene dos URLs**: producción y
     * prueba comparten `api.mercadopago.com` y se distinguen únicamente por el
     * prefijo del access token. Eso significa que no hay ninguna barrera de red
     * entre probar y cobrar: un token real pegado en la variable equivocada
     * cobra.
     *
     * Por eso el ambiente se declara **explícitamente** y el arranque compara lo
     * declarado contra el prefijo del token que encuentra. Declarar `sandbox` y
     * traer un token `APP_USR-` impide arrancar. Ver `verificarAmbienteDePagos`.
     */
    ambiente: process.env.PAYMENTS_ENV ?? 'sandbox',

    /**
     * La referencia al secreto, no el secreto: `env:PAYMENTS_ACCESS_TOKEN`,
     * `kms:<arn>`. Igual que `EMAIL_API_KEY_REF` y `AI_API_KEY_REF`.
     */
    accessTokenRef:
      process.env.PAYMENTS_ACCESS_TOKEN_REF ??
      (process.env.PAYMENTS_ACCESS_TOKEN !== undefined && process.env.PAYMENTS_ACCESS_TOKEN !== ''
        ? 'env:PAYMENTS_ACCESS_TOKEN'
        : null),

    /**
     * El secreto con el que Mercado Pago firma las notificaciones.
     *
     * Es **distinto** del access token y se da de alta aparte, en el panel de
     * la aplicación. Puede faltar teniendo token: es una instalación a medio
     * configurar, no un error, y en ese estado el webhook no se puede verificar
     * — así que se rechaza en vez de creerle. Ver `rutas.ts`.
     */
    webhookSecretRef:
      process.env.PAYMENTS_WEBHOOK_SECRET_REF ??
      (process.env.PAYMENTS_WEBHOOK_SECRET !== undefined &&
      process.env.PAYMENTS_WEBHOOK_SECRET !== ''
        ? 'env:PAYMENTS_WEBHOOK_SECRET'
        : null),

    /**
     * A dónde vuelve el navegador después de que el cliente autoriza el medio
     * de pago.
     *
     * Sin esto no se puede crear una suscripción: el cliente quedaría en el
     * sitio de Mercado Pago sin forma de volver, y NEXO sin saber que autorizó
     * hasta el primer webhook.
     */
    backUrl: process.env.PAYMENTS_BACK_URL ?? null,

    /** Timeout por intento. No existe una llamada de cobro sin límite. */
    timeoutMs: Number(process.env.PAYMENTS_TIMEOUT_MS ?? 10_000),

    /**
     * Reintentos **además** del primero.
     *
     * Se aplican distinto según la llamada sea una lectura o una escritura: el
     * detalle está en `pagos/mercadopago.ts` y el criterio, ejercitable, en
     * `@aai/billing-engine/pasarela`. Reintentar mal una escritura cobra dos
     * veces, así que el valor por defecto es deliberadamente bajo.
     */
    maxRetries: Number(process.env.PAYMENTS_MAX_RETRIES ?? 2),
  },

  secrets: {
    /**
     * De dónde salen los secretos de las integraciones.
     *
     *   `none`  sin gestor. **Es un modo de operación**: el ERP funciona entero
     *           y las integraciones que necesitan credencial lo dicen.
     *   `env`   del entorno para los del despliegue, y de la referencia
     *           declarada para los de una empresa. El modo normal hoy.
     *   `kms`   un gestor externo. **Todavía no hay ninguno conectado**, y
     *           pedirlo hace fallar el arranque en vez de degradar a `env`.
     *
     * Un valor desconocido tampoco arranca, por lo mismo que `AI_PROVIDER`: un
     * sistema que dice tener un gestor de secretos y no lo tiene es peor que
     * uno que dice que no.
     */
    provider: process.env.SECRETS_PROVIDER ?? 'env',
  },

  /** Registrar la IP en la bitácora queda sujeto a evaluación legal (§21). */
  recordIpInAudit: process.env.AUDIT_RECORD_IP === 'true',

  /**
   * Token del recolector de métricas.
   *
   * Sin él, `GET /metrics` **no existe**: contesta 404 como cualquier ruta
   * inexistente. No se inventa un token por defecto ni se deja abierto «porque
   * son solo contadores»: los contadores dicen cuántas empresas operan, a qué
   * hora y con qué volumen, y eso es información del negocio de alguien.
   *
   * Se compara en tiempo constante, como cualquier secreto.
   */
  metricsToken: process.env.METRICS_TOKEN ?? null,

  issuer: process.env.MFA_ISSUER ?? 'NEXO',
} as const;

if (config.mfaEncryptionKey.length !== 32) {
  throw new Error('MFA_ENCRYPTION_KEY debe ser de 32 bytes codificados en base64');
}
