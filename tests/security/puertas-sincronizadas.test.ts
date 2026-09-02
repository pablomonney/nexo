/**
 * Las tres listas de puertas dicen lo mismo.
 *
 * NEXO tiene sus controles escritos **tres veces**, y no por descuido: cada
 * copia sirve para algo distinto.
 *
 *   `npm run verify`   la cadena que corre una persona antes de commitear
 *   `PASOS`            la secuencia de `pipeline.mjs`, que se puede imprimir
 *   `ci.yml`           lo que corre GitHub Actions, que es lo que realmente
 *                      bloquea un merge
 *
 * Tres listas mantenidas a mano se desincronizan, y cuando se desincronizan el
 * daño es de una forma particular: **el árbol local da verde y el candado que
 * falta es justo el que nadie corre**. Ya había pasado — `audit:cadena` y
 * `verify:arranque` vivían en `verify` y no estaban ni en el pipeline ni en
 * Actions, así que un merge podía pasar sin que la cadena de la bitácora se
 * verificara nunca.
 *
 * Este test no elige una lista como fuente de verdad: comprueba que las tres
 * coincidan. Cuál es la canónica es una decisión que no hace falta tomar para
 * que el defecto sea imposible.
 *
 * ## Qué se compara
 *
 * Solo las **puertas**: los comandos que verifican algo. Los pasos de
 * preparación —crear bases, migrar, sembrar— no se comparan porque cada lista
 * tiene motivos legítimos para tenerlos distintos: el pipeline corre `db:setup`
 * dos veces a propósito, para probar que las migraciones son idempotentes, y
 * eso en `verify` no tendría sentido.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Comandos que preparan, no que verifican.
 *
 * Están declarados con su motivo porque la lista es lo único que separa «este
 * paso no es una puerta» de «a este paso se le escapó la puerta».
 */
const PREPARACION = new Map<string, string>([
  ['db:setup', 'Crea y migra la base de desarrollo. En CI corre dos veces, a propósito.'],
  ['test:db', 'Crea y migra la base de tests.'],
  ['build', 'Compila. Su fallo lo ataja `typecheck`.'],
]);

/**
 * Los comandos `npm run X` que aparecen en un texto, en sus dos formas.
 *
 * `package.json` y `ci.yml` los escriben como una línea de shell; el pipeline,
 * como un arreglo de argumentos. Leer una sola forma haría que el barrido
 * encontrara cero comandos en el pipeline y **diera verde**, que es la manera
 * exacta en que un control de sincronización deja de controlar.
 */
function comandosDe(texto: string): Set<string> {
  const enLinea = [...texto.matchAll(/npm run ([a-z:_-]+)/g)].map((m) => m[1]!);
  const enArreglo = [...texto.matchAll(/'npm',\s*'run',\s*'([a-z:_-]+)'/g)].map((m) => m[1]!);
  return new Set([...enLinea, ...enArreglo].filter((c) => !PREPARACION.has(c)));
}

/**
 * Lo mismo, pero solo sobre lo que se ejecuta.
 *
 * El `ci.yml` explica sus pasos en comentarios y ahí menciona `npm run ci` y
 * `npm run verify` para contrastarlos con lo que hace. Un barrido que leyera la
 * prosa los tomaría por pasos y pediría que existieran en el pipeline. Se leen
 * los comentarios porque están, no porque corran.
 */
function comandosEjecutadosDe(yaml: string): Set<string> {
  const sinComentarios = yaml
    .split('\n')
    .filter((linea) => !linea.trimStart().startsWith('#'))
    .join('\n');
  return comandosDe(sinComentarios);
}

describe('Las tres listas de puertas dicen lo mismo', () => {
  it('`verify`, el pipeline y ci.yml corren las mismas puertas', async () => {
    const paquete = JSON.parse(await readFile(join(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const pipeline = await readFile(join(RAIZ, 'scripts', 'pipeline.mjs'), 'utf8');
    const ci = await readFile(join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');

    const enVerify = comandosDe(paquete.scripts['verify'] ?? '');
    // Del pipeline solo interesa el arreglo `PASOS`, no los comentarios de
    // arriba: un ejemplo en la documentación no es un paso que corra.
    const cuerpoPasos = pipeline.slice(pipeline.indexOf('export const PASOS'));
    const enPipeline = comandosDe(cuerpoPasos);
    const enCi = comandosEjecutadosDe(ci);

    expect(enVerify.size, 'el barrido tiene que encontrar puertas: no pasa por vacío')
      .toBeGreaterThan(5);

    const faltan = (a: Set<string>, b: Set<string>): string[] =>
      [...a].filter((c) => !b.has(c)).sort();

    expect(
      faltan(enVerify, enPipeline),
      'están en `npm run verify` y no en PASOS de pipeline.mjs',
    ).toEqual([]);
    expect(
      faltan(enVerify, enCi),
      'están en `npm run verify` y no en ci.yml: un merge pasaría sin ellas',
    ).toEqual([]);
    expect(
      faltan(enPipeline, enVerify),
      'están en el pipeline y no en `npm run verify`: nadie las corre antes de commitear',
    ).toEqual([]);
    expect(
      faltan(enCi, enPipeline),
      'están en ci.yml y no en el pipeline',
    ).toEqual([]);
  });

  it('cada puerta existe como script de npm', async () => {
    // Una lista que nombra un script inexistente falla recién en CI, quince
    // minutos después, y con un mensaje de shell.
    const paquete = JSON.parse(await readFile(join(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const pipeline = await readFile(join(RAIZ, 'scripts', 'pipeline.mjs'), 'utf8');
    const ci = await readFile(join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');

    const todos = new Set([
      ...comandosDe(paquete.scripts['verify'] ?? ''),
      ...comandosDe(pipeline.slice(pipeline.indexOf('export const PASOS'))),
      ...comandosEjecutadosDe(ci),
    ]);

    const inexistentes = [...todos].filter((c) => paquete.scripts[c] === undefined).sort();
    expect(inexistentes, 'estos comandos no existen en package.json').toEqual([]);
  });

  it('la lista de preparación no acumula comandos que ya no existen', async () => {
    // Una excepción que sobrevive a su comando exime a un nombre que mañana
    // puede significar otra cosa.
    const paquete = JSON.parse(await readFile(join(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const fantasmas = [...PREPARACION.keys()].filter((c) => paquete.scripts[c] === undefined);
    expect(fantasmas, 'estos comandos de preparación ya no existen').toEqual([]);
  });
});
