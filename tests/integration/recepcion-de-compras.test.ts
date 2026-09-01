/**
 * El circuito de compras completo y su control de tres puntas.
 *
 * ```
 * ORDEN DE COMPRA ──► RECEPCIÓN ──► FACTURA DEL PROVEEDOR
 *   ¿qué pedí?        ¿qué llegó?     ¿qué me cobraron?
 * ```
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que la conciliación detecte lo que no coincide.** Un test que solo
 *      recorriera el camino feliz —tres cantidades iguales— pasaría igual con
 *      la comparación rota.
 *   2. **Que la factura de compra NO se cree acá.** La emite el proveedor y
 *      llega como documento; NEXO la vincula. Es la diferencia con ventas, y
 *      usa la misma columna.
 *   3. **Que lo confirmado no se edite.** Confirmar es afirmar qué llegó.
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

suite('Recepción de mercadería y conciliación de compras', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let proveedorId: string;
  let otroProveedorId: string;
  let productoId: string;
  let cuitProveedor: string;
  let numeroCbte = 6000;

  const pedir = (
    method: 'GET' | 'POST' | 'PUT',
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
    cuitProveedor = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-rec-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio rec ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa rec ${stamp}`, withCheckDigit(`33${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-rec-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-rec-${stamp}@estudio.test`;
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
        code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '5.1.01', name: 'Compras', type: 'COSTO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitProveedor,
        razonSocial: `Proveedor ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    otroProveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `33${stamp}${cuitCheckDigit(`33${stamp}`)}`,
        razonSocial: `Otro proveedor ${stamp}`,
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    productoId = (
      await pedir('POST', '/products', {
        codigo: `MERCA-${stamp}`,
        nombre: 'Mercadería para reventa',
        impuesto: 'IVA',
        cuentaCompra: '5.1.01',
        llevaStock: true,
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Orden de compra ACEPTADA por 10 unidades a 100. */
  async function ordenAceptada(unidades: string): Promise<string> {
    const alta = await pedir('POST', '/commercial-documents', {
      direccion: 'COMPRAS', tipo: 'PEDIDO', terceroId: proveedorId, fecha: '2026-03-01',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    const neto = (Number(unidades) * 100).toFixed(2);
    const iva = (Number(neto) * 0.21).toFixed(2);
    expect(
      (await pedir('PUT', `/commercial-documents/${id}/lines`, {
        renglones: [
          {
            productoId,
            descripcion: 'Mercadería para reventa',
            cantidad: unidades,
            precioUnitario: '100.0000',
            tratamiento: 'GRAVADO',
            neto,
            iva,
          },
        ],
      })).statusCode,
    ).toBe(200);
    expect((await pedir('POST', `/commercial-documents/${id}/emit`)).statusCode).toBe(200);
    expect((await pedir('POST', `/commercial-documents/${id}/accept`)).statusCode).toBe(200);
    return id;
  }

  /** Recepción confirmada de la cantidad indicada contra una orden. */
  async function recepcionConfirmada(ordenId: string, unidades: string): Promise<string> {
    const alta = await pedir('POST', '/goods-receipts', {
      ordenId, proveedorId, fecha: '2026-03-03', remito: `R-${stamp}`,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    expect(
      (await pedir('PUT', `/goods-receipts/${id}/lines`, {
        renglones: [
          { productoId, descripcion: 'Mercadería para reventa', cantidad: unidades },
        ],
      })).statusCode,
    ).toBe(200);
    expect((await pedir('POST', `/goods-receipts/${id}/confirm`)).statusCode).toBe(200);
    return id;
  }

  /** Factura del proveedor: llega como documento y se registra, como siempre. */
  async function facturaDelProveedor(unidades: string): Promise<string> {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="fc-${stamp}-${numeroCbte}.xml"\r\n` +
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

    const neto = (Number(unidades) * 100).toFixed(2);
    const iva = (Number(neto) * 0.21).toFixed(2);
    const total = (Number(neto) + Number(iva)).toFixed(2);

    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'COMPRAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero: numeroCbte,
      fecha: '2026-03-05',
      cuitContraparte: cuitProveedor,
      razonSocial: `Proveedor ${stamp}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva, noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    const ttId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('PUT', `/tax-transactions/${ttId}/lines`, {
        renglones: [
          {
            productoId,
            descripcion: 'Mercadería para reventa',
            cantidad: unidades,
            precioUnitario: '100.0000',
            tratamiento: 'GRAVADO',
            neto, iva,
          },
        ],
      })).statusCode,
    ).toBe(200);

    return ttId;
  }

  // -------------------------------------------------------------------------
  it('el circuito completo concilia cuando las tres cantidades coinciden', async () => {
    const orden = await ordenAceptada('10');
    await recepcionConfirmada(orden, '10');
    const factura = await facturaDelProveedor('10');

    const vinculo = await pedir('POST', `/commercial-documents/${orden}/link-invoice`, {
      taxTransactionId: factura,
    });
    expect(vinculo.statusCode, vinculo.body).toBe(200);

    const match = await pedir('GET', `/commercial-documents/${orden}/match`);
    expect(match.statusCode, match.body).toBe(200);
    const r = match.json<{
      coinciden: boolean;
      items: { pedido: string; recibido: string; facturado: string; coincide: boolean }[];
      alcance: string;
    }>();
    expect(r.coinciden).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.pedido).toBe('10.0000');
    expect(r.items[0]!.recibido).toBe('10.0000');
    expect(r.items[0]!.facturado).toBe('10.0000');
    // La conciliación compara cantidades, no importes, y lo dice.
    expect(r.alcance).toContain('no importes');
  });

  it('detecta que llegó de menos de lo facturado', async () => {
    const orden = await ordenAceptada('10');
    await recepcionConfirmada(orden, '8');
    const factura = await facturaDelProveedor('10');
    expect(
      (await pedir('POST', `/commercial-documents/${orden}/link-invoice`, {
        taxTransactionId: factura,
      })).statusCode,
    ).toBe(200);

    const r = (await pedir('GET', `/commercial-documents/${orden}/match`)).json<{
      coinciden: boolean;
      items: { recibido: string; facturado: string; recibidoSinFacturar: string }[];
    }>();
    expect(r.coinciden, 'cobraron diez y llegaron ocho: no puede dar por bueno').toBe(false);
    expect(r.items[0]!.recibido).toBe('8.0000');
    expect(r.items[0]!.facturado).toBe('10.0000');
    expect(r.items[0]!.recibidoSinFacturar).toBe('-2.0000');
  });

  it('la diferencia aparece en la bandeja como trabajo pendiente', async () => {
    const orden = await ordenAceptada('10');
    await recepcionConfirmada(orden, '7');
    const factura = await facturaDelProveedor('10');
    expect(
      (await pedir('POST', `/commercial-documents/${orden}/link-invoice`, {
        taxTransactionId: factura,
      })).statusCode,
    ).toBe(200);

    const bandeja = await pedir('GET', '/work-queue?limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    const items = bandeja.json<{ items: { entityId: string; rama: string }[] }>().items;
    expect(
      items.some((i) => i.entityId === orden && i.rama === 'COMPRA_NO_CONCILIA'),
      'alguien tiene que mirarlo antes de pagar',
    ).toBe(true);
  });

  it('mercadería recibida sin factura es pasivo sin registrar, y la bandeja lo dice', async () => {
    const orden = await ordenAceptada('5');
    await recepcionConfirmada(orden, '5');

    const bandeja = await pedir('GET', '/work-queue?limite=200');
    const item = bandeja
      .json<{ items: { entityId: string; rama: string; disponibilidad: string }[] }>()
      .items.find((i) => i.entityId === orden && i.rama === 'RECIBIDO_SIN_FACTURA');
    expect(item, 'la deuda existe y no está registrada').toBeDefined();
    // No se resuelve desde adentro: hace falta que el proveedor mande la factura.
    expect(item!.disponibilidad).toBe('INFORMATIVO');
  });

  // -------------------------------------------------------------------------
  // Candados
  // -------------------------------------------------------------------------
  it('lo que se confirmó que llegó no se edita', async () => {
    const orden = await ordenAceptada('10');
    const recepcion = await recepcionConfirmada(orden, '10');

    const r = await pedir('PUT', `/goods-receipts/${recepcion}/lines`, {
      renglones: [{ productoId, descripcion: 'Corregido a mano', cantidad: '99' }],
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('RECEPCION_CONFIRMADA');
  });

  it('no se confirma una recepción vacía', async () => {
    const alta = await pedir('POST', '/goods-receipts', {
      proveedorId, fecha: '2026-03-03',
    });
    const id = alta.json<{ id: string }>().id;
    const r = await pedir('POST', `/goods-receipts/${id}/confirm`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('RECEPCION_SIN_RENGLONES');
  });

  it('anular exige motivo, y una recepción anulada no revive', async () => {
    const orden = await ordenAceptada('10');
    const recepcion = await recepcionConfirmada(orden, '10');

    const sinMotivo = await pedir('POST', `/goods-receipts/${recepcion}/cancel`, {});
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    expect(
      (await pedir('POST', `/goods-receipts/${recepcion}/cancel`, {
        motivo: 'Se cargó contra la orden equivocada',
      })).statusCode,
    ).toBe(200);

    const revivir = await pedir('POST', `/goods-receipts/${recepcion}/confirm`);
    expect(revivir.statusCode, revivir.body).toBe(409);

    // Y deja de contar en la conciliación: la recepción anulada no llegó.
    const r = (await pedir('GET', `/commercial-documents/${orden}/match`)).json<{
      items: { recibido: string }[];
    }>();
    expect(r.items[0]!.recibido).toBe('0.0000');
  });

  it('no se recibe contra la orden de otro proveedor', async () => {
    const orden = await ordenAceptada('10');
    const r = await pedir('POST', '/goods-receipts', {
      ordenId: orden, proveedorId: otroProveedorId, fecha: '2026-03-03',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('PROVEEDOR_NO_COINCIDE');
  });

  it('no se recibe mercadería contra un documento de ventas', async () => {
    const venta = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS', tipo: 'PEDIDO', terceroId: proveedorId, fecha: '2026-03-01',
    });
    const r = await pedir('POST', '/goods-receipts', {
      ordenId: venta.json<{ id: string }>().id, proveedorId, fecha: '2026-03-03',
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('en ventas la factura se emite, no se vincula', async () => {
    const venta = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS', tipo: 'PEDIDO', terceroId: proveedorId, fecha: '2026-03-01',
    });
    const r = await pedir('POST', `/commercial-documents/${venta.json<{ id: string }>().id}/link-invoice`, {
      taxTransactionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('una misma factura no se vincula a dos órdenes', async () => {
    const primera = await ordenAceptada('10');
    const segunda = await ordenAceptada('10');
    const factura = await facturaDelProveedor('10');

    expect(
      (await pedir('POST', `/commercial-documents/${primera}/link-invoice`, {
        taxTransactionId: factura,
      })).statusCode,
    ).toBe(200);

    const r = await pedir('POST', `/commercial-documents/${segunda}/link-invoice`, {
      taxTransactionId: factura,
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('FACTURA_YA_VINCULADA');
  });

  it('una recepción sin orden previa es legítima', async () => {
    // Llega mercadería sin orden. Obligar a inventar una orden para poder
    // registrar lo que ya está en el depósito invertiría la prioridad.
    const alta = await pedir('POST', '/goods-receipts', {
      proveedorId, fecha: '2026-03-03', remito: `SIN-ORDEN-${stamp}`,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    expect(
      (await pedir('PUT', `/goods-receipts/${id}/lines`, {
        renglones: [{ descripcion: 'Algo que llegó sin orden', cantidad: '3' }],
      })).statusCode,
    ).toBe(200);
    expect((await pedir('POST', `/goods-receipts/${id}/confirm`)).statusCode).toBe(200);
  });

  it('la conciliación es del circuito de compras', async () => {
    const venta = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS', tipo: 'PEDIDO', terceroId: proveedorId, fecha: '2026-03-01',
    });
    const r = await pedir('GET', `/commercial-documents/${venta.json<{ id: string }>().id}/match`);
    expect(r.statusCode, r.body).toBe(400);
  });

  it('el borrado físico de una recepción está prohibido', async () => {
    const orden = await ordenAceptada('10');
    const recepcion = await recepcionConfirmada(orden, '10');
    await expect(db.query('DELETE FROM goods_receipts WHERE id = $1', [recepcion])).rejects.toThrow();
  });
});
