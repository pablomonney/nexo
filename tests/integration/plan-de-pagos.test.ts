/**
 * Condiciones de pago por comprobante: el plan de cuotas.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que la proyección de cobranzas deje de estar equivocada.** Es el
 *      motivo real de la migración 0060. Una factura en tres cuotas, con el
 *      modelo anterior, se proyectaba entera en una sola fecha. No quedaba
 *      incompleta: quedaba mal, con toda la apariencia de estar bien. El test
 *      que la ubica en tres tramos distintos es el que importa.
 *   2. **Que la cuota se declare al imputar.** Con un plan y un cobro parcial,
 *      el sistema no sabe qué cuota se pagó. Consumir de la más vieja a la más
 *      nueva habría sido cómodo y habría sido adivinar (ADR-015 §7).
 *   3. **Que el plan cierre contra el total.** Un plan que no suma la factura
 *      deja una parte sin fecha de vencimiento.
 *   4. **Que nada de esto se guarde dos veces.** El pendiente de cada cuota se
 *      deriva; no hay columna que mantener.
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

suite('Plan de pagos por comprobante', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let cuitCliente: string;
  let numeroCbte = 8400;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Una fecha desplazada respecto de hoy, en ISO. Negativo = pasado. */
  const enDias = (dias: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-plan-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio plan ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa plan ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-plan-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-plan-${stamp}@estudio.test`;
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

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitCliente,
        razonSocial: `Cliente en cuotas ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Una factura de venta vinculada al cliente. */
  async function factura(total: string, fecha: string): Promise<string> {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="plan-${stamp}-${numeroCbte}.xml"\r\n` +
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
      neto: total, iva: '0', noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const ttId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${ttId}/party`, { partyId: clienteId })).statusCode,
    ).toBe(200);
    return ttId;
  }

  /** Un cobro aprobado. Devuelve la línea del tercero, que es lo que se imputa. */
  async function cobro(importe: string): Promise<string> {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: enDias(0),
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

    return (
      await db.query<{ id: string }>(
        'SELECT id FROM journal_entry_lines WHERE entry_id = $1 AND party_id = $2',
        [entryId, clienteId],
      )
    ).rows[0]!.id;
  }

  it('sin plan y sin plazo del tercero, no hay vencimiento y se dice por qué', async () => {
    const tt = await factura('1000.00', enDias(-40));
    const r = await pedir('GET', `/tax-transactions/${tt}/installments`);

    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ tienePlan: boolean; cuotas: unknown[]; vencimiento: string }>();
    expect(cuerpo.tienePlan, 'sin plan es sin plan, no un plan de cero cuotas').toBe(false);
    expect(cuerpo.cuotas).toEqual([]);
    expect(cuerpo.vencimiento).toContain('No hay');
  });

  it('un plan que no suma el total se rechaza', async () => {
    const tt = await factura('1000.00', enDias(-40));
    const r = await pedir('PUT', `/tax-transactions/${tt}/installments`, {
      cuotas: [
        { vencimiento: enDias(0), importe: '300.00' },
        { vencimiento: enDias(30), importe: '300.00' },
      ],
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('PLAN_NO_CIERRA');
  });

  it('una cuota que vence antes que el comprobante se rechaza', async () => {
    const tt = await factura('1000.00', enDias(-10));
    const r = await pedir('PUT', `/tax-transactions/${tt}/installments`, {
      cuotas: [{ vencimiento: enDias(-30), importe: '1000.00' }],
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUOTA_ANTES_DEL_COMPROBANTE');
  });

  it('declarar el plan deja cada cuota con su vencimiento y su pendiente derivado', async () => {
    const tt = await factura('900.00', enDias(-40));
    const alta = await pedir('PUT', `/tax-transactions/${tt}/installments`, {
      cuotas: [
        { vencimiento: enDias(-10), importe: '300.00' },
        { vencimiento: enDias(20), importe: '300.00' },
        { vencimiento: enDias(50), importe: '300.00' },
      ],
    });
    expect(alta.statusCode, alta.body).toBe(200);

    const r = await pedir('GET', `/tax-transactions/${tt}/installments`);
    const cuerpo = r.json<{
      tienePlan: boolean;
      cuotas: { numero: number; importe: string; pendiente: string; diasDeMora: number }[];
    }>();

    expect(cuerpo.tienePlan).toBe(true);
    expect(cuerpo.cuotas.map((c) => c.numero), 'el número sale del orden, no del cuerpo')
      .toEqual([1, 2, 3]);
    expect(cuerpo.cuotas.every((c) => c.pendiente === c.importe), 'sin cobros, todo pendiente')
      .toBe(true);
    // Solo la primera está vencida. Las otras dos no, y eso es exactamente lo
    // que el modelo anterior no podía expresar.
    expect(cuerpo.cuotas[0]!.diasDeMora).toBeGreaterThan(0);
    expect(cuerpo.cuotas[1]!.diasDeMora).toBe(0);
    expect(cuerpo.cuotas[2]!.diasDeMora).toBe(0);
  });

  it('con plan, la imputación tiene que decir qué cuota cancela', async () => {
    const tt = await factura('900.00', enDias(-40));
    expect(
      (await pedir('PUT', `/tax-transactions/${tt}/installments`, {
        cuotas: [
          { vencimiento: enDias(-10), importe: '300.00' },
          { vencimiento: enDias(20), importe: '600.00' },
        ],
      })).statusCode,
    ).toBe(200);

    const linea = await cobro('300.00');
    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: tt,
      journalEntryLineId: linea,
      importe: '300.00',
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('IMPUTACION_SIN_CUOTA');
  });

  it('sin plan, una imputación no puede nombrar una cuota', async () => {
    const conPlan = await factura('500.00', enDias(-40));
    expect(
      (await pedir('PUT', `/tax-transactions/${conPlan}/installments`, {
        cuotas: [{ vencimiento: enDias(10), importe: '500.00' }],
      })).statusCode,
    ).toBe(200);
    const cuotaAjena = (
      await pedir('GET', `/tax-transactions/${conPlan}/installments`)
    ).json<{ cuotas: { id: string }[] }>().cuotas[0]!.id;

    const sinPlan = await factura('500.00', enDias(-40));
    const linea = await cobro('500.00');
    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: sinPlan,
      journalEntryLineId: linea,
      importe: '500.00',
      installmentId: cuotaAjena,
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUOTA_SIN_PLAN');
  });

  it('no se puede imputar a una cuota más de lo que la cuota vale', async () => {
    const tt = await factura('900.00', enDias(-40));
    expect(
      (await pedir('PUT', `/tax-transactions/${tt}/installments`, {
        cuotas: [
          { vencimiento: enDias(-10), importe: '300.00' },
          { vencimiento: enDias(20), importe: '600.00' },
        ],
      })).statusCode,
    ).toBe(200);
    const cuota1 = (
      await pedir('GET', `/tax-transactions/${tt}/installments`)
    ).json<{ cuotas: { id: string }[] }>().cuotas[0]!.id;

    // 500 entra sin problema en el comprobante de 900: el candado del total, que
    // ya existía desde la 0053, no alcanza para atajar esto.
    const linea = await cobro('500.00');
    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId: tt,
      journalEntryLineId: linea,
      importe: '500.00',
      installmentId: cuota1,
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('IMPUTACION_EXCEDE_CUOTA');
  });

  it('pagar la segunda cuota no salda la primera: el vencimiento sigue siendo el de la impaga más vieja', async () => {
    const tt = await factura('600.00', enDias(-40));
    expect(
      (await pedir('PUT', `/tax-transactions/${tt}/installments`, {
        cuotas: [
          { vencimiento: enDias(-10), importe: '300.00' },
          { vencimiento: enDias(20), importe: '300.00' },
        ],
      })).statusCode,
    ).toBe(200);
    const cuotas = (
      await pedir('GET', `/tax-transactions/${tt}/installments`)
    ).json<{ cuotas: { id: string }[] }>().cuotas;

    const linea = await cobro('300.00');
    expect(
      (await pedir('POST', '/party-allocations', {
        taxTransactionId: tt,
        journalEntryLineId: linea,
        importe: '300.00',
        installmentId: cuotas[1]!.id,
      })).statusCode,
    ).toBe(201);

    const fila = await db.query<{ vencimiento: string; dias_de_mora: number; cuotas: number }>(
      `SELECT vencimiento::text, dias_de_mora, cuotas
         FROM invoice_settlement WHERE tax_transaction_id = $1`,
      [tt],
    );

    expect(fila.rows[0]!.cuotas).toBe(2);
    // Lo que importa: la mora no desaparece porque se pagó la cuota nueva.
    expect(fila.rows[0]!.vencimiento, 'el vencimiento es el de la cuota 1, que sigue impaga')
      .toBe(enDias(-10));
    expect(fila.rows[0]!.dias_de_mora).toBeGreaterThan(0);
  });

  it('la proyección de cobranzas reparte las cuotas en sus tramos, no la factura entera en uno', async () => {
    // Es el defecto que motivó todo el bloque. Con el modelo anterior estas tres
    // cuotas caían en un solo tramo y la proyección decía otra cosa que la
    // realidad.
    const antes = (
      await pedir('GET', '/analysis/proyeccion-de-cobranzas')
    ).json<{ proyeccion: Record<string, string> }>().proyeccion;

    const tt = await factura('900.00', enDias(-40));
    expect(
      (await pedir('PUT', `/tax-transactions/${tt}/installments`, {
        cuotas: [
          { vencimiento: enDias(-10), importe: '100.00' },
          { vencimiento: enDias(20), importe: '200.00' },
          { vencimiento: enDias(50), importe: '600.00' },
        ],
      })).statusCode,
    ).toBe(200);

    const r = await pedir('GET', '/analysis/proyeccion-de-cobranzas');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ proyeccion: Record<string, string>; metodologia: string }>();

    const delta = (clave: string): number =>
      Number(cuerpo.proyeccion[clave]) - Number(antes[clave]);

    expect(delta('vencido'), 'la cuota vencida').toBe(100);
    expect(delta('proximos30'), 'la que vence dentro de 20 días').toBe(200);
    expect(delta('de31a60'), 'la que vence dentro de 50').toBe(600);
    expect(cuerpo.metodologia).toContain('cuota');
  });

  it('no se cambia el plan de un comprobante con cobros imputados', async () => {
    const tt = await factura('400.00', enDias(-40));
    expect(
      (await pedir('PUT', `/tax-transactions/${tt}/installments`, {
        cuotas: [{ vencimiento: enDias(10), importe: '400.00' }],
      })).statusCode,
    ).toBe(200);
    const cuota = (
      await pedir('GET', `/tax-transactions/${tt}/installments`)
    ).json<{ cuotas: { id: string }[] }>().cuotas[0]!.id;

    const linea = await cobro('400.00');
    expect(
      (await pedir('POST', '/party-allocations', {
        taxTransactionId: tt,
        journalEntryLineId: linea,
        importe: '400.00',
        installmentId: cuota,
      })).statusCode,
    ).toBe(201);

    const r = await pedir('PUT', `/tax-transactions/${tt}/installments`, {
      cuotas: [
        { vencimiento: enDias(10), importe: '200.00' },
        { vencimiento: enDias(40), importe: '200.00' },
      ],
    });

    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ message: string }>().message).toContain('imputad');
  });

  it('declarar el plan queda en la bitácora con el plan anterior y el nuevo', async () => {
    const tt = await factura('500.00', enDias(-40));
    await pedir('PUT', `/tax-transactions/${tt}/installments`, {
      cuotas: [{ vencimiento: enDias(10), importe: '500.00' }],
    });
    await pedir('PUT', `/tax-transactions/${tt}/installments`, {
      cuotas: [
        { vencimiento: enDias(10), importe: '250.00' },
        { vencimiento: enDias(40), importe: '250.00' },
      ],
    });

    const r = await db.query<{ old_value: unknown; new_value: { cuotas: unknown[] } }>(
      `SELECT old_value, new_value FROM audit_logs
        WHERE company_id = $1 AND action = 'DECLARAR_PLAN_DE_PAGOS' AND object_id = $2
        ORDER BY seq DESC LIMIT 1`,
      [empresa, tt],
    );

    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.new_value.cuotas).toHaveLength(2);
    expect(r.rows[0]!.old_value, 'el plan que había, para poder comparar').not.toBeNull();
  });

  it('no existe ninguna columna de pendiente por cuota: todo se deriva', async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tax_transaction_installments'`,
    );
    const columnas = r.rows.map((f) => f.column_name);

    expect(columnas).toContain('importe');
    for (const prohibida of ['pendiente', 'imputado', 'saldo', 'status', 'pagada']) {
      expect(columnas, `${prohibida} sería una segunda verdad`).not.toContain(prohibida);
    }
  });

  it('las vistas del plan conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('installment_settlement', 'invoice_settlement')`,
    );
    expect(r.rowCount).toBe(2);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
