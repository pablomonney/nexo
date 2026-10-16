#!/usr/bin/env node
/**
 * La llamada real a Claude, de punta a punta, ANTES de encender el asistente para un cliente.
 *
 *   ASSISTANT_API_KEY=sk-ant-... npm run asistente:probar
 *
 * (o con la clave ya puesta en el `.env` local, que git ignora). No necesita base de datos ni servidor: usa el mismo adaptador
 * que usa la aplicación (`apps/api/dist/ai/chat-claude.js`, compilado con `npm run build`), así que prueba exactamente lo que
 * va a correr en producción.
 *
 * ## Qué comprueba (cuatro llamadas, centavos de dólar)
 *
 *   1. Un texto simple.                       La clave sirve y el modelo existe en la cuenta.
 *   2. Una herramienta, ida y vuelta.         El modelo pide la herramienta, recibe el resultado y lo usa.
 *   3. Una imagen.                            El modelo acepta fotos con estos parámetros.
 *   4. El costo.                              Compara el uso informado con el precio declarado (migración 0136).
 *
 * ## Qué NO hace
 *
 * No imprime la clave, ni el texto de un error del proveedor (puede traer el pedido): sólo el código. No toca la base, no
 * enciende nada, no despliega. Si falta la clave, lo dice y sale sin llamar a nadie.
 *
 * ## Qué hacer con el resultado
 *
 * Si las cuatro pasan, el proveedor está conectado en serio: lo siguiente es `ASSISTANT_PROVIDER=anthropic` en el `.env` del
 * servidor y los pasos de `docs/ASISTENTE.md` §8. Si el costo medido no coincide con el declarado, corregir `ai_pricing`
 * (una fila nueva con otra vigencia) antes de confiar en `assistant_messages.costo_micros`.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* sin .env: se usa el entorno */
}

const clave = process.env.ASSISTANT_API_KEY;
if (clave === undefined || clave === '') {
  console.error(
    'Falta ASSISTANT_API_KEY. No se llamó a nadie.\n' +
      '  Creá una clave en https://platform.claude.com/settings/keys (la cuenta necesita saldo) y corré:\n' +
      '  ASSISTANT_API_KEY=... npm run asistente:probar\n' +
      '  La clave NO va al repositorio ni a un chat.',
  );
  process.exit(2);
}

let ProveedorDeChatClaude;
let MODELO_POR_DEFECTO;
try {
  ({ ProveedorDeChatClaude, MODELO_POR_DEFECTO } = await import(
    pathToFileURL(join(RAIZ, 'apps', 'api', 'dist', 'ai', 'chat-claude.js')).href
  ));
} catch {
  console.error('No encuentro apps/api/dist: corré `npm run build` primero.');
  process.exit(2);
}

const modelo = process.env.ASSISTANT_MODEL_ID || MODELO_POR_DEFECTO;
// Los precios declarados en la 0136, en micros de dólar por mil tokens. Si Anthropic los cambia, esto lo muestra.
const PRECIO = { entrada: 100, salida: 500 };

const proveedor = new ProveedorDeChatClaude({
  apiKey: async () => clave,
  modelo,
  timeoutMs: 60_000,
  maxReintentos: 1,
  esfuerzo: process.env.ASSISTANT_EFFORT || 'low',
});

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let entrada = 0;
let salida = 0;
let fallos = 0;
const usar = (r) => {
  if (r.uso !== null) {
    entrada += r.uso.entrada;
    salida += r.uso.salida;
  }
};
const textoDe = (r) => r.bloques.filter((b) => b.tipo === 'texto').map((b) => b.texto).join('').trim();
const paso = async (nombre, fn) => {
  try {
    const detalle = await fn();
    console.log(`  ✔ ${nombre}${detalle ? ' — ' + detalle : ''}`);
  } catch (e) {
    fallos += 1;
    // Sólo el código: el texto del proveedor puede traer el pedido.
    console.log(`  ✘ ${nombre} — ${e?.codigo ?? 'ERROR'}${e?.status ? ' (HTTP ' + e.status + ')' : ''}`);
  }
};

console.log(`Probando ${modelo} (esfuerzo ${process.env.ASSISTANT_EFFORT || 'low'})…`);

await paso('1 · texto simple', async () => {
  const r = await proveedor.conversar({
    system: 'Respondés lo mínimo.',
    mensajes: [{ rol: 'usuario', bloques: [{ tipo: 'texto', texto: 'Respondé únicamente con la palabra OK.' }] }],
    herramientas: [],
    maxTokens: 64,
  });
  usar(r);
  if (!/ok/i.test(textoDe(r))) throw Object.assign(new Error('respuesta inesperada'), { codigo: 'RESPUESTA_INESPERADA' });
  return `contestó, modelo ${r.modeloId}`;
});

await paso('2 · herramienta, ida y vuelta', async () => {
  const herramientas = [
    {
      nombre: 'dame_un_numero',
      descripcion: 'Devuelve un número de prueba. Es la única fuente del número.',
      esquema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  const usuario = { rol: 'usuario', bloques: [{ tipo: 'texto', texto: 'Usá la herramienta dame_un_numero y decime el valor que devuelve.' }] };
  const r1 = await proveedor.conversar({ system: 'Usá las herramientas cuando haga falta.', mensajes: [usuario], herramientas, maxTokens: 256 });
  usar(r1);
  const pedido = r1.bloques.find((b) => b.tipo === 'herramienta');
  if (pedido === undefined || r1.razonDeCorte !== 'herramienta') {
    throw Object.assign(new Error('no pidió la herramienta'), { codigo: 'NO_PIDIO_LA_HERRAMIENTA' });
  }
  const r2 = await proveedor.conversar({
    system: 'Usá las herramientas cuando haga falta.',
    mensajes: [
      usuario,
      { rol: 'asistente', bloques: r1.bloques, crudo: r1.crudo },
      { rol: 'usuario', bloques: [{ tipo: 'resultado', id: pedido.id, contenido: JSON.stringify({ valor: '1.234,50' }), esError: false }] },
    ],
    herramientas,
    maxTokens: 256,
  });
  usar(r2);
  if (!textoDe(r2).includes('1.234,50')) {
    throw Object.assign(new Error('no usó el valor'), { codigo: 'NO_USO_EL_RESULTADO' });
  }
  return 'pidió la herramienta y usó el resultado tal cual';
});

await paso('3 · imagen', async () => {
  const r = await proveedor.conversar({
    system: 'Respondés lo mínimo.',
    mensajes: [
      {
        rol: 'usuario',
        bloques: [
          { tipo: 'adjunto', clase: 'imagen', mediaType: 'image/png', base64: PNG_1X1 },
          { tipo: 'texto', texto: 'Describí en una frase qué ves en esta imagen.' },
        ],
      },
    ],
    herramientas: [],
    maxTokens: 128,
  });
  usar(r);
  if (textoDe(r) === '') throw Object.assign(new Error('sin texto'), { codigo: 'SIN_TEXTO' });
  return 'aceptó la imagen';
});

const micros = Math.ceil((entrada * PRECIO.entrada) / 1000) + Math.ceil((salida * PRECIO.salida) / 1000);
console.log(`  · uso total: ${entrada} tokens de entrada, ${salida} de salida`);
console.log(`  · costo calculado con el precio declarado (${PRECIO.entrada}/${PRECIO.salida} micros por mil): US$ ${(micros / 1_000_000).toFixed(6)}`);
console.log('    Compará este número con el uso que muestra la consola de Anthropic; si difiere, corregí ai_pricing.');

if (fallos > 0) {
  console.log(`\n${fallos} paso(s) fallaron. NO encender el asistente para un cliente.`);
  process.exit(1);
}
console.log('\nLas llamadas anduvieron. Siguiente: docs/ASISTENTE.md §8 (ASSISTANT_PROVIDER=anthropic y encender una empresa de prueba).');
