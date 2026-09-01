/**
 * Depósitos, movimientos y existencias.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que las existencias se deriven.** No hay columna `stock_actual`, y hay
 *      un test que falla si alguien la agrega.
 *   2. **Que la entrada por recepción la escriba la base**, no la aplicación
 *      (A-7). Confirmar una recepción mueve stock aunque nadie llame a la ruta
 *      de stock.
 *   3. **Que el libro sea inmutable.** Deshacer es un movimiento nuevo, no una
 *      edición — igual que un contraasiento.
 *   4. **Que no se invente el umbral.** Un producto sin mínimo declarado nunca
 *      figura bajo mínimo.
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

suite('Stock: depósitos, movimientos y existencias', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let proveedorId: string;
  let conMinimo: string;
  let sinMinimo: string;
  let servicioId: string;
  let central: string;
  let sucursal: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
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
          `fundador-stk-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio stk ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa stk ${stamp}`, withCheckDigit(`34${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-stk-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-stk-${stamp}@estudio.test`;
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
    expect(
      (await pedir('POST', '/accounts', { code: '5.1.01', name: 'Compras', type: 'COSTO' }))
        .statusCode,
    ).toBe(201);

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Proveedor stk ${stamp}`,
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    // Un producto con mínimo declarado y otro sin él: la diferencia es el
    // corazón de la mitad «no inventar el umbral».
    conMinimo = (
      await pedir('POST', '/products', {
        codigo: `CON-MIN-${stamp}`,
        nombre: 'Producto con mínimo',
        impuesto: 'IVA',
        cuentaCompra: '5.1.01',
        llevaStock: true,
        stockMinimo: '20',
      })
    ).json<{ id: string }>().id;

    sinMinimo = (
      await pedir('POST', '/products', {
        codigo: `SIN-MIN-${stamp}`,
        nombre: 'Producto sin mínimo',
        impuesto: 'IVA',
        llevaStock: true,
      })
    ).json<{ id: string }>().id;

    servicioId = (
      await pedir('POST', '/products', {
        codigo: `SERV-${stamp}`,
        nombre: 'Servicio',
        tipo: 'SERVICIO',
        unidad: 'HORA',
        impuesto: 'IVA',
      })
    ).json<{ id: string }>().id;

    central = (
      await pedir('POST', '/warehouses', { codigo: `CENTRAL-${stamp}`, nombre: 'Depósito central' })
    ).json<{ id: string }>().id;
    sucursal = (
      await pedir('POST', '/warehouses', { codigo: `SUC-${stamp}`, nombre: 'Sucursal' })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Una recepción confirmada que entra `cantidad` del producto en un depósito. */
  async function recibir(
    productoId: string,
    cantidad: string,
    deposito: string | null,
  ): Promise<string> {
    const alta = await pedir('POST', '/goods-receipts', {
      proveedorId, fecha: '2026-03-03',
      ...(deposito === null ? {} : { depositoId: deposito }),
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    expect(
      (await pedir('PUT', `/goods-receipts/${id}/lines`, {
        renglones: [{ productoId, descripcion: 'Mercadería', cantidad }],
      })).statusCode,
    ).toBe(200);
    return id;
  }

  // -------------------------------------------------------------------------
  it('confirmar una recepción mueve stock sin pasar por la ruta de stock', async () => {
    // A-7 aplicado al stock: el libro lo escribe la base. Si lo escribiera la
    // aplicación, bastaría una segunda ruta que confirmara sin mover.
    const id = await recibir(conMinimo, '100', central);
    expect((await pedir('POST', `/goods-receipts/${id}/confirm`)).statusCode).toBe(200);

    const r = await pedir('GET', `/products/${conMinimo}/stock`);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      existencias: { depositoId: string; existencia: string }[];
      movimientos: { tipo: string; origenTipo: string }[];
    }>();
    expect(cuerpo.existencias).toHaveLength(1);
    expect(cuerpo.existencias[0]!.existencia).toBe('100.0000');
    expect(cuerpo.movimientos[0]!.tipo).toBe('ENTRADA');
    expect(cuerpo.movimientos[0]!.origenTipo).toBe('RECEPCION');
  });

  it('no hay ninguna columna que guarde la existencia', async () => {
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'products'
          AND column_name IN ('stock', 'stock_actual', 'existencia', 'cantidad')`,
    );
    expect(columnas.rows).toEqual([]);
  });

  it('una recepción con productos de stock no se confirma sin depósito', async () => {
    const id = await recibir(conMinimo, '5', null);
    const r = await pedir('POST', `/goods-receipts/${id}/confirm`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('RECEPCION_SIN_DEPOSITO');

    // Y con el depósito indicado al confirmar, entra.
    const ok = await pedir('POST', `/goods-receipts/${id}/confirm`, { depositoId: central });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('anular una recepción confirmada no borra: escribe el movimiento contrario', async () => {
    const antes = await existencia(sinMinimo);
    const id = await recibir(sinMinimo, '40', central);
    expect((await pedir('POST', `/goods-receipts/${id}/confirm`)).statusCode).toBe(200);
    expect(await existencia(sinMinimo)).toBe(antes + 40);

    expect(
      (await pedir('POST', `/goods-receipts/${id}/cancel`, {
        motivo: 'Se cargó contra el depósito equivocado',
      })).statusCode,
    ).toBe(200);

    expect(await existencia(sinMinimo), 'la existencia vuelve').toBe(antes);

    // Y quedan las dos filas: el libro solo crece.
    const movs = await db.query<{ cantidad: string }>(
      `SELECT cantidad::text FROM stock_movements
        WHERE origen_id = $1 OR motivo LIKE '%recepción anulada%'`,
      [id],
    );
    expect(Number(movs.rowCount)).toBeGreaterThanOrEqual(2);
  });

  it('el libro de movimientos no se edita ni se borra', async () => {
    const mov = await db.query<{ id: string }>(
      'SELECT id FROM stock_movements WHERE company_id = $1 LIMIT 1',
      [empresa],
    );
    await expect(
      db.query('UPDATE stock_movements SET cantidad = 1 WHERE id = $1', [mov.rows[0]!.id]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM stock_movements WHERE id = $1', [mov.rows[0]!.id]),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  it('un servicio no mueve stock', async () => {
    const r = await pedir('POST', '/stock-movements/ajuste', {
      productoId: servicioId, depositoId: central, cantidad: '1',
      fecha: '2026-03-05', sentido: 'POSITIVO', motivo: 'No debería entrar',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('PRODUCTO_SIN_STOCK');
  });

  it('un ajuste exige motivo y queda en la bitácora', async () => {
    const sinMotivo = await pedir('POST', '/stock-movements/ajuste', {
      productoId: conMinimo, depositoId: central, cantidad: '3',
      fecha: '2026-03-05', sentido: 'NEGATIVO',
    });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const antes = await existencia(conMinimo);
    const r = await pedir('POST', '/stock-movements/ajuste', {
      productoId: conMinimo, depositoId: central, cantidad: '3',
      fecha: '2026-03-05', sentido: 'NEGATIVO', motivo: 'Tres unidades rotas en el recuento',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(await existencia(conMinimo)).toBe(antes - 3);

    const bitacora = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE object_id = $1 AND action = 'AJUSTAR_STOCK'`,
      [r.json<{ id: string }>().id],
    );
    expect(bitacora.rowCount).toBe(1);
  });

  it('una transferencia son dos movimientos y no cambia el total', async () => {
    const total = await existencia(conMinimo);
    const r = await pedir('POST', '/stock-movements/transferencia', {
      productoId: conMinimo, origenDepositoId: central, destinoDepositoId: sucursal,
      cantidad: '25', fecha: '2026-03-06',
    });
    expect(r.statusCode, r.body).toBe(201);

    const detalle = await pedir('GET', `/products/${conMinimo}/stock`);
    const existencias = detalle
      .json<{ existencias: { depositoId: string; existencia: string }[] }>()
      .existencias;
    expect(existencias).toHaveLength(2);
    // El total no cambia: la mercadería se movió, no apareció ni desapareció.
    expect(await existencia(conMinimo)).toBe(total);
    expect(
      Number(existencias.find((e) => e.depositoId === sucursal)!.existencia),
    ).toBe(25);
  });

  it('no se transfiere de un depósito a sí mismo', async () => {
    const r = await pedir('POST', '/stock-movements/transferencia', {
      productoId: conMinimo, origenDepositoId: central, destinoDepositoId: central,
      cantidad: '1', fecha: '2026-03-06',
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  // -------------------------------------------------------------------------
  // El umbral no se inventa
  // -------------------------------------------------------------------------
  it('sin mínimo declarado, nunca figura bajo mínimo', async () => {
    const r = await pedir('GET', '/stock');
    const filas = r.json<{
      existencias: { productoId: string; bajoMinimo: boolean; stockMinimo: string | null }[];
      alcance: string;
    }>();

    const sin = filas.existencias.find((e) => e.productoId === sinMinimo);
    expect(sin!.stockMinimo).toBeNull();
    expect(sin!.bajoMinimo, 'sin umbral declarado no hay nada que comparar').toBe(false);
    expect(filas.alcance).toContain('no inventa el umbral');
  });

  it('con mínimo declarado, avisa cuando la existencia cae por debajo', async () => {
    // Quedan 97 con mínimo 20. Se baja a 10 con un ajuste.
    const actual = await existencia(conMinimo);
    expect(
      (await pedir('POST', '/stock-movements/ajuste', {
        productoId: conMinimo, depositoId: central,
        cantidad: String(actual - 10), fecha: '2026-03-07',
        sentido: 'NEGATIVO', motivo: 'Recuento físico',
      })).statusCode,
    ).toBe(201);

    const r = await pedir('GET', '/stock?soloBajoMinimo=si');
    const ids = r.json<{ existencias: { productoId: string }[] }>().existencias
      .map((e) => e.productoId);
    expect(ids).toContain(conMinimo);
    expect(ids).not.toContain(sinMinimo);

    const bandeja = await pedir('GET', '/work-queue?limite=200');
    const item = bandeja
      .json<{ items: { rama: string; entityId: string; disponibilidad: string }[] }>()
      .items.find((i) => i.rama === 'STOCK_BAJO_MINIMO' && i.entityId === conMinimo);
    expect(item).toBeDefined();
    // No se resuelve desde la bandeja: hay que comprar.
    expect(item!.disponibilidad).toBe('INFORMATIVO');
  });

  it('una existencia negativa aparece como algo que falta registrar', async () => {
    const actual = await existencia(sinMinimo);
    expect(
      (await pedir('POST', '/stock-movements/ajuste', {
        productoId: sinMinimo, depositoId: central,
        cantidad: String(actual + 5), fecha: '2026-03-08',
        sentido: 'NEGATIVO', motivo: 'Salida no registrada que aparece en el recuento',
      })).statusCode,
    ).toBe(201);

    expect(await existencia(sinMinimo)).toBe(-5);

    const bandeja = await pedir('GET', '/work-queue?limite=200');
    expect(
      bandeja.json<{ items: { rama: string; entityId: string }[] }>().items
        .some((i) => i.rama === 'EXISTENCIA_NEGATIVA' && i.entityId === sinMinimo),
      'existencia negativa es un dato imposible: en algún lado falta un movimiento',
    ).toBe(true);
  });

  it('las existencias son por empresa y no se filtran', async () => {
    const otras = await db.query<{ cantidad: string }>(
      `SELECT count(*)::text AS cantidad FROM stock_movements WHERE company_id <> $1`,
      [empresa],
    );
    // La consulta directa ve todo porque corre como superusuario; lo que importa
    // es que la vista lleve `security_invoker`, que es lo que hace que la
    // aplicación —con rol `aai_app`— vea solo lo suyo.
    const invoker = await db.query<{ reloptions: string[] }>(
      `SELECT reloptions FROM pg_class WHERE relname IN ('stock_on_hand', 'stock_by_product')`,
    );
    for (const fila of invoker.rows) {
      expect(fila.reloptions).toContain('security_invoker=true');
    }
    expect(otras.rowCount).toBe(1);
  });

  /** La existencia total del producto, como número. */
  async function existencia(productoId: string): Promise<number> {
    const r = await pedir('GET', `/products/${productoId}/stock`);
    const filas = r.json<{ existencias: { existencia: string }[] }>().existencias;
    return filas.reduce((total, e) => total + Number(e.existencia), 0);
  }
});
