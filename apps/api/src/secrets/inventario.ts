/**
 * Qué es secreto en NEXO, cuánto pesa, y qué pasa si falta.
 *
 * ## Por qué esto es código y no una tabla en un documento
 *
 * Porque una tabla en un documento no se puede comprobar. La auditoría B-2 ya
 * encontró que `.env.example` y el código habían dejado de coincidir en los dos
 * sentidos —prometía un Redis y un S3 que nadie usaba, y callaba las tres
 * variables que deciden si el servidor arranca— y eso pasó justamente porque la
 * única lista vivía en prosa.
 *
 * Acá la lista es una constante, y `tests/security/politica-de-secretos.test.ts`
 * comprueba contra el código que:
 *
 *   · toda variable que la aplicación lee está clasificada;
 *   · lo que se declara crítico e imprescindible **de verdad impide arrancar**;
 *   · lo que se declara opcional **de verdad deja arrancar**.
 *
 * Sin la tercera, «opcional» sería una opinión. Con ella, agregar una
 * integración obliga a decidir de qué lado está antes de que exista.
 *
 * ## Las tres sensibilidades, y qué las separa
 *
 *     CRITICO       Filtrarla compromete datos, accesos o dinero. Va al gestor
 *                   de secretos el día que haya uno.
 *     SENSIBLE      Conviene que sea privada; filtrarla no abre la puerta a
 *                   nada por sí sola.
 *     CONFIGURACION No es secreto. Puede estar a la vista.
 *
 * `DATABASE_URL` es el caso que obliga a mirar con cuidado: la cadena lleva la
 * contraseña adentro, así que es CRÍTICA aunque el resto de la cadena no lo sea.
 */

export type Sensibilidad = 'CRITICO' | 'SENSIBLE' | 'CONFIGURACION';

/** Dónde debería vivir el valor cuando exista un gestor de secretos. */
export type Destino =
  /** Al gestor. Es material que no puede estar en un archivo del despliegue. */
  | 'GESTOR'
  /** Al entorno del despliegue. No es material, o no lo justifica. */
  | 'ENTORNO';

export interface SecretoDeclarado {
  readonly variable: string;
  readonly uso: string;
  readonly sensibilidad: Sensibilidad;
  /**
   * ¿Sin esto el servidor **no arranca** en producción?
   *
   * Es una afirmación sobre el comportamiento, no una intención: el control la
   * verifica. Declararla en `true` sobre algo que sí arranca hace fallar la
   * suite, y al revés también.
   */
  readonly impideArrancar: boolean;
  /** Qué integración lo necesita. `null` es del núcleo del sistema. */
  readonly integracion: string | null;
  readonly destino: Destino;
}

/**
 * Todo lo que la aplicación lee del entorno.
 *
 * **Solo el servidor.** Las variables de los scripts de operación —`PG_BIN`,
 * `NEXO_BACKUP_DIR`, `ARCA_TA_CACHE`— no están: no las lee el proceso que
 * atiende pedidos, las lee quien corre un comando a mano en su máquina. El
 * control mira `apps/` y `packages/` por el mismo motivo.
 */
export const INVENTARIO_DE_SECRETOS: readonly SecretoDeclarado[] = [
  // ── Núcleo: sin esto no hay sistema ──────────────────────────────────────
  {
    variable: 'DATABASE_URL',
    uso: 'La conexión a PostgreSQL. **Lleva la contraseña adentro de la cadena.**',
    sensibilidad: 'CRITICO',
    impideArrancar: true,
    integracion: null,
    destino: 'GESTOR',
  },
  {
    variable: 'MFA_ENCRYPTION_KEY',
    uso: 'Cifra el secreto TOTP en reposo. 32 bytes en base64.',
    sensibilidad: 'CRITICO',
    // Comprobado: sin ella, y con largo distinto de 32 bytes, `config.ts` tira
    // al importarse. Es lo primero que se evalúa, así que el proceso no llega
    // a escuchar.
    impideArrancar: true,
    integracion: null,
    destino: 'GESTOR',
  },

  // ── Núcleo: configuración, no secretos ───────────────────────────────────
  {
    variable: 'PORT',
    uso: 'Puerto donde escucha la API.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'NODE_ENV',
    uso: 'Endurece cookies, HSTS, el sobre de ARCA y la exigencia de la clave de MFA.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'TRUST_PROXY',
    uso: 'De dónde sale request.ip. Decide si el límite de intentos distingue clientes.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'BUILD_ID',
    uso: 'Qué versión está corriendo. Aparece en GET /health.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'SESSION_IDLE_MINUTES',
    uso: 'Expiración de sesión por inactividad.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'SESSION_ABSOLUTE_HOURS',
    uso: 'Expiración absoluta de la sesión.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'LOGIN_MAX_FAILED',
    uso: 'Intentos fallidos antes de bloquear una cuenta.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'LOGIN_LOCK_MINUTES',
    uso: 'Cuánto dura el bloqueo de una cuenta.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'LOGIN_RATE_PER_MINUTE',
    uso: 'Fallos por minuto y por origen sobre las rutas de autenticación.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'AUDIT_RECORD_IP',
    uso: 'Si la bitácora guarda la IP. Tiene consecuencias legales (§21).',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'MFA_ISSUER',
    uso: 'El nombre que muestra la aplicación de códigos.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'DOCUMENT_STORAGE_PATH',
    uso: 'Raíz del almacén de documentos. En producción, un volumen.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },
  {
    variable: 'DOCUMENT_MAX_BYTES',
    uso: 'Tope de tamaño de un documento subido.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: null,
    destino: 'ENTORNO',
  },

  // ── Observabilidad ───────────────────────────────────────────────────────
  {
    variable: 'METRICS_TOKEN',
    uso: 'Abre GET /metrics. Sin él la ruta contesta 404 y no existe.',
    // Los contadores dicen cuántas empresas operan, a qué hora y con qué
    // volumen: es información del negocio de alguien, no «solo números».
    sensibilidad: 'CRITICO',
    impideArrancar: false,
    integracion: 'métricas',
    destino: 'GESTOR',
  },

  // ── Gestor de secretos ───────────────────────────────────────────────────
  {
    variable: 'SECRETS_PROVIDER',
    uso: 'Qué gestor resuelve las referencias: none, env o kms.',
    sensibilidad: 'CONFIGURACION',
    // Un valor desconocido sí impide arrancar, pero eso es una validación de
    // vocabulario y no un secreto faltante: con la variable ausente se usa
    // `env` y el servidor levanta.
    impideArrancar: false,
    integracion: 'secretos',
    destino: 'ENTORNO',
  },

  // ── ARCA ─────────────────────────────────────────────────────────────────
  {
    variable: 'ARCA_ENVIRONMENT',
    uso: 'mock, homologacion o produccion.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'ARCA',
    destino: 'ENTORNO',
  },
  {
    variable: 'ARCA_TIMEOUT_MS',
    uso: 'Timeout de las llamadas al organismo.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'ARCA',
    destino: 'ENTORNO',
  },
  {
    variable: 'ARCA_LOCAL_KEK',
    uso: 'Envuelve las claves privadas de ARCA en desarrollo. 32 bytes en base64.',
    sensibilidad: 'CRITICO',
    // No impide arrancar porque en producción **no se usa en ningún caso**:
    // `desenvolver()` se niega a abrir un sobre `local:` con NODE_ENV=production
    // y `envolver()` se niega a crearlo. El bloqueo está en el uso, no en el
    // arranque, y ahí es donde tiene que estar.
    impideArrancar: false,
    integracion: 'ARCA',
    destino: 'GESTOR',
  },

  // ── Proveedor de modelo ──────────────────────────────────────────────────
  {
    variable: 'AI_PROVIDER',
    uso: 'none, mock o http. Un valor desconocido impide arrancar.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },
  {
    variable: 'AI_API_KEY',
    uso: 'La credencial del proveedor de modelo.',
    sensibilidad: 'CRITICO',
    // Sin ella el estado es «preparado, no conectado»: el sistema arranca y las
    // sugerencias salen de la historia de la empresa. Es un modo de operación.
    impideArrancar: false,
    integracion: 'IA',
    destino: 'GESTOR',
  },
  {
    variable: 'AI_API_KEY_REF',
    uso: 'Dónde está la credencial: env:AI_API_KEY o kms:<arn>.',
    // La referencia no es el valor. Todo el diseño de `secret_refs` se apoya en
    // esta distinción: la tabla no tiene columna donde poner material.
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },
  {
    variable: 'AI_MODEL_ID',
    uso: 'Qué modelo se pide.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },
  {
    variable: 'AI_BASE_URL',
    uso: 'El extremo del proveedor de modelo.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },
  {
    variable: 'AI_TIMEOUT_MS',
    uso: 'Timeout por intento contra el modelo.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },
  {
    variable: 'AI_MAX_RETRIES',
    uso: 'Reintentos además del primero.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },
  {
    variable: 'AI_PREGUNTAS_POR_MINUTO',
    uso: 'Tope técnico por usuario contra el bucle.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'IA',
    destino: 'ENTORNO',
  },

  // ── Correo ───────────────────────────────────────────────────────────────
  {
    variable: 'EMAIL_PROVIDER',
    uso: 'none o resend. Un valor desconocido impide arrancar.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'correo',
    destino: 'ENTORNO',
  },
  {
    variable: 'EMAIL_API_KEY',
    uso: 'La credencial de Resend.',
    sensibilidad: 'CRITICO',
    // Sin ella el estado es «preparado, no conectado» y el alta sigue
    // funcionando contra la bandeja de salida.
    impideArrancar: false,
    integracion: 'correo',
    destino: 'GESTOR',
  },
  {
    variable: 'EMAIL_API_KEY_REF',
    uso: 'Dónde está la credencial de correo.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'correo',
    destino: 'ENTORNO',
  },
  {
    variable: 'EMAIL_FROM',
    uso: 'Remitente. Tiene que ser de un dominio verificado en la cuenta.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'correo',
    destino: 'ENTORNO',
  },
  {
    variable: 'EMAIL_TIMEOUT_MS',
    uso: 'Timeout por intento de envío.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'correo',
    destino: 'ENTORNO',
  },
  {
    variable: 'EMAIL_MAX_RETRIES',
    uso: 'Reintentos además del primero. Un timeout NO se reintenta.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'correo',
    destino: 'ENTORNO',
  },

  // ── OCR ──────────────────────────────────────────────────────────────────
  {
    variable: 'OCR_ENGINE',
    uso: 'none o mock. No hay motor real conectado.',
    sensibilidad: 'CONFIGURACION',
    impideArrancar: false,
    integracion: 'OCR',
    destino: 'ENTORNO',
  },

] as const;

/**
 * Lo que llevan credenciales y **no** lo lee el servidor.
 *
 * Está acá y no en el inventario porque el inventario clasifica lo que decide
 * cómo corre el proceso que atiende pedidos, y estas las lee un comando que
 * alguien ejecuta a mano. Mezclarlas haría que el control de arranque intentara
 * comprobar si el servidor levanta sin una variable que el servidor no mira.
 *
 * No por eso son inocuas: `SANDBOX_DATABASE_URL` lleva una contraseña adentro
 * de la cadena, igual que `DATABASE_URL`, y va al gestor de secretos el día que
 * haya uno.
 */
export const DE_LOS_COMANDOS: readonly SecretoDeclarado[] = [
  {
    variable: 'SANDBOX_DATABASE_URL',
    uso: 'La base del sandbox de simulación (`npm run sandbox:*`). **Lleva la contraseña adentro.**',
    sensibilidad: 'CRITICO',
    impideArrancar: false,
    integracion: 'sandbox',
    destino: 'GESTOR',
  },
] as const;

/** Lo que tiene que estar en producción o el servidor no levanta. */
export const IMPRESCINDIBLES: readonly string[] = INVENTARIO_DE_SECRETOS.filter(
  (s) => s.impideArrancar,
).map((s) => s.variable);

/** Lo que va a un gestor de secretos el día que se conecte uno. */
export const AL_GESTOR: readonly string[] = INVENTARIO_DE_SECRETOS.filter(
  (s) => s.destino === 'GESTOR',
).map((s) => s.variable);
