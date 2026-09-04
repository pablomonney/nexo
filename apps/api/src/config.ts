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
    apiKey: process.env.AI_API_KEY ?? null,

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

  issuer: process.env.MFA_ISSUER ?? 'Contabilidad AI',
} as const;

if (config.mfaEncryptionKey.length !== 32) {
  throw new Error('MFA_ENCRYPTION_KEY debe ser de 32 bytes codificados en base64');
}
