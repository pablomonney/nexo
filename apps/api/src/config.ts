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
  },

  ai: {
    /**
     * Proveedor de modelo: `none` (por defecto) o `mock`.
     *
     * `none` no es "sin funcionalidad": el sistema sigue sugiriendo con la
     * historia de la empresa, sin mandar un solo documento afuera. Es un modo de
     * operación previsto (§8), no un estado degradado.
     */
    provider: process.env.AI_PROVIDER ?? 'none',
  },

  /** Registrar la IP en la bitácora queda sujeto a evaluación legal (§21). */
  recordIpInAudit: process.env.AUDIT_RECORD_IP === 'true',

  issuer: process.env.MFA_ISSUER ?? 'Contabilidad AI',
} as const;

if (config.mfaEncryptionKey.length !== 32) {
  throw new Error('MFA_ENCRYPTION_KEY debe ser de 32 bytes codificados en base64');
}
