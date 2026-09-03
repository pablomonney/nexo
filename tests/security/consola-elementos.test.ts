/**
 * S-15 — la consola escribe en el elemento que cree.
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

describe('S-15 — la consola escribe en el elemento que cree', () => {
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

  /**
   * La otra mitad del mismo problema: una pantalla que existe y a la que no se
   * llega, o un botón que apunta a una pantalla que no existe.
   *
   * `ir()` recorre `VISTAS` para esconder todas menos una. Una sección que no
   * esté en esa lista **nunca se esconde**: queda visible debajo de las demás.
   * Y un botón sin sección deja la pantalla en blanco.
   */
  it('cada botón del menú tiene su pantalla, y cada pantalla su lugar en VISTAS', () => {
    const botones = [...html.matchAll(/data-vista="([a-z]+)"/g)].map((m) => m[1]!);
    const secciones = idsDelHtml(html)
      .filter((id) => id.startsWith('v-'))
      .map((id) => id.slice(2));
    const vistas = listaDeVistas(html);

    const sinPantalla = botones.filter((v) => !secciones.includes(v));
    expect(sinPantalla, 'Botones del menú que no tienen sección').toEqual([]);

    // `login` es la única sin botón: se entra por el flujo de sesión, no por el
    // menú —que ni siquiera está visible sin sesión—.
    const sinBoton = secciones.filter((v) => !botones.includes(v) && v !== 'login');
    expect(sinBoton, 'Pantallas a las que no se llega desde el menú').toEqual([]);

    const fueraDeVistas = secciones.filter((v) => !vistas.includes(v));
    expect(
      fueraDeVistas,
      'Estas pantallas no están en VISTAS: ir() no las esconde, así que quedan visibles ' +
        'debajo de la que el usuario abrió:\n  ' + fueraDeVistas.join('\n  '),
    ).toEqual([]);

    const vistasFantasma = vistas.filter((v) => !secciones.includes(v));
    expect(vistasFantasma, 'VISTAS nombra pantallas que ya no existen').toEqual([]);
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

/** Los nombres del arreglo `VISTAS`, que es lo que `ir()` esconde y muestra. */
function listaDeVistas(html: string): string[] {
  const desde = html.indexOf('const VISTAS = [');
  const hasta = html.indexOf('];', desde);
  if (desde === -1 || hasta === -1) return [];
  return [...html.slice(desde, hasta).matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
}

/** Los `id` que el código pide, por `E('...')` o por `getElementById('...')`. */
function idsPedidosPorElCodigo(html: string): string[] {
  const pedidos = [
    ...html.matchAll(/\bE\('([A-Za-z0-9_-]+)'\)/g),
    ...html.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g),
  ].map((m) => m[1]!);
  return [...new Set(pedidos)];
}
