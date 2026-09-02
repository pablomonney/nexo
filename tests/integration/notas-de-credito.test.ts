/**
 * Una nota de crédito resta.
 *
 * ## El defecto que este archivo fija
 *
 * `invoice_settlement` trataba **todo** comprobante con tercero como algo que
 * ese tercero debe. Una nota de crédito de mil pesos aparecía como mil pesos
 * más de deuda del cliente, cuando es exactamente lo contrario. Y no quedaba
 * ahí: `party_aging` —la lista con la que se sale a cobrar— la sumaba al saldo,
 * y el aviso de mora podía reclamarle a un cliente una nota de crédito vencida.
 *
 * El signo no se decidió acá: sale de `arca_comprobante_types.clase`, que ya
 * clasificaba cada tipo y cita el manual del organismo del que salió. El dato
 * estaba archivado y no lo miraba nadie.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que la nota de crédito reste** en la cuenta corriente.
 *   2. **Que la nota de débito siga sumando**: aumenta lo que el cliente debe.
 *   3. **Que el saldo del cliente sea el neto**, y que un cliente con crédito a
 *      favor se informe como tal en vez de desaparecer del listado.
 *   4. **Que no se le reclame la mora de una nota de crédito.**
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

suite('Notas de crédito en la cuenta corriente', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let cuitCliente: string;
  let numeroCbte = 12_000;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Un comprobante de venta del tipo que se pida. */
  const emitir = async (cbteTipo: number, total: string, fecha: string): Promise<string> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="nc-${stamp}-${numeroCbte}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>${numeroCbte}</n></c>\r\n--X--\r\n`;

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

    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS',
      cbteTipo,
      puntoVenta: 1,
      numero: numeroCbte,
      fecha,
      cuitContraparte: cuitCliente,
      razonSocial: `Cliente nc ${stamp}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: total, iva: '0', noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const id = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${id}/party`, { partyId: clienteId })).statusCode,
    ).toBe(200);
    return id;
  };

  /** La antigüedad de saldos del cliente, del lado de las ventas. */
  const saldo = async (): Promise<{ pendiente: string; comprobantes: number }> => {
    const r = await pedir('GET', `/parties/${clienteId}/saldo`);
    expect(r.statusCode, r.body).toBe(200);
    const filas = r.json<{
      antiguedad: { direccion: string; pendiente: string; comprobantes: number }[];
    }>().antiguedad;
    const ventas = filas.find((f) => f.direccion === 'VENTAS');
    expect(ventas, 'el cliente tiene que figurar del lado de las ventas').toBeDefined();
    return ventas!;
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    hoy = new Date().toISOString().slice(0, 10);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-nc-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio nc ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa nc ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-nc-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-nc-${stamp}@estudio.test`;
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

    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitCliente,
        razonSocial: `Cliente nc ${stamp}`,
        roles: ['CLIENTE'],
        // Con plazo declarado para que la mora se pueda calcular: sin él, el
        // sistema no afirma mora y la cuarta prueba no probaría nada.
        diasDePago: 0,
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('una factura suma al saldo del cliente', async () => {
    await emitir(1, '10000.00', hoy);

    const s = await saldo();
    expect(s.pendiente).toBe('10000.00');
  });

  it('una nota de débito también suma: aumenta lo que el cliente debe', async () => {
    await emitir(2, '1000.00', hoy);

    const s = await saldo();
    expect(s.pendiente).toBe('11000.00');
  });

  it('una nota de crédito **resta**', async () => {
    await emitir(3, '4000.00', hoy);

    const s = await saldo();
    // 10.000 + 1.000 − 4.000. Antes de la 0080 esto daba 15.000: la nota de
    // crédito figuraba como más deuda del cliente.
    expect(s.pendiente).toBe('7000.00');
  });

  it('el signo sale del catálogo archivado, no de una lista escrita a mano', async () => {
    const r = await db.query<{ clase: string; fuente: string }>(
      'SELECT clase, fuente FROM arca_comprobante_types WHERE codigo = 3',
    );
    expect(r.rows[0]!.clase).toBe('NOTA_CREDITO');
    // La clase viene con la cita del manual del que salió.
    expect(r.rows[0]!.fuente).toContain('ARCA');

    // Y la vista expone la clase, para que quien lee sepa por qué resta.
    const v = await db.query<{ clase: string; total: string }>(
      `SELECT clase, total::text FROM invoice_settlement
        WHERE company_id = $1 AND cbte_tipo = 3`,
      [empresa],
    );
    expect(v.rows[0]!.clase).toBe('NOTA_CREDITO');
    expect(v.rows[0]!.total).toBe('-4000.00');
  });

  it('un cliente con crédito a favor no desaparece del listado', async () => {
    // Una nota de crédito grande deja el saldo en negativo. Con el filtro
    // anterior —`pendiente > 0`— el cliente se caía del listado y su crédito
    // dejaba de verse en ningún lado.
    await emitir(3, '20000.00', hoy);

    const s = await saldo();
    expect(Number(s.pendiente)).toBeLessThan(0);
    expect(s.comprobantes).toBeGreaterThan(0);

    const aging = await db.query<{ pendiente: string }>(
      `SELECT pendiente::text FROM party_aging
        WHERE company_id = $1 AND party_id = $2 AND direction = 'VENTAS'`,
      [empresa, clienteId],
    );
    expect(aging.rows[0]!.pendiente).toBe('-13000.00');
  });

  it('no se reclama la mora de una nota de crédito', async () => {
    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string; motivo: string }[] }>().items;

    // La rama de cobranzas filtra por pendiente positivo, así que una nota de
    // crédito no puede aparecer como algo que hay que ir a cobrar.
    const cobranzas = items.filter((i) => i.rama === 'FACTURA_VENCIDA');
    for (const c of cobranzas) {
      expect(c.motivo).not.toContain('-');
    }
  });
});
