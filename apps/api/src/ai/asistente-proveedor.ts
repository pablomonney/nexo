/**
 * De dónde sale el proveedor del asistente conversacional. Un solo lugar.
 *
 * Mismo criterio que `proveedor.ts` para los agentes de salida estructurada, con los estados que le corresponden a un chat:
 *
 *     DESHABILITADO   `none`. No hay asistente, y es un modo de operación.
 *     PREPARADO       `anthropic` sin credencial. El transporte está; la conexión no. **No es un error**, y el
 *                     arranque lo dice con esas palabras.
 *     CONFIGURADO     `anthropic` con credencial. Puede llamar.
 *
 * Ni siquiera `CONFIGURADO` dice «conectado»: que haya credencial no prueba que sirva. Lo único que lo prueba es una
 * llamada que volvió, y eso lo dicen `assistant_messages` y `ai_answers`, no una variable de entorno.
 *
 * Un valor que no es ninguno de los dos **no existe como estado**: el servidor no arranca.
 */

import type { ProveedorDeChat } from '@aai/ai-engine';
import { EnvSecretProvider, type SecretProvider } from '@aai/secrets';
import { config } from '../config.js';
import { ProveedorDeChatClaude } from './chat-claude.js';
import { refDeLaClave } from './proveedor.js';

export type EstadoDelAsistente = 'DESHABILITADO' | 'PREPARADO' | 'CONFIGURADO';

export const PROVEEDORES_DEL_ASISTENTE = ['none', 'anthropic'] as const;

export interface ConfiguracionDelAsistente {
  readonly provider: string;
  /** La referencia al secreto, no el secreto: `env:ASSISTANT_API_KEY`, `kms:<arn>`. */
  readonly apiKeyRef: string | null;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly esfuerzo: string;
  readonly maxTokens: number;
  readonly mensajesPorMinuto: number;
}

/** Qué le falta a `anthropic` para poder llamar. */
export function faltantesDelAsistente(c: ConfiguracionDelAsistente): string[] {
  return c.apiKeyRef === null || c.apiKeyRef === '' ? ['ASSISTANT_API_KEY'] : [];
}

export function estadoDelAsistente(c: ConfiguracionDelAsistente): EstadoDelAsistente {
  if (c.provider === 'none') return 'DESHABILITADO';
  return faltantesDelAsistente(c).length === 0 ? 'CONFIGURADO' : 'PREPARADO';
}

/** Se corre antes de escuchar. Un valor desconocido no degrada en silencio. */
export function verificarProveedorDelAsistente(c: ConfiguracionDelAsistente): string | null {
  if (!(PROVEEDORES_DEL_ASISTENTE as readonly string[]).includes(c.provider)) {
    return (
      `ASSISTANT_PROVIDER="${c.provider}" no es un proveedor conocido. ` +
      `Los valores admitidos son: ${PROVEEDORES_DEL_ASISTENTE.join(', ')}.`
    );
  }
  if (!['low', 'medium', 'high'].includes(c.esfuerzo)) {
    return `ASSISTANT_EFFORT="${c.esfuerzo}" no es válido. Los valores admitidos son: low, medium, high.`;
  }
  return null;
}

/**
 * El proveedor que corresponde a la configuración, o `null` si no hay con qué llamar (`none` o credencial faltante).
 *
 * `null` no es una degradación silenciosa: la ruta de estado dice `DESHABILITADO` o `PREPARADO` con su motivo.
 */
export function crearProveedorDeChat(
  c: ConfiguracionDelAsistente = config.asistente,
  secretos: SecretProvider = new EnvSecretProvider(),
): ProveedorDeChat | null {
  const error = verificarProveedorDelAsistente(c);
  if (error !== null) throw new Error(error);
  if (estadoDelAsistente(c) !== 'CONFIGURADO') return null;

  return new ProveedorDeChatClaude({
    // La credencial se resuelve **por llamada**: este objeto vive tanto como el proceso; el secreto, lo que dura la llamada.
    apiKey: async () => (await secretos.get(refDeLaClave(c.apiKeyRef!))).valor,
    modelo: c.modelId,
    timeoutMs: c.timeoutMs,
    maxReintentos: c.maxRetries,
    esfuerzo: c.esfuerzo as 'low' | 'medium' | 'high',
  });
}
