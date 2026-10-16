/**
 * `GET /subscription` dice a dónde transferir (cobro manual), y el aviso de cobranza que se encola lo lleva.
 *
 * La configuración se lee al importar el servidor, así que acá se declara ANTES de importarlo (import dinámico). Lo que no
 * sirve (un CBU con error de tipeo) tiene que verse como «no hay datos», no como una cuenta equivocada.
 */

import { closePool, initPool } from '@aai/db';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';
const CBU = '2850590940090418135201';

suite('Datos de cobro en la suscripción y en los avisos', () => {
  let app: FastifyInstance;
  let db: Client;
  let empresa: string;
  let token: string;

  beforeAll(async () => {
    process.env['NEXO_COBRO_TITULAR'] = 'NEXO Servicios SRL';
    process.env['NEXO_COBRO_CBU'] = CBU;
    process.env['NEXO_COBRO_ALIAS'] = 'nexo.cobros';
    const { buildServer } = await import('@aai/api/server');
    initPool(process.env['DATABASE_URL']!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    const stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const fundadorId = (await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [`fundador-dc-${stamp}@estudio.test`, 'Fundador', clave])).rows[0]!.id;
    const organizationId = (await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [`Estudio dc ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId])).rows[0]!.create_organization;
    empresa = (await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [fundadorId, organizationId, `Empresa dc ${stamp}`, withCheckDigit(`27${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31'])).rows[0]!.create_company;
    const tokenFundador = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `fundador-dc-${stamp}@estudio.test`, password: PASSWORD } })).json<{ token: string }>().token;
    const email = `admin-dc-${stamp}@estudio.test`;
    const userId = (await app.inject({ method: 'POST', url: `/organizations/${organizationId}/users`, headers: { authorization: `Bearer ${tokenFundador}` }, payload: { email, fullName: 'Administradora', password: PASSWORD, level: 'MEMBER' } })).json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/companies/${empresa}/roles`, headers: { authorization: `Bearer ${tokenFundador}` }, payload: { userId, role: 'ADMINISTRADOR' } });
    const inicial = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).json<{ token: string }>().token;
    const secret = (await app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` } })).json<{ secret: string }>().secret;
    await app.inject({ method: 'POST', url: '/auth/mfa/confirm', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${inicial}` } });
    token = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).json<{ token: string }>().token;
    await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${token}` } });
  });

  afterAll(async () => {
    for (const k of ['NEXO_COBRO_TITULAR', 'NEXO_COBRO_CBU', 'NEXO_COBRO_ALIAS']) delete process.env[k];
    await app.close();
    await db.end();
    await closePool();
  });

  it('GET /subscription trae a dónde transferir', async () => {
    const r = await app.inject({ method: 'GET', url: '/subscription', headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ cobro: unknown }>().cobro).toEqual({ medio: 'TRANSFERENCIA', titular: 'NEXO Servicios SRL', cbu: CBU, alias: 'nexo.cobros', banco: null, cuit: null });
  });

  it('el aviso de cobranza que se encola lleva el CBU y no lleva importes', async () => {
    const { encolarAvisoDeCobranza } = await import('@aai/api/billing/avisos');
    const tx = { query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]) };
    const r = await encolarAvisoDeCobranza(tx, empresa, 'SUSPENSION_PROXIMA', { empresa: 'Empresa dc', diasParaLaSuspension: 2 });
    expect(r.estado).toBe('ENCOLADO');
    const cuerpos = await db.query<{ cuerpo: string }>(`SELECT cuerpo FROM email_outbox WHERE tipo = 'AVISO_DE_COBRANZA' AND asunto LIKE '%Empresa dc%' ORDER BY creado_el DESC LIMIT 1`);
    expect(cuerpos.rows[0]!.cuerpo).toContain(`CBU/CVU: ${CBU}`);
    expect(cuerpos.rows[0]!.cuerpo).toContain('NEXO Servicios SRL');
  });
});
