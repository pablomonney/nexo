/**
 * S-28 — El código que corre está en el repositorio.
 *
 * Este control existe porque el defecto ocurrió. La regla `secrets/` del
 * `.gitignore` —puesta para que nadie commitee material de credenciales, que es
 * correcto— no estaba anclada, así que coincidía con **cualquier** carpeta
 * llamada así a cualquier profundidad. Se comió `packages/secrets` y
 * `apps/api/src/secrets` enteros: el paquete estaba escrito, importado,
 * testeado y verde, y no estaba en el repositorio.
 *
 * Nada avisa de esto. El typecheck compila, los tests pasan, el lint de
 * arquitectura cruza el módulo — todos leen el disco. El único que sabía era
 * `git status`, callándose por diseño: ignorar de más es exactamente lo que se
 * le pidió.
 *
 * Es la misma familia que S-16 y S-17 vista un piso más abajo. Aquellos
 * preguntan si algo construido tiene quién lo use; este pregunta si algo que ya
 * se usa **existe fuera de esta máquina**.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Lo que es código fuente, por extensión. */
const FUENTE = /\.(ts|tsx|mjs|cjs|sql|html)$/u;

/**
 * Lo que se ignora con razón y no es fuente que deba versionarse.
 *
 * La lista es corta a propósito. Cada entrada es un artefacto derivado o un
 * archivo de prueba que se escribe y se borra; si mañana hace falta una
 * excepción nueva, agregarla obliga a justificarla acá, que es el punto.
 */
const DERIVADOS = [
  /(^|\/)(dist|build|coverage|node_modules|\.next|\.turbo|var)\//u,
  // El artefacto que S-8 escribe para comprobar que el lint se cae de verdad.
  // Existe solo mientras ese test corre, y está ignorado a propósito.
  /packages\/ai-engine\/src\/__adr001_probe__\.ts$/u,
];

/**
 * Los archivos que git ignora bajo los directorios de código, o `null` si acá
 * no hay repositorio.
 *
 * Un checkout desde un tarball no tiene `.git`, y ahí la pregunta no tiene
 * sentido: el test se salta en vez de fallar. Pero **solo** por eso: cualquier
 * otro fallo de git se propaga.
 *
 * La primera versión de esta función tenía un `catch` que devolvía `null` ante
 * cualquier error, y el primer intento de mutación lo desnudó: sin acotar la
 * consulta, la salida incluía `node_modules` entero, git se caía con `ENOBUFS`,
 * el `catch` lo convertía en «no hay repositorio» y el test daba **verde con la
 * regla rota**. Un control que se salta solo cuando falla es peor que no
 * tenerlo: ocupa el lugar del que sí funcionaría.
 *
 * De ahí las dos correcciones: los pathspec acotan la consulta a lo que importa
 * —que además la hace rápida— y el `catch` distingue el único caso legítimo.
 */
function ignorados(): readonly string[] | null {
  try {
    const salida = execFileSync(
      'git',
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        'apps',
        'packages',
        'tests',
        'scripts',
        'infrastructure',
        ':(exclude)**/node_modules/**',
        ':(exclude)**/dist/**',
        ':(exclude)**/coverage/**',
      ],
      { cwd: RAIZ, encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 },
    );
    return salida.split('\n').filter((linea) => linea.trim() !== '');
  } catch (error) {
    const detalle = `${(error as { stderr?: string }).stderr ?? ''}${(error as Error).message}`;
    if (/not a git repository/iu.test(detalle)) return null;
    throw new Error(`git no pudo listar los archivos ignorados: ${detalle}`);
  }
}

describe('S-28 — el código que corre está en el repositorio', () => {
  it('ninguna fuente de apps, packages, tests, scripts o migraciones está ignorada', () => {
    const lista = ignorados();
    if (lista === null) {
      // No hay repositorio. Nada que comprobar y nada que romper.
      expect(true).toBe(true);
      return;
    }

    const perdidos = lista.filter(
      (archivo) =>
        /^(apps|packages|tests|scripts|infrastructure)\//u.test(archivo) &&
        FUENTE.test(archivo) &&
        !DERIVADOS.some((patron) => patron.test(archivo)),
    );

    expect(
      perdidos,
      'estos archivos existen en disco, el sistema los usa, y el `.gitignore` los deja ' +
        'afuera del repositorio. Casi siempre es una regla sin anclar: `secrets/` coincide ' +
        'con cualquier carpeta con ese nombre; `/secrets/` solo con la de la raíz',
    ).toEqual([]);
  });

  it('la regla que protege el material de credenciales sigue estando', () => {
    // El arreglo de arriba no puede haber sido «sacar la regla». Lo que se
    // arregló fue su alcance: la raíz sí, cualquier carpeta homónima no.
    const gitignore = execFileSync('git', ['check-ignore', '-v', 'secrets/x.pem'], {
      cwd: RAIZ,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    expect(gitignore, 'la carpeta secrets/ de la raíz tiene que seguir ignorada').toContain(
      'secrets/',
    );
  });
});
