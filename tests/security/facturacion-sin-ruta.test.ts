/**
 * S-44 — ninguna ruta puede llegar al ciclo de facturación.
 *
 * ## Este control se escribió tarde, y conviene decir por qué
 *
 * `apps/api/src/billing/ciclo.ts` y `apps/api/src/routes/facturacion.ts` dicen
 * los dos, desde hace meses, que «`tests/security/facturacion-sin-ruta.test.ts`
 * comprueba que ninguna ruta importe el ciclo de facturación».
 *
 * **Ese archivo no existía.** La regla era cierta —ninguna ruta lo importaba— y
 * no estaba comprobada por nada; las dos afirmaciones se escribieron con la
 * intención de escribir el control y el control nunca se escribió. Es la forma
 * más incómoda de este defecto: no había un agujero, había la *creencia* de que
 * el agujero estaba tapado, que es lo que hace que nadie vuelva a mirar.
 *
 * Apareció en B2.5.5, al conectar la pasarela de pagos, porque ahí la regla dejó
 * de ser gratis: un webhook necesita registrar cobros, y el camino corto es que
 * la ruta llame a `procesarEventoDePago`. Se resolvió con una bandeja
 * (`payment_webhook_inbox`, 0119) justamente para no tener que ceder esto.
 *
 * ## Qué defiende
 *
 * `aai_app` —el rol con el que corre la API— tiene `SELECT` y nada más sobre las
 * tablas de facturación, y sobre `payment_events` no tiene ni eso. Eso es lo que
 * impide que el administrador de una empresa cliente se emita un cargo, lo marque
 * pagado o se levante una suspensión.
 *
 * El candado real es el de la base, y S-29 lo comprueba. Esto comprueba la otra
 * mitad: que nadie escriba el camino. Sin este control, alguien puede importar
 * el ciclo en una ruta, ver que falla con 42501, y «arreglarlo» agregando un
 * `GRANT` — y en ese momento el candado se abre para toda la API, no solo para
 * esa ruta.
 *
 * ## Por qué mira el grafo entero y no los imports directos
 *
 * Porque un import indirecto abre exactamente el mismo camino. Una ruta que
 * importe un módulo que importe el ciclo puede llamarlo igual, y buscar solo la
 * línea `from '../billing/ciclo.js'` en los archivos de `routes/` dejaría pasar
 * el caso con un archivo en el medio — que es, además, la forma en que esto
 * llegaría de verdad.
 */

import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(RAIZ, 'apps', 'api', 'src');
const RUTAS = join(SRC, 'routes');

/** El módulo que ninguna ruta puede alcanzar, y el motivo. */
const PROHIBIDOS: Readonly<Record<string, string>> = {
  'billing/ciclo.ts':
    'El ciclo emite cargos, registra cobros y suspende suscripciones. Corre como operador ' +
    'desde `npm run facturacion:ciclo`, no como respuesta a una petición HTTP.',
  'pagos/bandeja.ts':
    'Aplica notificaciones de la pasarela escribiendo en payment_intents y payment_events, ' +
    'que aai_app no puede escribir. Corre desde `npm run pagos:bandeja`.',
};

/** Resuelve un import relativo de TypeScript (`./x.js`) al archivo real. */
function resolverImport(desde: string, especificador: string): string | null {
  if (!especificador.startsWith('.')) return null;
  const bruto = resolve(dirname(desde), especificador);
  return bruto.replace(/\.js$/u, '.ts');
}

async function importsDe(archivo: string): Promise<string[]> {
  let texto: string;
  try {
    texto = await readFile(archivo, 'utf8');
  } catch {
    return [];
  }
  // `import ... from '...'`, `export ... from '...'` y `await import('...')`.
  const encontrados = [
    ...texto.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/gu),
  ].map((m) => m[1]!);
  return encontrados
    .map((e) => resolverImport(archivo, e))
    .filter((x): x is string => x !== null);
}

/** Todo lo que un archivo puede alcanzar, directa o indirectamente. */
async function alcanzables(raiz: string): Promise<Set<string>> {
  const vistos = new Set<string>();
  const pendientes = [raiz];

  while (pendientes.length > 0) {
    const actual = pendientes.pop()!;
    if (vistos.has(actual)) continue;
    vistos.add(actual);
    for (const siguiente of await importsDe(actual)) {
      if (!vistos.has(siguiente)) pendientes.push(siguiente);
    }
  }

  vistos.delete(raiz);
  return vistos;
}

describe('S-44 — la facturación no se toca desde una ruta', () => {
  it('ninguna ruta alcanza el ciclo de facturación ni la bandeja de pagos', async () => {
    const archivos = (await readdir(RUTAS)).filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'),
    );

    // El control positivo del barrido: si `routes/` se moviera o se renombrara,
    // la lista quedaría vacía y este test pasaría sin haber mirado nada.
    expect(archivos.length, 'no se encontró ninguna ruta: el barrido no miró nada').toBeGreaterThan(
      20,
    );

    const violaciones: string[] = [];

    for (const nombre of archivos) {
      const ruta = join(RUTAS, nombre);
      const puedeLlegar = await alcanzables(ruta);

      for (const [prohibido, motivo] of Object.entries(PROHIBIDOS)) {
        const objetivo = join(SRC, ...prohibido.split('/'));
        if (puedeLlegar.has(objetivo)) {
          violaciones.push(
            `routes/${nombre} llega a ${prohibido}\n    ${motivo}\n` +
              `    (el camino puede ser indirecto: revisá qué importa ${nombre})`,
          );
        }
      }
    }

    expect(
      violaciones,
      'Una ruta que llega a estos módulos puede escribir en las tablas de facturación. ' +
        'El rol de la aplicación hoy se lo impide (S-29), así que el síntoma sería un 42501 ' +
        'y la corrección tentadora sería un GRANT — que abriría el candado para TODA la API:\n' +
        violaciones.join('\n'),
    ).toEqual([]);
  });

  it('los módulos que el barrido protege existen', async () => {
    // Sin esto, renombrar `billing/ciclo.ts` dejaría el control mirando un
    // archivo que no existe: no encontraría nada y pasaría para siempre.
    for (const prohibido of Object.keys(PROHIBIDOS)) {
      const objetivo = join(SRC, ...prohibido.split('/'));
      await expect(
        readFile(objetivo, 'utf8'),
        `${prohibido} ya no existe: el control está mirando al vacío`,
      ).resolves.toBeTruthy();
    }
  });

  it('el barrido ve una violación cuando la hay', async () => {
    // «Un control que no se ve fallar no es un control». Se arma el caso a mano:
    // el módulo de pagos de la bandeja SÍ alcanza el ciclo de facturación, que
    // es exactamente la forma que tendría la violación si estuviera en una ruta.
    const puedeLlegar = await alcanzables(join(SRC, 'pagos', 'bandeja.ts'));
    expect(
      puedeLlegar.has(join(SRC, 'billing', 'ciclo.ts')),
      'el recorrido del grafo no encuentra un import que sí está',
    ).toBe(true);
  });

  it('el barrido sigue los imports indirectos, no solo los de primer nivel', async () => {
    // `bandeja.ts` importa `billing/ciclo.ts`, que importa `pagos/fabrica.ts`.
    // Ese tercer salto solo aparece si el recorrido es transitivo.
    const puedeLlegar = await alcanzables(join(SRC, 'pagos', 'bandeja.ts'));
    const directos = await importsDe(join(SRC, 'pagos', 'bandeja.ts'));
    const fabrica = join(SRC, 'pagos', 'fabrica.ts');

    expect(directos, 'fabrica.ts pasó a ser un import directo: elegí otro salto').not.toContain(
      fabrica,
    );
    expect(puedeLlegar.has(fabrica), 'el recorrido no es transitivo').toBe(true);
  });

  it('las dos afirmaciones del código nombran este archivo', async () => {
    // La otra mitad de la corrección. Los comentarios que decían que este
    // control existía fueron ciertos recién cuando se escribió; que sigan
    // nombrándolo es lo que hace que alguien llegue hasta acá.
    const nombre = relative(RAIZ, join(RAIZ, 'tests', 'security', 'facturacion-sin-ruta.test.ts'))
      .split(/[\\/]/u)
      .join('/');

    for (const archivo of [join(SRC, 'billing', 'ciclo.ts'), join(RUTAS, 'facturacion.ts')]) {
      const texto = await readFile(archivo, 'utf8');
      expect(texto, `${archivo} ya no nombra el control`).toContain(nombre);
    }
  });
});
