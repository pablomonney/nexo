/**
 * S-13 — la consola escribe en el elemento que cree.
 *
 * ## El defecto que este barrido encontró
 *
 * `getElementById` devuelve el **primero** que aparece en el documento. Dos
 * pantallas con el mismo `id` no dan error: la segunda escribe en la primera,
 * en silencio.
 *
 * Estaba pasando con dos pantallas enteras. «Comisiones» compartía `t-com`,
 * `com-msg` y `com-alta` con «Comercial», y «Recuento físico» compartía
 * `t-rec`, `rec-msg` y `rec-detalle` con «Recepciones». Como las dos víctimas
 * aparecen antes en el HTML, la tabla de vendedores se dibujaba dentro de la
 * pantalla de presupuestos y la de recuentos dentro de la de recepciones: las
 * dos pantallas nuevas se veían vacías y las dos viejas mostraban datos que no
 * eran suyos.
 *
 * Es el mismo patrón que este repositorio viene persiguiendo —estructura
 * correcta, código escrito, nadie recorriendo el camino entre las dos—, ahora
 * en el navegador. Ningún test lo veía: el contrato de rutas (S-12) comprueba
 * que las llamadas existan, no dónde se dibuja la respuesta.
 *
 * Las dos preguntas de acá son las que faltaban:
 *
 *   1. ¿Hay dos elementos con el mismo `id`?
 *   2. ¿Cada `id` que el código pide existe en el HTML?
 *
 * La segunda cierra el otro extremo: un `E('algo-que-no-existe')` devuelve
 * `null` y explota recién cuando alguien abre esa pantalla.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const CONSOLA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'consola.html',
);

/**
 * Los `id` que el código arma en tiempo de ejecución y no aparecen literales en
 * el HTML. Cada uno se declara con el motivo: la lista es la excepción, no el
 * filtro.
 */
const ARMADOS_AL_VUELO = new Map<string, string>([]);

describe('S-13 — la consola escribe en el elemento que cree', () => {
  let html = '';

  beforeAll(async () => {
    html = await readFile(CONSOLA, 'utf8');
  });

  it('el barrido encuentra elementos: no está pasando por vacío', () => {
    expect(idsDelHtml(html).length).toBeGreaterThan(200);
    expect(idsPedidosPorElCodigo(html).length).toBeGreaterThan(200);
  });

  it('no hay dos elementos con el mismo id', () => {
    const vistos = new Set<string>();
    const repetidos: string[] = [];
    for (const id of idsDelHtml(html)) {
      if (vistos.has(id) && !repetidos.includes(id)) repetidos.push(id);
      vistos.add(id);
    }

    expect(
      repetidos,
      'Estos id están dos veces en la consola. getElementById devuelve el primero, así que ' +
        'la pantalla que aparece después escribe en la que aparece antes, en silencio:\n  ' +
        repetidos.join('\n  '),
    ).toEqual([]);
  });

  it('cada id que el código pide existe en el HTML', () => {
    const existentes = new Set(idsDelHtml(html));
    const fantasmas: string[] = [];

    for (const id of idsPedidosPorElCodigo(html)) {
      if (existentes.has(id) || ARMADOS_AL_VUELO.has(id)) continue;
      if (!fantasmas.includes(id)) fantasmas.push(id);
    }

    expect(
      fantasmas,
      'El código pide estos id y no existen en el HTML. E(...) devuelve null y la pantalla ' +
        'explota recién cuando alguien la abre:\n  ' + fantasmas.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula id que ya existen', () => {
    // Una excepción que sobrevive a su motivo convierte la lista en decoración.
    const existentes = new Set(idsDelHtml(html));
    const sobrantes = [...ARMADOS_AL_VUELO.keys()].filter((id) => existentes.has(id));
    expect(sobrantes, 'Estos id ya existen en el HTML y no necesitan excepción').toEqual([]);
  });
});

/** Los `id` declarados en el marcado, en orden de aparición. */
function idsDelHtml(html: string): string[] {
  return [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!);
}

/** Los `id` que el código pide, por `E('...')` o por `getElementById('...')`. */
function idsPedidosPorElCodigo(html: string): string[] {
  const pedidos = [
    ...html.matchAll(/\bE\('([A-Za-z0-9_-]+)'\)/g),
    ...html.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g),
  ].map((m) => m[1]!);
  return [...new Set(pedidos)];
}
