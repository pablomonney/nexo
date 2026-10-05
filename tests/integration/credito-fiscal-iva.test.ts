/**
 * `GET /vat/credito-fiscal/:txId` — que la respuesta se pueda mandar.
 *
 * `evaluarCreditoFiscal` devuelve `ivaDiscriminado` como `Money`, con
 * `amount: bigint`. La ruta lo reenviaba tal cual, sin pasar por
 * `toDecimalString` como hace el resto de este mismo archivo con cada Money
 * — y `JSON.stringify` no sabe serializar un bigint: la ruta respondía 500
 * ante cualquier comprobante de compra, siempre. No es un caso de borde: es
 * el único camino de esta ruta.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('GET /vat/credito-fiscal/:txId no se cae al serializar', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-cf-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio cf ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa cf ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-cf-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-cf-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId, role },
      });
    }

    const inicial = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('una compra con IVA discriminado responde 200 y no un 500 de serialización', async () => {
    const cuitProveedor = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    const hoy = new Date().toISOString().slice(0, 10);

    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="cf-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c></c>\r\n--X--\r\n`;
    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);

    const op = await pedir(
      'POST',
      `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: 'COMPRAS',
        cbteTipo: 1,
        puntoVenta: 1,
        numero: 1,
        fecha: hoy,
        cuitContraparte: cuitProveedor,
        razonSocial: `Proveedor cf ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: '1000.00', iva: '210.00', noGravado: '0', exento: '0', percepciones: '0',
        total: '1210.00',
      },
    );
    expect(op.statusCode, op.body).toBe(201);
    const txId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    const r = await pedir('GET', `/vat/credito-fiscal/${txId}`);
    expect(r.statusCode, r.body).toBe(200);

    const cuerpo = r.json<{ ivaDiscriminado: unknown; estado: string }>();
    // El bug era justamente que esta propiedad llegaba como bigint y rompía
    // el `JSON.stringify` de la respuesta entera — acá ya se parseó bien.
    expect(typeof cuerpo.ivaDiscriminado).toBe('string');
    expect(cuerpo.ivaDiscriminado).toBe('210.00');
    expect(typeof cuerpo.estado).toBe('string');
  });
});
