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

// ── El aislamiento, comprobado y no supuesto ────────────────────────────────
//
// Este servidor se abre para MIRAR pantallas, y lo que hereda del `.env` de
// desarrollo no tiene por qué ser inofensivo: ese archivo puede traer un proveedor
// de pagos, uno de correo o una clave de IA. Con un token de pagos cargado (aunque
// sea de prueba), apretar un botón de cobro llamaría de verdad a la pasarela. Acá
// se corta eso de raíz: la base tiene que ser local y de pruebas, y todo lo que
// habla con el exterior se fuerza a «ninguno», sin importar lo que diga el `.env`.
let destino;
try {
  destino = new URL(pruebas);
} catch {
  console.error('Me niego: no se pudo interpretar la dirección de la base de pruebas derivada de DATABASE_URL.');
  process.exit(2);
}
const nombreDeLaBase = destino.pathname.replace(/^\//u, '');
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(destino.hostname) || !nombreDeLaBase.endsWith('_test')) {
  console.error(
    `Me niego: la base de destino es «${nombreDeLaBase}» en «${destino.hostname}». ` +
      'Este servidor solo abre una base local cuyo nombre termina en _test.',
  );
  process.exit(2);
}

const SIN_EXTERIOR = {
  PAYMENTS_PROVIDER: 'none',
  EMAIL_PROVIDER: 'none',
  AI_PROVIDER: 'none',
  // Las credenciales también: aunque el proveedor fuera `none`, un token cargado no debe
  // poder llegar a un adaptador por otro camino.
  PAYMENTS_ACCESS_TOKEN: '',
  PAYMENTS_WEBHOOK_SECRET: '',
  EMAIL_API_KEY: '',
  AI_API_KEY: '',
  NODE_ENV: 'development',
};

console.log('Sirviendo contra la base de pruebas en http://localhost:3002/consola');
console.log(`  base         ${nombreDeLaBase} en ${destino.hostname}:${destino.port || '5432'} (local, de pruebas)`);
console.log('  hacia afuera pagos=none correo=none IA=none; sin tokens ni claves de terceros');

const hijo = spawn(process.execPath, [join(RAIZ, 'apps', 'api', 'dist', 'index.js')], {
  cwd: RAIZ,
  stdio: 'inherit',
  env: { ...process.env, ...SIN_EXTERIOR, DATABASE_URL: pruebas, PORT: '3002' },
});

hijo.on('exit', (codigo) => process.exit(codigo ?? 0));
