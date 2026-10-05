/**
 * `POST /banks/accounts/:id/reconciliations/propose` — que la respuesta se
 * pueda mandar cuando el motor encuentra una ambigüedad.
 *
 * Un movimiento con dos candidatos igual de puntuados no es un error del
 * motor: es la respuesta correcta («el empate no se resuelve», ver
 * `packages/bank-engine/src/bank-engine.test.ts`). Pero `ambiguos[].candidatos[]`
 * lleva un `importe: Money` (`amount: bigint`), y la ruta lo reenviaba tal
 * cual mientras el resto de la respuesta (`propuestas[].importe`,
 * `diferencias[].importe`, los saldos) sí pasaba por `toDecimalString`. La
 * ruta respondía 500 ante cualquier ambigüedad real — no un caso de borde,
 * el caso que esta rama del motor existe para atender.
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

suite('POST /banks/.../reconciliations/propose con una ambigüedad real', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
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
    hoy = (await db.query<{ hoy: string }>('SELECT current_date::text AS hoy')).rows[0]!.hoy;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-amb-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio amb ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa amb ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-amb-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-amb-${stamp}@estudio.test`;
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

    // El plan de cuentas es por empresa: no hay cuentas por defecto.
    for (const cuenta of [
      { code: '1.1.02', name: 'Deudores por ventas', type: 'ACTIVO', requiresThirdParty: true },
      { code: '1.1.04', name: 'Banco', type: 'ACTIVO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('dos asientos del mismo importe contra un solo movimiento no rompen la respuesta', async () => {
    const cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    const clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitCliente,
        razonSocial: `Cliente amb ${stamp}`, roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    const cuentaBancaria = await pedir('POST', '/banks/accounts', {
      banco: `Banco ambiguo ${stamp}`,
      cuentaCodigo: '1.1.04',
    });
    expect(cuentaBancaria.statusCode, cuentaBancaria.body).toBe(201);
    const bancoId = cuentaBancaria.json<{ id: string }>().id;

    // Dos asientos aprobados, mismo importe y misma fecha, con descripciones
    // que no coinciden entre sí ni con el extracto: nada que desempate.
    for (const descripcion of ['Movimiento Uno', 'Movimiento Dos']) {
      const asiento = await pedir('POST', '/journal-entries', {
        journalCode: 'BANCOS',
        entryDate: hoy,
        description: descripcion,
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.04', debit: '50000.00', credit: '0' },
          { accountCode: '1.1.02', debit: '0', credit: '50000.00', partyId: clienteId },
        ],
        source: { type: 'RECEIPT', id: null },
        manualJustification: `Prueba de ambigüedad: ${descripcion}`,
      });
      expect(asiento.statusCode, asiento.body).toBe(201);
      const asientoId = asiento.json<{ id: string }>().id;
      expect(
        (await pedir('POST', `/journal-entries/${asientoId}/approve`)).statusCode,
      ).toBe(200);
    }

    const mapeo = await pedir('POST', '/banks/statement-layouts', {
      bankAccountId: bancoId,
      nombre: 'Extracto ambiguo',
      filasEncabezado: 1,
      columnaFecha: 0,
      columnaDescripcion: 1,
      formatoFecha: 'AAAA-MM-DD',
      formatoImporte: 'ES_AR',
      signo: { tipo: 'COLUMNAS_SEPARADAS', columnaDebito: 2, columnaCredito: 3 },
    });
    expect(mapeo.statusCode, mapeo.body).toBe(201);

    const extracto = await pedir('POST', `/banks/accounts/${bancoId}/statements`, {
      layoutId: mapeo.json<{ id: string }>().id,
      desde: `${hoy.slice(0, 4)}-01-01`,
      hasta: hoy,
      saldoInicial: '0',
      saldoFinal: '50000.00',
      contenido: ['Fecha;Descripcion;Debito;Credito', `${hoy};DEBITO VARIOS;;50.000,00`].join('\n'),
    });
    expect(extracto.statusCode, extracto.body).toBe(201);

    const propuesta = await pedir(
      'POST',
      `/banks/accounts/${bancoId}/reconciliations/propose`,
      { desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy, saldoSegunExtracto: '50000.00' },
    );
    // El bug hacía que esto diera 500. Con el fix, 200 y el importe ya es string.
    expect(propuesta.statusCode, propuesta.body).toBe(200);

    const p = propuesta.json<{
      propuestas: unknown[];
      ambiguos: { movimientoId: string; candidatos: { importe: unknown }[] }[];
    }>();
    expect(p.propuestas, 'nada se resuelve solo: hay empate').toEqual([]);
    expect(p.ambiguos.length).toBeGreaterThan(0);
    expect(p.ambiguos[0]!.candidatos.length).toBeGreaterThanOrEqual(2);
    for (const candidato of p.ambiguos[0]!.candidatos) {
      expect(typeof candidato.importe).toBe('string');
      expect(candidato.importe).toBe('50000.00');
    }
  });
});
