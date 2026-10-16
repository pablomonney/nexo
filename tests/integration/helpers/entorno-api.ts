/**
 * Un entorno de pruebas de la API listo para usar: servidor, base, una empresa y una persona con los roles
 * de contador y administrador, con el segundo factor ya verificado.
 *
 * Es el armado que cada suite de integración repetía a mano (ochenta líneas en `caja.test.ts`,
 * `stock.test.ts`, `ordenes-de-pago.test.ts`…). Las suites nuevas lo usan desde acá; las viejas siguen con el suyo
 * hasta que se las toque por otra razón: reescribirlas solo para sacar la duplicación sería cambiar pruebas
 * que andan sin un motivo.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { connect, type Client } from './db.js';
import { sufijoUnico } from './identificadores.js';

const PASSWORD = 'una-contrasena-suficientemente-larga';

export interface EntornoApi {
  readonly app: FastifyInstance;
  readonly db: Client;
  readonly stamp: string;
  readonly empresa: string;
  readonly organizationId: string;
  readonly userId: string;
  /** El token de la persona (con el segundo factor ya verificado), para las pruebas que necesitan armar el pedido a mano. */
  readonly token: string;
  /** Un día fijo y válido (hoy, en UTC; las suites que dependen del borde horario fijan el suyo). */
  readonly hoy: string;
  pedir(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  /** Cierra el servidor, la conexión y el pool. */
  cerrar(): Promise<void>;
}

export async function crearEntorno(etiqueta: string): Promise<EntornoApi> {
  initPool(process.env['DATABASE_URL']!);
  const app = await buildServer(process.env['DEBUG_API'] ? { logger: true } : undefined);
  await app.ready();
  const db = await connect();
  const stamp = await sufijoUnico(db);

  const { hash: argonHash } = await import('@node-rs/argon2');
  const hashDeLaClave = await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });

  const fundadorId = (
    await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [
      `fundador-${etiqueta}-${stamp}@estudio.test`,
      'Fundador',
      hashDeLaClave,
    ])
  ).rows[0]!.id;

  const organizationId = (
    await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
      `Estudio ${etiqueta} ${stamp}`,
      withCheckDigit(`30${stamp}`),
      fundadorId,
    ])
  ).rows[0]!.create_organization;

  const empresa = (
    await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
      fundadorId,
      organizationId,
      `Empresa ${etiqueta} ${stamp}`,
      withCheckDigit(`27${stamp}`),
      'SA',
      'AR-C',
      'IGJ',
      '12-31',
    ])
  ).rows[0]!.create_company;

  const login = async (email: string): Promise<string> =>
    (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).json<{ token: string }>().token;

  const tokenFundador = await login(`fundador-${etiqueta}-${stamp}@estudio.test`);
  const email = `operador-${etiqueta}-${stamp}@estudio.test`;
  const userId = (
    await app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/users`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { email, fullName: 'Operador', password: PASSWORD, level: 'MEMBER' },
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

  const inicial = await login(email);
  const secret = (
    await app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` } })
  ).json<{ secret: string }>().secret;
  await app.inject({
    method: 'POST',
    url: '/auth/mfa/confirm',
    payload: { code: totp(secret, Date.now()) },
    headers: { authorization: `Bearer ${inicial}` },
  });
  const token = await login(email);
  await app.inject({
    method: 'POST',
    url: '/auth/mfa/verify',
    payload: { code: totp(secret, Date.now()) },
    headers: { authorization: `Bearer ${token}` },
  });

  return {
    app,
    db,
    stamp,
    empresa,
    organizationId,
    userId,
    token,
    hoy: new Date().toISOString().slice(0, 10),
    pedir: (method, url, payload, headers = {}) =>
      app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa, ...headers },
        ...(payload === undefined ? {} : { payload }),
      }),
    cerrar: async () => {
      await app.close();
      await db.end();
      await closePool();
    },
  };
}
