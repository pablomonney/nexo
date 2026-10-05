#!/usr/bin/env node
/**
 * Establece una contraseña nueva y aleatoria para UNA cuenta puntual,
 * identificada por correo exacto — hoy, solo `mariana.sosa.produccion@demo-nexo.test`.
 *
 *   node scripts/reset-password-usuario.mjs --email mariana.sosa.produccion@demo-nexo.test            → solo dry-run
 *   node scripts/reset-password-usuario.mjs --email mariana.sosa.produccion@demo-nexo.test --hacelo    → lo cambia
 *
 * ## Por qué existe
 *
 * Es el mismo caso que `reset-mfa-usuario.mjs`: NEXO no tiene recuperación de
 * contraseña por autoservicio (revisado `apps/web/consola.html` y
 * `apps/api/src/routes/auth.ts` — no hay ninguna ruta `/auth/recover*` ni
 * botón de «olvidé mi contraseña»), y esta cuenta de producción del curso
 * perdió la sesión y la contraseña quedó fuera de este entorno de trabajo.
 * Sin este script, la cuenta queda sin forma de entrar.
 *
 * ## Por qué el correo está restringido a uno solo
 *
 * A propósito, y no por generalidad: existen DOS cuentas "Mariana Sosa" en
 * esta base (`mariana.sosa@demo-nexo.test`, huérfana, y
 * `mariana.sosa.produccion@demo-nexo.test`, la real — con el MFA, el rol y la
 * empresa de este curso). Un script que aceptara cualquier correo podría
 * tocar la cuenta equivocada sin que nadie lo notara. Este solo acepta la
 * dirección exacta que se autorizó.
 *
 * ## Qué NO hace
 *
 *  - No toca `mfa_enabled`, `mfa_secret_encrypted` ni ninguna otra columna de
 *    autenticación: solo `password_hash`.
 *  - No toca `failed_login_count` ni `locked_until` — un login correcto los
 *    limpia solo (`apps/api/src/routes/auth.ts`, línea ~199).
 *  - No toca `companies`, `company_users`, roles ni datos contables.
 *  - No corre contra una base que no sea la de desarrollo local.
 *  - No hashea nada por su cuenta: usa `hashPassword` de
 *    `apps/api/dist/auth/crypto.js`, el mismo Argon2id que usa el login real.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(join(AQUI, '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const HACELO = process.argv.includes('--hacelo');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--email') args.set('email', process.argv[i + 1]);
}
const email = args.get('email');

// La única dirección que este script acepta. No es una lista para ampliar
// después con un segundo `--email`: es la restricción en sí.
const UNICO_CORREO_PERMITIDO = 'mariana.sosa.produccion@demo-nexo.test';

if (email === undefined || email.trim() === '') {
  console.error('Uso: node scripts/reset-password-usuario.mjs --email correo@ejemplo.test [--hacelo]');
  process.exit(2);
}
if (email.trim().toLowerCase() !== UNICO_CORREO_PERMITIDO) {
  console.error(
    `Este script solo opera sobre «${UNICO_CORREO_PERMITIDO}». Se pidió «${email}». Se corta sin tocar nada.`,
  );
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

const parsed = new URL(url);
const nombreDeBase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  console.error(
    `El host de DATABASE_URL es «${parsed.hostname}», no localhost. Este script solo corre contra ` +
      'la base local de desarrollo. Se corta sin tocar nada.',
  );
  process.exit(2);
}
if (nombreDeBase.endsWith('_test')) {
  console.error(
    `«${nombreDeBase}» es la base de pruebas y la reconstruye ` +
      '`node scripts/test-db.mjs --reset`. Este script es para la de desarrollo.',
  );
  process.exit(2);
}

const c = new pg.Client({ connectionString: url });
await c.connect();

const usuarios = await c.query(
  `SELECT id, email, full_name, status, mfa_enabled, failed_login_count, locked_until
     FROM users WHERE lower(email) = lower($1)`,
  [email],
);

console.log(`Base: ${nombreDeBase} (${parsed.hostname})\n`);

if (usuarios.rowCount === 0) {
  console.log(`No existe ningún usuario con el correo exacto «${email}». No se toca nada.`);
  await c.end();
  process.exit(0);
}
if (usuarios.rowCount > 1) {
  // El email es único en la tabla real, pero si algo raro pasara, no se sigue.
  console.error('Hay más de un usuario con ese correo. Se corta sin tocar nada.');
  await c.end();
  process.exit(1);
}

const usuario = usuarios.rows[0];
console.table([usuario]);

if (!HACELO) {
  console.log(
    '\nEsto es lo que se resetearía: password_hash → el hash Argon2id de una contraseña nueva ' +
      'generada al azar en el momento. Ninguna otra columna ni fila se toca.\n' +
      'Para hacerlo:\n' +
      `  node scripts/reset-password-usuario.mjs --email ${email} --hacelo`,
  );
  await c.end();
  process.exit(0);
}

// Se importa el mismo Argon2id que usa el login real — no se inventa el
// formato del hash. `correo-bandeja.mjs` importa del mismo `dist/` por el
// mismo motivo: un solo lugar decide cómo se hashea, y es el compilado real.
const { hashPassword } = await import(new URL('../apps/api/dist/auth/crypto.js', import.meta.url).href);

// 24 bytes al azar, base64url: no imprimible-ambiguo, sin caracteres que
// puedan confundirse al tipearla, y muy por encima del mínimo de 12.
const nuevaContrasena = randomBytes(24).toString('base64url');
const nuevoHash = await hashPassword(nuevaContrasena);

await c.query('BEGIN');
try {
  const actualizado = await c.query(
    `UPDATE users SET password_hash = $1
      WHERE id = $2 AND email = $3
      RETURNING id, email`,
    [nuevoHash, usuario.id, usuario.email],
  );

  if (actualizado.rowCount !== 1) {
    throw new Error(`Se esperaba actualizar exactamente 1 fila y se actualizaron ${actualizado.rowCount}.`);
  }

  // Post-check: releer el hash y confirmar que la contraseña nueva verifica
  // contra lo que quedó guardado, antes de dar el commit por bueno.
  const { verifyPassword } = await import(
    new URL('../apps/api/dist/auth/crypto.js', import.meta.url).href
  );
  const relectura = await c.query('SELECT password_hash FROM users WHERE id = $1', [usuario.id]);
  const verifica = await verifyPassword(relectura.rows[0].password_hash, nuevaContrasena);
  if (!verifica) {
    throw new Error('Post-check falló: el hash guardado no verifica contra la contraseña generada.');
  }

  await c.query('COMMIT');
  console.log(`\nListo. Contraseña nueva para ${actualizado.rows[0].email} (post-check OK):`);
  console.log(`\n    ${nuevaContrasena}\n`);
  console.log('No queda guardada en ningún archivo ni log persistente. Usala ahora para entrar y, ' +
    'una vez adentro, no hace falta hacer nada más con ella — es de un solo uso operativo.');
} catch (error) {
  await c.query('ROLLBACK');
  console.error('\nNo se cambió nada:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

await c.end();
