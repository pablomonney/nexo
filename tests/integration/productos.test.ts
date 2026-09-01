/**
 * El maestro de productos y servicios, recorrido por HTTP.
 *
 * Lo que este archivo defiende, además de que el alta funcione:
 *
 *   1. **Que no haya una alícuota guardada.** Es la garantía de §6 hecha test.
 *      Una columna `alicuota` en el maestro haría que una factura de 2024 se
 *      recalculara con la alícuota de hoy, y el error sería invisible.
 *   2. **Que la cuenta sugerida sirva.** Una cuenta no imputable o del tipo
 *      equivocado hace fallar el asiento recién al armarlo, cuando ya hay una
 *      factura emitida esperando. El candado corta en el alta.
 *   3. **Que el aislamiento aguante**, igual que en terceros.
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

suite('Maestro de productos', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresaA: string;
  let empresaB: string;

  const pedir = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    empresa: string,
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

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-prod-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio prod ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          fundadorId, organizationId, nombre, withCheckDigit(`${prefijo}${stamp}`),
          'SA', 'AR-C', 'IGJ', '12-31',
        ])
      ).rows[0]!.create_company;

    empresaA = await crearEmpresa(`Empresa A prod ${stamp}`, '33');
    empresaB = await crearEmpresa(`Empresa B prod ${stamp}`, '27');

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-prod-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-prod-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const empresa of [empresaA, empresaB]) {
      for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
        await app.inject({
          method: 'POST',
          url: `/companies/${empresa}/roles`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { userId, role },
        });
      }
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

    // Plan mínimo: una de ingresos imputable, una de costo, una NO imputable y
    // una de pasivo. Las dos últimas existen para que los candados tengan contra
    // qué fallar — un test que solo prueba el camino feliz no prueba el candado.
    for (const empresa of [empresaA, empresaB]) {
      for (const cuenta of [
        { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
        { code: '5.1.01', name: 'Compras', type: 'COSTO' },
        { code: '4', name: 'Ingresos (rubro)', type: 'INGRESO', isPostable: false },
        { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
      ]) {
        const r = await pedir('POST', '/accounts', empresa, cuenta);
        expect(r.statusCode, r.body).toBe(201);
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  let sillaId: string;

  it('da de alta un producto gravado con su cuenta de venta', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `SILLA-${stamp}`,
      nombre: 'Silla de oficina',
      tipo: 'PRODUCTO',
      unidad: 'UNIDAD',
      tratamientoImpositivo: 'GRAVADO',
      impuesto: 'IVA',
      cuentaVenta: '4.1.01',
      cuentaCompra: '5.1.01',
      llevaStock: true,
      precioLista: '85000.5000',
    });
    expect(r.statusCode, r.body).toBe(201);
    sillaId = r.json<{ id: string }>().id;

    const ficha = await pedir('GET', `/products/${sillaId}`, empresaA);
    expect(ficha.statusCode).toBe(200);
    const p = ficha.json<{ producto: Record<string, unknown> }>().producto;
    expect(p.impuesto).toBe('IVA');
    expect(p.cuentaVentaCodigo).toBe('4.1.01');
    expect(p.llevaStock).toBe(true);
    expect(p.precioLista).toBe('85000.5000');
  });

  it('el maestro NO guarda alícuotas: la resuelve el motor por fecha', async () => {
    // §6 hecho comprobación estructural. Si alguien agrega `alicuota` acá, este
    // test cae — y tiene que caer: una factura de 2024 recalculada con la
    // alícuota de hoy es un error que no se ve hasta que lo mira ARCA.
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'products'
          AND column_name IN ('alicuota', 'tax_rate', 'tax_rate_id', 'iva', 'porcentaje_iva')`,
    );
    expect(columnas.rows).toEqual([]);
  });

  it('un producto gravado sin impuesto declarado no entra', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `SIN-IMP-${stamp}`,
      nombre: 'Gravado sin impuesto',
      tratamientoImpositivo: 'GRAVADO',
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('un producto exento sí puede no declarar impuesto', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `LIBRO-${stamp}`,
      nombre: 'Libro',
      tratamientoImpositivo: 'EXENTO',
      cuentaVenta: '4.1.01',
    });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('un servicio no lleva stock', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `HORA-${stamp}`,
      nombre: 'Hora de consultoría',
      tipo: 'SERVICIO',
      unidad: 'HORA',
      impuesto: 'IVA',
      llevaStock: true,
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('el código no se repite, ni cambiando mayúsculas', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `silla-${stamp}`,
      nombre: 'Otra silla',
      impuesto: 'IVA',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('PRODUCTO_DUPLICADO');
  });

  it('rechaza una cuenta de venta que no es imputable', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `NOIMP-${stamp}`,
      nombre: 'Con cuenta de rubro',
      impuesto: 'IVA',
      cuentaVenta: '4',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTA_DE_VENTA_INVALIDA');
  });

  it('rechaza una cuenta de venta que no es de ingresos', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `MALTIPO-${stamp}`,
      nombre: 'Con cuenta de pasivo',
      impuesto: 'IVA',
      cuentaVenta: '2.1.01',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTA_DE_VENTA_INVALIDA');
  });

  it('rechaza una cuenta que no existe en esta empresa', async () => {
    const r = await pedir('POST', '/products', empresaA, {
      codigo: `FANTASMA-${stamp}`,
      nombre: 'Con cuenta inexistente',
      impuesto: 'IVA',
      cuentaVenta: '9.9.99',
    });
    expect(r.statusCode, r.body).toBe(404);
  });

  it('la empresa B no ve el producto de la empresa A', async () => {
    const ficha = await pedir('GET', `/products/${sillaId}`, empresaB);
    expect(ficha.statusCode).toBe(404);

    const lista = await pedir('GET', '/products', empresaB);
    expect(lista.statusCode).toBe(200);
    const ids = lista.json<{ productos: { id: string }[] }>().productos.map((p) => p.id);
    expect(ids).not.toContain(sillaId);
  });

  it('el mismo código puede existir en otra empresa', async () => {
    const r = await pedir('POST', '/products', empresaB, {
      codigo: `SILLA-${stamp}`,
      nombre: 'Silla de la empresa B',
      impuesto: 'IVA',
    });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('editar exige motivo y queda en la bitácora', async () => {
    const sinMotivo = await pedir('PATCH', `/products/${sillaId}`, empresaA, {
      precioLista: '90000.0000',
    });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const conMotivo = await pedir('PATCH', `/products/${sillaId}`, empresaA, {
      precioLista: '90000.0000',
      motivo: 'Actualización de lista de septiembre',
    });
    expect(conMotivo.statusCode, conMotivo.body).toBe(200);

    const bitacora = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE object_type = 'products' AND object_id = $1 ORDER BY occurred_at`,
      [sillaId],
    );
    expect(bitacora.rows.map((f) => f.action)).toEqual(['CREAR_PRODUCTO', 'MODIFICAR_PRODUCTO']);
  });

  it('el borrado físico de un producto está prohibido', async () => {
    await expect(db.query('DELETE FROM products WHERE id = $1', [sillaId])).rejects.toThrow();
  });

  it('busca por código y por nombre, y pagina sin repetir', async () => {
    const porNombre = await pedir('GET', '/products?q=silla', empresaA);
    expect(porNombre.statusCode).toBe(200);
    expect(porNombre.json<{ productos: unknown[] }>().productos.length).toBeGreaterThan(0);

    const p1 = await pedir('GET', '/products?limite=1', empresaA);
    const uno = p1.json<{ productos: { id: string }[]; cursor: string | null }>();
    expect(uno.cursor).not.toBeNull();

    const p2 = await pedir(
      'GET',
      `/products?limite=1&cursor=${encodeURIComponent(uno.cursor!)}`,
      empresaA,
    );
    const dos = p2.json<{ productos: { id: string }[] }>();
    expect(dos.productos[0]!.id).not.toBe(uno.productos[0]!.id);
  });
});
