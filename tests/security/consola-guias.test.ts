/**
 * Las guías de la consola no pueden señalar cosas que no existen.
 *
 * Cada pantalla tiene una tarjeta «Cómo se usa esta pantalla» y un recorrido guiado cuyos pasos señalan elementos reales
 * (`a: '#b-ter-alta'`). Si alguien renombra un botón o quita un campo y la guía sigue apuntándole, el recorrido muestra
 * un foco vacío y el «Mostrame» no hace nada: una guía rota es peor que ninguna, porque la persona deja de confiar en ella.
 *
 * Lo que se comprueba, leyendo `consola.html` como texto (igual que el resto de los tests de la consola):
 *   · toda pantalla con botón en el menú tiene guía (salvo la lista de empresas, que no es una tarea);
 *   · toda guía es de una pantalla que existe;
 *   · todo `id` al que apunta una guía o un «siguiente paso» existe en el HTML;
 *   · todo atajo «Después podés…» y todo botón de «siguiente paso» lleva a una pantalla del menú;
 *   · todo «siguiente paso» cuelga de un `decir()` que existe, y ese `decir()` pasa un texto de éxito (si no, la guía no se
 *     mostraría nunca);
 *   · el motor de las guías no usa `innerHTML`: sus textos van por `textContent`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');

/** El texto de un `const NOMBRE = {` … `};` de primer nivel del script. */
function objetoLiteral(nombre: string): string {
  const i = html.indexOf(`const ${nombre} = {`);
  expect(i, `no encuentro «const ${nombre} = {» en consola.html`).toBeGreaterThanOrEqual(0);
  const fin = html.indexOf('\n};\n', i);
  expect(fin, `no cierra «${nombre}»`).toBeGreaterThan(i);
  return html.slice(i, fin + 3);
}

const ids = new Set([...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!));
const vistasDelMenu = new Set([...html.matchAll(/<button data-vista="([a-z-]+)"/g)].map((m) => m[1]!));
const seccionesDeVista = new Set([...ids].filter((i) => i.startsWith('v-')).map((i) => i.slice(2)));

const guias = objetoLiteral('GUIAS');
const proximos = objetoLiteral('PROXIMOS');

/** Las claves de primer nivel (dos espacios de sangría) de un literal. */
const clavesDe = (texto: string): string[] => [...texto.matchAll(/^ {2}'?([a-z0-9-]+)'?: \{/gm)].map((m) => m[1]!);

describe('Guías de la consola · lo que señalan existe', () => {
  const claves = clavesDe(guias);

  it('hay guías, y cada una es de una pantalla que existe', () => {
    expect(claves.length).toBeGreaterThan(25);
    expect(claves.filter((v) => !seccionesDeVista.has(v))).toEqual([]);
  });

  it('toda pantalla del menú tiene su guía (la lista de empresas no es una tarea)', () => {
    const SIN_GUIA = new Set(['empresa']);
    const faltan = [...vistasDelMenu].filter((v) => !SIN_GUIA.has(v) && !claves.includes(v));
    expect(faltan, 'pantallas del menú sin guía: escribile los pasos en GUIAS').toEqual([]);
  });

  it('todo `a:` de una guía o de un «siguiente paso» apunta a un id que existe', () => {
    const apuntados = [...(guias + proximos).matchAll(/\ba: '#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]!);
    expect(apuntados.length).toBeGreaterThan(80);
    expect(
      [...new Set(apuntados)].filter((id) => !ids.has(id)),
      'la guía señala elementos que ya no están en la pantalla',
    ).toEqual([]);
  });

  it('cada paso señala algo de SU pantalla, no de otra', () => {
    const intrusos: string[] = [];
    for (const vista of claves) {
      const desde = guias.indexOf(`\n  ${vista}: {`);
      const hasta = guias.indexOf('\n  },', desde);
      const bloque = guias.slice(desde, hasta);
      const seccion = html.slice(html.indexOf(`<section id="v-${vista}"`), html.indexOf('</section>', html.indexOf(`<section id="v-${vista}"`)));
      for (const m of bloque.matchAll(/\ba: '#([A-Za-z0-9_-]+)'/g)) {
        if (!seccion.includes(`id="${m[1]}"`)) intrusos.push(`${vista} → #${m[1]}`);
      }
    }
    expect(intrusos, 'el paso señala un elemento que está en otra pantalla').toEqual([]);
  });

  it('todo atajo «Después podés…» lleva a una pantalla del menú', () => {
    const destinos = [...guias.matchAll(/\['([a-z-]+)', '[^']+'\]/g)].map((m) => m[1]!);
    expect(destinos.length).toBeGreaterThan(60);
    expect([...new Set(destinos)].filter((v) => !vistasDelMenu.has(v))).toEqual([]);
  });
});

describe('Guías de la consola · el «siguiente paso» tras una acción', () => {
  const destinos = clavesDe(proximos);

  it('todo botón de «siguiente paso» que cambia de pantalla va a una pantalla del menú', () => {
    const vistas = [...proximos.matchAll(/\bvista: '([a-z-]+)'/g)].map((m) => m[1]!);
    expect(vistas.length).toBeGreaterThan(5);
    expect(vistas.filter((v) => !vistasDelMenu.has(v))).toEqual([]);
  });

  it.each(destinos)('«%s» existe en el HTML y alguien lo dice con un texto de éxito', (destino) => {
    expect(ids.has(destino), `${destino} no es un id del HTML`).toBe(true);
    const llamadas = [...html.matchAll(new RegExp(`decir\\('${destino}', ([^;]*)\\);`, 'g'))].map((m) => m[1]!);
    expect(llamadas.length, `nadie llama decir('${destino}', …)`).toBeGreaterThan(0);
    // Debe haber al menos una llamada que pase el tercer argumento (el texto de éxito): si no, el «siguiente paso» no sale.
    expect(
      llamadas.some((a) => /,\s*['"`]|,\s*[a-zA-Z(]/.test(a) && !/,\s*null\s*$/.test(a)),
      `ninguna llamada a decir('${destino}') pasa un texto de éxito`,
    ).toBe(true);
  });

  it('`decir()` muestra el «siguiente paso» sólo cuando hay texto de éxito (las lecturas no lo muestran)', () => {
    const i = html.indexOf('function decir(destino, resultado, exito)');
    const cuerpo = html.slice(i, html.indexOf('\n}\n', i));
    expect(cuerpo).toContain('GUIA.proximoPaso(destino, caja, exito);');
    const motor = html.slice(html.indexOf('function proximoPaso'), html.indexOf('return { refrescar'));
    expect(motor).toContain('if (!p || !exito) return;');
  });
});

describe('Guías de la consola · el motor no inyecta marcado', () => {
  it('el bloque de las guías no usa innerHTML ni insertAdjacentHTML', () => {
    const desde = html.indexOf('const GUIA = (() => {');
    const hasta = html.indexOf('return { refrescar', desde);
    expect(desde).toBeGreaterThan(0);
    const motor = html.slice(desde, hasta);
    expect(motor).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/u);
  });
});
