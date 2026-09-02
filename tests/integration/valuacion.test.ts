/**
 * Valuación de existencias y costo de mercadería vendida.
 *
 * ## Qué defiende
 *
 *   1. **Que sin método declarado no se afirme nada.** Qué método usa un ente
 *      es una decisión contable con norma detrás.
 *   2. **Que no se ofrezca lo que no se calcula.** Declarar FIFO se rechaza con
 *      el motivo escrito, en vez de aceptarlo y devolver vacío.
 *   3. **Que el promedio sea el promedio.** Dos entradas a precios distintos y
 *      una salida en el medio: la aritmética se comprueba con números que se
 *      pueden rehacer a mano.
 *   4. **Que una entrada sin costo deje al producto sin valuar**, en vez de
 *      producir un promedio más chico que nadie sabría interpretar.
 *   5. **Que nada de esto escriba en el Mayor.**
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

interface Valuacion {
  readonly metodoVigente: { metodo: string } | null;
  readonly productos: {
    codigo: string;
    metodo: string | null;
    cantidad: string;
    costoTotal: string | null;
    costoUnitario: string | null;
    entradasSinCosto: boolean;
    metodologia: string;
  }[];
  readonly totalValuado: string;
  readonly productosSinValuar: number;
  readonly alcance: string;
}

suite('Valuación de existencias', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let proveedorId: string;
  let deposito: string;
  let productoConCosto: string;
  let productoSinCosto: string;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const valuacion = async (): Promise<Valuacion> =>
    (await pedir('GET', '/stock-valuation')).json<Valuacion>();

  const producto = (v: Valuacion, codigo: string) =>
    v.productos.find((p) => p.codigo === codigo)!;

  /** Una recepción confirmada: es lo único que escribe entradas de stock. */
  const recibir = async (
    productoId: string,
    cantidad: string,
    costoUnitario: string | null,
    fecha: string,
  ): Promise<void> => {
    const alta = await pedir('POST', '/goods-receipts', {
      proveedorId,
      fecha,
      depositoId: deposito,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;

    const renglon: Record<string, unknown> = {
      productoId,
      descripcion: 'Mercadería',
      cantidad,
    };
    if (costoUnitario !== null) renglon.costoUnitario = costoUnitario;

    expect(
      (await pedir('PUT', `/goods-receipts/${id}/lines`, { renglones: [renglon] })).statusCode,
    ).toBe(200);
    expect((await pedir('POST', `/goods-receipts/${id}/confirm`)).statusCode).toBe(200);
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
          `fundador-val-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio val ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa val ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-val-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-val-${stamp}@estudio.test`;
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

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Proveedor val ${stamp}`,
        roles: ['PROVEEDOR'],
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

    deposito = (
      await pedir('POST', '/warehouses', { codigo: `DEP-${stamp}`, nombre: 'Central' })
    ).json<{ id: string }>().id;

    productoConCosto = (
      await pedir('POST', '/products', {
        codigo: `CC-${stamp}`,
        nombre: 'Con costo',
        tipo: 'PRODUCTO',
        llevaStock: true,
        impuesto: 'IVA',
      })
    ).json<{ id: string }>().id;

    productoSinCosto = (
      await pedir('POST', '/products', {
        codigo: `SC-${stamp}`,
        nombre: 'Sin costo',
        tipo: 'PRODUCTO',
        llevaStock: true,
        impuesto: 'IVA',
      })
    ).json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin método declarado no se afirma ningún costo', async () => {
    await recibir(productoConCosto, '100', '10.00', hoy);

    const v = await valuacion();
    expect(v.metodoVigente).toBeNull();

    const p = producto(v, `CC-${stamp}`);
    expect(p.cantidad).toBe('100.0000');
    // La cantidad se sabe; el costo no se afirma. Son dos cosas distintas.
    expect(p.costoTotal).toBeNull();
    expect(p.metodologia).toContain('no declaró método');
    expect(v.totalValuado).toBe('0');
  });

  it('lo que falta llega a la bandeja sin bloquear nada', async () => {
    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string; bloquea: boolean }[] }>().items;

    const aviso = items.find((i) => i.rama === 'SIN_METODO_DE_VALUACION');
    expect(aviso).toBeDefined();
    // El stock se mueve igual: lo que no se puede es valuarlo.
    expect(aviso!.bloquea).toBe(false);
  });

  it('no se puede declarar un método que el sistema no calcula', async () => {
    const metodos = (await pedir('GET', '/stock-valuation/methods')).json<{
      metodos: { codigo: string; estado: string; porQue: string }[];
    }>();

    const fifo = metodos.metodos.find((m) => m.codigo === 'FIFO')!;
    expect(fifo.estado).toBe('PLANIFICADO');
    expect(fifo.porQue).toContain('capas');

    const r = await pedir('PUT', '/stock-valuation', {
      metodo: 'FIFO',
      vigenciaDesde: hoy,
      motivo: 'Queremos FIFO',
    });
    // Aceptarlo y devolver vacío dejaría a la empresa sin valuación sin
    // entender por qué.
    expect(r.statusCode).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('METODO_NO_DISPONIBLE');
  });

  it('declarado el promedio ponderado, el costo se calcula y se puede rehacer a mano', async () => {
    const declarar = await pedir('PUT', '/stock-valuation', {
      metodo: 'PPP',
      vigenciaDesde: `${new Date().getUTCFullYear()}-01-01`,
      motivo: 'Es el método que el ente venía aplicando',
    });
    expect(declarar.statusCode, declarar.body).toBe(200);

    // Segunda entrada a otro precio: 100 a $10 y 100 a $20 → promedio $15.
    await recibir(productoConCosto, '100', '20.00', hoy);

    const v = await valuacion();
    expect(v.metodoVigente!.metodo).toBe('PPP');

    const p = producto(v, `CC-${stamp}`);
    expect(p.cantidad).toBe('200.0000');
    expect(p.costoTotal, '100×10 + 100×20').toBe('3000.00');
    expect(p.costoUnitario, 'y el promedio es 15').toBe('15.0000');
  });

  it('una salida se costea al promedio del momento, y el promedio no cambia', async () => {
    // Se venden 50 al promedio de 15 → costo 750; quedan 150 valuados en 2.250.
    const salida = await pedir('POST', '/stock-movements/ajuste', {
      productoId: productoConCosto,
      depositoId: deposito,
      cantidad: '50',
      fecha: hoy,
      sentido: 'NEGATIVO',
      motivo: 'Salida de prueba para verificar el costeo',
    });
    expect(salida.statusCode, salida.body).toBe(201);

    const p = producto(await valuacion(), `CC-${stamp}`);
    expect(p.cantidad).toBe('150.0000');
    expect(p.costoTotal).toBe('2250.00');
    // Una salida no mueve el promedio: se lleva su parte exacta.
    expect(p.costoUnitario).toBe('15.0000');
  });

  it('una entrada sin costo deja el producto sin valuar, y dice cuál', async () => {
    await recibir(productoSinCosto, '10', null, hoy);

    const v = await valuacion();
    const p = producto(v, `SC-${stamp}`);

    expect(p.cantidad).toBe('10.0000');
    expect(p.entradasSinCosto).toBe(true);
    // Un promedio que ignora las entradas sin costo no es un promedio.
    expect(p.costoTotal).toBeNull();
    expect(p.metodologia).toContain('sin costo declarado');
    expect(v.productosSinValuar).toBeGreaterThanOrEqual(1);

    // Y el total valuado sigue siendo solo lo que se pudo valuar.
    expect(v.totalValuado).toBe('2250.00');

    const items = (await pedir('GET', '/work-queue?entidad=products&limite=200'))
      .json<{ items: { rama: string; entityId: string }[] }>().items;
    expect(
      items.find((i) => i.rama === 'ENTRADA_SIN_COSTO' && i.entityId === productoSinCosto),
    ).toBeDefined();
  });

  it('las salidas no llevan costo declarado: lo impide la base', async () => {
    // El costo de una salida es el promedio del momento. Dejar que alguien lo
    // escriba crearía una segunda verdad capaz de contradecirlo.
    await expect(
      db.query(
        `INSERT INTO stock_movements
           (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
            origen_tipo, motivo, costo_unitario, created_by)
         VALUES ($1,$2,$3,'AJUSTE_NEGATIVO','1',$4,'AJUSTE','prueba','99.00','test')`,
        [empresa, productoConCosto, deposito, hoy],
      ),
    ).rejects.toThrow(/sm_costo_solo_en_entradas/);
  });

  it('dos métodos vigentes a la vez no se aceptan', async () => {
    const r = await pedir('PUT', '/stock-valuation', {
      metodo: 'PPP',
      vigenciaDesde: hoy,
      motivo: 'Otra vez',
    });
    // Con dos, el mismo producto tendría dos costos.
    expect(r.statusCode).toBe(409);
  });

  it('el costo de ventas sale de las salidas por venta, no de los ajustes', async () => {
    const r = await pedir('GET', '/analysis/costo-de-ventas');
    expect(r.statusCode).toBe(200);
    const c = r.json<{ porMes: unknown[]; costoTotal: string; alcance: string }>();

    // La salida de arriba fue un AJUSTE, no una venta: no es costo de
    // mercadería vendida. Confundirlos inflaría el CMV con roturas.
    expect(c.porMes).toHaveLength(0);
    expect(c.costoTotal).toBe('0');
    expect(c.alcance).toContain('no genera ningún asiento');
  });

  it('valuar no escribe en el Mayor', async () => {
    const antes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ledger_movements WHERE company_id = $1',
      [empresa],
    );

    await valuacion();
    await pedir('GET', '/analysis/costo-de-ventas');

    const despues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ledger_movements WHERE company_id = $1',
      [empresa],
    );
    // El asiento de costo de mercadería vendida lo firma una persona.
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  });

  it('las vistas de valuación conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('stock_movements_ordenados', 'stock_ppp', 'stock_valuation',
                          'analytics_costo_de_ventas', 'work_queue_valuacion')`,
    );
    expect(r.rowCount).toBe(5);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
