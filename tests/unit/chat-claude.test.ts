/**
 * El adaptador de Claude: la traducción del puerto de chat a la API de mensajes, y el manejo de sus fallos.
 *
 * Se ejecuta el adaptador REAL (con el SDK oficial) contra un `fetch` de mentira que habla la forma documentada de la API.
 * Prueba lo que el adaptador manda y cómo lee la respuesta; NO prueba que la cuenta de nadie ande (eso necesita una
 * credencial real: ver el encabezado de `chat-claude.ts`).
 */

import { ErrorDeProveedor, type PedidoDeChat } from '@aai/ai-engine';
import { describe, expect, it } from 'vitest';
import { MODELO_POR_DEFECTO, ProveedorDeChatClaude } from '../../apps/api/src/ai/chat-claude.js';

interface PedidoCapturado {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly cuerpo: Record<string, unknown>;
}

function fetchDeMentira(responder: (n: number) => { status: number; cuerpo: unknown }) {
  const pedidos: PedidoCapturado[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    pedidos.push({ url: String(url), headers, cuerpo: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = responder(pedidos.length);
    return new Response(JSON.stringify(r.cuerpo), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, pedidos };
}

const OK = (content: unknown[], stop_reason: string, usage: Record<string, number> = { input_tokens: 120, output_tokens: 30 }) => ({
  status: 200,
  cuerpo: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_sequence: null, usage },
});

const PEDIDO: PedidoDeChat = {
  system: 'Sos el asistente.',
  mensajes: [{ rol: 'usuario', bloques: [{ tipo: 'texto', texto: '¿Cuánto vendí este mes?' }] }],
  herramientas: [{ nombre: 'preguntar_al_sistema', descripcion: 'Consulta el catálogo.', esquema: { type: 'object', properties: { preguntaId: { type: 'string' } }, required: ['preguntaId'], additionalProperties: false } }],
  maxTokens: 700,
};

const CLAVE_DE_PRUEBA = 'clave-de-prueba-que-no-debe-aparecer-en-ningun-error';
const proveedor = (f: typeof fetch, extra: Record<string, unknown> = {}) =>
  new ProveedorDeChatClaude({ apiKey: async () => CLAVE_DE_PRUEBA, fetch: f, maxReintentos: 0, baseUrl: 'https://api.ejemplo.test', ...extra });

describe('lo que se manda', () => {
  it('Haiku 5.5 por defecto, el endpoint de mensajes y la credencial en x-api-key (no en la URL ni el cuerpo)', async () => {
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'Hola' }], 'end_turn'));
    await proveedor(f).conversar(PEDIDO);
    const p = pedidos[0]!;
    expect(MODELO_POR_DEFECTO).toBe('claude-haiku-5-5');
    expect(p.cuerpo['model']).toBe('claude-haiku-5-5');
    expect(p.url).toContain('/v1/messages');
    expect(p.headers['x-api-key']).toBe(CLAVE_DE_PRUEBA);
    expect(p.url).not.toContain(CLAVE_DE_PRUEBA);
    expect(JSON.stringify(p.cuerpo)).not.toContain(CLAVE_DE_PRUEBA);
  });

  it('NO manda temperature, top_p, top_k, thinking ni tool_choice (Haiku 5.5 rechaza lo distinto del defecto; no se fuerza ninguna herramienta)', async () => {
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'Hola' }], 'end_turn'));
    await proveedor(f).conversar(PEDIDO);
    for (const prohibido of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'budget_tokens']) {
      expect(Object.keys(pedidos[0]!.cuerpo), `se mandó ${prohibido}`).not.toContain(prohibido);
    }
  });

  it('manda sistema, mensajes, herramientas con su esquema, max_tokens y el esfuerzo (low por defecto)', async () => {
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'Hola' }], 'end_turn'));
    await proveedor(f).conversar(PEDIDO);
    const c = pedidos[0]!.cuerpo;
    expect(c['system']).toEqual([{ type: 'text', text: 'Sos el asistente.', cache_control: { type: 'ephemeral' } }]);
    expect(c['max_tokens']).toBe(700);
    expect(c['output_config']).toEqual({ effort: 'low' });
    expect(c['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: '¿Cuánto vendí este mes?' }] }]);
    expect(c['tools']).toEqual([{ name: 'preguntar_al_sistema', description: 'Consulta el catálogo.', input_schema: PEDIDO.herramientas[0]!.esquema }]);
  });

  it('sin herramientas no manda la clave tools', async () => {
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'Hola' }], 'end_turn'));
    await proveedor(f).conversar({ ...PEDIDO, herramientas: [] });
    expect(Object.keys(pedidos[0]!.cuerpo)).not.toContain('tools');
  });

  it('el resultado de una herramienta vuelve como tool_result (con is_error si fue un error), y el contenido crudo del modelo se reenvía idéntico', async () => {
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'ok' }], 'end_turn'));
    const crudo = [{ type: 'thinking', thinking: '', signature: 'firma-opaca' }, { type: 'tool_use', id: 'tu_1', name: 'preguntar_al_sistema', input: { preguntaId: 'ventas' } }];
    await proveedor(f).conversar({
      ...PEDIDO,
      mensajes: [
        ...PEDIDO.mensajes,
        { rol: 'asistente', bloques: [{ tipo: 'herramienta', id: 'tu_1', nombre: 'preguntar_al_sistema', entrada: { preguntaId: 'ventas' } }], crudo },
        { rol: 'usuario', bloques: [{ tipo: 'resultado', id: 'tu_1', contenido: '{"error":"x"}', esError: true }] },
      ],
    });
    const m = pedidos[0]!.cuerpo['messages'] as { role: string; content: unknown }[];
    expect(m[1]).toEqual({ role: 'assistant', content: crudo }); // idéntico, incluido el bloque de razonamiento
    expect(m[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"error":"x"}', is_error: true }] });
  });

  it('el modelo y el esfuerzo se pueden configurar', async () => {
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'Hola' }], 'end_turn'));
    await proveedor(f, { modelo: 'claude-sonnet-5-5', esfuerzo: 'medium' }).conversar(PEDIDO);
    expect(pedidos[0]!.cuerpo['model']).toBe('claude-sonnet-5-5');
    expect(pedidos[0]!.cuerpo['output_config']).toEqual({ effort: 'medium' });
  });
});

describe('lo que se lee', () => {
  it('un texto: bloques de texto, razón «fin», uso y modelo', async () => {
    const { f } = fetchDeMentira(() => OK([{ type: 'text', text: 'Vendiste ' }, { type: 'text', text: 'bastante.' }], 'end_turn', { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 400 }));
    const r = await proveedor(f).conversar(PEDIDO);
    expect(r.bloques).toEqual([{ tipo: 'texto', texto: 'Vendiste ' }, { tipo: 'texto', texto: 'bastante.' }]);
    expect(r.razonDeCorte).toBe('fin');
    expect(r.uso).toEqual({ entrada: 500, salida: 20 });
    expect(r.modeloId).toBe('claude-haiku-5-5');
  });

  it('una llamada a herramienta: bloque «herramienta», razón «herramienta», y el razonamiento queda en crudo (no en los bloques)', async () => {
    const { f } = fetchDeMentira(() => OK([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'tu_9', name: 'preguntar_al_sistema', input: { preguntaId: 'ventas' } }], 'tool_use'));
    const r = await proveedor(f).conversar(PEDIDO);
    expect(r.bloques).toEqual([{ tipo: 'herramienta', id: 'tu_9', nombre: 'preguntar_al_sistema', entrada: { preguntaId: 'ventas' } }]);
    expect(r.razonDeCorte).toBe('herramienta');
    expect((r.crudo as { type: string }[]).map((b) => b.type)).toEqual(['thinking', 'tool_use']);
  });

  it.each([['max_tokens', 'maxTokens'], ['refusal', 'rechazo'], ['stop_sequence', 'otra']])('stop_reason «%s» → «%s»', async (de, a) => {
    const { f } = fetchDeMentira(() => OK([{ type: 'text', text: 'x' }], de));
    expect((await proveedor(f).conversar(PEDIDO)).razonDeCorte).toBe(a);
  });
});

describe('cuando falla', () => {
  const falla = async (status: number) => {
    const { f } = fetchDeMentira(() => ({ status, cuerpo: { type: 'error', error: { type: 'x', message: `detalle interno con ${CLAVE_DE_PRUEBA} y datos de la empresa` } } }));
    return proveedor(f).conversar(PEDIDO).catch((e: unknown) => e as ErrorDeProveedor);
  };

  it.each([[401, 'CREDENCIAL_RECHAZADA'], [403, 'CREDENCIAL_RECHAZADA'], [429, 'LIMITE_DE_TASA'], [500, 'PROVEEDOR_CAIDO'], [529, 'PROVEEDOR_CAIDO'], [400, 'PEDIDO_INVALIDO'], [404, 'PEDIDO_INVALIDO']])('HTTP %i → %s', async (status, codigo) => {
    const e = await falla(status);
    expect(e).toBeInstanceOf(ErrorDeProveedor);
    expect(e.codigo).toBe(codigo);
  });

  it('el mensaje del proveedor NUNCA se propaga (puede traer el pedido, con datos de la empresa) ni la credencial', async () => {
    for (const status of [400, 401, 429, 500]) {
      const e = await falla(status);
      expect(`${e.message} ${JSON.stringify(e)}`).not.toContain(CLAVE_DE_PRUEBA);
      expect(e.message).not.toContain('datos de la empresa');
    }
  });

  it('una caída de red → RED', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const e = await proveedor(f).conversar(PEDIDO).catch((x: unknown) => x as ErrorDeProveedor);
    expect(e.codigo).toBe('RED');
  });

  it('no contestar a tiempo → TIMEOUT', async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const e = await proveedor(f, { timeoutMs: 50 }).conversar(PEDIDO).catch((x: unknown) => x as ErrorDeProveedor);
    expect(e.codigo).toBe('TIMEOUT');
  });

  it('la credencial se resuelve en CADA llamada (no queda en el objeto)', async () => {
    let n = 0;
    const { f, pedidos } = fetchDeMentira(() => OK([{ type: 'text', text: 'x' }], 'end_turn'));
    const p = new ProveedorDeChatClaude({ apiKey: async () => `clave-${(n += 1)}`, fetch: f, maxReintentos: 0, baseUrl: 'https://api.ejemplo.test' });
    await p.conversar(PEDIDO);
    await p.conversar(PEDIDO);
    expect(pedidos.map((x) => x.headers['x-api-key'])).toEqual(['clave-1', 'clave-2']);
  });
});
