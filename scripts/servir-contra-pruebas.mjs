#!/usr/bin/env node
/**
 * Levanta la API contra la base de **pruebas**, para poder abrir la consola.
 *
 *   node scripts/servir-contra-pruebas.mjs
 *
 * Existe por una razón concreta: la base de desarrollo no tiene datos de
 * negocio —está anotado como deuda en `NEXO_ROADMAP.md`—, así que la consola
 * abierta contra ella muestra un login y nada más. La de pruebas sí los tiene,
 * porque las suites de integración los crean.
 *
 * No siembra nada ni escribe nada por su cuenta: cambia `DATABASE_URL` y
 * `PORT`, y arranca el mismo servidor de siempre. Correr `npm test` vuelve a
 * dejar la base como estaba.
 *
 * **No sirve para desarrollar contra ella.** Cualquier suite que corra le pisa
 * las filas por abajo. Es para mirar una pantalla con datos adentro.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const desarrollo = process.env.DATABASE_URL;
if (!desarrollo) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

// El mismo sufijo que usa `tests/setup-env.ts`. Si las dos formas de derivar el
// nombre se separaran, esto abriría una base que no es la que corren los tests.
const pruebas = desarrollo.replace(/\/([^/?]+)(\?|$)/u, '/$1_test$2');
if (pruebas === desarrollo) {
  console.error('No se pudo derivar el nombre de la base de pruebas.');
  process.exit(2);
}

console.log('Sirviendo contra la base de pruebas en http://localhost:3002/consola');

const hijo = spawn(process.execPath, [join(RAIZ, 'apps', 'api', 'dist', 'index.js')], {
  cwd: RAIZ,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: pruebas, PORT: '3002' },
});

hijo.on('exit', (codigo) => process.exit(codigo ?? 0));
