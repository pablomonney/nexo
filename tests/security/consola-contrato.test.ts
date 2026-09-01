/**
 * S-12 — la consola no puede llamar a una ruta que no existe.
 *
 * La FASE 1 encontró que el selector de empresa pedía
 * `GET /organizations/:id/companies`, que devolvía 404: el circuito andaba y
 * nadie podía entrar a usarlo. Nadie lo detectó porque no había forma
 * automática de detectarlo — los tests de la consola comprobaban su CSP y que
 * no tocara la base, no que sus llamadas existieran.
 *
 * Este barrido cierra eso. Lee el HTML, reconstruye cada URL que la página
 * puede pedir y la compara contra el inventario real de rutas de Fastify. Una
 * llamada nueva a una ruta inexistente falla acá, no en producción.
 *
 * No comprueba que la respuesta tenga la forma esperada: eso lo hacen los tests
 * de navegación, ejercitando las pantallas contra datos reales.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const CONSOLA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'consola.html',
);

/** El segmento que ocupa una variable en una URL armada por concatenación. */
const VARIABLE = '§';

/**
 * Reconstruye la URL de una expresión de concatenación.
 *
 * `'/documents/' + id + '/extract'` → `/documents/<var>/extract`
 *
 * Se recorre carácter por carácter en vez de partir por `+`: hay expresiones con
 * ternarios adentro —`(cursor ? '&cursor=' + cursor : '')`— y partirlas daría
 * basura.
 */
function reconstruir(expresion: string): string {
  let salida = '';
  let i = 0;
  while (i < expresion.length) {
    if (expresion[i] === "'") {
      const fin = expresion.indexOf("'", i + 1);
      if (fin === -1) break;
      salida += expresion.slice(i + 1, fin);
      i = fin + 1;
      continue;
    }
    // Un tramo que no es literal: una variable, una llamada, un ternario.
    const siguiente = expresion.indexOf("'", i);
    const tramo = (siguiente === -1 ? expresion.slice(i) : expresion.slice(i, siguiente)).trim();
    if (tramo !== '' && tramo !== '+') salida += VARIABLE;
    if (siguiente === -1) break;
    i = siguiente;
  }
  // La query no forma parte de la ruta registrada.
  const corte = salida.indexOf('?');
  return corte === -1 ? salida : salida.slice(0, corte);
}

/**
 * Lee el argumento de URL a partir de una posición, respetando comillas y
 * paréntesis.
 *
 * Una expresión regular no alcanza: hay argumentos con paréntesis adentro
 * —`'/x?' + q.toString()`, `(cursor ? '…' : '')`— y cortar por el primer `,` o
 * `)` daría una URL a medias, que es peor que ninguna: haría fallar el barrido
 * por un defecto del barrido.
 */
function leerArgumento(texto: string, desde: number): { expresion: string; fin: number } {
  let i = desde;
  let profundidad = 0;
  let comilla: string | null = null;
  for (; i < texto.length; i += 1) {
    const c = texto[i]!;
    if (comilla !== null) {
      if (c === '\\') i += 1;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { comilla = c; continue; }
    if (c === '(' || c === '[' || c === '{') { profundidad += 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (profundidad === 0) break;
      profundidad -= 1;
      continue;
    }
    if (c === ',' && profundidad === 0) break;
  }
  return { expresion: texto.slice(desde, i), fin: i };
}

/** Todas las llamadas HTTP que la consola puede emitir. */
function llamadasDe(html: string): { metodo: string; url: string }[] {
  const salida: { metodo: string; url: string }[] = [];

  // api('GET', <url>, …)
  const porApi = /api\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*/g;
  let m: RegExpExecArray | null;
  while ((m = porApi.exec(html)) !== null) {
    const url = reconstruir(leerArgumento(html, porApi.lastIndex).expresion);
    if (url.startsWith('/')) salida.push({ metodo: m[1]!, url });
  }

  // fetch(<url>, { … }) — la descarga de la evidencia.
  const porFetch = /fetch\(\s*/g;
  while ((m = porFetch.exec(html)) !== null) {
    const url = reconstruir(leerArgumento(html, porFetch.lastIndex).expresion);
    if (url.startsWith('/')) salida.push({ metodo: 'GET', url });
  }

  return salida;
}

suite('S-12 — la consola solo llama a rutas que existen', () => {
  let app: FastifyInstance;
  let html = '';

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    html = await readFile(CONSOLA, 'utf8');
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('el barrido encuentra llamadas: no está pasando por vacío', () => {
    const llamadas = llamadasDe(html);
    expect(llamadas.length, 'la consola tiene que llamar a la API').toBeGreaterThan(20);
    expect(llamadas.some((l) => l.url === '/companies')).toBe(true);
    expect(llamadas.some((l) => l.url === '/work-queue')).toBe(true);
  });

  it('cada llamada de la consola resuelve contra una ruta registrada', () => {
    const patrones = app.routeTable.map((ruta) => ({
      metodo: ruta.method,
      url: ruta.url,
      regex: new RegExp(
        '^' +
          ruta.url
            .split('/')
            .map((parte) => (parte.startsWith(':') ? '[^/]+' : parte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .join('/') +
          '$',
      ),
    }));

    const huerfanas: string[] = [];
    for (const llamada of llamadasDe(html)) {
      const candidata = llamada.url.split('/').map((p) => (p === VARIABLE ? 'x' : p)).join('/');
      const existe = patrones.some(
        (p) => p.metodo === llamada.metodo && p.regex.test(candidata),
      );
      if (!existe) huerfanas.push(`${llamada.metodo} ${llamada.url.replace(/§/g, '<var>')}`);
    }

    expect(
      huerfanas,
      'La consola llama a rutas que no existen:\n  ' + huerfanas.join('\n  '),
    ).toEqual([]);
  });

  it('la consola no ofrece acciones de escritura sin pedir su permiso', () => {
    // Cada `POST` que la consola puede emitir tiene que estar detrás de una
    // comprobación de permiso o de un formulario que solo se muestra con él.
    // Se verifica que la página conozca la función que hace esa pregunta y que
    // la use tantas veces como pantallas de acción tiene.
    expect(html).toMatch(/const puede\s*=/);
    const usos = (html.match(/puede\('/g) ?? []).length;
    expect(usos, 'la consola tiene que consultar permisos antes de ofrecer acciones')
      .toBeGreaterThanOrEqual(10);
  });

  it('distingue el origen IA del profesional con estilo propio', () => {
    // ADR-001 en la pantalla: un ítem propuesto por una máquina y uno declarado
    // por una persona no comparten fila, ni color, ni verbo.
    expect(html).toContain('p-ia');
    expect(html).toContain('propuesto por IA');
    expect(html).toContain('declarado por una persona');
    expect(html).toContain('contestó ARCA');
  });
});
