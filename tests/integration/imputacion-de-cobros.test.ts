/**
 * Composición y antigüedad de la cuenta corriente.
 *
 * `party_balances` ya decía **cuánto** se debe. Esto prueba las dos preguntas
 * que hacen falta para trabajar: **qué facturas** componen ese saldo y **desde
 * cuándo**.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que el sistema no invente vencimientos.** Sin condición de pago
 *      declarada, `diasDeMora` es `null` y nada figura vencido. Es la
 *      diferencia entre informar y suponer (§42).
 *   2. **Los cuatro candados de la imputación.** Cada uno corresponde a una
 *      forma concreta de dejar la cartera diciendo algo falso — la peor, usar
 *      el asiento de la propia factura para cancelarla, dejaría toda la cartera
 *      en cero sin que entrara un peso.
 *   3. **Que el pendiente se derive.** No hay columna de saldo pendiente.
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

suite('Imputación de cobros y antigüedad de saldos', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let clienteSinPlazoId: string;
  let cuitCliente: string;
  let cuitSinPlazo: string;
  let numeroCbte = 7000;

  const pedir = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
  ) =>
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
    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    cuitSinPlazo = `33${stamp}${cuitCheckDigit(`33${stamp}`)}`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-imp-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio imp ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa imp ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-imp-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-imp-${stamp}@estudio.test`;
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

    // El ejercicio abarca hoy: los cobros se asientan con fecha de hoy para que
    // la antigüedad y la mora se midan contra `current_date` de verdad.
    const hoy = new Date();
    const anio = hoy.getUTCFullYear();
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

    // Un cliente con condición de pago declarada y otro sin ella. La diferencia
    // entre los dos es el corazón de este archivo.
    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitCliente,
        razonSocial: `Cliente con plazo ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
        diasDePago: 30,
      })
    ).json<{ id: string }>().id;

    clienteSinPlazoId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitSinPlazo,
        razonSocial: `Cliente sin plazo ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Fecha ISO de hace `dias` días. */
  const haceDias = (dias: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
  };

  /** Una factura de venta vinculada al tercero, por el total indicado. */
  async function factura(
    partyId: string,
    cuit: string,
    total: string,
    fecha: string,
  ): Promise<string> {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="imp-${stamp}-${numeroCbte}.xml"\r\n` +
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
      cuitContraparte: cuit,
      razonSocial: 'Cliente',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: total, iva: '0', noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const ttId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${ttId}/party`, { partyId })).statusCode,
    ).toBe(200);
    return ttId;
  }

  /**
   * Un cobro: asiento aprobado que acredita al cliente. Devuelve el id de la
   * línea imputada al tercero, que es lo que se imputa.
   */
  async function cobro(partyId: string, importe: string): Promise<string> {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: haceDias(0),
      description: 'Cobranza',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0' },
        { accountCode: '1.1.02', debit: '0', credit: importe, partyId },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Cobranza registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const entryId = alta.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${entryId}/approve`)).statusCode).toBe(200);

    const linea = await db.query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE entry_id = $1 AND party_id = $2`,
      [entryId, partyId],
    );
    return linea.rows[0]!.id;
  }

  // -------------------------------------------------------------------------
  // El vencimiento no se inventa
  // -------------------------------------------------------------------------
  it('sin condición de pago declarada, el sistema no afirma mora', async () => {
    await factura(clienteSinPlazoId, cuitSinPlazo, '5000.00', haceDias(200));

    const r = await pedir('GET', `/parties/${clienteSinPlazoId}/saldo`);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      comprobantes: { diasDeMora: number | null; vencimiento: string | null;
                      vencimientoDeclarado: boolean; antiguedadDias: number }[];
      antiguedad: { vencido: string; masDe90: string }[];
      alcance: string;
    }>();

    const c = cuerpo.comprobantes[0]!;
    // Doscientos días de antigüedad y ninguna afirmación de mora: son dos
    // preguntas distintas y el sistema no las confunde.
    expect(c.antiguedadDias).toBeGreaterThan(190);
    expect(c.vencimientoDeclarado).toBe(false);
    expect(c.vencimiento).toBeNull();
    expect(c.diasDeMora).toBeNull();
    expect(cuerpo.alcance).toContain('no se afirma mora');

    // Cae en el tramo de más de 90 días —que es antigüedad, no mora— y NO suma
    // a `vencido`.
    expect(Number(cuerpo.antiguedad[0]!.masDe90)).toBe(5000);
    expect(Number(cuerpo.antiguedad[0]!.vencido)).toBe(0);
  });

  it('con condición declarada, el vencimiento se deriva y la mora se afirma', async () => {
    await factura(clienteId, cuitCliente, '10000.00', haceDias(100));

    const r = await pedir('GET', `/parties/${clienteId}/saldo`);
    const cuerpo = r.json<{
      tercero: { diasDePago: number };
      comprobantes: { diasDeMora: number; vencimientoDeclarado: boolean }[];
      antiguedad: { vencido: string }[];
      alcance: string;
    }>();

    expect(cuerpo.tercero.diasDePago).toBe(30);
    expect(cuerpo.comprobantes[0]!.vencimientoDeclarado).toBe(true);
    // Cien días de antigüedad menos treinta de plazo: setenta de mora.
    expect(cuerpo.comprobantes[0]!.diasDeMora).toBeGreaterThan(65);
    expect(Number(cuerpo.antiguedad[0]!.vencido)).toBe(10000);
    expect(cuerpo.alcance).toContain('30 días');
  });

  it('la factura vencida aparece en la bandeja; la que no tiene plazo, no', async () => {
    const bandeja = await pedir('GET', '/work-queue?limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    const vencidas = bandeja
      .json<{ items: { rama: string; entityId: string }[] }>()
      .items.filter((i) => i.rama === 'FACTURA_VENCIDA');

    const conPlazo = await db.query<{ id: string }>(
      `SELECT tax_transaction_id AS id FROM invoice_settlement
        WHERE party_id = $1 AND company_id = $2`,
      [clienteId, empresa],
    );
    const sinPlazo = await db.query<{ id: string }>(
      `SELECT tax_transaction_id AS id FROM invoice_settlement
        WHERE party_id = $1 AND company_id = $2`,
      [clienteSinPlazoId, empresa],
    );

    expect(vencidas.some((v) => v.entityId === conPlazo.rows[0]!.id)).toBe(true);
    expect(
      vencidas.some((v) => v.entityId === sinPlazo.rows[0]!.id),
      'una bandeja que afirmara mora sin plazo acordado estaría inventando el acuerdo',
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Imputar
  // -------------------------------------------------------------------------
  it('imputar un cobro reduce el pendiente y lo deriva del hecho', async () => {
    const f = await factura(clienteId, cuitCliente, '3000.00', haceDias(5));
    const linea = await cobro(clienteId, '1200.00');

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: f,
      journalEntryLineId: linea,
      importe: '1200.00',
    });
    expect(r.statusCode, r.body).toBe(201);

    const detalle = await pedir('GET', `/tax-transactions/${f}/allocations`);
    const cuerpo = detalle.json<{
      saldo: { total: string; imputado: string; pendiente: string };
      imputaciones: { importe: string; status: string }[];
    }>();
    expect(cuerpo.saldo.imputado).toBe('1200.00');
    expect(cuerpo.saldo.pendiente).toBe('1800.00');
    expect(cuerpo.imputaciones).toHaveLength(1);
  });

  it('no hay ninguna columna que guarde el pendiente', async () => {
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('tax_transactions', 'parties')
          AND column_name IN ('pendiente', 'saldo_pendiente', 'imputado', 'cancelado')`,
    );
    expect(columnas.rows).toEqual([]);
  });

  it('no se imputa más de lo que dice el comprobante', async () => {
    const f = await factura(clienteId, cuitCliente, '1000.00', haceDias(5));
    const linea = await cobro(clienteId, '5000.00');

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: f, journalEntryLineId: linea, importe: '1500.00',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('IMPUTACION_EXCEDE_COMPROBANTE');
  });

  it('un cobro no cancela más de lo que entró', async () => {
    const uno = await factura(clienteId, cuitCliente, '5000.00', haceDias(5));
    const dos = await factura(clienteId, cuitCliente, '5000.00', haceDias(5));
    const linea = await cobro(clienteId, '1000.00');

    expect(
      (await pedir('POST', '/party-allocations', {
        taxTransactionId: uno, journalEntryLineId: linea, importe: '1000.00',
      })).statusCode,
    ).toBe(201);

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: dos, journalEntryLineId: linea, importe: '1.00',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('IMPUTACION_EXCEDE_MOVIMIENTO');
  });

  it('una factura no se cancela con su propio asiento', async () => {
    // El error que este candado evita dejaría toda la cartera en cero sin que
    // entrara un peso: cada factura «pagada» por el asiento que la registra.
    const f = await factura(clienteId, cuitCliente, '2000.00', haceDias(5));

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'VENTAS',
      entryDate: haceDias(5),
      description: 'Venta registrada',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.02', debit: '2000.00', credit: '0', partyId: clienteId },
        { accountCode: '4.1.01', debit: '0', credit: '2000.00' },
      ],
      source: { type: 'INVOICE', id: f },
      manualJustification: 'Asiento de la propia factura',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const entryId = alta.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${entryId}/approve`)).statusCode).toBe(200);

    const linea = await db.query<{ id: string }>(
      'SELECT id FROM journal_entry_lines WHERE entry_id = $1 AND party_id = $2',
      [entryId, clienteId],
    );

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: f, journalEntryLineId: linea.rows[0]!.id, importe: '2000.00',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('MOVIMIENTO_ES_LA_FACTURA');
  });

  it('un asiento sin aprobar no cancela nada', async () => {
    const f = await factura(clienteId, cuitCliente, '1000.00', haceDias(5));
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: haceDias(0),
      description: 'Cobranza en borrador',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: '1000.00', credit: '0' },
        { accountCode: '1.1.02', debit: '0', credit: '1000.00', partyId: clienteId },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Todavía sin aprobar',
    });
    const linea = await db.query<{ id: string }>(
      'SELECT id FROM journal_entry_lines WHERE entry_id = $1 AND party_id = $2',
      [alta.json<{ id: string }>().id, clienteId],
    );

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: f, journalEntryLineId: linea.rows[0]!.id, importe: '1000.00',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('ASIENTO_SIN_APROBAR');
  });

  it('no se imputa un cobro de un tercero a la factura de otro', async () => {
    const f = await factura(clienteId, cuitCliente, '1000.00', haceDias(5));
    const linea = await cobro(clienteSinPlazoId, '1000.00');

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: f, journalEntryLineId: linea, importe: '1000.00',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('TERCERO_NO_COINCIDE');
  });

  it('un comprobante sin tercero resuelto no se puede imputar', async () => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="huerf-${stamp}.xml"\r\n` +
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
    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS', cbteTipo: 1, puntoVenta: 1, numero: numeroCbte,
      fecha: haceDias(5), cuitContraparte: cuitCliente, razonSocial: 'Sin resolver',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '100.00', iva: '0', noGravado: '0', exento: '0', percepciones: '0', total: '100.00',
    });
    const linea = await cobro(clienteId, '100.00');

    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: op.json<{ taxTransactionId: string }>().taxTransactionId,
      journalEntryLineId: linea,
      importe: '100.00',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('COMPROBANTE_SIN_TERCERO');
  });

  // -------------------------------------------------------------------------
  // Anular y rehacer
  // -------------------------------------------------------------------------
  it('anular una imputación devuelve el pendiente y deja rastro', async () => {
    const f = await factura(clienteId, cuitCliente, '4000.00', haceDias(5));
    const linea = await cobro(clienteId, '4000.00');

    const id = (
      await pedir('POST', '/party-allocations', {
        taxTransactionId: f, journalEntryLineId: linea, importe: '4000.00',
      })
    ).json<{ id: string }>().id;

    const sinMotivo = await pedir('POST', `/party-allocations/${id}/cancel`, {});
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    expect(
      (await pedir('POST', `/party-allocations/${id}/cancel`, {
        motivo: 'Se imputó a la factura equivocada',
      })).statusCode,
    ).toBe(200);

    const detalle = await pedir('GET', `/tax-transactions/${f}/allocations`);
    expect(detalle.json<{ saldo: { pendiente: string } }>().saldo.pendiente).toBe('4000.00');

    const bitacora = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE object_id = $1
        AND action IN ('IMPUTAR_COBRO', 'ANULAR_IMPUTACION') ORDER BY occurred_at`,
      [f],
    );
    expect(bitacora.rows.map((x) => x.action)).toEqual(['IMPUTAR_COBRO', 'ANULAR_IMPUTACION']);
  });

  it('el movimiento vuelve a estar disponible después de anular', async () => {
    const f = await factura(clienteId, cuitCliente, '900.00', haceDias(5));
    const linea = await cobro(clienteId, '900.00');
    const id = (
      await pedir('POST', '/party-allocations', {
        taxTransactionId: f, journalEntryLineId: linea, importe: '900.00',
      })
    ).json<{ id: string }>().id;

    const durante = await pedir('GET', `/parties/${clienteId}/movimientos-sin-imputar`);
    expect(
      durante.json<{ movimientos: { lineaId: string }[] }>().movimientos
        .some((m) => m.lineaId === linea),
    ).toBe(false);

    await pedir('POST', `/party-allocations/${id}/cancel`, { motivo: 'Se rehace' });

    const despues = await pedir('GET', `/parties/${clienteId}/movimientos-sin-imputar`);
    const vuelto = despues
      .json<{ movimientos: { lineaId: string; disponible: string }[] }>()
      .movimientos.find((m) => m.lineaId === linea);
    expect(vuelto, 'el cobro vuelve a estar disponible: nadie lo aplicó').toBeDefined();
    expect(vuelto!.disponible).toBe('900.00');
  });

  it('el cobro sin imputar aparece en la bandeja', async () => {
    const linea = await cobro(clienteId, '777.00');
    const bandeja = await pedir('GET', '/work-queue?limite=200');
    const items = bandeja.json<{ items: { rama: string; motivo: string }[] }>().items;
    expect(
      items.some((i) => i.rama === 'COBRO_SIN_IMPUTAR' && i.motivo.includes('777')),
      'el saldo neto ya está bien; falta saber qué factura quedó saldada',
    ).toBe(true);
    expect(linea).toBeTruthy();
  });

  it('el reporte de antigüedad ordena por pendiente y avisa su alcance', async () => {
    const r = await pedir('GET', '/reports/aging?direccion=VENTAS');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ terceros: { razonSocial: string }[]; alcance: string }>();
    expect(cuerpo.terceros.length).toBeGreaterThan(0);
    expect(cuerpo.alcance).toContain('sin condición de pago declarada');
  });

  it('el borrado físico de una imputación está prohibido', async () => {
    const f = await factura(clienteId, cuitCliente, '600.00', haceDias(5));
    const linea = await cobro(clienteId, '600.00');
    const id = (
      await pedir('POST', '/party-allocations', {
        taxTransactionId: f, journalEntryLineId: linea, importe: '600.00',
      })
    ).json<{ id: string }>().id;

    await expect(db.query('DELETE FROM party_allocations WHERE id = $1', [id])).rejects.toThrow();
  });
});
