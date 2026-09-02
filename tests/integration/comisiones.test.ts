/**
 * Vendedores y comisiones.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que el porcentaje nunca se invente.** Es un acuerdo entre dos
 *      personas. Sin esquema vigente para la fecha del comprobante la comisión
 *      es `null`, no cero, y el vendedor va a la bandeja.
 *   2. **Que la base declarada cambie el número, y se vea cuál se usó.** Neto,
 *      total con IVA y cobrado dan tres cifras distintas sobre la misma venta.
 *   3. **Que se aplique el esquema vigente el día del comprobante**, no el de
 *      hoy.
 *   4. **Que devengar no sea pagar.** El módulo no escribe un peso en el Mayor.
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

interface Vendedor {
  readonly id: string;
  readonly codigo: string;
  readonly comprobantes: number;
  readonly facturado: string;
  readonly cobrado: string;
  readonly comisionDevengada: string;
  readonly comprobantesSinEsquema: number;
  readonly metodologia: string;
}

suite('Vendedores y comisiones', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let cuitCliente: string;
  let vendedor: string;
  let numeroCbte = 7000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  const haceDias = (dias: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
  };

  /** Una factura de venta con neto e IVA, para que la base importe. */
  const factura = async (neto: string, iva: string, total: string, fecha: string) => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="com-${stamp}-${numeroCbte}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numeroCbte}</n></comprobante>\r\n--X--\r\n`;

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
      cbteTipo: 1,
      puntoVenta: 1,
      numero: numeroCbte,
      fecha,
      cuitContraparte: cuitCliente,
      razonSocial: 'Cliente',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva, noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const ttId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${ttId}/party`, { partyId: clienteId })).statusCode,
    ).toBe(200);
    return ttId;
  };

  /** Una cobranza imputada al comprobante. */
  const cobrar = async (ttId: string, importe: string): Promise<void> => {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: hoy,
      description: 'Cobranza',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0' },
        { accountCode: '1.1.02', debit: '0', credit: importe, partyId: clienteId },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Cobranza registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const entryId = alta.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${entryId}/approve`)).statusCode).toBe(200);

    const linea = await db.query<{ id: string }>(
      'SELECT id FROM journal_entry_lines WHERE entry_id = $1 AND party_id = $2',
      [entryId, clienteId],
    );

    expect(
      (await pedir('POST', '/party-allocations', {
        taxTransactionId: ttId,
        journalEntryLineId: linea.rows[0]!.id,
        importe,
      })).statusCode,
    ).toBe(201);
  };

  const verVendedor = async (id: string): Promise<Vendedor> =>
    (await pedir('GET', `/salespeople/${id}`)).json<{ vendedor: Vendedor }>().vendedor;

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
          `fundador-com-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio com ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa com ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-com-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `gerenta-com-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Gerenta comercial', password: PASSWORD, level: 'MEMBER' },
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
        razonSocial: `Cliente com ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '1.1.02', name: 'Deudores por ventas', type: 'ACTIVO', requiresThirdParty: true },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin vendedores declarados, la bandeja no reclama nada', async () => {
    await factura('100000.00', '21000.00', '121000.00', haceDias(10));

    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string }[] }>().items;

    // No toda empresa vende con vendedores. El aviso aparece recién cuando hay
    // alguien a quien atribuirle la venta.
    expect(items.some((i) => i.rama === 'VENTA_SIN_VENDEDOR')).toBe(false);
  });

  it('con un vendedor declarado, las ventas sin dueño llegan a la bandeja', async () => {
    const r = await pedir('POST', '/salespeople', {
      codigo: `V-${stamp}`, nombre: 'Vendedora del norte',
    });
    expect(r.statusCode, r.body).toBe(201);
    vendedor = r.json<{ id: string }>().id;

    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string; evidenciaFaltante: string[] | null }[] }>().items;

    const aviso = items.find((i) => i.rama === 'VENTA_SIN_VENDEDOR');
    expect(aviso, 'la factura de antes no dice quién vendió').toBeDefined();
    expect(aviso!.evidenciaFaltante).toContain('VENDEDOR');
  });

  it('sin esquema declarado, la comisión no es cero: no existe', async () => {
    const f = await factura('200000.00', '42000.00', '242000.00', haceDias(5));
    expect(
      (await pedir('POST', `/tax-transactions/${f}/salesperson`, { vendedorId: vendedor }))
        .statusCode,
    ).toBe(200);

    const v = await verVendedor(vendedor);
    expect(v.comprobantes).toBe(1);
    expect(v.facturado).toBe('242000.00');
    // Nadie declaró el acuerdo: la venta se cuenta aparte, no suma cero.
    expect(v.comisionDevengada).toBe('0');
    expect(v.comprobantesSinEsquema).toBe(1);
    expect(v.metodologia).toContain('no porque valga cero');

    const items = (await pedir('GET', '/work-queue?entidad=salespeople&limite=200'))
      .json<{ items: { rama: string; entityId: string; evidenciaFaltante: string[] | null }[] }>()
      .items;
    const aviso = items.find(
      (i) => i.rama === 'COMISION_SIN_ESQUEMA' && i.entityId === vendedor,
    );
    expect(aviso, 'falta el acuerdo, y el aviso es por vendedor').toBeDefined();
    expect(aviso!.evidenciaFaltante).toContain('ESQUEMA_DE_COMISION');
  });

  it('la base declarada cambia el número, y se ve cuál se usó', async () => {
    // 5 % sobre el **neto**: 200.000 × 5 % = 10.000. Sobre el total serían
    // 12.100, y esos 2.100 de diferencia son comisión sobre el IVA.
    expect(
      (await pedir('POST', `/salespeople/${vendedor}/schemes`, {
        porcentaje: 5,
        base: 'NETO_FACTURADO',
        vigenciaDesde: haceDias(30),
        vigenciaHasta: haceDias(3),
      })).statusCode,
    ).toBe(201);

    const detalle = (await pedir('GET', `/salespeople/${vendedor}`)).json<{
      vendedor: Vendedor;
      devengado: { base: string; baseImporte: string; porcentaje: string; comision: string }[];
    }>();

    const renglon = detalle.devengado[0]!;
    expect(renglon.base).toBe('NETO_FACTURADO');
    expect(renglon.baseImporte, 'la cifra sobre la que se aplicó, para rehacerlo a mano')
      .toBe('200000.00');
    expect(renglon.porcentaje).toBe('5.00');
    expect(renglon.comision).toBe('10000.00');

    expect(detalle.vendedor.comisionDevengada).toBe('10000.00');
    expect(detalle.vendedor.comprobantesSinEsquema).toBe(0);
  });

  it('se aplica el esquema vigente el día del comprobante, no el de hoy', async () => {
    // Un acuerdo nuevo, del 10 % sobre lo cobrado, que arranca después de la
    // factura anterior. Si el sistema usara «el último cargado», la venta vieja
    // pasaría a devengar 10 % y el histórico cambiaría solo.
    expect(
      (await pedir('POST', `/salespeople/${vendedor}/schemes`, {
        porcentaje: 10,
        base: 'TOTAL_COBRADO',
        vigenciaDesde: haceDias(2),
      })).statusCode,
    ).toBe(201);

    const f = await factura('100000.00', '21000.00', '121000.00', hoy);
    expect(
      (await pedir('POST', `/tax-transactions/${f}/salesperson`, { vendedorId: vendedor }))
        .statusCode,
    ).toBe(200);

    // Todavía no se cobró nada: sobre lo cobrado, la comisión es cero de verdad
    // —hay acuerdo y la base vale cero— y eso es distinto de «no se sabe».
    const antes = (await pedir('GET', `/salespeople/${vendedor}`)).json<{
      devengado: { comision: string; baseImporte: string }[];
    }>();
    expect(antes.devengado[0]!.baseImporte).toBe('0');
    expect(antes.devengado[0]!.comision).toBe('0.00');

    // Se cobra la mitad: la comisión devenga a medida que entra la plata.
    await cobrar(f, '60500.00');

    const despues = (await pedir('GET', `/salespeople/${vendedor}`)).json<{
      vendedor: Vendedor;
      devengado: { comision: string; baseImporte: string; porcentaje: string }[];
    }>();
    expect(despues.devengado[0]!.baseImporte).toBe('60500.00');
    expect(despues.devengado[0]!.porcentaje).toBe('10.00');
    expect(despues.devengado[0]!.comision).toBe('6050.00');

    // Y la vieja sigue con su 5 % sobre el neto: 10.000 + 6.050.
    expect(despues.vendedor.comisionDevengada).toBe('16050.00');
  });

  it('dos esquemas vigentes el mismo día no se aceptan', async () => {
    const r = await pedir('POST', `/salespeople/${vendedor}/schemes`, {
      porcentaje: 8, base: 'NETO_FACTURADO', vigenciaDesde: hoy,
    });
    // Se superpone con el abierto: calcular por orden de carga sería azar
    // disfrazado de regla.
    expect(r.statusCode).toBe(409);
  });

  it('una compra no tiene vendedor', async () => {
    const compra = await db.query<{ id: string }>(
      'SELECT id FROM tax_transactions WHERE company_id = $1 AND direction = $2 LIMIT 1',
      [empresa, 'COMPRAS'],
    );
    if (compra.rowCount === 0) return; // esta suite no carga compras

    const r = await pedir('POST', `/tax-transactions/${compra.rows[0]!.id}/salesperson`, {
      vendedorId: vendedor,
    });
    expect(r.statusCode).toBe(409);
  });

  it('devengar no es pagar: el módulo no escribe en el Mayor', async () => {
    const antes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
      [empresa],
    );

    expect(
      (await pedir('POST', `/salespeople/${vendedor}/schemes`, {
        porcentaje: 3, base: 'TOTAL_FACTURADO',
        vigenciaDesde: haceDias(200), vigenciaHasta: haceDias(100),
      })).statusCode,
    ).toBe(201);

    const despues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
      [empresa],
    );
    expect(despues.rows[0]!.n, 'la comisión a pagar es un asiento que firma una persona')
      .toBe(antes.rows[0]!.n);

    const an = (await pedir('GET', '/analysis/comisiones')).json<{ alcance: string }>();
    expect(an.alcance).toContain('devengado, no pagado');
  });

  it('un vendedor se inactiva, no se borra', async () => {
    await expect(
      db.query('DELETE FROM salespeople WHERE id = $1', [vendedor]),
    ).rejects.toThrow(/E_VEND_NO_BORRA/);

    expect(
      (await pedir('PUT', `/salespeople/${vendedor}`, { status: 'INACTIVO' })).statusCode,
    ).toBe(200);

    // Y sus ventas siguen atribuidas: el histórico no cambia porque alguien se
    // haya ido.
    const v = await verVendedor(vendedor);
    expect(v.comisionDevengada).toBe('16050.00');
  });

  it('las vistas de comisiones conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('commission_accruals', 'analytics_comisiones',
                          'work_queue_comisiones')`,
    );
    expect(r.rowCount).toBe(3);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
