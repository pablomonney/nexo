/**
 * Recuperar una cuenta a mano: `scripts/recuperar-cuenta.mjs` ejecutado de verdad contra una base real.
 *
 * Es la herramienta que deja entrar a alguien a una empresa con datos contables de terceros, así que lo que se prueba es
 * que tenga las trabas: simulacro por defecto, motivo y verificación de identidad obligatorios, sólo cuentas ACTIVAS,
 * constancia en la bitácora, sesiones cerradas, y que no toque lo que no tiene que tocar.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(RAIZ, 'scripts', 'recuperar-cuenta.mjs');
const VERIFICACION = 'Llamada al titular registrado y confirmación del CUIT y del último comprobante emitido';
const MOTIVO = 'La persona perdió el teléfono con el segundo factor';

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: RAIZ,
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: process.env['DATABASE_URL'] ?? '', USERNAME: 'prueba' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}

suite('Recuperar una cuenta a mano', () => {
  let db: Client;
  let fx: Fixture;
  let stamp: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'recuperar-cuenta');
    stamp = await sufijoUnico(db);
  });
  afterAll(async () => {
    await db?.end();
  });

  /** Una cuenta ACTIVA con segundo factor, 3 códigos de recuperación, una sesión abierta y un rol en la empresa A. */
  async function cuenta(etiqueta: string, estado = 'ACTIVE'): Promise<{ id: string; email: string }> {
    const email = `${etiqueta}-${stamp}@estudio.test`;
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, status, mfa_enabled, mfa_secret_encrypted, mfa_confirmed_at)
         VALUES ($1, 'Quien perdió el acceso', 'hash-de-prueba', $2, true, 'cifrado-de-prueba', now()) RETURNING id`,
        [email, estado],
      )
    ).rows[0]!.id;
    for (let i = 0; i < 3; i += 1) {
      await db.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [id, `${'a'.repeat(63)}${i}`]);
    }
    await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, absolute_expires_at, mfa_satisfied)
       VALUES ($1, $2, now() + interval '30 minutes', now() + interval '12 hours', true)`,
      [id, `${'b'.repeat(32)}${id.replace(/-/gu, '')}`],
    );
    await db.query(
      `INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from)
       SELECT $1, $2, r.id, CURRENT_DATE FROM roles r WHERE r.code = 'CONTADOR'`,
      [id, fx.companyA],
    );
    return { id, email };
  }
  const estadoMfa = async (id: string) =>
    (await db.query<{ mfa_enabled: boolean; mfa_secret_encrypted: string | null; codigos: number; sesiones: number; password_hash: string }>(
      `SELECT mfa_enabled, mfa_secret_encrypted, password_hash,
              (SELECT count(*)::int FROM mfa_recovery_codes WHERE user_id = u.id) AS codigos,
              (SELECT count(*)::int FROM sessions WHERE user_id = u.id AND revoked_at IS NULL) AS sesiones
         FROM users u WHERE id = $1`,
      [id],
    )).rows[0]!;

  it('«ver» informa y no escribe', async () => {
    const u = await cuenta('ver');
    const r = cli('ver', '--email', u.email);
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('segundo factor    activado; códigos de recuperación guardados: 3');
    expect(r.salida).toContain('sesiones abiertas 1');
    expect(r.salida).not.toContain('cifrado-de-prueba'); // nunca un secreto
    expect((await estadoMfa(u.id)).mfa_enabled).toBe(true);
  });

  it('sin --confirmar es un SIMULACRO: dice qué haría y no escribe nada', async () => {
    const u = await cuenta('simulacro');
    const r = cli('segundo-factor', '--email', u.email, '--motivo', MOTIVO, '--verificacion', VERIFICACION);
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('SIMULACRO: no se escribió nada');
    expect(r.salida).toContain('HARÍA: apagar el segundo factor, borrar sus 3 código(s) de recuperación');
    expect(await estadoMfa(u.id)).toMatchObject({ mfa_enabled: true, codigos: 3, sesiones: 1 });
    const bitacora = await db.query("SELECT 1 FROM audit_logs WHERE object_id = $1 AND action = 'RESETEAR_SEGUNDO_FACTOR'", [u.id]);
    expect(bitacora.rowCount).toBe(0);
  });

  it('exige motivo y verificación de identidad: sin ellos no toca nada, ni siquiera con --confirmar', async () => {
    const u = await cuenta('sin-motivo');
    for (const args of [
      ['--verificacion', VERIFICACION],
      ['--motivo', MOTIVO],
      ['--motivo', 'corto', '--verificacion', VERIFICACION],
      ['--motivo', MOTIVO, '--verificacion', 'sí'],
    ]) {
      const r = cli('segundo-factor', '--email', u.email, ...args, '--confirmar');
      expect(r.codigo, r.salida).toBe(2);
    }
    expect(await estadoMfa(u.id)).toMatchObject({ mfa_enabled: true, codigos: 3, sesiones: 1 });
  });

  it('segundo-factor --confirmar: lo apaga, borra los códigos, cierra las sesiones y NO toca la contraseña', async () => {
    const u = await cuenta('mfa');
    const antes = await estadoMfa(u.id);
    const r = cli('segundo-factor', '--email', u.email, '--motivo', MOTIVO, '--verificacion', VERIFICACION, '--confirmar');
    expect(r.codigo, r.salida).toBe(0);
    expect(r.salida).toContain('LISTO. Segundo factor apagado');

    const despues = await estadoMfa(u.id);
    expect(despues).toMatchObject({ mfa_enabled: false, mfa_secret_encrypted: null, codigos: 0, sesiones: 0 });
    expect(despues.password_hash, 'la contraseña no se toca').toBe(antes.password_hash);
  });

  it('deja constancia en la bitácora de la empresa, con el motivo y la verificación, y sin secretos', async () => {
    const u = await cuenta('bitacora');
    cli('segundo-factor', '--email', u.email, '--motivo', MOTIVO, '--verificacion', VERIFICACION, '--confirmar');
    const f = await db.query<{ actor_id: string; motivo: string; old_value: unknown; new_value: unknown }>(
      `SELECT actor_id, motivo, old_value, new_value FROM audit_logs WHERE company_id = $1 AND object_id = $2 AND action = 'RESETEAR_SEGUNDO_FACTOR'`,
      [fx.companyA, u.id],
    );
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]!.actor_id).toBe('operador:recuperar-cuenta');
    expect(f.rows[0]!.motivo).toContain(MOTIVO);
    expect(f.rows[0]!.motivo).toContain(VERIFICACION);
    expect(JSON.stringify(f.rows[0])).not.toContain('cifrado-de-prueba');
  });

  it('sólo actúa sobre cuentas ACTIVAS y por correo exacto', async () => {
    const pendiente = await cuenta('pendiente', 'PENDIENTE');
    const r = cli('segundo-factor', '--email', pendiente.email, '--motivo', MOTIVO, '--verificacion', VERIFICACION, '--confirmar');
    expect(r.codigo, r.salida).toBe(3);
    expect(await estadoMfa(pendiente.id)).toMatchObject({ mfa_enabled: true, codigos: 3 });

    const inexistente = cli('segundo-factor', '--email', `no-existe-${stamp}@estudio.test`, '--motivo', MOTIVO, '--verificacion', VERIFICACION, '--confirmar');
    expect(inexistente.codigo).toBe(3);
    // Un patrón no es un correo: no hay forma de tocar a varias cuentas de una vez.
    const patron = cli('segundo-factor', '--email', '%@estudio.test', '--motivo', MOTIVO, '--verificacion', VERIFICACION, '--confirmar');
    expect(patron.codigo).toBe(3);
  });

  it('correo: cambia el correo con el que entra, invalida los códigos de recuperación y cierra las sesiones', async () => {
    const u = await cuenta('correo');
    // Un código de «olvidé mi contraseña» pendiente iría a la casilla vieja: tiene que morir.
    await db.query(
      `INSERT INTO email_verifications (user_id, token_hash, proposito, expira_el) VALUES ($1, $2, 'RECUPERACION', now() + interval '1 hour')`,
      [u.id, `${'c'.repeat(32)}${u.id.replace(/-/gu, '')}`],
    );
    const nuevo = `nuevo-${stamp}@estudio.test`;
    const r = cli('correo', '--email', u.email, '--nuevo', nuevo, '--motivo', 'Cambió de casilla de correo', '--verificacion', VERIFICACION, '--confirmar');
    expect(r.codigo, r.salida).toBe(0);

    const fila = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [u.id]);
    expect(fila.rows[0]!.email).toBe(nuevo);
    expect((await estadoMfa(u.id)).sesiones).toBe(0);
    const vivo = await db.query("SELECT 1 FROM email_verifications WHERE user_id = $1 AND consumido_el IS NULL", [u.id]);
    expect(vivo.rowCount, 'quedó un código de recuperación vivo hacia la casilla vieja').toBe(0);
    // El segundo factor NO se toca al cambiar el correo.
    expect((await estadoMfa(u.id)).mfa_enabled).toBe(true);
    const bitacora = await db.query("SELECT 1 FROM audit_logs WHERE company_id = $1 AND object_id = $2 AND action = 'CAMBIAR_CORREO_DE_CUENTA'", [fx.companyA, u.id]);
    expect(bitacora.rowCount).toBe(1);
  });

  it('correo: no pisa a otra cuenta que ya usa ese correo', async () => {
    const a = await cuenta('dup-a');
    const b = await cuenta('dup-b');
    const r = cli('correo', '--email', a.email, '--nuevo', b.email.toUpperCase(), '--motivo', 'Cambió de casilla de correo', '--verificacion', VERIFICACION, '--confirmar');
    expect(r.codigo, r.salida).toBe(3);
    const fila = await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [a.id]);
    expect(fila.rows[0]!.email).toBe(a.email);
  });
});
