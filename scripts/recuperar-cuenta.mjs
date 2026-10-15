#!/usr/bin/env node
/**
 * Recuperar una cuenta a mano: los dos casos que «olvidé mi contraseña» no resuelve.
 *
 *   node scripts/recuperar-cuenta.mjs ver            --email <correo>
 *   node scripts/recuperar-cuenta.mjs segundo-factor --email <correo> --motivo "<por qué>" --verificacion "<cómo se verificó quién es>" [--confirmar]
 *   node scripts/recuperar-cuenta.mjs correo         --email <correo actual> --nuevo <correo nuevo> --motivo "…" --verificacion "…" [--confirmar]
 *
 * ## Cuándo se usa
 *
 *   · `segundo-factor`: la persona perdió el segundo factor **y** los códigos de recuperación. La pantalla de alta de MFA no
 *     vuelve a mostrar el secreto, a propósito, así que no hay otra salida. Apaga el segundo factor y borra los códigos de
 *     recuperación: al entrar, tiene que configurarlo de nuevo (los roles que lo exigen no pasan sin él).
 *   · `correo`: la persona perdió el acceso a la casilla de la cuenta (el código de «olvidé mi contraseña» llega a una
 *     bandeja que ya no es suya). Cambia el correo con el que entra.
 *
 * La contraseña olvidada NO se resuelve acá: es `POST /auth/recuperar` (por correo), y no necesita al operador.
 *
 * ## Por qué es una herramienta con tantas trabas
 *
 * Es el acto que deja a alguien entrar a una empresa con datos contables de terceros. Hace falta que **no** se pueda hacer
 * a la ligera ni sin dejar rastro:
 *
 *   · el simulacro es lo normal: sin `--confirmar` sólo muestra qué haría y a qué empresas alcanza;
 *   · `--motivo` y `--verificacion` son OBLIGATORIOS y quedan en la bitácora de cada empresa de la cuenta. La verificación
 *     de identidad la hace una persona (docs/legal/PROCEDIMIENTO_RECUPERACION_DE_CUENTA.md §3) y acá se escribe cómo;
 *   · identifica a la persona por el correo EXACTO (nunca por patrón) y sólo actúa sobre una cuenta ACTIVA;
 *   · cierra todas las sesiones de la cuenta;
 *   · no imprime ni guarda ningún secreto, y no toca la contraseña ni ninguna otra columna.
 *
 * ## En el servidor
 *
 * `bash scripts/recuperar-cuenta.sh <subcomando> …` lo corre dentro de la imagen, con el mismo patrón que `cobro-manual.sh`.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { opcionesDeConexion } from './lib/zona.mjs';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI y en la imagen las variables vienen del entorno */
}

const [, , subcomando, ...resto] = process.argv;
const opcion = (nombre) => {
  const i = resto.indexOf(`--${nombre}`);
  return i >= 0 ? resto[i + 1] : undefined;
};
const confirmar = resto.includes('--confirmar');

function uso(codigo) {
  console.error(
    'uso: node scripts/recuperar-cuenta.mjs ver --email <correo>\n' +
      '     node scripts/recuperar-cuenta.mjs segundo-factor --email <correo> --motivo "<por qué>" --verificacion "<cómo se verificó>" [--confirmar]\n' +
      '     node scripts/recuperar-cuenta.mjs correo --email <correo actual> --nuevo <correo nuevo> --motivo "…" --verificacion "…" [--confirmar]',
  );
  process.exit(codigo);
}

if (!['ver', 'segundo-factor', 'correo'].includes(subcomando ?? '')) uso(subcomando === undefined || subcomando === '--help' ? 0 : 2);
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

const email = (opcion('email') ?? '').trim();
if (email === '') {
  console.error('Falta --email.');
  process.exit(2);
}

const motivo = (opcion('motivo') ?? '').trim();
const verificacion = (opcion('verificacion') ?? '').trim();
const nuevo = (opcion('nuevo') ?? '').trim();

if (subcomando !== 'ver') {
  if (motivo.length < 10) {
    console.error('Falta --motivo (al menos 10 caracteres): por qué se hace.');
    process.exit(2);
  }
  if (verificacion.length < 20) {
    console.error(
      'Falta --verificacion (al menos 20 caracteres): cómo se verificó que quien lo pide es el titular de la cuenta. ' +
        'Sin eso no se toca nada.',
    );
    process.exit(2);
  }
  if (subcomando === 'correo' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(nuevo)) {
    console.error('Falta --nuevo, con un correo válido.');
    process.exit(2);
  }
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL, ...opcionesDeConexion() });
await cliente.connect();
const destino = new URL(process.env.DATABASE_URL);
console.log(`base: ${destino.pathname.slice(1)} en ${destino.hostname}\n`);

try {
  const fila = await cliente.query(
    `SELECT id, email, full_name, status, mfa_enabled, (mfa_secret_encrypted IS NOT NULL) AS tiene_secreto
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (fila.rowCount === 0) {
    console.error(`No existe ninguna cuenta con el correo «${email}». No se toca nada.`);
    process.exit(3);
  }
  const u = fila.rows[0];
  const empresas = await cliente.query(
    `SELECT DISTINCT c.id, c.legal_name, c.cuit
       FROM user_company_roles ucr JOIN companies c ON c.id = ucr.company_id
      WHERE ucr.user_id = $1 ORDER BY c.legal_name`,
    [u.id],
  );
  const codigos = (await cliente.query('SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1', [u.id])).rows[0].n;
  const sesiones = (await cliente.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [u.id])).rows[0].n;

  console.log(`cuenta            ${u.email} (${u.full_name})`);
  console.log(`estado            ${u.status}`);
  console.log(`segundo factor    ${u.mfa_enabled ? 'activado' : 'apagado'}; códigos de recuperación guardados: ${codigos}`);
  console.log(`sesiones abiertas ${sesiones}`);
  console.log(`empresas          ${empresas.rowCount === 0 ? '(ninguna)' : empresas.rows.map((e) => `${e.legal_name} (${e.cuit})`).join('; ')}`);

  if (subcomando === 'ver') process.exit(0);

  if (u.status !== 'ACTIVE') {
    console.error(`\nLa cuenta está ${u.status}: esto sólo actúa sobre cuentas ACTIVAS. No se toca nada.`);
    process.exit(3);
  }
  if (subcomando === 'segundo-factor' && !u.mfa_enabled && !u.tiene_secreto && codigos === 0) {
    console.log('\nEsta cuenta no tiene ningún estado de segundo factor que resetear. No se toca nada.');
    process.exit(0);
  }
  if (subcomando === 'correo') {
    const ya = await cliente.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [nuevo]);
    if (ya.rowCount > 0) {
      console.error(`\nYa existe una cuenta con el correo «${nuevo}». No se toca nada.`);
      process.exit(3);
    }
  }

  const accion = subcomando === 'segundo-factor' ? 'RESETEAR_SEGUNDO_FACTOR' : 'CAMBIAR_CORREO_DE_CUENTA';
  console.log(
    subcomando === 'segundo-factor'
      ? `\nHARÍA: apagar el segundo factor, borrar sus ${codigos} código(s) de recuperación y cerrar sus ${sesiones} sesión(es).`
      : `\nHARÍA: cambiar el correo de «${u.email}» a «${nuevo}», invalidar los códigos de recuperación pendientes y cerrar sus ${sesiones} sesión(es).`,
  );
  console.log(
    empresas.rowCount === 0
      ? 'AVISO: la cuenta no pertenece a ninguna empresa: no hay bitácora donde dejar constancia.'
      : `Dejaría constancia («${accion}») en la bitácora de ${empresas.rowCount} empresa(s).`,
  );
  if (!confirmar) {
    console.log('\nSIMULACRO: no se escribió nada. Para hacerlo, el mismo comando con --confirmar.');
    process.exit(0);
  }

  const texto = `${motivo} · Verificación de identidad: ${verificacion}`;
  await cliente.query('BEGIN');
  try {
    if (subcomando === 'segundo-factor') {
      await cliente.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [u.id]);
      const r = await cliente.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL, mfa_confirmed_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'ACTIVE'`,
        [u.id],
      );
      if (r.rowCount !== 1) throw new Error(`se esperaba actualizar 1 cuenta y fueron ${r.rowCount}`);
    } else {
      await cliente.query(
        `UPDATE email_verifications SET consumido_el = now()
          WHERE user_id = $1 AND proposito = 'RECUPERACION' AND consumido_el IS NULL`,
        [u.id],
      );
      const r = await cliente.query(`UPDATE users SET email = $2, updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`, [u.id, nuevo]);
      if (r.rowCount !== 1) throw new Error(`se esperaba actualizar 1 cuenta y fueron ${r.rowCount}`);
    }
    await cliente.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);

    for (const e of empresas.rows) {
      await cliente.query(
        `INSERT INTO audit_logs
           (company_id, actor_type, actor_id, action, object_type, object_id, old_value, new_value, motivo, ip, user_agent, prev_hash, hash)
         VALUES ($1, 'SYSTEM', 'operador:recuperar-cuenta', $2, 'users', $3, $4::jsonb, $5::jsonb, $6, NULL, NULL, '', '')`,
        [
          e.id,
          accion,
          u.id,
          JSON.stringify(subcomando === 'segundo-factor' ? { mfaEnabled: u.mfa_enabled, codigosDeRecuperacion: codigos } : { correo: u.email }),
          JSON.stringify(subcomando === 'segundo-factor' ? { mfaEnabled: false, codigosDeRecuperacion: 0 } : { correo: nuevo }),
          texto,
        ],
      );
    }
    await cliente.query('COMMIT');
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  console.log(
    subcomando === 'segundo-factor'
      ? '\nLISTO. Segundo factor apagado y sesiones cerradas. Al entrar, la persona tiene que configurarlo de nuevo.'
      : `\nLISTO. El correo de la cuenta ahora es «${nuevo}» y las sesiones se cerraron.`,
  );
} catch (error) {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
