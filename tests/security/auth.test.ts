/**
 * S-2 — Autenticación, segundo factor y sesiones.
 *
 * Cubre las exigencias de SECURITY.md §2: Argon2id, MFA obligatorio para
 * Administrador / Contador / Auditor, bloqueo progresivo, y tokens de sesión que
 * no se guardan en claro.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('S-2 — autenticación y segundo factor', () => {
  let app: FastifyInstance;
  let raw: Client;
  let stamp: string;
  let organizationId: string;
  let companyId: string;
  let contadorEmail: string;
  let contadorId: string;
  let cargadorEmail: string;

  const login = (email: string, password = PASSWORD) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    stamp = await sufijoUnico(raw);
    contadorEmail = `contador-${stamp}@estudio.test`;
    cargadorEmail = `cargador-${stamp}@estudio.test`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const contador = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [contadorEmail, 'Contador', hash],
    );
    contadorId = contador.rows[0]!.id;
    const cargador = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [cargadorEmail, 'Cargador', hash],
    );

    const org = await raw.query<{ create_organization: string }>(
      'SELECT create_organization($1, $2, $3)',
      [`Estudio auth ${stamp}`, withCheckDigit(`30${stamp}`), contadorId],
    );
    organizationId = org.rows[0]!.create_organization;
    await raw.query(
      'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, $3)',
      [organizationId, cargador.rows[0]!.id, 'MEMBER'],
    );

    const company = await raw.query<{ create_company: string }>(
      'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        contadorId, organizationId, 'Empresa auth', withCheckDigit(`33${stamp}`),
        'SRL', 'AR-C', 'IGJ', '12-31',
      ],
    );
    companyId = company.rows[0]!.create_company;

    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      contadorId, companyId, contadorId, 'CONTADOR',
    ]);
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      contadorId, companyId, cargador.rows[0]!.id, 'CARGADOR',
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  it('rechaza una contraseña incorrecta', async () => {
    const response = await login(cargadorEmail, 'no-es-la-contrasena');
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toBe('INVALID_CREDENTIALS');
  });

  it('no permite enumerar cuentas: el email inexistente responde igual', async () => {
    const inexistente = await login(`nadie-${stamp}@estudio.test`);
    const existente = await login(cargadorEmail, 'no-es-la-contrasena');
    expect(inexistente.statusCode).toBe(existente.statusCode);
    expect(inexistente.json()).toEqual(existente.json());
  });

  it('el token de sesión se guarda hasheado, nunca en claro', async () => {
    const response = await login(cargadorEmail);
    expect(response.statusCode).toBe(200);
    const token = response.json<{ token: string }>().token;

    const stored = await raw.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sessions WHERE token_hash = $1',
      [token],
    );
    expect(stored.rows[0]!.n).toBe('0');

    const { createHash } = await import('node:crypto');
    const hashed = await raw.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sessions WHERE token_hash = $1',
      [createHash('sha256').update(token).digest('hex')],
    );
    expect(hashed.rows[0]!.n).toBe('1');
  });

  it('la cookie de sesión es httpOnly y sameSite strict', async () => {
    const response = await login(cargadorEmail);
    const cookie = response.headers['set-cookie'];
    const raw_cookie = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(raw_cookie).toContain('HttpOnly');
    expect(raw_cookie).toContain('SameSite=Strict');
  });

  it('logout revoca la sesión', async () => {
    const token = (await login(cargadorEmail)).json<{ token: string }>().token;
    const before = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('una sesión expirada no autentica', async () => {
    const token = (await login(cargadorEmail)).json<{ token: string }>().token;
    const { createHash } = await import('node:crypto');
    await raw.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [
      createHash('sha256').update(token).digest('hex'),
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('un rol que exige MFA no accede a la empresa sin configurarlo', async () => {
    const token = (await login(contadorEmail)).json<{ token: string }>().token;
    const response = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toBe('MFA_SETUP_REQUIRED');
  });

  it('un rol que no exige MFA sí accede', async () => {
    const token = (await login(cargadorEmail)).json<{ token: string }>().token;
    const response = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ roles: string[] }>().roles).toContain('CARGADOR');
  });

  it('flujo completo de MFA: setup, confirm, y login posterior que lo exige', async () => {
    const token = (await login(contadorEmail)).json<{ token: string }>().token;

    const setup = await app.inject({
      method: 'POST',
      url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(setup.statusCode).toBe(200);
    const { secret, recoveryCodes } = setup.json<{ secret: string; recoveryCodes: string[] }>();
    expect(recoveryCodes).toHaveLength(10);

    // El secreto se guarda cifrado: no debe aparecer en claro en la base.
    const stored = await raw.query<{ mfa_secret_encrypted: string }>(
      'SELECT mfa_secret_encrypted FROM users WHERE id = $1',
      [contadorId],
    );
    expect(stored.rows[0]!.mfa_secret_encrypted).not.toContain(secret);
    expect(stored.rows[0]!.mfa_secret_encrypted).toMatch(/^v1\./);

    const confirm = await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);

    // A partir de acá, un login nuevo exige el segundo factor.
    const relogin = await login(contadorEmail);
    expect(relogin.json<{ mfaRequired: boolean }>().mfaRequired).toBe(true);
    const newToken = relogin.json<{ token: string }>().token;

    const blocked = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json<{ error: string }>().error).toBe('MFA_REQUIRED');

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: '000000' },
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(wrong.statusCode).toBe(401);

    const verified = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(verified.statusCode, verified.body).toBe(200);

    const allowed = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: { authorization: `Bearer ${newToken}`, 'x-company-id': companyId },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('un código de recuperación sirve una sola vez', async () => {
    const email = `recovery-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    await raw.query(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3)',
      [email, 'Recovery', await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 })],
    );

    const token = (await login(email)).json<{ token: string }>().token;
    const setup = await app.inject({
      method: 'POST',
      url: '/auth/mfa/setup',
      headers: { authorization: `Bearer ${token}` },
    });
    const { secret, recoveryCodes } = setup.json<{ secret: string; recoveryCodes: string[] }>();
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    const first = (await login(email)).json<{ token: string }>().token;
    const used = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: recoveryCodes[0] },
      headers: { authorization: `Bearer ${first}` },
    });
    expect(used.statusCode, used.body).toBe(200);

    const second = (await login(email)).json<{ token: string }>().token;
    const reused = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: recoveryCodes[0] },
      headers: { authorization: `Bearer ${second}` },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('bloquea la cuenta tras varios intentos fallidos', async () => {
    const email = `bloqueo-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    await raw.query(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3)',
      [email, 'Bloqueo', await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 })],
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(email, 'mal');
      expect(response.statusCode).toBe(401);
    }

    // Con la cuenta bloqueada, ni siquiera la contraseña correcta entra.
    const blocked = await login(email);
    expect(blocked.statusCode).toBe(429);
  });
});
