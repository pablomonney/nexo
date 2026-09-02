/**
 * El circuito de compras, de punta a punta.
 *
 * ## Por qué existe este archivo
 *
 * La orden de compra **ya estaba construida**: es un `commercial_document` con
 * `direction = 'COMPRAS'`, la recepción la cita por `commercial_document_id`
 * desde la 0052, y la factura del proveedor se vincula con `link-invoice`. Todo
 * el camino existe desde hace seis migraciones.
 *
 * Y no lo recorría nadie: la suite del ciclo comercial no menciona `COMPRAS` ni
 * una vez. Otra vez la misma forma — código correcto, regla escrita, y el
 * camino entre las dos sin caminar.
 *
 * Peor todavía: al auditar la cobertura del producto **yo mismo lo declaré
 * ausente**, porque busqué una tabla `purchase_orders` en vez de mirar si el
 * ciclo comercial era bidireccional. La corrección está en
 * `docs/roadmap/COBERTURA_ERP.md`.
 *
 * ## Qué defiende
 *
 *   1. Que el circuito completo funcione: orden → recepción → factura →
 *      conciliación de tres puntas.
 *   2. Que las dos direcciones **no se mezclen**: una factura de ventas no
 *      puede ser la factura de una orden de compra, y en ventas la factura no
 *      se vincula porque NEXO la emite.
 *   3. Que lo comprometido y no facturado sea salida de caja futura (ADR-018).
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

suite('Circuito de compras', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let proveedorId: string;
  let cuitProveedor: string;
  let productoId: string;
  let deposito: string;
  let numeroCbte = 61000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    cuitProveedor = `33${stamp}${cuitCheckDigit(`33${stamp}`)}`;

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-cmp-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio cmp ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa cmp ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-cmp-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-cmp-${stamp}@estudio.test`;
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
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    expect(
      (await pedir('POST', '/accounts', { code: '5.1.01', name: 'Compras', type: 'COSTO' }))
        .statusCode,
    ).toBe(201);

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitProveedor,
        razonSocial: `Proveedor cmp ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    productoId = (
      await pedir('POST', '/products', {
        codigo: `INS-${stamp}`,
        nombre: 'Insumo',
        impuesto: 'IVA',
        cuentaCompra: '5.1.01',
        llevaStock: true,
      })
    ).json<{ id: string }>().id;

    deposito = (
      await pedir('POST', '/warehouses', { codigo: `DEP-${stamp}`, nombre: 'Depósito' })
    ).json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Una orden de compra emitida y aceptada, con un renglón. */
  async function ordenAceptada(cantidad: string, neto: string, iva: string): Promise<string> {
    const alta = await pedir('POST', '/commercial-documents', {
      direccion: 'COMPRAS',
      tipo: 'PEDIDO',
      terceroId: proveedorId,
      fecha: hoy,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    expect(
      (await pedir('PUT', `/commercial-documents/${id}/lines`, {
        renglones: [
          {
            productoId,
            descripcion: 'Insumo pedido al proveedor',
            cantidad,
            unidad: 'UNIDAD',
            precioUnitario: (Number(neto) / Number(cantidad)).toFixed(4),
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

  /** Una factura de compra del proveedor, resuelta contra el maestro. */
  async function facturaDeCompra(neto: string, iva: string, total: string): Promise<string> {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="cmp-${stamp}-${numeroCbte}.xml"\r\n` +
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
      direction: 'COMPRAS',
      cbteTipo: 1,
      puntoVenta: 7,
      numero: numeroCbte,
      fecha: hoy,
      cuitContraparte: cuitProveedor,
      razonSocial: 'Proveedor',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva, noGravado: '0', exento: '0', percepciones: '0', total,
    });
    expect(op.statusCode, op.body).toBe(201);
    return op.json<{ taxTransactionId: string }>().taxTransactionId;
  }

  it('la orden de compra existe: es un documento comercial con dirección COMPRAS', async () => {
    const id = await ordenAceptada('10', '1000.00', '210.00');

    const r = await pedir('GET', `/commercial-documents/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json<{ documento: { direccion: string; tipo: string; status: string } }>().documento;

    expect(d.direccion).toBe('COMPRAS');
    expect(d.tipo).toBe('PEDIDO');
    expect(d.status).toBe('ACEPTADO');
  });

  it('la recepción cita la orden, y las dos son de la misma empresa', async () => {
    const orden = await ordenAceptada('10', '1000.00', '210.00');

    const recepcion = await pedir('POST', '/goods-receipts', {
      proveedorId,
      fecha: hoy,
      depositoId: deposito,
      ordenId: orden,
    });
    expect(recepcion.statusCode, recepcion.body).toBe(201);

    const id = recepcion.json<{ id: string }>().id;
    const guardada = await db.query<{ commercial_document_id: string | null }>(
      'SELECT commercial_document_id FROM goods_receipts WHERE id = $1',
      [id],
    );
    expect(guardada.rows[0]!.commercial_document_id, 'la recepción quedó atada a la orden')
      .toBe(orden);
  });

  it('el circuito completo cierra: orden → recepción → factura → tres puntas', async () => {
    const orden = await ordenAceptada('10', '1000.00', '210.00');

    const recepcion = (
      await pedir('POST', '/goods-receipts', {
        proveedorId, fecha: hoy, depositoId: deposito, ordenId: orden,
      })
    ).json<{ id: string }>().id;

    expect(
      (await pedir('PUT', `/goods-receipts/${recepcion}/lines`, {
        renglones: [{ productoId, descripcion: 'Insumo', cantidad: '10' }],
      })).statusCode,
    ).toBe(200);
    expect(
      (await pedir('POST', `/goods-receipts/${recepcion}/confirm`, { depositoId: deposito }))
        .statusCode,
    ).toBe(200);

    const factura = await facturaDeCompra('1000.00', '210.00', '1210.00');

    // La tercera punta: sin el detalle de la factura, el match compara lo pedido
    // y lo recibido contra cero facturado — y dice, con razón, que no coinciden.
    expect(
      (await pedir('PUT', `/tax-transactions/${factura}/lines`, {
        renglones: [
          {
            productoId,
            descripcion: 'Insumo',
            cantidad: '10',
            unidad: 'UNIDAD',
            precioUnitario: '100.0000',
            tratamiento: 'GRAVADO',
            neto: '1000.00',
            iva: '210.00',
          },
        ],
      })).statusCode,
    ).toBe(200);

    const vinculo = await pedir('POST', `/commercial-documents/${orden}/link-invoice`, {
      taxTransactionId: factura,
    });
    expect(vinculo.statusCode, vinculo.body).toBe(200);

    // La conciliación de tres puntas cuelga de **la orden**, no de la recepción:
    // lo que compara es lo pedido contra lo recibido contra lo facturado, y el
    // único de los tres que los conoce a todos es el pedido.
    const match = await pedir('GET', `/commercial-documents/${orden}/match`);
    expect(match.statusCode, match.body).toBe(200);
    const cuerpo = match.json<{ items: { pedido: string; recibido: string }[]; coinciden: boolean; alcance: string }>();
    expect(cuerpo.items.length, 'hay algo que comparar').toBeGreaterThan(0);
    expect(cuerpo.coinciden, 'se pidieron 10, se recibieron 10').toBe(true);
    // El match compara cantidades y lo dice: que coincidan no afirma que el
    // precio facturado sea el pactado.
    expect(cuerpo.alcance).toContain('no importes');
  });

  it('la factura de una orden de compra no puede ser un comprobante de ventas', async () => {
    const orden = await ordenAceptada('5', '500.00', '105.00');

    // Un comprobante de ventas cualquiera.
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="vta-${stamp}-${numeroCbte}.xml"\r\n` +
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
    const venta = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS',
      cbteTipo: 1, puntoVenta: 8, numero: numeroCbte, fecha: hoy,
      cuitContraparte: cuitProveedor, razonSocial: 'X',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '500.00', iva: '105.00', noGravado: '0', exento: '0', percepciones: '0',
      total: '605.00',
    });

    const r = await pedir('POST', `/commercial-documents/${orden}/link-invoice`, {
      taxTransactionId: venta.json<{ taxTransactionId: string }>().taxTransactionId,
    });

    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('COMPROBANTE_DE_VENTAS');
  });

  it('en ventas la factura no se vincula: NEXO la emite', async () => {
    // Las dos direcciones no son simétricas y el sistema lo dice en vez de
    // aceptar el pedido y hacer algo raro.
    const alta = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS',
      tipo: 'PEDIDO',
      terceroId: proveedorId,
      fecha: hoy,
    });
    const id = alta.json<{ id: string }>().id;

    const r = await pedir('POST', `/commercial-documents/${id}/link-invoice`, {
      taxTransactionId: '00000000-0000-7000-8000-000000000000',
    });

    expect(r.statusCode, r.body).toBe(400);
    expect(r.json<{ message: string }>().message).toContain('NEXO la crea');
  });

  // -------------------------------------------------------------------------
  // La capa de decisión (ADR-018)
  // -------------------------------------------------------------------------
  it('una orden aceptada es salida de caja comprometida', async () => {
    const antes = (await pedir('GET', '/analysis/flujo-de-fondos'))
      .json<{ porFuente: { sentido: string; fuente: string; total: string }[] }>().porFuente;
    const base = (f: string): number =>
      Number(antes.find((x) => x.fuente === f)?.total ?? 0);

    await ordenAceptada('20', '2000.00', '420.00');

    const r = await pedir('GET', '/analysis/flujo-de-fondos');
    const cuerpo = r.json<{
      porFuente: { sentido: string; fuente: string; total: string; sinFecha: string }[];
      consolidado: { sentido: string; total: string }[];
      alcance: string;
    }>();

    const comprometido = cuerpo.porFuente.find((f) => f.fuente === 'COMPROMETIDO')!;
    expect(comprometido.sentido, 'una orden de compra es plata que sale').toBe('SALE');
    expect(Number(comprometido.total) - base('COMPROMETIDO')).toBe(2420);

    // Una orden aceptada no dice cuándo se paga, así que no se la ubica en
    // ningún tramo. Inventarle un vencimiento sería inventar el acuerdo.
    expect(Number(comprometido.sinFecha)).toBeGreaterThan(0);
    expect(cuerpo.alcance).toContain('inventar el acuerdo');

    // El consolidado viene por sentido y no como un neto: un solo número
    // escondería que la plata entra en marzo y sale en enero.
    //
    // Esta empresa no tiene ventas, así que no hay fila ENTRA — y eso está
    // bien: la vista no inventa una fila en cero para completar la simetría.
    expect(cuerpo.consolidado.map((c) => c.sentido)).toContain('SALE');
    expect(cuerpo.consolidado.every((c) => c.sentido === 'ENTRA' || c.sentido === 'SALE')).toBe(true);
  });

  it('la orden facturada deja de ser compromiso: pasa a ser deuda', async () => {
    // Es la condición que evita el doble conteo, y no la elige nadie: el estado
    // FACTURADO lo pone el circuito al vincular la factura.
    const orden = await ordenAceptada('4', '400.00', '84.00');

    const antesComprometido = Number(
      (await pedir('GET', '/analysis/flujo-de-fondos'))
        .json<{ porFuente: { fuente: string; total: string }[] }>()
        .porFuente.find((f) => f.fuente === 'COMPROMETIDO')?.total ?? 0,
    );

    const factura = await facturaDeCompra('400.00', '84.00', '484.00');
    expect(
      (await pedir('POST', `/commercial-documents/${orden}/link-invoice`, {
        taxTransactionId: factura,
      })).statusCode,
    ).toBe(200);

    const despues = Number(
      (await pedir('GET', '/analysis/flujo-de-fondos'))
        .json<{ porFuente: { fuente: string; total: string }[] }>()
        .porFuente.find((f) => f.fuente === 'COMPROMETIDO')?.total ?? 0,
    );

    expect(antesComprometido - despues, 'salió de comprometido al facturarse').toBe(484);
  });

  it('solo se vincula la factura de una orden aceptada', async () => {
    const borrador = (
      await pedir('POST', '/commercial-documents', {
        direccion: 'COMPRAS', tipo: 'PEDIDO', terceroId: proveedorId, fecha: hoy,
      })
    ).json<{ id: string }>().id;

    const r = await pedir('POST', `/commercial-documents/${borrador}/link-invoice`, {
      taxTransactionId: await facturaDeCompra('100.00', '21.00', '121.00'),
    });

    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('DOCUMENTO_NO_ACEPTADO');
  });
});
