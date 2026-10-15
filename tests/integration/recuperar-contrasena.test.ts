/**
 * «Olvidé mi contraseña»: `POST /auth/recuperar` y `POST /auth/restablecer`.
 *
 * Hasta el 2026-10-15 no existía: quien perdía la contraseña no tenía salida (los dos scripts de reseteo del repositorio
 * están atados a una cuenta de demostración y a la base local). Como el alta, es una ruta que cambia el acceso a una
 * cuenta **sin sesión**, así que lo que se prueba no es que ande sino que no sea una puerta abierta:
 *
 *   1. no se averigua quién usa NEXO (la respuesta no depende de que la cuenta exista);
 *   2. el código no se devuelve por ningún lado: sale por el cuerpo del mensaje y nada más;
 *   3. sirve una sola vez, vence, y pedir otro mata al anterior;
 *   4. cambiar la contraseña cierra las sesiones y limpia el bloqueo, **pero no toca el segundo factor**;
 *   5. queda constancia en la bitácora de la empresa, sin la contraseña.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';
const NUEVA = 'otra-contrasena-todavia-mas-larga';

suite('Recuperar la contraseña', () => {
  let app: FastifyInstance;
  let db: Client;
  let fx: Fixture;
  let stamp: string;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    fx = await seed(db, 'recup');
    stamp = await sufijoUnico(db);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  const pedir = (email: string) => app.inject({ method: 'POST', url: '/auth/recuperar', payload: { email } });
  const restablecer = (token: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/restablecer', payload: { token, password } });
  const entrar = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

  /** Un usuario ACTIVO (alta + confirmación, como en producción), con contraseña `PASSWORD`. */
  const usuarioActivo = async (etiqueta: string): Promise<{ email: string; id: string }> => {
    const email = `${etiqueta}-${stamp}@estudio.test`;
    const alta = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD, fullName: 'Quien recupera' } });
    expect(alta.statusCode, alta.body).toBe(200);
    const m = await db.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM email_outbox WHERE destinatario = $1 AND tipo = 'VERIFICACION_DE_ALTA' ORDER BY creado_el DESC LIMIT 1`,
      [email],
    );
    const token = /\n\n([A-Za-z0-9_-]{20,})\n/u.exec(m.rows[0]!.cuerpo)![1]!;
    const ok = await app.inject({ method: 'POST', url: '/auth/verificar-correo', payload: { token } });
    expect(ok.statusCode, ok.body).toBe(200);
    const id = (await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email])).rows[0]!.id;
    return { email, id };
  };

  /** El código, leído como lo leería el operador: de la bandeja, con la conexión del operador. */
  const codigoDeLaBandeja = async (email: string): Promise<string> => {
    const r = await db.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM email_outbox WHERE destinatario = $1 AND tipo = 'RECUPERACION' ORDER BY creado_el DESC LIMIT 1`,
      [email],
    );
    const m = /\n\n([A-Za-z0-9_-]{20,})\n/u.exec(r.rows[0]?.cuerpo ?? '');
    if (m === null) throw new Error('el mensaje no trae código');
    return m[1]!;
  };
  const mensajes = async (email: string, tipo: string): Promise<number> =>
    Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM email_outbox WHERE destinatario = $1 AND tipo = $2', [email, tipo])).rows[0]!.n);

  it('contesta lo mismo exista la cuenta o no (no se averigua quién usa NEXO)', async () => {
    const u = await usuarioActivo('existe');
    const conCuenta = await pedir(u.email);
    const sinCuenta = await pedir(`no-existe-${stamp}@estudio.test`);
    expect(conCuenta.statusCode).toBe(200);
    expect(sinCuenta.statusCode).toBe(conCuenta.statusCode);
    expect(sinCuenta.json<{ mensaje: string }>().mensaje).toBe(conCuenta.json<{ mensaje: string }>().mensaje);
    // …y sólo con cuenta salió un mensaje.
    expect(await mensajes(u.email, 'RECUPERACION')).toBe(1);
    expect(await mensajes(`no-existe-${stamp}@estudio.test`, 'RECUPERACION')).toBe(0);
  });

  it('una cuenta sin confirmar no recibe nada (a ella se le resuelve con «No me llegó»)', async () => {
    const email = `pendiente-${stamp}@estudio.test`;
    await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password: PASSWORD, fullName: 'Pendiente' } });
    const r = await pedir(email);
    expect(r.statusCode).toBe(200);
    expect(await mensajes(email, 'RECUPERACION')).toBe(0);
  });

  it('el código no se devuelve por ningún lado y se guarda sólo hasheado', async () => {
    const u = await usuarioActivo('sin-codigo');
    const r = await pedir(u.email);
    const codigo = await codigoDeLaBandeja(u.email);
    expect(r.body).not.toContain(codigo);
    const guardado = await db.query<{ token_hash: string }>(`SELECT token_hash FROM email_verifications WHERE user_id = $1 AND proposito = 'RECUPERACION'`, [u.id]);
    expect(guardado.rows[0]!.token_hash).not.toBe(codigo);
    expect(guardado.rows[0]!.token_hash).toHaveLength(64);
  });

  it('con el código se elige la contraseña nueva: la vieja deja de servir, la nueva sirve, y el código sirve UNA vez', async () => {
    const u = await usuarioActivo('cambia');
    await pedir(u.email);
    const codigo = await codigoDeLaBandeja(u.email);

    const r = await restablecer(codigo, NUEVA);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ estado: string }>().estado).toBe('RESTABLECIDA');
    expect(r.body).not.toContain(NUEVA);

    expect((await entrar(u.email, PASSWORD)).statusCode, 'la contraseña vieja sigue sirviendo').toBe(401);
    expect((await entrar(u.email, NUEVA)).statusCode).toBe(200);

    const otraVez = await restablecer(codigo, 'una-tercera-contrasena-larga');
    expect(otraVez.statusCode).toBe(400);
    expect((await entrar(u.email, NUEVA)).statusCode, 'el código reusado cambió la contraseña').toBe(200);

    // Y avisó a la dirección de la cuenta, sin repetir la contraseña.
    expect(await mensajes(u.email, 'AVISO')).toBeGreaterThanOrEqual(1);
    const aviso = await db.query<{ cuerpo: string }>(`SELECT cuerpo FROM email_outbox WHERE destinatario = $1 AND tipo = 'AVISO' ORDER BY creado_el DESC LIMIT 1`, [u.email]);
    expect(aviso.rows[0]!.cuerpo).not.toContain(NUEVA);
  });

  it('un código inexistente y uno ya usado dan el mismo mensaje (no dice si alguna vez fue válido)', async () => {
    const u = await usuarioActivo('mismo-mensaje');
    await pedir(u.email);
    const codigo = await codigoDeLaBandeja(u.email);
    await restablecer(codigo, NUEVA);
    const usado = await restablecer(codigo, NUEVA);
    const inventado = await restablecer('un-codigo-que-nunca-existio-123456', NUEVA);
    expect(usado.statusCode).toBe(400);
    expect(inventado.statusCode).toBe(400);
    expect(inventado.json<{ message?: string; mensaje?: string }>()).toEqual(usado.json<{ message?: string; mensaje?: string }>());
  });

  it('cambiar la contraseña CIERRA todas las sesiones de la cuenta', async () => {
    const u = await usuarioActivo('sesiones');
    const sesion = (await entrar(u.email, PASSWORD)).json<{ token: string }>().token;
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${sesion}` } })).statusCode).toBe(200);

    await pedir(u.email);
    expect((await restablecer(await codigoDeLaBandeja(u.email), NUEVA)).statusCode).toBe(200);

    const despues = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${sesion}` } });
    expect(despues.statusCode, 'una sesión anterior sobrevivió al cambio de contraseña').toBe(401);
  });

  it('limpia el bloqueo por intentos fallidos', async () => {
    const u = await usuarioActivo('bloqueada');
    await db.query(`UPDATE users SET failed_login_count = 5, locked_until = now() + interval '15 minutes' WHERE id = $1`, [u.id]);
    expect((await entrar(u.email, PASSWORD)).statusCode, 'precondición: la cuenta tiene que estar bloqueada').not.toBe(200);

    await pedir(u.email);
    expect((await restablecer(await codigoDeLaBandeja(u.email), NUEVA)).statusCode).toBe(200);
    const fila = await db.query<{ failed_login_count: number; locked_until: string | null }>('SELECT failed_login_count, locked_until FROM users WHERE id = $1', [u.id]);
    expect(fila.rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
    expect((await entrar(u.email, NUEVA)).statusCode).toBe(200);
  });

  it('NO toca el segundo factor: recuperar la contraseña por correo no es una forma de saltearlo', async () => {
    const u = await usuarioActivo('con-mfa');
    await db.query(`UPDATE users SET mfa_enabled = true, mfa_secret_encrypted = 'cifrado-de-prueba', mfa_confirmed_at = now() WHERE id = $1`, [u.id]);
    const antes = await db.query('SELECT mfa_enabled, mfa_secret_encrypted, mfa_confirmed_at FROM users WHERE id = $1', [u.id]);

    await pedir(u.email);
    expect((await restablecer(await codigoDeLaBandeja(u.email), NUEVA)).statusCode).toBe(200);

    const despues = await db.query('SELECT mfa_enabled, mfa_secret_encrypted, mfa_confirmed_at FROM users WHERE id = $1', [u.id]);
    expect(despues.rows[0]).toEqual(antes.rows[0]);
    expect(despues.rows[0]!.mfa_enabled).toBe(true);
  });

  it('el código vence', async () => {
    const u = await usuarioActivo('vence');
    await pedir(u.email);
    const codigo = await codigoDeLaBandeja(u.email);
    await db.query(
      `UPDATE email_verifications SET creado_el = now() - interval '3 hours', expira_el = now() - interval '2 hours' WHERE user_id = $1 AND proposito = 'RECUPERACION'`,
      [u.id],
    );
    const r = await restablecer(codigo, NUEVA);
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toMatch(/venci/u);
    expect((await entrar(u.email, PASSWORD)).statusCode, 'la contraseña no tenía que cambiar').toBe(200);
  });

  it('una contraseña corta se rechaza SIN consumir el código', async () => {
    const u = await usuarioActivo('corta');
    await pedir(u.email);
    const codigo = await codigoDeLaBandeja(u.email);
    expect((await restablecer(codigo, 'corta')).statusCode).toBe(400);
    expect((await restablecer(codigo, NUEVA)).statusCode, 'el rechazo por contraseña corta consumió el código').toBe(200);
  });

  it('pedir otro código mata al anterior; y no salen dos mensajes en el mismo minuto', async () => {
    const u = await usuarioActivo('doble');
    await pedir(u.email);
    const primero = await codigoDeLaBandeja(u.email);
    await pedir(u.email); // dentro del minuto: no sale otro mensaje
    expect(await mensajes(u.email, 'RECUPERACION'), 'sin freno, esta ruta llena la bandeja de cualquiera').toBe(1);
    expect((await restablecer(primero, NUEVA)).statusCode, 'el primero tenía que seguir vivo').toBe(200);

    const v = await usuarioActivo('doble-b');
    await pedir(v.email);
    const viejo = await codigoDeLaBandeja(v.email);
    // Pasado el freno, otro pedido invalida el anterior.
    await db.query(`UPDATE email_verifications SET creado_el = now() - interval '5 minutes', expira_el = now() + interval '55 minutes' WHERE user_id = $1 AND proposito = 'RECUPERACION'`, [v.id]);
    await pedir(v.email);
    expect(await mensajes(v.email, 'RECUPERACION')).toBe(2);
    expect((await restablecer(viejo, NUEVA)).statusCode, 'el código anterior seguía vivo').toBe(400);
    expect((await restablecer(await codigoDeLaBandeja(v.email), NUEVA)).statusCode).toBe(200);
  });

  it('deja constancia en la bitácora de la empresa de la cuenta, sin la contraseña', async () => {
    const u = await usuarioActivo('bitacora');
    await db.query(
      `INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from)
       SELECT $1, $2, r.id, CURRENT_DATE FROM roles r WHERE r.code = 'CONTADOR'`,
      [u.id, fx.companyA],
    );
    await pedir(u.email);
    expect((await restablecer(await codigoDeLaBandeja(u.email), NUEVA)).statusCode).toBe(200);

    const fila = await db.query<{ action: string; actor_id: string; object_id: string; old_value: unknown; new_value: unknown; motivo: string }>(
      `SELECT action, actor_id, object_id, old_value, new_value, motivo FROM audit_logs WHERE company_id = $1 AND action = 'RESTABLECER_CONTRASENA' AND object_id = $2`,
      [fx.companyA, u.id],
    );
    expect(fila.rows).toHaveLength(1);
    expect(fila.rows[0]!.actor_id).toBe('system:recuperacion');
    expect(JSON.stringify(fila.rows[0])).not.toContain(NUEVA);
    expect(JSON.stringify(fila.rows[0])).not.toMatch(/argon2/iu);
  });
});
