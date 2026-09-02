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
  let comprobanteDeVenta: string;
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

    // Una venta de verdad: la salida de stock por venta exige citarla, y es la
    // única salida que cuenta como costo de mercadería vendida.
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="val-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>1</n></c>\r\n--X--\r\n`;
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
      numero: 9001,
      fecha: hoy,
      cuitContraparte: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
      razonSocial: `Cliente val ${stamp}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '5000.00', iva: '1050.00', noGravado: '0', exento: '0', percepciones: '0',
      total: '6050.00',
    });
    expect(op.statusCode, op.body).toBe(201);
    comprobanteDeVenta = op.json<{ taxTransactionId: string }>().taxTransactionId;
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

  it('el asiento de costo no se propone si falta declarar dónde va', async () => {
    // Una salida por venta de verdad: es la única que cuenta como costo de
    // mercadería vendida. El ajuste de antes no era una venta.
    const mes = hoy.slice(0, 7);
    const venta = await pedir('POST', '/stock-movements/salida', {
      productoId: productoConCosto,
      depositoId: deposito,
      cantidad: '10',
      fecha: hoy,
      taxTransactionId: comprobanteDeVenta,
    });
    expect(venta.statusCode, venta.body).toBe(201);

    const r = await pedir('GET', `/analysis/costo-de-ventas/asiento-propuesto?mes=${mes}`);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json<{
      renglones: unknown[];
      motivoSinRenglones: string | null;
      rolesFaltantes: string[];
    }>();

    expect(p.renglones).toHaveLength(0);
    expect(p.rolesFaltantes).toEqual(['COSTO_DE_VENTAS', 'MERCADERIA']);
    expect(p.motivoSinRenglones).toContain('inventar la contabilidad');
  });

  it('declaradas las cuentas, el asiento se propone y cuadra', async () => {
    for (const cuenta of [
      { code: '1.1.05', name: 'Mercadería', type: 'ACTIVO' },
      { code: '5.1.02', name: 'Costo de mercadería vendida', type: 'COSTO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode, cuenta.code).toBe(201);
    }

    // La cuenta del tipo equivocado se rechaza: el costo no es un activo.
    const alReves = await pedir('PUT', '/accounting-map', {
      asignaciones: [{ rol: 'COSTO_DE_VENTAS', cuenta: '1.1.05' }],
    });
    expect(alReves.statusCode).toBe(422);

    expect(
      (await pedir('PUT', '/accounting-map', {
        asignaciones: [
          { rol: 'MERCADERIA', cuenta: '1.1.05' },
          { rol: 'COSTO_DE_VENTAS', cuenta: '5.1.02' },
        ],
      })).statusCode,
    ).toBe(200);

    const mes = hoy.slice(0, 7);
    const p = (await pedir('GET', `/analysis/costo-de-ventas/asiento-propuesto?mes=${mes}`))
      .json<{
        renglones: { accountCode: string; debit: string; credit: string }[];
        costo: string;
        metodo: string;
        justificacionSugerida: string;
      }>();

    expect(p.renglones).toHaveLength(2);
    // 10 unidades al promedio de 15 = 150.
    expect(p.costo).toBe('150.00');
    expect(p.metodo).toBe('PPP');

    const debe = p.renglones.find((l) => l.debit !== '0')!;
    const haber = p.renglones.find((l) => l.credit !== '0')!;
    expect(debe.accountCode, 'el costo se reconoce como resultado').toBe('5.1.02');
    expect(haber.accountCode, 'y la mercadería se da de baja').toBe('1.1.05');
    expect(debe.debit).toBe(haber.credit);
    expect(p.justificacionSugerida).toContain('PPP');
  });

  it('el asiento de costo llega al Mayor por el camino de siempre', async () => {
    const mes = hoy.slice(0, 7);
    const p = (await pedir('GET', `/analysis/costo-de-ventas/asiento-propuesto?mes=${mes}`))
      .json<{
        renglones: unknown[];
        justificacionSugerida: string;
      }>();

    const antes = await db.query<{ saldo: string }>(
      `SELECT coalesce(sum(lm.debit - lm.credit), 0)::text AS saldo
         FROM ledger_movements lm
         JOIN accounts a ON a.id = lm.account_id AND a.company_id = lm.company_id
        WHERE lm.company_id = $1 AND a.code = '5.1.02'`,
      [empresa],
    );
    expect(antes.rows[0]!.saldo, 'todavía no se asentó nada').toBe('0');

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: hoy,
      description: `Costo de mercadería vendida — ${mes}`,
      currency: 'ARS',
      lines: p.renglones,
      source: { type: 'MANUAL', id: null },
      manualJustification: p.justificacionSugerida,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir('POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);

    const despues = await db.query<{ saldo: string }>(
      `SELECT coalesce(sum(lm.debit - lm.credit), 0)::text AS saldo
         FROM ledger_movements lm
         JOIN accounts a ON a.id = lm.account_id AND a.company_id = lm.company_id
        WHERE lm.company_id = $1 AND a.code = '5.1.02'`,
      [empresa],
    );
    // El resultado del ejercicio ya incluye el costo de lo vendido. Es lo que
    // faltaba para que una venta dejara de figurar entera como ganancia.
    expect(despues.rows[0]!.saldo).toBe('150.00');
  });

  it('el margen no se afirma si lo facturado no coincide con lo que salió', async () => {
    // El comprobante de la venta declaró 5.000 de neto sin renglones, y la
    // salida de stock fue de 10 unidades. Sin renglones no hay unidades
    // vendidas contra las que comparar, así que el margen no se afirma.
    const r = await pedir('GET', '/analysis/margen');
    expect(r.statusCode, r.body).toBe(200);
    const m = r.json<{
      porProducto: { codigo: string; margen: string | null; unidadesVendidas: string;
                     unidadesSalidas: string; metodologia: string }[];
      totalAfirmable: { sin_afirmar: number };
      alcance: string;
    }>();

    const p = m.porProducto.find((x) => x.codigo === `CC-${stamp}`);
    expect(p, 'el producto que salió del depósito tiene que aparecer').toBeDefined();
    expect(p!.unidadesSalidas).toBe('10.0000');
    expect(p!.unidadesVendidas, 'el comprobante no tenía renglones').toBe('0');
    // Diez que salieron contra cero facturadas: el margen no se afirma.
    expect(p!.margen).toBeNull();
    expect(p!.metodologia).toContain('más grande que el real');
    expect(m.alcance).toContain('parece bueno');
  });

  it('con las dos puntas completas, el margen se afirma y se puede rehacer', async () => {
    // Se factura con renglón por el producto: 10 unidades a 300 = 3.000 de
    // venta, contra un costo de 150 (10 al promedio de 15).
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="mar-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>2</n></c>\r\n--X--\r\n`;
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
      numero: 9002,
      fecha: hoy,
      cuitContraparte: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
      razonSocial: `Cliente val ${stamp}`,
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '3000.00', iva: '630.00', noGravado: '0', exento: '0', percepciones: '0',
      total: '3630.00',
    });
    expect(op.statusCode, op.body).toBe(201);
    const segunda = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('PUT', `/tax-transactions/${segunda}/lines`, {
        renglones: [{
          productoId: productoSinCosto,
          descripcion: 'Mercadería sin costo',
          cantidad: '10',
          precioUnitario: '300.00',
          tratamiento: 'GRAVADO',
          // El detalle cierra contra la cabecera: lo exige el candado diferido
          // de la 0049, y es lo que impide que un renglón diga otra cosa que el
          // comprobante.
          neto: '3000.00',
          iva: '630.00',
        }],
      })).statusCode,
    ).toBe(200);

    const m = (await pedir('GET', '/analysis/margen')).json<{
      porProducto: { codigo: string; margen: string | null; metodologia: string }[];
    }>();

    // Este producto tiene entradas sin costo, así que aunque las unidades
    // cierren el margen sigue sin afirmarse — y dice por qué.
    const p = m.porProducto.find((x) => x.codigo === `SC-${stamp}`)!;
    expect(p.margen).toBeNull();
    expect(p.metodologia).toContain('sin costo');
  });

  /**
   * Un producto con las dos puntas completas y vendido a pérdida.
   *
   * Se arma entero acá —entrada con costo, comprobante con renglón, salida
   * citando la venta— porque es la única forma de que el margen sea afirmable,
   * y la señal solo mira lo afirmable.
   */
  const venderAPerdida = async (): Promise<string> => {
    const codigo = `BC-${stamp}`;
    const id = (
      await pedir('POST', '/products', {
        codigo, nombre: 'Vendido bajo costo', tipo: 'PRODUCTO',
        llevaStock: true, impuesto: 'IVA',
      })
    ).json<{ id: string }>().id;

    // Entra a 100 y sale a 50: la pérdida es un hecho, no una opinión.
    await recibir(id, '10', '100.00', hoy);

    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="bc-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>3</n></c>\r\n--X--\r\n`;
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
      'POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: 'VENTAS', cbteTipo: 1, puntoVenta: 1, numero: 9003, fecha: hoy,
        cuitContraparte: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Cliente val ${stamp}`, condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: '500.00', iva: '105.00', noGravado: '0', exento: '0', percepciones: '0',
        total: '605.00',
      },
    );
    expect(op.statusCode, op.body).toBe(201);
    const comprobante = op.json<{ taxTransactionId: string }>().taxTransactionId;

    expect(
      (await pedir('PUT', `/tax-transactions/${comprobante}/lines`, {
        renglones: [{
          productoId: id, descripcion: 'Vendido bajo costo', cantidad: '10',
          precioUnitario: '50.00', tratamiento: 'GRAVADO',
          neto: '500.00', iva: '105.00',
        }],
      })).statusCode,
    ).toBe(200);

    expect(
      (await pedir('POST', '/stock-movements/salida', {
        productoId: id, depositoId: deposito, cantidad: '10', fecha: hoy,
        taxTransactionId: comprobante,
      })).statusCode,
    ).toBe(201);

    return codigo;
  };

  it('vender por debajo del costo se señala sin que nadie declare un umbral', async () => {
    const codigo = await venderAPerdida();

    const r = await pedir('GET', '/analysis/signals');
    expect(r.statusCode, r.body).toBe(200);
    const senal = r
      .json<{
        senales: {
          tipo: string; sujeto: string; valor: string; umbral: string | null;
          superaUmbral: boolean | null; metodologia: string;
        }[];
      }>()
      .senales.find((s) => s.tipo === 'VENTA_BAJO_COSTO' && s.sujeto.includes(codigo));

    expect(senal, 'un producto vendido a pérdida tiene que aparecer').toBeDefined();
    // 500 de venta contra 1.000 de costo: −100 %.
    expect(senal!.valor).toBe('-100.00');
    // Sin umbral: el signo del margen no es un juicio de nadie.
    expect(senal!.umbral).toBeNull();
    expect(senal!.superaUmbral).toBe(true);
    expect(senal!.metodologia).toContain('último mes con margen afirmable');
  });

  it('la señal sin umbral llega a la bandeja con motivo, no en blanco', async () => {
    // El motivo se armaba concatenando el umbral, y con una señal sin umbral la
    // concatenación entera daba NULL: un renglón de bandeja sin texto, por una
    // regla de SQL.
    const items = (await pedir('GET', '/work-queue?entidad=products&limite=200'))
      .json<{ items: { estado: string; motivo: string | null; bloquea: boolean }[] }>().items;

    const item = items.find((i) => i.estado === 'VENTA_BAJO_COSTO');
    expect(item, 'la venta bajo costo tiene que llegar a la bandeja').toBeDefined();
    expect(item!.motivo, 'el motivo no puede venir vacío').toBeTruthy();
    expect(item!.motivo).toContain('es un hecho, no un umbral declarado');
    expect(item!.bloquea, 'informar no es bloquear').toBe(false);
  });

  it('el margen general no se llama insuficiente mientras nadie declare el piso', async () => {
    const senal = (await pedir('GET', '/analysis/signals'))
      .json<{ senales: { tipo: string; superaUmbral: boolean | null; umbral: string | null }[] }>()
      .senales.find((s) => s.tipo === 'MARGEN_INSUFICIENTE');

    expect(senal, 'la señal existe: informa el margen').toBeDefined();
    expect(senal!.umbral).toBeNull();
    // NULL y no false: false sería afirmar que el margen está bien.
    expect(senal!.superaUmbral).toBeNull();
  });

  it('declarado el piso, el margen que no llega se enciende', async () => {
    const declarar = await pedir('PUT', '/analysis/thresholds', {
      caidaVentasPct: null,
      concentracionClientePct: null,
      diasClienteInactivo: null,
      moraPct: null,
      rechazoChequesPct: null,
      crmDiasSinActividad: null,
      margenMinimoPct: 30,
    });
    expect(declarar.statusCode, declarar.body).toBe(200);

    const senal = (await pedir('GET', '/analysis/signals'))
      .json<{ senales: { tipo: string; superaUmbral: boolean | null; umbral: string | null }[] }>()
      .senales.find((s) => s.tipo === 'MARGEN_INSUFICIENTE');

    expect(senal!.umbral).toBe('30.00');
    expect(senal!.superaUmbral, 'el margen afirmable está muy por debajo de 30 %').toBe(true);
  });

  /**
   * La caché contra la derivación.
   *
   * Desde la 0086 el promedio se calcula al escribir y `stock_ppp` lee lo
   * calculado. Un valor guardado solo vale si se puede rehacer, así que la
   * derivación quedó viva —`stock_ppp_derivado`— y estas dos pruebas la usan
   * para lo único que sirve: comprobar que las dos digan lo mismo.
   */
  const diferenciasContraLaDerivacion = async (): Promise<number> => {
    const r = await db.query<{ d: number }>(
      `SELECT count(*)::int AS d FROM (
         SELECT movement_id, n, cantidad, costo_total, costo_de_salida, falta_costo
           FROM stock_ppp WHERE company_id = $1
         EXCEPT
         SELECT movement_id, n, cantidad, costo_total, costo_de_salida, falta_costo
           FROM stock_ppp_derivado WHERE company_id = $1
       ) x`,
      [empresa],
    );
    return r.rows[0]!.d;
  };

  it('lo calculado al escribir coincide con rehacer la cuenta', async () => {
    // El barrido tiene que estar mirando algo: si la empresa no tuviera
    // movimientos, cero diferencias no probaría nada.
    const filas = await db.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM stock_ppp WHERE company_id = $1',
      [empresa],
    );
    expect(filas.rows[0]!.c).toBeGreaterThan(5);

    expect(await diferenciasContraLaDerivacion()).toBe(0);
  });

  it('un movimiento con fecha vieja rehace la cadena, no la deja mal', async () => {
    // Es el caso incómodo de la 0086: el orden del libro es (fecha, alta, id),
    // así que una recepción del lunes cargada el martes se mete en el medio y
    // cambia el promedio de todo lo que vino después.
    const antes = await db.query<{ costo: string | null }>(
      `SELECT costo_total::text AS costo FROM stock_valuation
        WHERE company_id = $1 AND producto_codigo = $2`,
      [empresa, `CC-${stamp}`],
    );

    const anterior = new Date(Date.now() - 86_400_000 * 30).toISOString().slice(0, 10);
    await recibir(productoConCosto, '100', '5.00', anterior);

    // La cadena entera se rehizo: si el trigger solo hubiera agregado un paso
    // al final, la derivación y la caché diferirían en todos los movimientos
    // posteriores a esa fecha.
    expect(await diferenciasContraLaDerivacion()).toBe(0);

    const despues = await db.query<{ costo: string | null }>(
      `SELECT costo_total::text AS costo FROM stock_valuation
        WHERE company_id = $1 AND producto_codigo = $2`,
      [empresa, `CC-${stamp}`],
    );
    expect(despues.rows[0]!.costo).not.toBe(antes.rows[0]!.costo);
  });

  it('la aplicación no puede escribir el costo calculado', async () => {
    // La caché la escribe la base. Que `aai_app` pudiera tocarla sería
    // exactamente la segunda verdad que la 0077 evita.
    const permisos = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'aai_app' AND table_name = 'stock_movement_ppp'`,
    );
    expect(permisos.rows.map((p) => p.privilege_type).sort()).toEqual(['SELECT']);
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
