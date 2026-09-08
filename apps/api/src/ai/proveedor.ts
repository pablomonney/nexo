/**
 * De dónde sale el proveedor de modelo. Un solo lugar.
 *
 * Antes había dos: `predictions.ts` e `intelligence.ts` tenían cada uno su
 * función `proveedor()` con el mismo `if` de dos ramas. Dos copias de una
 * decisión se desincronizan, y el día que se desincronicen una parte del
 * sistema va a estar hablando con un modelo y la otra no, sin que nadie lo
 * note: las dos siguen contestando.
 *
 * ## Los estados, y por qué son cuatro y no dos
 *
 * El bug que este archivo cierra era de nombres. `AI_PROVIDER=openai` hacía que
 * el arranque informara **IA: openai, real** mientras `proveedor()` devolvía el
 * proveedor deshabilitado: el sistema decía tener una capacidad que no tenía.
 *
 *     DESHABILITADO   `none`. No hay IA externa, y es un modo de operación.
 *     SIMULADO        `mock`. Se abstiene siempre; no es un modelo.
 *     PREPARADO       `http` sin credencial, sin modelo o sin URL.
 *                     El transporte está; la conexión no. **No es un error.**
 *     CONFIGURADO     `http` con las tres cosas. Puede llamar.
 *
 * Nótese que ni siquiera `CONFIGURADO` dice «conectado»: que haya credencial no
 * prueba que sirva. Lo único que prueba una conexión es una llamada que volvió,
 * y eso lo dice `ai_predictions`, no una variable de entorno.
 *
 * Un valor que no es ninguno de los tres **no existe como estado**: el arranque
 * falla. Ver `verificarProveedor`.
 */

import {
  HttpLLMProvider,
  MockLLMProvider,
  NullLLMProvider,
  type LLMProvider,
} from '@aai/ai-engine';
import { EnvSecretProvider, type SecretProvider, type SecretRef } from '@aai/secrets';
import { config } from '../config.js';

export type EstadoDelProveedor = 'DESHABILITADO' | 'SIMULADO' | 'PREPARADO' | 'CONFIGURADO';

/** Los tres valores que `AI_PROVIDER` admite. */
export const PROVEEDORES_CONOCIDOS = ['none', 'mock', 'http'] as const;

export interface ConfiguracionDeIa {
  readonly provider: string;
  /** La referencia al secreto, no el secreto: `env:AI_API_KEY`, `kms:<arn>`. */
  readonly apiKeyRef: string | null;
  readonly modelId: string | null;
  readonly baseUrl: string | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/**
 * Qué le falta a `http` para poder llamar.
 *
 * Se devuelve la lista y no un booleano porque «preparado» sin decir qué falta
 * obliga a adivinar entre tres variables.
 */
export function faltantesDeHttp(ia: ConfiguracionDeIa): string[] {
  const faltan: string[] = [];
  if (ia.apiKeyRef === null || ia.apiKeyRef === '') faltan.push('AI_API_KEY');
  if (ia.modelId === null || ia.modelId === '') faltan.push('AI_MODEL_ID');
  if (ia.baseUrl === null || ia.baseUrl === '') faltan.push('AI_BASE_URL');
  return faltan;
}

export function estadoDelProveedor(ia: ConfiguracionDeIa): EstadoDelProveedor {
  if (ia.provider === 'none') return 'DESHABILITADO';
  if (ia.provider === 'mock') return 'SIMULADO';
  return faltantesDeHttp(ia).length === 0 ? 'CONFIGURADO' : 'PREPARADO';
}

/**
 * Se corre antes de escuchar. Un `AI_PROVIDER` desconocido **carga el sistema
 * sin IA y sin avisar**, que es la forma más cara de equivocarse: no falla
 * nada, y las sugerencias simplemente no aparecen nunca.
 */
export function verificarProveedor(ia: ConfiguracionDeIa): string | null {
  if ((PROVEEDORES_CONOCIDOS as readonly string[]).includes(ia.provider)) return null;
  return (
    `AI_PROVIDER="${ia.provider}" no es un proveedor conocido. ` +
    `Los valores admitidos son: ${PROVEEDORES_CONOCIDOS.join(', ')}.`
  );
}

/**
 * El proveedor que corresponde a la configuración.
 *
 * `PREPARADO` devuelve el deshabilitado, y eso **no es una degradación
 * silenciosa**: el arranque ya dijo qué falta, y la respuesta de la API dice
 * `SIN_PROVEEDOR` con su motivo. La diferencia con el bug anterior es que nadie
 * afirma que hay un modelo.
 */
export function crearProveedor(
  ia: ConfiguracionDeIa = config.ai,
  secretos: SecretProvider = new EnvSecretProvider(),
): LLMProvider {
  const error = verificarProveedor(ia);
  if (error !== null) throw new Error(error);

  switch (estadoDelProveedor(ia)) {
    case 'DESHABILITADO':
    case 'PREPARADO':
      return new NullLLMProvider();

    case 'SIMULADO':
      return proveedorSimulado();

    case 'CONFIGURADO':
      return new HttpLLMProvider({
        baseUrl: ia.baseUrl!,
        // La credencial se resuelve **por llamada**, no acá. Este objeto puede
        // vivir tanto como el proceso; el secreto vive el tiempo de la llamada.
        //
        // El proveedor de modelo es del despliegue, no de una empresa: la
        // referencia no lleva `companyId`. El día que una empresa traiga su
        // propia clave, lo único que cambia es de dónde sale la referencia.
        apiKey: async () => (await secretos.get(refDeLaClave(ia.apiKeyRef!))).valor,
        modelId: ia.modelId!,
        providerId: 'http',
        timeoutMs: ia.timeoutMs,
        maxRetries: ia.maxRetries,
      });
  }
}

/**
 * De la referencia configurada a la identidad del secreto.
 *
 * `env:AI_API_KEY` es la forma normal y la que sale de `AI_API_KEY`. El nombre
 * de la variable viaja en el `name` porque es lo que el `EnvSecretProvider`
 * necesita para encontrarla.
 *
 * Una referencia con otro prefijo —`kms:`— también se acepta acá: quien la
 * resuelva es el gestor que corresponda, y este archivo no tiene por qué saber
 * cuál. Es todo el punto de la abstracción.
 */
export function refDeLaClave(referencia: string): SecretRef {
  const corte = referencia.indexOf(':');
  if (corte === -1) {
    // Sin prefijo se asume el entorno: es lo que había antes de que las
    // referencias existieran, y romper esa configuración al actualizar sería
    // gratuito.
    return { companyId: null, scope: 'env', name: referencia };
  }
  const prefijo = referencia.slice(0, corte);
  const resto = referencia.slice(corte + 1);
  return prefijo === 'env'
    ? { companyId: null, scope: 'env', name: resto }
    : { companyId: null, scope: 'ai', name: 'api-key' };
}

/**
 * El simulado **se abstiene siempre**, y esa es toda su gracia.
 *
 * Un mock que redactara un párrafo o eligiera una cuenta produciría algo
 * indistinguible de una respuesta real, y alguien la aprobaría. Igual que con
 * ARCA y con el OCR: el simulado se usa si y solo si está pedido explícitamente,
 * y contesta una abstención declarada.
 *
 * La misma instancia sirve a los dos agentes: cada uno lee del `output` los
 * campos de su schema, y los dos objetos tienen `abstencion: true`.
 */
function proveedorSimulado(): LLMProvider {
  return new MockLLMProvider({
    respuestas: [
      {
        output: {
          // Clasificación.
          cuentaCodigo: '__SIMULACION__',
          tratamiento: 'NO_DETERMINADO',
          confianza: 0.1,
          razon: 'Respuesta de simulación: no proviene de ningún modelo y no tiene valor.',
          citas: [],
          // Respuesta narrada.
          texto: '',
          datosUsados: [],
          normasCitadas: [],
          abstencion: true,
        },
      },
    ],
    alAgotarse: 'REPETIR',
  });
}
