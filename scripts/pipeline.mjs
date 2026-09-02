#!/usr/bin/env node
/**
 * El pipeline, en un solo lugar.
 *
 *   npm run ci          — lo corre entero, desde cero
 *   npm run ci -- --secuencia   — imprime los pasos y sale
 *
 * ## Por qué existe
 *
 * La auditoría maestra encontró que `.github/workflows/ci.yml` **no podía
 * correr**: arranca Postgres con la base `aai`, `tests/setup-env.ts` deriva
 * `aai_test` para que las suites no ensucien la de desarrollo —corrección
 * correcta, del 2026-08-27— y ningún paso creaba esa segunda base. Cada suite
 * de integración habría fallado en su `beforeAll`. No se detectó porque el
 * repositorio no tiene remoto: CI nunca se ejecutó ni una vez.
 *
 * El arreglo obvio —agregar un paso al YAML— deja el mismo problema para la
 * próxima: dos definiciones del pipeline, una en el YAML y otra en `verify`, que
 * pueden divergir sin que nadie lo note hasta que alguien mira. Así que la
 * secuencia vive acá, la corre este script, y hay un test que comprueba que el
 * workflow ejecute exactamente estos pasos y en este orden.
 *
 * ## Las tres bases, y quién crea cada una
 *
 *   `aai`         desarrollo/base. La crea y migra `db:setup`.
 *   `aai_test`    integración. La crea y migra `test:db`. **Este era el hueco.**
 *   `aai_verify`  verificación conductual. La crean y destruyen `audit:invariants`
 *                 y `ledger:verify` en cada corrida.
 *
 * Ninguna suite depende de la de desarrollo: `setup-env.ts` la redirige antes de
 * importar nada, y los gates conductuales se hacen la suya.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(HERE, '..');
if (existsSync(join(RAIZ, '.env'))) {
  process.loadEnvFile(join(RAIZ, '.env'));
}

/**
 * Los pasos, en orden.
 *
 * `nombre` es el que tiene que aparecer en el workflow; `comando` es lo que se
 * ejecuta. Un paso con `soloLocal` corre acá y no en CI —hoy ninguno—, y uno con
 * `soloCI` al revés.
 *
 * El orden no es decorativo: las puertas baratas van primero para que un error
 * de tipos no espere quince minutos de tests, y las bases se crean antes de lo
 * que las necesita.
 */
export const PASOS = [
  { nombre: 'Typecheck', comando: ['npm', 'run', 'typecheck'] },
  { nombre: 'ESLint', comando: ['npm', 'run', 'lint'] },
  { nombre: 'Lint de arquitectura (ADR-001)', comando: ['npm', 'run', 'lint:arch'] },
  { nombre: 'Prohibido el punto flotante en importes', comando: ['npm', 'run', 'check:no-float'] },
  { nombre: 'Integridad del archivo normativo', comando: ['npm', 'run', 'norms:verify'] },
  { nombre: 'Crear base y migrar', comando: ['npm', 'run', 'db:setup'] },
  { nombre: 'Migraciones idempotentes', comando: ['npm', 'run', 'db:setup'] },
  { nombre: 'Crear y migrar la base de tests', comando: ['npm', 'run', 'test:db'] },
  { nombre: 'Tests (con umbrales de cobertura)', comando: ['npm', 'run', 'test:coverage'] },
  {
    nombre: 'El primer arranque funciona sobre una base vacía',
    comando: ['npm', 'run', 'verify:arranque'],
  },
  { nombre: 'Invariantes — estructura (los candados están)', comando: ['npm', 'run', 'audit:estructura'] },
  {
    nombre: 'Invariantes — conducta (base aislada, fixtures y verificación)',
    comando: ['npm', 'run', 'audit:invariants'],
  },
  {
    nombre: 'El Mayor coincide con el Diario (ACCOUNTING_ENGINE.md §7)',
    comando: ['npm', 'run', 'ledger:verify'],
  },
  {
    nombre: 'La bitácora no fue adulterada, y el detector detecta',
    comando: ['npm', 'run', 'audit:cadena'],
  },
];

const invocadoDirectamente =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invocadoDirectamente) {
  if (process.argv.includes('--secuencia')) {
    for (const [i, paso] of PASOS.entries()) {
      console.log(`${String(i + 1).padStart(2, '0')}. ${paso.nombre}`);
      console.log(`    ${paso.comando.join(' ')}`);
    }
    process.exit(0);
  }

  // `--desde-cero` destruye y rehace las bases antes de empezar. Es lo que hace
  // CI en cada corrida —un contenedor nuevo— y lo que hay que poder reproducir
  // acá para que «pasa en local» signifique algo.
  const desdeCero = process.argv.includes('--desde-cero');

  console.log('Pipeline de NEXO\n');
  if (desdeCero) {
    console.log('Modo DESDE CERO: se destruyen y rehacen las bases de tests y de verificación.\n');
    ejecutar('Reset de la base de tests', ['node', 'scripts/test-db.mjs', '--reset']);
  }

  const comenzo = Date.now();
  for (const [i, paso] of PASOS.entries()) {
    console.log(`\n── ${String(i + 1).padStart(2, '0')}/${PASOS.length} · ${paso.nombre}`);
    ejecutar(paso.nombre, paso.comando);
  }

  const segundos = Math.round((Date.now() - comenzo) / 1000);
  console.log(`\n✔ Pipeline completo en ${segundos}s. Los ${PASOS.length} pasos pasaron.`);
}

function ejecutar(nombre, comando) {
  const [programa, ...argumentos] = comando;
  const resultado = spawnSync(programa, argumentos, {
    cwd: RAIZ,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  if (resultado.status !== 0) {
    console.error(`\n✘ Falló: ${nombre}`);
    console.error(`  ${comando.join(' ')} salió con ${resultado.status}`);
    console.error('\n  El pipeline corta acá: los pasos siguientes verificarían sobre un estado que');
    console.error('  ya se sabe roto, y sus resultados no significarían nada.');
    process.exit(resultado.status ?? 1);
  }
}
