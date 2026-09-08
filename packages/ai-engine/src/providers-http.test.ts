/**
 * El transporte hacia un proveedor de modelo.
 *
 * Todo lo de acá corre **sin red y sin credencial**: `fetch` se inyecta y la
 * espera entre reintentos también, así que los tests no duermen. Es la única
 * forma de ejercitar los caminos que importan —un 429, un timeout, un JSON
 * roto— sin una cuenta en ningún lado.
 *
 * Lo que estos tests defienden, en orden de importancia:
 *
 *   1. **Que la credencial no salga por ningún lado.** Ni en un mensaje de
 *      error, ni en una excepción, ni en el objeto que se propaga.
 *   2. **Que se reintente lo que puede salir distinto, y nada más.** Un 400 mal
 *      armado sale igual mil veces; un 429 reintentado sin freno empeora
 *      justamente el problema que se está tratando de resolver.
 *   3. **Que una respuesta que no tiene la forma acordada se rechace**, en vez
 *      de interpretarse con buena voluntad.
 */

import { describe, expect, it } from 'vitest';
import {
  DIALECTO_NEXO,
  ErrorDeProveedor,
  HttpLLMProvider,
  reintentable,
  type FetchLike,
} from './providers-http.js';

const CLAVE = 'clave-de-prueba-que-no-debe-aparecer-en-ningun-lado';

const PEDIDO = {
  system: 'instrucciones',
  messages: [{ role: 'user' as const, content: 'hola' }],
  schema: { type: 'object' as const },
  temperature: 0 as const,
  maxTokens: 100,
};

interface Llamada {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Un `fetch` que contesta lo que se le diga y anota lo que recibió. */
function fetchDe(
  respuestas: readonly (
    | { status: number; cuerpo: string }
    | { error: Error }
  )[],
): { fetch: FetchLike; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    llamadas.push({ url, headers: init.headers, body: init.body });
    const r = respuestas[Math.min(i, respuestas.length - 1)]!;
    i += 1;
    if ('error' in r) throw r.error;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.cuerpo,
    };
  };
  return { fetch, llamadas };
}

const OK = JSON.stringify({
  output: { cuentaCodigo: '5.1.03' },
  model: 'modelo-x',
  usage: { input_tokens: 120, output_tokens: 45 },
});

function proveedor(opciones: {
  fetch: FetchLike;
  maxRetries?: number;
  timeoutMs?: number;
}): { p: HttpLLMProvider; esperas: number[] } {
  const esperas: number[] = [];
  const p = new HttpLLMProvider({
    baseUrl: 'https://proveedor.invalido/v1/completions',
    apiKey: async () => CLAVE,
    modelId: 'modelo-x',
    providerId: 'http',
    timeoutMs: opciones.timeoutMs ?? 5_000,
    maxRetries: opciones.maxRetries ?? 2,
    fetch: opciones.fetch,
    esperar: async (ms) => {
      esperas.push(ms);
    },
  });
  return { p, esperas };
}

describe('HttpLLMProvider — el camino feliz', () => {
  it('manda el pedido con el modelo y la autorización, y lee la salida', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 200, cuerpo: OK }]);
    const { p } = proveedor({ fetch });

    const r = await p.complete(PEDIDO);

    expect(r.output).toEqual({ cuentaCodigo: '5.1.03' });
    expect(r.modelId).toBe('modelo-x');
    expect(llamadas).toHaveLength(1);

    const cuerpo = JSON.parse(llamadas[0]!.body);
    expect(cuerpo.model).toBe('modelo-x');
    // `temperature: 0` no es una preferencia: es lo que hace que la misma
    // pregunta con el mismo contexto dé la misma respuesta.
    expect(cuerpo.temperature).toBe(0);
    expect(cuerpo.schema).toEqual({ type: 'object' });
  });

  it('trae el uso en unidades propias, no en las del proveedor', async () => {
    const { fetch } = fetchDe([{ status: 200, cuerpo: OK }]);
    const { p } = proveedor({ fetch });

    const r = await p.complete(PEDIDO);

    expect(r.uso).toEqual({ tokensDeEntrada: 120, tokensDeSalida: 45, tokensTotales: 165 });
  });

  it('sin uso informado, el uso es null y no cero', async () => {
    // Cero tokens es una afirmación —«esta llamada no gastó»— y sería falsa.
    const sinUso = JSON.stringify({ output: {}, model: 'modelo-x' });
    const { fetch } = fetchDe([{ status: 200, cuerpo: sinUso }]);
    const { p } = proveedor({ fetch });

    expect((await p.complete(PEDIDO)).uso).toBeNull();
  });

  it('un uso a medias tampoco cuenta', async () => {
    // Con solo los tokens de entrada el costo saldría a la mitad y se vería
    // igual que uno completo.
    const aMedias = JSON.stringify({
      output: {},
      model: 'm',
      usage: { input_tokens: 10 },
    });
    const { fetch } = fetchDe([{ status: 200, cuerpo: aMedias }]);
    const { p } = proveedor({ fetch });

    expect((await p.complete(PEDIDO)).uso).toBeNull();
  });
});

describe('HttpLLMProvider — la credencial', () => {
  it('viaja en la cabecera, y en ningún otro lado del pedido', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 200, cuerpo: OK }]);
    const { p } = proveedor({ fetch });
    await p.complete(PEDIDO);

    expect(llamadas[0]!.headers['authorization']).toBe(`Bearer ${CLAVE}`);
    expect(llamadas[0]!.body).not.toContain(CLAVE);
    expect(llamadas[0]!.url).not.toContain(CLAVE);
  });

  it('no aparece en el error de una credencial rechazada', async () => {
    // Es el caso donde más fácil se filtra: el error habla de la credencial.
    const { fetch } = fetchDe([{ status: 401, cuerpo: 'no autorizado' }]);
    const { p } = proveedor({ fetch, maxRetries: 0 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);

    expect(error).toBeInstanceOf(ErrorDeProveedor);
    expect((error as ErrorDeProveedor).codigo).toBe('CREDENCIAL_RECHAZADA');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(CLAVE);
  });

  it('no aparece en el error de un fallo de red', async () => {
    // El mensaje de un error de red suele traer la URL completa, y hay
    // proveedores que aceptan la clave en la query.
    const conClave = new Error(`connect ECONNREFUSED https://x/?key=${CLAVE}`);
    const { fetch } = fetchDe([{ error: conClave }]);
    const { p } = proveedor({ fetch, maxRetries: 0 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);

    expect((error as ErrorDeProveedor).codigo).toBe('RED');
    expect((error as Error).message).not.toContain(CLAVE);
  });

  it('no aparece en el error de un pedido inválido, que trae el cuerpo del proveedor', async () => {
    const eco = `el pedido fue: {"authorization":"Bearer ${CLAVE}"}`;
    const { fetch } = fetchDe([{ status: 400, cuerpo: eco }]);
    const { p } = proveedor({ fetch, maxRetries: 0 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);

    expect((error as ErrorDeProveedor).codigo).toBe('PEDIDO_INVALIDO');
    // El cuerpo de la respuesta no se lee para armar el error, justamente por esto.
    expect((error as Error).message).not.toContain(CLAVE);
  });
});

describe('HttpLLMProvider — cada código HTTP a su estado', () => {
  const casos = [
    [400, 'PEDIDO_INVALIDO'],
    [401, 'CREDENCIAL_RECHAZADA'],
    [403, 'CREDENCIAL_RECHAZADA'],
    [404, 'PEDIDO_INVALIDO'],
    [422, 'PEDIDO_INVALIDO'],
    [429, 'LIMITE_DE_TASA'],
    [500, 'PROVEEDOR_CAIDO'],
    [502, 'PROVEEDOR_CAIDO'],
    [503, 'PROVEEDOR_CAIDO'],
    [504, 'PROVEEDOR_CAIDO'],
  ] as const;

  for (const [status, codigo] of casos) {
    it(`HTTP ${status} → ${codigo}`, async () => {
      const { fetch } = fetchDe([{ status, cuerpo: '' }]);
      const { p } = proveedor({ fetch, maxRetries: 0 });

      const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);
      expect((error as ErrorDeProveedor).codigo).toBe(codigo);
      expect((error as ErrorDeProveedor).status).toBe(status);
    });
  }

  it('un timeout se distingue de una caída', async () => {
    // Son dos hechos distintos: uno es «tardó de más», el otro «contestó mal».
    const abortado = Object.assign(new Error('abortado'), { name: 'AbortError' });
    const { fetch } = fetchDe([{ error: abortado }]);
    const { p } = proveedor({ fetch, maxRetries: 0, timeoutMs: 1_234 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);
    expect((error as ErrorDeProveedor).codigo).toBe('TIMEOUT');
    expect((error as Error).message).toContain('1234');
  });

  it('un JSON roto no se interpreta con buena voluntad', async () => {
    const { fetch } = fetchDe([{ status: 200, cuerpo: '{ esto no es json' }]);
    const { p } = proveedor({ fetch, maxRetries: 0 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);
    expect((error as ErrorDeProveedor).codigo).toBe('RESPUESTA_ILEGIBLE');
  });

  it('un JSON válido sin la forma acordada tampoco', async () => {
    // 200 con un cuerpo que no trae `output`: el proveedor contestó algo, y ese
    // algo no es una respuesta.
    const { fetch } = fetchDe([{ status: 200, cuerpo: '{"otra_cosa":1}' }]);
    const { p } = proveedor({ fetch, maxRetries: 0 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);
    expect((error as ErrorDeProveedor).codigo).toBe('RESPUESTA_ILEGIBLE');
  });
});

describe('HttpLLMProvider — reintentos', () => {
  it('reintenta un 429 y devuelve la respuesta buena', async () => {
    const { fetch, llamadas } = fetchDe([
      { status: 429, cuerpo: '' },
      { status: 200, cuerpo: OK },
    ]);
    const { p, esperas } = proveedor({ fetch, maxRetries: 2 });

    const r = await p.complete(PEDIDO);

    expect(r.modelId).toBe('modelo-x');
    expect(llamadas).toHaveLength(2);
    // Y esperó antes de insistir: un reintento inmediato sobre un 429 es
    // exactamente lo que el 429 está pidiendo que no se haga.
    expect(esperas).toEqual([200]);
  });

  it('reintenta un 500', async () => {
    const { fetch, llamadas } = fetchDe([
      { status: 500, cuerpo: '' },
      { status: 200, cuerpo: OK },
    ]);
    const { p } = proveedor({ fetch, maxRetries: 2 });

    await p.complete(PEDIDO);
    expect(llamadas).toHaveLength(2);
  });

  it('NO reintenta un 400: sale igual mil veces', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 400, cuerpo: '' }]);
    const { p } = proveedor({ fetch, maxRetries: 3 });

    await p.complete(PEDIDO).catch(() => undefined);
    expect(llamadas).toHaveLength(1);
  });

  it('NO reintenta un 401: la credencial equivocada no mejora con insistencia', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 401, cuerpo: '' }]);
    const { p } = proveedor({ fetch, maxRetries: 3 });

    await p.complete(PEDIDO).catch(() => undefined);
    expect(llamadas).toHaveLength(1);
  });

  it('NO reintenta una respuesta ilegible: el proveedor contestó, y contestó mal', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 200, cuerpo: 'no json' }]);
    const { p } = proveedor({ fetch, maxRetries: 3 });

    await p.complete(PEDIDO).catch(() => undefined);
    expect(llamadas).toHaveLength(1);
  });

  it('respeta el máximo y no reintenta para siempre', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 503, cuerpo: '' }]);
    const { p, esperas } = proveedor({ fetch, maxRetries: 2 });

    const error = await p.complete(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);

    // Tres llamadas: el primer intento más dos reintentos.
    expect(llamadas).toHaveLength(3);
    expect((error as ErrorDeProveedor).codigo).toBe('PROVEEDOR_CAIDO');
    // Backoff exponencial: 200, 400.
    expect(esperas).toEqual([200, 400]);
  });

  it('con maxRetries en 0 hay un solo intento', async () => {
    const { fetch, llamadas } = fetchDe([{ status: 503, cuerpo: '' }]);
    const { p, esperas } = proveedor({ fetch, maxRetries: 0 });

    await p.complete(PEDIDO).catch(() => undefined);
    expect(llamadas).toHaveLength(1);
    expect(esperas).toEqual([]);
  });

  it('el backoff tiene techo', async () => {
    const { fetch } = fetchDe([{ status: 503, cuerpo: '' }]);
    const { p, esperas } = proveedor({ fetch, maxRetries: 8 });

    await p.complete(PEDIDO).catch(() => undefined);

    // Sin techo, el octavo reintento esperaría veinticinco segundos: más que el
    // timeout de la petición entera.
    expect(Math.max(...esperas)).toBeLessThanOrEqual(4_000);
  });

  it('qué se reintenta está dicho en un solo lugar', () => {
    expect(reintentable('LIMITE_DE_TASA')).toBe(true);
    expect(reintentable('PROVEEDOR_CAIDO')).toBe(true);
    expect(reintentable('RED')).toBe(true);
    expect(reintentable('TIMEOUT')).toBe(true);
    expect(reintentable('PEDIDO_INVALIDO')).toBe(false);
    expect(reintentable('CREDENCIAL_RECHAZADA')).toBe(false);
    expect(reintentable('RESPUESTA_ILEGIBLE')).toBe(false);
  });
});

describe('El dialecto — dónde queda el vendor', () => {
  it('el transporte no sabe nada de la forma del proveedor', async () => {
    // Un dialecto inventado con otra forma: el transporte lo usa sin cambiar.
    // Es la prueba de que conectar un proveedor nuevo son dos funciones puras.
    const dialecto = {
      id: 'otro',
      cuerpo: (p: { modelId: string }) => ({ nombre_del_modelo: p.modelId }),
      leer: (json: unknown) => {
        const j = json as { resultado?: unknown };
        return j.resultado === undefined
          ? null
          : { output: j.resultado, modelId: 'otro-1', uso: null };
      },
    };

    const { fetch, llamadas } = fetchDe([
      { status: 200, cuerpo: JSON.stringify({ resultado: { ok: true } }) },
    ]);
    const p = new HttpLLMProvider({
      baseUrl: 'https://otro.invalido',
      apiKey: async () => CLAVE,
      modelId: 'm',
      providerId: 'http',
      timeoutMs: 1_000,
      maxRetries: 0,
      dialecto,
      fetch,
    });

    const r = await p.complete(PEDIDO);
    expect(r.output).toEqual({ ok: true });
    expect(r.modelId).toBe('otro-1');
    expect(JSON.parse(llamadas[0]!.body)).toEqual({ nombre_del_modelo: 'm' });
  });

  it('el dialecto propio no acepta una respuesta sin `output`', () => {
    expect(DIALECTO_NEXO.leer({ model: 'x' })).toBeNull();
    expect(DIALECTO_NEXO.leer(null)).toBeNull();
    expect(DIALECTO_NEXO.leer('texto')).toBeNull();
  });

  it('sin `model` en la respuesta, el modelo es "desconocido" y no se inventa', () => {
    // Guardar el id que se pidió como si fuera el que contestó sería afirmar
    // que el proveedor usó ese modelo, y no lo dijo.
    const leida = DIALECTO_NEXO.leer({ output: {} });
    expect(leida?.modelId).toBe('desconocido');
  });
});
