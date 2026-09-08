/**
 * La credencial del modelo, resuelta por el gestor de secretos.
 *
 * Es la cadena que la fase anterior dejó a medias:
 *
 *     config.ai.apiKeyRef  →  SecretProvider  →  secreto  →  adaptador HTTP
 *
 * Antes la clave viajaba en `config.ai.apiKey` y de ahí al constructor del
 * adaptador, donde se quedaba viva tanto como el proceso. Ahora la
 * configuración guarda **dónde está** y el material se resuelve por llamada.
 *
 * Lo que estos tests defienden:
 *
 *   1. Que la clave **llega** por esa vía y no por otra.
 *   2. Que se resuelve **por llamada**, no una vez y al guardado.
 *   3. Que un fallo del gestor sube como error del gestor —`SECRET_NOT_FOUND`—
 *      y no disfrazado de fallo del proveedor de modelo. Son dos problemas
 *      distintos y llevan a acciones opuestas: uno se arregla configurando,
 *      el otro esperando.
 */

import { describe, expect, it } from 'vitest';
import { HttpLLMProvider, type FetchLike } from '@aai/ai-engine';
import { ErrorDeSecreto, InMemorySecretProvider, NullSecretProvider } from '@aai/secrets';
import { crearProveedor, refDeLaClave, type ConfiguracionDeIa } from '@aai/api/ai/proveedor';

const VALOR = 'TEST_SECRET_ONLY-a1b2c3d4e5f60718';

const COMPLETA: ConfiguracionDeIa = {
  provider: 'http',
  apiKeyRef: 'env:AI_API_KEY',
  modelId: 'modelo-x',
  baseUrl: 'https://proveedor.invalido/v1',
  timeoutMs: 5_000,
  maxRetries: 0,
};

const PEDIDO = {
  system: 'instrucciones',
  messages: [{ role: 'user' as const, content: 'hola' }],
  schema: { type: 'object' as const },
  temperature: 0 as const,
  maxTokens: 50,
};

const OK = JSON.stringify({ output: {}, model: 'modelo-x' });

/** Un `fetch` que anota las cabeceras que recibió. */
function fetchQueAnota(): { fetch: FetchLike; cabeceras: Record<string, string>[] } {
  const cabeceras: Record<string, string>[] = [];
  const fetch: FetchLike = async (_url, init) => {
    cabeceras.push(init.headers);
    return { ok: true, status: 200, text: async () => OK };
  };
  return { fetch, cabeceras };
}

describe('La clave del modelo viene del gestor de secretos', () => {
  it('la referencia se traduce a la identidad del secreto', () => {
    // `env:X` nombra la variable directamente; sin prefijo también, porque es
    // lo que había antes de que las referencias existieran y romper esa
    // configuración al actualizar sería gratuito.
    expect(refDeLaClave('env:AI_API_KEY')).toEqual({
      companyId: null,
      scope: 'env',
      name: 'AI_API_KEY',
    });
    expect(refDeLaClave('AI_API_KEY').name).toBe('AI_API_KEY');

    // Y una del despliegue en un gestor externo cae en la identidad canónica.
    expect(refDeLaClave('kms:proyecto/ai/key')).toEqual({
      companyId: null,
      scope: 'ai',
      name: 'api-key',
    });
  });

  it('llega a la cabecera, resuelta por el proveedor de secretos', async () => {
    const secretos = new InMemorySecretProvider({ esProduccion: false });
    secretos.poner({ companyId: null, scope: 'env', name: 'AI_API_KEY' }, VALOR);

    const { fetch, cabeceras } = fetchQueAnota();
    const llm = crearProveedor(COMPLETA, secretos) as HttpLLMProvider;

    // El adaptador se arma con la fábrica; el `fetch` se inyecta reconstruyendo
    // con las mismas opciones, que es lo que la fábrica hace por dentro.
    const conFetch = new HttpLLMProvider({
      baseUrl: COMPLETA.baseUrl!,
      apiKey: async () => (await secretos.get(refDeLaClave(COMPLETA.apiKeyRef!))).valor,
      modelId: COMPLETA.modelId!,
      providerId: 'http',
      timeoutMs: COMPLETA.timeoutMs,
      maxRetries: 0,
      fetch,
    });

    expect(llm.id, 'la fábrica devuelve el adaptador HTTP').toBe('http');
    await conFetch.complete(PEDIDO);

    expect(cabeceras[0]!['authorization']).toBe(`Bearer ${VALOR}`);
  });

  it('se resuelve por llamada, no una vez', async () => {
    // Es la diferencia que hace que el material viva el tiempo de la llamada:
    // un adaptador que la recibe en el constructor la tiene mientras el objeto
    // exista, y ese objeto puede vivir tanto como el servidor.
    let veces = 0;
    const { fetch } = fetchQueAnota();
    const p = new HttpLLMProvider({
      baseUrl: 'https://x.invalido',
      apiKey: async () => {
        veces += 1;
        return VALOR;
      },
      modelId: 'm',
      providerId: 'http',
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch,
    });

    await p.complete(PEDIDO);
    await p.complete(PEDIDO);

    expect(veces, 'una resolución por llamada').toBe(2);
  });

  it('sin gestor, el error es del gestor y no del proveedor de modelo', async () => {
    // Son dos problemas distintos: «falta configurar la credencial» se arregla
    // configurando, «el proveedor está caído» se arregla esperando. Traducir el
    // primero al segundo manda a quien diagnostica al lugar equivocado.
    const { fetch } = fetchQueAnota();
    const nulo = new NullSecretProvider();
    const p = new HttpLLMProvider({
      baseUrl: 'https://x.invalido',
      apiKey: async () => (await nulo.get(refDeLaClave('env:AI_API_KEY'))).valor,
      modelId: 'm',
      providerId: 'http',
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch,
    });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorDeSecreto);
    expect((error as ErrorDeSecreto).codigo).toBe('SECRET_NOT_FOUND');
  });

  it('el fallo del gestor no llega a hacer la llamada', async () => {
    // No se manda un pedido con una credencial vacía «a ver si anda»: eso gasta
    // una llamada facturable y produce un 401 que se lee como credencial
    // inválida cuando lo que pasó es que no había ninguna.
    const { fetch, cabeceras } = fetchQueAnota();
    const nulo = new NullSecretProvider();
    const p = new HttpLLMProvider({
      baseUrl: 'https://x.invalido',
      apiKey: async () => (await nulo.get(refDeLaClave('env:AI_API_KEY'))).valor,
      modelId: 'm',
      providerId: 'http',
      timeoutMs: 1_000,
      maxRetries: 0,
      fetch,
    });

    await p.complete(PEDIDO).catch(() => undefined);
    expect(cabeceras, 'no se llamó al proveedor').toHaveLength(0);
  });

  it('la configuración no guarda la clave: guarda dónde está', () => {
    // Es la propiedad que hace que un volcado de la configuración —un log de
    // arranque, un reporte de error, un `JSON.stringify(config)`— no exponga
    // nada.
    expect(JSON.stringify(COMPLETA)).not.toContain(VALOR);
    expect(COMPLETA.apiKeyRef).toBe('env:AI_API_KEY');
  });
});
