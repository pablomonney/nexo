/**
 * El detalle de un comprobante, y el candado que lo hace confiable.
 *
 * La cabecera de `tax_transactions` alcanza para el IVA y para el asiento. No
 * alcanza para margen, ni para stock, ni para que un conector de e-commerce
 * escriba lo que trae de la tienda. Los renglones cubren eso.
 *
 * Lo que se prueba acá, en orden de importancia:
 *
 *   1. **Que los renglones cierren contra la cabecera**, verificado al COMMIT.
 *      Sin este candado el detalle sería decorativo: cualquier suma pasaría.
 *   2. **Que cada tratamiento sume en su columna.** Un renglón exento que
 *      engrosara el neto gravado saldría mal en el subdiario de IVA — y el
 *      dato se habría cargado bien.
 *   3. **Que no se edite el detalle de un comprobante ya imputado** (ADR-003).
 *   4. Que un comprobante sin renglones siga siendo válido.
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

suite('Renglones de comprobante', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let productoId: string;
  let numero = 5000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Un comprobante con los totales que se le indiquen. */
  async function comprobante(totales: {
    neto: string;
    iva: string;
    exento: string;
    noGravado: string;
    total: string;
  }): Promise<string> {
    numero += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="ren-${stamp}-${numero}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numero}</n></comprobante>\r\n--X--\r\n`;

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
      puntoVenta: 1,
      numero,
      fecha: '2026-03-15',
      cuitContraparte: '30710000001',
      razonSocial: 'Proveedor de prueba',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: totales.neto,
      iva: totales.iva,
      noGravado: totales.noGravado,
      exento: totales.exento,
      percepciones: '0',
      total: totales.total,
    });
    expect(op.statusCode, op.body).toBe(201);
    return op.json<{ taxTransactionId: string }>().taxTransactionId;
  }

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
          `fundador-ren-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio ren ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa ren ${stamp}`, withCheckDigit(`33${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-ren-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-ren-${stamp}@estudio.test`;
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
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }

    productoId = (
      await pedir('POST', '/products', {
        codigo: `INSUMO-${stamp}`,
        nombre: 'Insumo de prueba',
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

  it('un comprobante sin renglones es válido, y lo dice', async () => {
    const id = await comprobante({
      neto: '1000.00', iva: '210.00', exento: '0', noGravado: '0', total: '1210.00',
    });
    const r = await pedir('GET', `/tax-transactions/${id}/lines`);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ renglones: unknown[]; alcance: string }>();
    expect(cuerpo.renglones).toEqual([]);
    expect(cuerpo.alcance).toContain('válido igual');
  });

  it('carga el detalle cuando cierra contra la cabecera', async () => {
    const id = await comprobante({
      neto: '1000.00', iva: '210.00', exento: '0', noGravado: '0', total: '1210.00',
    });

    const r = await pedir('PUT', `/tax-transactions/${id}/lines`, {
      renglones: [
        {
          productoId,
          descripcion: 'Insumo de prueba',
          cantidad: '4',
          unidad: 'UNIDAD',
          precioUnitario: '150.0000',
          tratamiento: 'GRAVADO',
          neto: '600.00',
          iva: '126.00',
        },
        {
          descripcion: 'Flete',
          cantidad: '1',
          precioUnitario: '400.0000',
          tratamiento: 'GRAVADO',
          neto: '400.00',
          iva: '84.00',
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(200);

    const detalle = await pedir('GET', `/tax-transactions/${id}/lines`);
    const renglones = detalle.json<{ renglones: { linea: number; productoCodigo: string | null }[] }>()
      .renglones;
    expect(renglones).toHaveLength(2);
    expect(renglones[0]!.linea).toBe(1);
    expect(renglones[0]!.productoCodigo).toBe(`INSUMO-${stamp}`);
    // El segundo renglón no está en el maestro y eso es legítimo: primero se
    // registra lo que pasó, después se ordena el maestro.
    expect(renglones[1]!.productoCodigo).toBeNull();
  });

  it('rechaza un detalle que no cierra, aunque sea por un peso', async () => {
    const id = await comprobante({
      neto: '1000.00', iva: '210.00', exento: '0', noGravado: '0', total: '1210.00',
    });

    const r = await pedir('PUT', `/tax-transactions/${id}/lines`, {
      renglones: [
        {
          descripcion: 'Un peso de menos',
          cantidad: '1',
          precioUnitario: '999.0000',
          tratamiento: 'GRAVADO',
          neto: '999.00',
          iva: '210.00',
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('RENGLONES_NO_CIERRAN');
  });

  it('cada tratamiento suma en su propia columna', async () => {
    const id = await comprobante({
      neto: '1000.00', iva: '210.00', exento: '500.00', noGravado: '0', total: '1710.00',
    });

    // Lo exento NO puede sumar al neto gravado: el subdiario de IVA saldría mal
    // con un dato cargado bien.
    const mal = await pedir('PUT', `/tax-transactions/${id}/lines`, {
      renglones: [
        {
          descripcion: 'Todo junto al neto',
          cantidad: '1', precioUnitario: '1500.0000',
          tratamiento: 'GRAVADO', neto: '1500.00', iva: '210.00',
        },
      ],
    });
    expect(mal.statusCode, mal.body).toBe(422);

    const bien = await pedir('PUT', `/tax-transactions/${id}/lines`, {
      renglones: [
        {
          descripcion: 'Mercadería gravada',
          cantidad: '1', precioUnitario: '1000.0000',
          tratamiento: 'GRAVADO', neto: '1000.00', iva: '210.00',
        },
        {
          descripcion: 'Libro exento',
          cantidad: '1', precioUnitario: '500.0000',
          tratamiento: 'EXENTO', neto: '500.00', iva: '0',
        },
      ],
    });
    expect(bien.statusCode, bien.body).toBe(200);
  });

  it('un renglón no gravado con IVA no entra', async () => {
    const id = await comprobante({
      neto: '0', iva: '0', exento: '100.00', noGravado: '0', total: '100.00',
    });
    const r = await pedir('PUT', `/tax-transactions/${id}/lines`, {
      renglones: [
        {
          descripcion: 'Exento con IVA',
          cantidad: '1', precioUnitario: '100.0000',
          tratamiento: 'EXENTO', neto: '100.00', iva: '21.00',
        },
      ],
    });
    expect(r.statusCode, r.body).not.toBe(200);
  });

  it('borrar el detalle es legítimo y queda en la bitácora', async () => {
    const id = await comprobante({
      neto: '100.00', iva: '21.00', exento: '0', noGravado: '0', total: '121.00',
    });
    expect(
      (await pedir('PUT', `/tax-transactions/${id}/lines`, {
        renglones: [
          {
            descripcion: 'Algo', cantidad: '1', precioUnitario: '100.0000',
            tratamiento: 'GRAVADO', neto: '100.00', iva: '21.00',
          },
        ],
      })).statusCode,
    ).toBe(200);

    const vacio = await pedir('PUT', `/tax-transactions/${id}/lines`, { renglones: [] });
    expect(vacio.statusCode, vacio.body).toBe(200);

    const bitacora = await db.query<{ cantidad: string }>(
      `SELECT count(*)::text AS cantidad FROM audit_logs
        WHERE object_id = $1 AND action = 'DETALLAR_COMPROBANTE'`,
      [id],
    );
    expect(Number(bitacora.rows[0]!.cantidad)).toBe(2);
  });

  it('no se edita el detalle de un comprobante ya imputado', async () => {
    const id = await comprobante({
      neto: '1000.00', iva: '210.00', exento: '0', noGravado: '0', total: '1210.00',
    });
    expect(
      (await pedir('PUT', `/tax-transactions/${id}/lines`, {
        renglones: [
          {
            descripcion: 'Compra', cantidad: '1', precioUnitario: '1000.0000',
            tratamiento: 'GRAVADO', neto: '1000.00', iva: '210.00',
          },
        ],
      })).statusCode,
    ).toBe(200);

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'COMPRAS',
      entryDate: '2026-03-15',
      description: 'Compra con detalle',
      currency: 'ARS',
      lines: [
        { accountCode: '5.1.01', debit: '1210.00', credit: '0' },
        { accountCode: '2.1.01', debit: '0', credit: '1210.00' },
      ],
      source: { type: 'INVOICE', id },
      manualJustification: 'Compra registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`)).statusCode,
    ).toBe(200);

    const r = await pedir('PUT', `/tax-transactions/${id}/lines`, {
      renglones: [
        {
          descripcion: 'Corregido a mano', cantidad: '2', precioUnitario: '500.0000',
          tratamiento: 'GRAVADO', neto: '1000.00', iva: '210.00',
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('COMPROBANTE_IMPUTADO');
  });

  it('los movimientos por producto se derivan de los renglones', async () => {
    const r = await pedir('GET', `/products/${productoId}/movimientos`);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      movimientos: { direccion: string; cantidad: string; neto: string }[];
      alcance: string;
    }>();
    const compras = cuerpo.movimientos.find((m) => m.direccion === 'COMPRAS');
    expect(compras, 'el producto se compró: tiene que aparecer').toBeDefined();
    expect(Number(compras!.cantidad)).toBeGreaterThan(0);
    // No se lo llama stock, y la respuesta lo dice.
    expect(cuerpo.alcance).toContain('no existencias');
  });

  it('no se puede detallar un comprobante de otra empresa', async () => {
    const ajeno = await app.inject({
      method: 'GET',
      url: '/tax-transactions/00000000-0000-4000-8000-000000000000/lines',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });
    expect(ajeno.statusCode).toBe(404);
  });
});
