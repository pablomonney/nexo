/**
 * La conciliación bancaria, por el camino que antes no existía.
 *
 * ## Qué encontró la auditoría de selectores
 *
 * La consola pedía el identificador de la conciliación con un `prompt`, y ese
 * identificador **no se podía conseguir**: `bank_reconciliations` no tenía ni un
 * solo `INSERT` en toda la aplicación —ni ruta, ni trigger—. Se podían proponer
 * coincidencias y confirmarlas, pero no había forma de crear la conciliación
 * que las sostiene. El test de la fase la insertaba por SQL directo, así que el
 * hueco no aparecía.
 *
 * Un campo que pide un uuid sin decir de dónde sacarlo casi siempre está
 * tapando que no hay de dónde.
 *
 * ## Qué defiende este archivo
 *
 *   1. **Que la conciliación se pueda abrir por HTTP.**
 *   2. **Que el saldo del libro no se declare**: sale del Mayor.
 *   3. **Que el acta no cierre sola**: confirmar con diferencia se rechaza.
 *   4. **Que no haya dos actas del mismo período.**
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('Conciliación bancaria por HTTP', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let cuentaCierra: string;
  let cuentaNoCierra: string;
  let anio: number;
  let desde: string;
  let hasta: string;

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

    anio = new Date().getUTCFullYear();
    desde = `${anio}-01-01`;
    // El corte es hoy: tiene que caer dentro de un período abierto.
    hasta = new Date().toISOString().slice(0, 10);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-conc-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio conc ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa conc ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-conc-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-conc-${stamp}@estudio.test`;
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
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
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
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.03', name: 'Banco que cierra', type: 'ACTIVO' },
      { code: '1.1.04', name: 'Banco que no cierra', type: 'ACTIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }

    // El alta de cuentas bancarias por HTTP no existe todavía, y este archivo
    // prueba la conciliación y no el alta. Se insertan directo, igual que hace
    // la suite de cheques.
    for (const [codigo, destino] of [['1.1.03', 'cierra'], ['1.1.04', 'no cierra']] as const) {
      const cuenta = await db.query<{ id: string }>(
        'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
        [empresa, codigo],
      );
      const banco = await db.query<{ id: string }>(
        `INSERT INTO bank_accounts (company_id, account_id, bank_name)
         VALUES ($1,$2,$3) RETURNING id`,
        [empresa, cuenta.rows[0]!.id, `Banco ${destino} ${stamp}`],
      );
      if (codigo === '1.1.03') cuentaCierra = banco.rows[0]!.id;
      else cuentaNoCierra = banco.rows[0]!.id;
    }

    // Un movimiento real en el Mayor: la cuenta que cierra queda en 1.000.
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: hasta,
      description: 'Cobranza acreditada',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.03', debit: '1000.00', credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: '1000.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Cobranza registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('la conciliación se abre por HTTP, y el saldo del libro sale del Mayor', async () => {
    const r = await pedir('POST', `/banks/accounts/${cuentaCierra}/reconciliations`, {
      desde,
      hasta,
      saldoExtracto: '1000.00',
    });
    expect(r.statusCode, r.body).toBe(201);

    const c = r.json<{ reconciliationId: string; saldoLibro: string; alcance: string }>();
    // No se declaró: se derivó del asiento aprobado de arriba.
    expect(c.saldoLibro).toBe('1000.00');
    expect(c.alcance).toContain('no se declara');
    expect(c.reconciliationId).toBeTruthy();
  });

  it('la lista la muestra con su diferencia, que es el acta', async () => {
    const r = await pedir('GET', '/banks/reconciliations');
    expect(r.statusCode).toBe(200);
    const lista = r.json<{
      conciliaciones: { status: string; saldoLibro: string; diferencia: string;
                        coincidencias: number }[];
    }>().conciliaciones;

    expect(lista).toHaveLength(1);
    expect(lista[0]!.status).toBe('BORRADOR');
    expect(lista[0]!.saldoLibro).toBe('1000.00');
    // Extracto 1.000 + ajustes 0 − libro 1.000 = 0: el acta cierra.
    expect(Number(lista[0]!.diferencia)).toBe(0);
    expect(lista[0]!.coincidencias).toBe(0);
  });

  it('no hay dos actas del mismo período para la misma cuenta', async () => {
    const r = await pedir('POST', `/banks/accounts/${cuentaCierra}/reconciliations`, {
      desde, hasta, saldoExtracto: '1000.00',
    });
    // Dos actas confirmadas del mismo mes son dos verdades sobre el mismo saldo.
    expect(r.statusCode).toBe(409);
    expect(r.json<{ message: string }>().message).toContain('dos verdades');
  });

  it('un acta que no cierra no se confirma', async () => {
    // La otra cuenta no tiene movimientos: el libro está en cero y el extracto
    // dice 900. La diferencia es real y la base no deja confirmarla.
    const abierta = await pedir('POST', `/banks/accounts/${cuentaNoCierra}/reconciliations`, {
      desde, hasta, saldoExtracto: '900.00',
    });
    expect(abierta.statusCode, abierta.body).toBe(201);
    expect(abierta.json<{ saldoLibro: string }>().saldoLibro).toBe('0');

    const id = abierta.json<{ reconciliationId: string }>().reconciliationId;
    const confirmar = await pedir('POST', `/banks/reconciliations/${id}/confirm`);
    expect(confirmar.statusCode, confirmar.body).toBe(409);

    // Y sigue en borrador: un intento fallido no deja el acta a medio confirmar.
    const estado = await db.query<{ status: string }>(
      'SELECT status FROM bank_reconciliations WHERE id = $1',
      [id],
    );
    expect(estado.rows[0]!.status).toBe('BORRADOR');
  });

  it('el acta que cierra se confirma, y queda firmada', async () => {
    const lista = (await pedir('GET', '/banks/reconciliations?status=BORRADOR'))
      .json<{ conciliaciones: { id: string; diferencia: string }[] }>().conciliaciones;
    const cierra = lista.find((c) => Number(c.diferencia) === 0)!;

    expect((await pedir('POST', `/banks/reconciliations/${cierra.id}/confirm`)).statusCode)
      .toBe(200);

    const fila = await db.query<{ status: string; confirmed_by: string | null }>(
      'SELECT status, confirmed_by FROM bank_reconciliations WHERE id = $1',
      [cierra.id],
    );
    expect(fila.rows[0]!.status).toBe('CONFIRMADA');
    // Sin firma no hay confirmación: lo exige un CHECK desde la 0022.
    expect(fila.rows[0]!.confirmed_by).not.toBeNull();
  });

  it('sin período que contenga la fecha de corte, no se abre', async () => {
    const r = await pedir('POST', `/banks/accounts/${cuentaCierra}/reconciliations`, {
      desde: `${anio - 5}-01-01`,
      hasta: `${anio - 5}-01-31`,
      saldoExtracto: '0',
    });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ message: string }>().message).toContain('período');
  });
});
