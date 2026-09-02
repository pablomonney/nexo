/**
 * La nota de crédito dice qué factura corrige.
 *
 * La 0080 arregló el signo: una nota de crédito resta. Quedaba flotando sin
 * dueño — el neto del cliente era correcto y el detalle no explicaba nada. Al
 * salir a cobrar hay que reclamar 10.000 o 6.000, y la lista no lo decía.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que aplicarla traslade saldo, no lo duplique**: la factura baja lo que
 *      la nota sube, y el total del tercero no se mueve.
 *   2. **Que no se aplique más de lo que la nota vale** ni más de lo que la
 *      factura debe: dejar una factura en negativo sería decir que el cliente
 *      pagó de más sin que entrara un peso.
 *   3. **Que la nota de un tercero no corrija la factura de otro**, ni una nota
 *      a otra nota.
 *   4. **Que con plan de cuotas la corrección nombre la cuota**, porque si no
 *      el comprobante bajaría y sus cuotas no.
 *   5. **Que anularla devuelva todo a donde estaba**, sin borrar el rastro.
 *   6. **Que una nota sin aplicar aparezca en la bandeja** cuando hay facturas
 *      abiertas del mismo tercero.
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

suite('Notas aplicadas a la factura que corrigen', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let otroId: string;
  let cuitCliente: string;
  let cuitOtro: string;
  let numeroCbte = 60_000;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Un comprobante de venta del tipo que se pida, imputado al tercero. */
  const emitir = async (cbteTipo: number, total: string, party: string, cuit: string) => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="na-${stamp}-${numeroCbte}.xml"\r\n` +
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

    const op = await pedir(
      'POST',
      `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: 'VENTAS',
        cbteTipo,
        puntoVenta: 1,
        numero: numeroCbte,
        fecha: hoy,
        cuitContraparte: cuit,
        razonSocial: `Cliente na ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: total, iva: '0', noGravado: '0', exento: '0', percepciones: '0', total,
      },
    );
    expect(op.statusCode, op.body).toBe(201);
    const id = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${id}/party`, { partyId: party })).statusCode,
    ).toBe(200);
    return id;
  };

  const aplicar = (correctoraId: string, corregidaId: string, importe: string, cuotaId?: string) =>
    pedir('POST', '/tax-transaction-corrections', {
      correctoraId, corregidaId, importe, ...(cuotaId === undefined ? {} : { cuotaId }),
    });

  const pendienteDe = async (id: string): Promise<string> => {
    const r = await db.query<{ pendiente: string }>(
      `SELECT pendiente::text FROM invoice_settlement
        WHERE tax_transaction_id = $1 AND company_id = $2`,
      [id, empresa],
    );
    return r.rows[0]!.pendiente;
  };

  /** El saldo del cliente del lado de las ventas, como lo ve quien va a cobrar. */
  const saldo = async (party = clienteId): Promise<string> => {
    const r = await pedir('GET', `/parties/${party}/saldo`);
    expect(r.statusCode, r.body).toBe(200);
    const fila = r
      .json<{ antiguedad: { direccion: string; pendiente: string }[] }>()
      .antiguedad.find((f) => f.direccion === 'VENTAS');
    return fila === undefined ? '0.00' : fila.pendiente;
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
          `fundador-na-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio na ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa na ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-na-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-na-${stamp}@estudio.test`;
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

    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    cuitOtro = `33${stamp}${cuitCheckDigit(`33${stamp}`)}`;

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitCliente,
        razonSocial: `Cliente na ${stamp}`, roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
    otroId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitOtro,
        razonSocial: `Otro cliente na ${stamp}`, roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

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

  it('aplicar la nota traslada saldo: la factura baja y la nota se consume', async () => {
    const factura = await emitir(1, '10000.00', clienteId, cuitCliente);
    const nota = await emitir(3, '4000.00', clienteId, cuitCliente);

    // Antes: dos renglones, uno que dice que debe todo y otro flotando.
    expect(await pendienteDe(factura)).toBe('10000.00');
    expect(await pendienteDe(nota)).toBe('-4000.00');
    const antes = await saldo();

    const r = await aplicar(nota, factura, '4000.00');
    expect(r.statusCode, r.body).toBe(201);

    // Después: la factura debe 6.000 y la nota está consumida.
    expect(await pendienteDe(factura)).toBe('6000.00');
    expect(await pendienteDe(nota)).toBe('0.00');
    // Y el total del tercero no se movió: se trasladó, no se creó ni destruyó.
    expect(await saldo()).toBe(antes);
  });

  it('no se aplica más de lo que a la nota le queda', async () => {
    const factura = await emitir(1, '10000.00', clienteId, cuitCliente);
    const nota = await emitir(3, '1000.00', clienteId, cuitCliente);

    expect((await aplicar(nota, factura, '600.00')).statusCode).toBe(201);

    const r = await aplicar(nota, factura, '600.00');
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('EXCEDE_LA_NOTA');
  });

  it('una nota de crédito no deja la factura en negativo', async () => {
    const factura = await emitir(1, '500.00', clienteId, cuitCliente);
    const nota = await emitir(3, '2000.00', clienteId, cuitCliente);

    const r = await aplicar(nota, factura, '2000.00');
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('EXCEDE_LA_FACTURA');
  });

  it('la nota de un tercero no corrige la factura de otro', async () => {
    const ajena = await emitir(1, '3000.00', otroId, cuitOtro);
    const nota = await emitir(3, '1000.00', clienteId, cuitCliente);

    const r = await aplicar(nota, ajena, '1000.00');
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('OTRO_TERCERO');
  });

  it('una nota no corrige otra nota, ni una factura corrige nada', async () => {
    const nota = await emitir(3, '1000.00', clienteId, cuitCliente);
    const otraNota = await emitir(3, '500.00', clienteId, cuitCliente);
    const factura = await emitir(1, '2000.00', clienteId, cuitCliente);

    const encadenada = await aplicar(nota, otraNota, '500.00');
    expect(encadenada.statusCode, encadenada.body).toBe(422);
    expect(encadenada.json<{ error: string }>().error).toBe('NO_ES_FACTURA');

    const alReves = await aplicar(factura, factura, '100.00');
    expect(alReves.statusCode, alReves.body).toBe(422);
  });

  it('una nota de débito le suma a la factura que corrige', async () => {
    const factura = await emitir(1, '1000.00', clienteId, cuitCliente);
    const debito = await emitir(2, '300.00', clienteId, cuitCliente);

    expect((await aplicar(debito, factura, '300.00')).statusCode).toBe(201);

    // La factura pasa a deber 1.300 y la nota de débito queda consumida: el
    // recargo dejó de flotar y tiene dueño.
    expect(await pendienteDe(factura)).toBe('1300.00');
    expect(await pendienteDe(debito)).toBe('0.00');
  });

  it('con plan de cuotas, la corrección nombra la cuota', async () => {
    const factura = await emitir(1, '2000.00', clienteId, cuitCliente);
    const plan = await pedir('PUT', `/tax-transactions/${factura}/installments`, {
      cuotas: [
        { numero: 1, vencimiento: hoy, importe: '1000.00' },
        { numero: 2, vencimiento: hoy, importe: '1000.00' },
      ],
    });
    expect(plan.statusCode, plan.body).toBe(200);
    const nota = await emitir(3, '400.00', clienteId, cuitCliente);

    const sinCuota = await aplicar(nota, factura, '400.00');
    expect(sinCuota.statusCode, sinCuota.body).toBe(422);
    expect(sinCuota.json<{ error: string }>().error).toBe('CORRECCION_SIN_CUOTA');

    const cuotas = await pedir('GET', `/tax-transactions/${factura}/installments`);
    expect(cuotas.statusCode, cuotas.body).toBe(200);
    const primera = cuotas.json<{ cuotas: { id: string; numero: number }[] }>().cuotas
      .find((c) => c.numero === 1)!;

    expect((await aplicar(nota, factura, '400.00', primera.id)).statusCode).toBe(201);

    // La cuota bajó, no solo el comprobante: sin esto habría dos verdades
    // sobre la misma deuda.
    const cuota = await db.query<{ pendiente: string }>(
      `SELECT pendiente::text FROM installment_settlement
        WHERE installment_id = $1 AND company_id = $2`,
      [primera.id, empresa],
    );
    expect(cuota.rows[0]!.pendiente).toBe('600.00');
    expect(await pendienteDe(factura)).toBe('1600.00');
  });

  it('anular la corrección devuelve todo a donde estaba, sin borrar el rastro', async () => {
    const factura = await emitir(1, '5000.00', clienteId, cuitCliente);
    const nota = await emitir(3, '2000.00', clienteId, cuitCliente);

    const alta = await aplicar(nota, factura, '2000.00');
    expect(alta.statusCode, alta.body).toBe(201);
    const correccionId = alta.json<{ id: string }>().id;
    expect(await pendienteDe(factura)).toBe('3000.00');

    const anulada = await pedir(
      'POST', `/tax-transaction-corrections/${correccionId}/cancel`,
      { motivo: 'La nota correspondía a otra factura' },
    );
    expect(anulada.statusCode, anulada.body).toBe(200);

    expect(await pendienteDe(factura)).toBe('5000.00');
    expect(await pendienteDe(nota)).toBe('-2000.00');

    // El rastro queda: la corrección anulada sigue en la lista del comprobante.
    const detalle = await pedir('GET', `/tax-transactions/${nota}/correcciones`);
    expect(detalle.statusCode, detalle.body).toBe(200);
    const filas = detalle.json<{ correcciones: { id: string; status: string }[] }>().correcciones;
    expect(filas.find((c) => c.id === correccionId)!.status).toBe('ANULADA');
  });

  it('una corrección no se borra por más que se intente', async () => {
    const factura = await emitir(1, '1000.00', clienteId, cuitCliente);
    const nota = await emitir(3, '400.00', clienteId, cuitCliente);
    const alta = await aplicar(nota, factura, '400.00');
    const id = alta.json<{ id: string }>().id;

    await expect(
      db.query('DELETE FROM tax_transaction_corrections WHERE id = $1', [id]),
    ).rejects.toThrow(/E_CORR_NO_SE_BORRA/);
  });

  it('la nota sin aplicar aparece en la bandeja habiendo facturas abiertas', async () => {
    const cliente = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `34${stamp}${cuitCheckDigit(`34${stamp}`)}`,
        razonSocial: `Cliente bandeja na ${stamp}`, roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
    const cuit = `34${stamp}${cuitCheckDigit(`34${stamp}`)}`;

    await emitir(1, '9000.00', cliente, cuit);
    const nota = await emitir(3, '1000.00', cliente, cuit);

    const bandeja = await pedir('GET', '/work-queue?entidad=tax_transactions&limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    const item = bandeja
      .json<{ items: { rama: string; entityId: string; bloquea: boolean }[] }>()
      .items.find((i) => i.entityId === nota && i.rama === 'NOTA_SIN_APLICAR');
    expect(item, 'la nota sin aplicar tiene que estar en la bandeja').toBeDefined();
    expect(item!.bloquea, 'el saldo ya es correcto: avisar no es bloquear').toBe(false);

    // Y el listado del tercero la ofrece con las facturas que podría corregir.
    const sinAplicar = await pedir('GET', `/parties/${cliente}/notas-sin-aplicar`);
    expect(sinAplicar.statusCode, sinAplicar.body).toBe(200);
    const fila = sinAplicar
      .json<{ notas: { id: string; sinAplicar: string; facturasAbiertas: number }[] }>()
      .notas.find((n) => n.id === nota);
    expect(fila).toBeDefined();
    expect(fila!.sinAplicar).toBe('-1000.00');
    expect(fila!.facturasAbiertas).toBeGreaterThan(0);
  });
});
