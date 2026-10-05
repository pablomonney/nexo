#!/usr/bin/env node
/**
 * Resetea el segundo factor de UN usuario, identificado por correo exacto.
 *
 *   node scripts/reset-mfa-usuario.mjs --email correo@ejemplo.test            → solo lista, no toca nada
 *   node scripts/reset-mfa-usuario.mjs --email correo@ejemplo.test --hacelo   → lo resetea
 *
 * ## Por qué existe
 *
 * NEXO no tiene ninguna ruta de administración para esto — a propósito: la
 * pantalla de alta de MFA dice que el secreto y los códigos de recuperación
 * "es la única vez que estos valores salen del servidor en claro" y no ofrece
 * "volver a verlos" (`apps/web/consola.html`, sección `v-mfa`). Un usuario que
 * pierde el secreto y los códigos de recuperación queda, por diseño, sin forma
 * de entrar por su cuenta. Ese es el caso: se generó el secreto, se confirmó,
 * y nunca se guardó en ningún lado fuera del servidor. Este script es la única
 * salida que queda, y toca la base directamente porque no hay otra capa.
 *
 * ## Qué NO hace
 *
 *  - No toca ninguna otra columna de `users` (nombre, contraseña, estado).
 *  - No toca ninguna otra fila: identifica al usuario por correo EXACTO
 *    (`=`, no `LIKE`), nunca por patrón.
 *  - No toca `companies`, `organizations`, `organization_members` ni
 *    `audit_logs`: la empresa y el rol del usuario quedan como están.
 *  - No corre contra una base que no sea la de desarrollo local.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

if (email === undefined || email.trim() === '') {
  console.error('Uso: node scripts/reset-mfa-usuario.mjs --email correo@ejemplo.test [--hacelo]');
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

/**
 * Nunca contra algo que no sea la base local de desarrollo.
 *
 * `_test` la reconstruye `test-db.mjs --reset`, así que un reset de MFA ahí no
 * tiene sentido — la fila puede no existir todavía en la próxima corrida. Y si
 * el host no es localhost, no es la base de este script bajo ninguna
 * circunstancia: no hay «producción» válida para esta herramienta.
 */
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
  `SELECT id, email, status, mfa_enabled, (mfa_secret_encrypted IS NOT NULL) AS tiene_secreto
     FROM users WHERE email = $1`,
  [email],
);

console.log(`Base: ${nombreDeBase} (${parsed.hostname})\n`);

if (usuarios.rowCount === 0) {
  console.log(`No existe ningún usuario con el correo exacto «${email}». No se toca nada.`);
  await c.end();
  process.exit(0);
}
if (usuarios.rowCount > 1) {
  // No debería pasar nunca (el correo es único), pero si pasara, no se sigue.
  console.error('Hay más de un usuario con ese correo. Se corta sin tocar nada.');
  await c.end();
  process.exit(1);
}

const usuario = usuarios.rows[0];
console.table([usuario]);

const codigos = await c.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1', [
  usuario.id,
]);
console.log(`Códigos de recuperación guardados: ${codigos.rows[0].n}`);

if (!usuario.mfa_enabled && !usuario.tiene_secreto && codigos.rows[0].n === 0) {
  console.log('\nEste usuario ya no tiene ningún estado de MFA que resetear.');
  await c.end();
  process.exit(0);
}

if (!HACELO) {
  console.log(
    '\nEsto es lo que se resetearía: mfa_enabled → false, mfa_secret_encrypted → NULL, y se ' +
      `borrarían sus ${codigos.rows[0].n} códigos de recuperación. Ninguna otra columna ni fila se toca.\n` +
      'Para hacerlo:\n' +
      `  node scripts/reset-mfa-usuario.mjs --email ${email} --hacelo`,
  );
  await c.end();
  process.exit(0);
}

await c.query('BEGIN');
try {
  const borrados = await c.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [usuario.id]);
  const actualizado = await c.query(
    `UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL
      WHERE id = $1 AND email = $2
      RETURNING id, email, mfa_enabled, (mfa_secret_encrypted IS NOT NULL) AS tiene_secreto`,
    [usuario.id, email],
  );

  if (actualizado.rowCount !== 1) {
    throw new Error(`Se esperaba actualizar exactamente 1 fila y se actualizaron ${actualizado.rowCount}.`);
  }

  await c.query('COMMIT');
  console.log(
    `\nListo. Se borraron ${borrados.rowCount} códigos de recuperación y se reseteó el MFA de:`,
  );
  console.table(actualizado.rows);
} catch (error) {
  await c.query('ROLLBACK');
  console.error('\nNo se cambió nada:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

await c.end();
