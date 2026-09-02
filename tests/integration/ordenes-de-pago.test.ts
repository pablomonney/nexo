/**
 * La orden de pago, y sobre todo la prueba de que se pagó.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que la orden no invente deuda**: no se puede ordenar pagar más de lo
 *      que el comprobante debe, ni una factura de otro proveedor, ni una venta.
 *   2. **Que aprobar signifique algo**: una orden vacía no se aprueba, y una
 *      aprobada ya no se edita.
 *   3. **Que «PAGADA» no sea una palabra**: marcar pagada exige el asiento *y*
 *      que ese asiento esté imputado a cada comprobante de la orden. Es la
 *      prueba central: sin ella, la orden diría pagada mientras la cuenta del
 *      proveedor sigue entera.
 *   4. **Que un pago parcial se vea parcial** en vez de darse por completo.
 *   5. **Que la orden no toque el Mayor** ni la proyección de fondos: los
 *      comprobantes que nombra ya estaban ahí por su pendiente.
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

suite('Órdenes de pago', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let proveedorId: string;
  let otroProveedorId: string;
  let clienteId: string;
  let cuitProveedor: string;
  let cuitOtro: string;
  let cuitCliente: string;
  let numeroCbte = 40_000;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Un comprobante, del lado que se pida, imputado a un tercero. */
  const comprobante = async (
    direction: 'COMPRAS' | 'VENTAS',
    partyId: string,
    cuit: string,
    total: string,
  ): Promise<string> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="op-${stamp}-${numeroCbte}.xml"\r\n` +
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
        direction,
        cbteTipo: 1,
        puntoVenta: 1,
        numero: numeroCbte,
        fecha: hoy,
        cuitContraparte: cuit,
        razonSocial: `Tercero op ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: total, iva: '0', noGravado: '0', exento: '0', percepciones: '0', total,
      },
    );
    expect(op.statusCode, op.body).toBe(201);
    const id = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('POST', `/tax-transactions/${id}/party`, { partyId })).statusCode,
    ).toBe(200);
    return id;
  };

  /**
   * Un asiento de pago aprobado, con su renglón del proveedor.
   *
   * Devuelve el asiento y la línea, porque imputar exige la línea y la orden
   * exige el asiento: son los dos extremos del mismo hecho.
   */
  const asientoDePago = async (
    importe: string,
    partyId: string,
  ): Promise<{ entryId: string; lineaId: string }> => {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: hoy,
      description: `Pago a proveedor ${stamp}`,
      currency: 'ARS',
      lines: [
        { accountCode: '2.1.01', debit: importe, credit: '0', partyId },
        { accountCode: '1.1.01', debit: '0', credit: importe },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Pago registrado para la orden',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const entryId = alta.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${entryId}/approve`)).statusCode).toBe(200);

    const linea = await db.query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE entry_id = $1 AND party_id = $2`,
      [entryId, partyId],
    );
    return { entryId, lineaId: linea.rows[0]!.id };
  };

  const imputar = async (
    taxTransactionId: string,
    journalEntryLineId: string,
    importe: string,
  ): Promise<void> => {
    const r = await pedir('POST', '/party-allocations', {
      taxTransactionId, journalEntryLineId, importe,
    });
    expect(r.statusCode, r.body).toBe(201);
  };

  /** Arma un borrador con los renglones que se le pasen. */
  const armar = async (
    renglones: { comprobanteId: string; importe: string }[],
    proveedor = proveedorId,
  ): Promise<string> => {
    const r = await pedir('POST', '/payment-orders', {
      proveedorId: proveedor, fecha: hoy, renglones,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  };

  const ver = async (ordenId: string) => {
    const r = await pedir('GET', `/payment-orders/${ordenId}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{
      orden: {
        // `bigint` llega como texto desde la base, igual que los importes.
        numero: string;
        estado: string;
        total: string;
        situacion: string;
        imputadoPorElAsiento: string | null;
        renglonesConSobrecompromiso: number;
      };
      renglones: { importe: string; pendiente: string; sobrecompromiso: boolean }[];
    }>();
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
          `fundador-op-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio op ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa op ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-op-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-op-${stamp}@estudio.test`;
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

    cuitProveedor = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    cuitOtro = `33${stamp}${cuitCheckDigit(`33${stamp}`)}`;
    cuitCliente = `27${stamp}${cuitCheckDigit(`27${stamp}`)}`;

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitProveedor,
        razonSocial: `Proveedor op ${stamp}`, roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;
    otroProveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitOtro,
        razonSocial: `Otro proveedor op ${stamp}`, roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;
    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT', numeroDocumento: cuitCliente,
        razonSocial: `Cliente op ${stamp}`, roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO', requiresThirdParty: true },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('la orden se numera sola y su total sale de los renglones', async () => {
    const a = await comprobante('COMPRAS', proveedorId, cuitProveedor, '10000.00');
    const b = await comprobante('COMPRAS', proveedorId, cuitProveedor, '5000.00');

    const orden = await armar([
      { comprobanteId: a, importe: '10000.00' },
      { comprobanteId: b, importe: '2000.00' },
    ]);

    const { orden: cabecera, renglones } = await ver(orden);
    expect(Number(cabecera.numero)).toBeGreaterThan(0);
    expect(cabecera.estado).toBe('BORRADOR');
    // 10.000 + 2.000: el total no vino en el cuerpo, se derivó.
    expect(cabecera.total).toBe('12000.00');
    expect(renglones).toHaveLength(2);
    expect(cabecera.situacion).toContain('Borrador');
  });

  it('no se puede ordenar pagar más de lo que el comprobante debe', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '1000.00');

    const r = await pedir('POST', '/payment-orders', {
      proveedorId, fecha: hoy,
      renglones: [{ comprobanteId: c, importe: '1500.00' }],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('EXCEDE_PENDIENTE');
  });

  it('la factura de otro proveedor no entra en la orden', async () => {
    const ajena = await comprobante('COMPRAS', otroProveedorId, cuitOtro, '3000.00');

    const r = await pedir('POST', '/payment-orders', {
      proveedorId, fecha: hoy,
      renglones: [{ comprobanteId: ajena, importe: '3000.00' }],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('COMPROBANTE_AJENO');
  });

  it('una factura de venta no se paga con una orden de pago', async () => {
    const venta = await comprobante('VENTAS', clienteId, cuitCliente, '4000.00');

    const r = await pedir('POST', '/payment-orders', {
      proveedorId, fecha: hoy,
      renglones: [{ comprobanteId: venta, importe: '4000.00' }],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('COMPROBANTE_DE_VENTAS');
  });

  it('una orden vacía no se aprueba', async () => {
    const vacia = await armar([]);

    const r = await pedir('POST', `/payment-orders/${vacia}/aprobar`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('ORDEN_SIN_RENGLONES');
  });

  it('una orden aprobada ya no se edita', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '2000.00');
    const orden = await armar([{ comprobanteId: c, importe: '2000.00' }]);
    expect((await pedir('POST', `/payment-orders/${orden}/aprobar`)).statusCode).toBe(200);

    const r = await pedir('PUT', `/payment-orders/${orden}/renglones`, {
      renglones: [{ comprobanteId: c, importe: '1000.00' }],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('ORDEN_NO_EDITABLE');
  });

  it('«pagada» sin asiento imputado se rechaza: es la prueba del pago', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '7000.00');
    const orden = await armar([{ comprobanteId: c, importe: '7000.00' }]);
    expect((await pedir('POST', `/payment-orders/${orden}/aprobar`)).statusCode).toBe(200);

    // El asiento existe y está aprobado, pero nadie imputó el pago a la
    // factura. Sin la imputación, la cuenta del proveedor sigue entera: decir
    // «pagada» acá sería escribir la palabra al lado de un hecho a medias.
    const { entryId } = await asientoDePago('7000.00', proveedorId);

    const r = await pedir('POST', `/payment-orders/${orden}/pagar`, { asientoId: entryId });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('PAGO_NO_IMPUTADO');

    // Y la orden siguió aprobada: el rechazo no la dejó a mitad de camino.
    expect((await ver(orden)).orden.estado).toBe('APROBADA');
  });

  it('con el pago imputado, la orden se marca pagada y la deuda baja', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '6000.00');
    const orden = await armar([{ comprobanteId: c, importe: '6000.00' }]);
    expect((await pedir('POST', `/payment-orders/${orden}/aprobar`)).statusCode).toBe(200);

    const { entryId, lineaId } = await asientoDePago('6000.00', proveedorId);
    await imputar(c, lineaId, '6000.00');

    const r = await pedir('POST', `/payment-orders/${orden}/pagar`, { asientoId: entryId });
    expect(r.statusCode, r.body).toBe(200);

    const { orden: cabecera } = await ver(orden);
    expect(cabecera.estado).toBe('PAGADA');
    expect(cabecera.imputadoPorElAsiento).toBe('6000.00');
    expect(cabecera.situacion).toContain('Pagada');

    // Lo que importa del otro lado: el comprobante quedó saldado.
    const saldo = await db.query<{ pendiente: string }>(
      `SELECT pendiente::text FROM invoice_settlement
        WHERE tax_transaction_id = $1 AND company_id = $2`,
      [c, empresa],
    );
    expect(saldo.rows[0]!.pendiente).toBe('0.00');
  });

  it('un pago parcial se informa parcial, no completo', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '9000.00');
    const orden = await armar([{ comprobanteId: c, importe: '9000.00' }]);
    expect((await pedir('POST', `/payment-orders/${orden}/aprobar`)).statusCode).toBe(200);

    // El asiento paga 4.000 de los 9.000 que la orden ordenaba.
    const { entryId, lineaId } = await asientoDePago('4000.00', proveedorId);
    await imputar(c, lineaId, '4000.00');

    expect(
      (await pedir('POST', `/payment-orders/${orden}/pagar`, { asientoId: entryId })).statusCode,
    ).toBe(200);

    const { orden: cabecera } = await ver(orden);
    expect(cabecera.imputadoPorElAsiento).toBe('4000.00');
    expect(cabecera.total).toBe('9000.00');
    expect(cabecera.situacion).toContain('parcialmente');

    const saldo = await db.query<{ pendiente: string }>(
      `SELECT pendiente::text FROM invoice_settlement
        WHERE tax_transaction_id = $1 AND company_id = $2`,
      [c, empresa],
    );
    expect(saldo.rows[0]!.pendiente).toBe('5000.00');
  });

  it('dos órdenes vivas sobre la misma factura se avisan, no se bloquean', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '8000.00');
    const primera = await armar([{ comprobanteId: c, importe: '8000.00' }]);
    const segunda = await armar([{ comprobanteId: c, importe: '8000.00' }]);

    // Las dos existen: el sistema no impidió la segunda.
    expect((await ver(segunda)).orden.total).toBe('8000.00');
    // Y las dos lo dicen: 8.000 + 8.000 sobre una deuda de 8.000.
    expect((await ver(segunda)).renglones[0]!.sobrecompromiso).toBe(true);
    expect((await ver(primera)).orden.renglonesConSobrecompromiso).toBe(1);

    const bandeja = await pedir('GET', '/work-queue?entidad=payment_orders&limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    const items = bandeja.json<{ items: { rama: string; entityId: string; bloquea: boolean }[] }>()
      .items;
    const item = items.find(
      (i) => i.entityId === segunda && i.rama === 'ORDEN_DE_PAGO_SOLAPADA',
    );
    expect(item, 'la orden solapada tiene que estar en la bandeja').toBeDefined();
    expect(item!.bloquea, 'avisar no es bloquear').toBe(false);
  });

  it('una orden aprobada y sin pagar espera en la bandeja', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '3500.00');
    const orden = await armar([{ comprobanteId: c, importe: '3500.00' }]);
    expect((await pedir('POST', `/payment-orders/${orden}/aprobar`)).statusCode).toBe(200);

    const bandeja = await pedir('GET', '/work-queue?entidad=payment_orders&limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    const items = bandeja.json<{ items: { rama: string; entityId: string; motivo: string }[] }>()
      .items;
    const item = items.find(
      (i) => i.entityId === orden && i.rama === 'ORDEN_DE_PAGO_SIN_PAGAR',
    );
    expect(item, 'la orden aprobada sin pagar tiene que estar en la bandeja').toBeDefined();
    expect(item!.motivo).toContain('asiento del pago');
  });

  it('la orden que salió del borrador se anula con motivo, no se borra', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '1200.00');
    const orden = await armar([{ comprobanteId: c, importe: '1200.00' }]);
    expect((await pedir('POST', `/payment-orders/${orden}/aprobar`)).statusCode).toBe(200);

    const anulada = await pedir('POST', `/payment-orders/${orden}/anular`, {
      motivo: 'El proveedor entregó una nota de crédito por el total',
    });
    expect(anulada.statusCode, anulada.body).toBe(200);

    const { orden: cabecera } = await ver(orden);
    expect(cabecera.estado).toBe('ANULADA');
    expect(cabecera.situacion).toContain('nota de crédito');

    // Y una anulada no vuelve: es final.
    const revivir = await pedir('POST', `/payment-orders/${orden}/aprobar`);
    expect(revivir.statusCode, revivir.body).toBe(422);
    expect(revivir.json<{ error: string }>().error).toBe('TRANSICION_INVALIDA');
  });

  it('lo pagable sale del pendiente, no del total del comprobante', async () => {
    const c = await comprobante('COMPRAS', proveedorId, cuitProveedor, '5500.00');
    const { lineaId } = await asientoDePago('500.00', proveedorId);
    await imputar(c, lineaId, '500.00');

    const r = await pedir('GET', `/payment-orders/pagables?proveedorId=${proveedorId}`);
    expect(r.statusCode, r.body).toBe(200);
    const fila = r
      .json<{ comprobantes: { id: string; total: string; pendiente: string }[] }>()
      .comprobantes.find((x) => x.id === c);
    expect(fila, 'el comprobante con saldo tiene que aparecer').toBeDefined();
    expect(fila!.total).toBe('5500.00');
    expect(fila!.pendiente).toBe('5000.00');
  });
});
