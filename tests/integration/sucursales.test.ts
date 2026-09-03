/**
 * Sucursales.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que la sucursal no se guarde en la factura.** La atribución se deriva
 *      del punto de venta, que ya viajaba en cada comprobante. No hay columna
 *      `branch_id` en `tax_transactions`, y un test lo verifica.
 *   2. **Que la vigencia proteja el histórico.** Reasignar un punto de venta no
 *      puede reescribir a qué sucursal pertenecen las ventas del año pasado.
 *   3. **Que un punto de venta sea de una sola boca por vez**, o el total de la
 *      empresa deja de cerrar contra la suma de sus sucursales.
 *   4. **Que lo que ninguna sucursal se lleva se informe.** Sin eso, la suma de
 *      las bocas parecería el total de la empresa cuando no lo es.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';
import { diasDeLaBase, hoyDeLaBase } from './helpers/fechas.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

interface Sucursal {
  readonly id: string;
  readonly codigo: string;
  readonly status: string;
  readonly puntosDeVenta: number;
  readonly comprobantes: number;
  readonly ventasNeto: string;
  readonly centroCodigo: string | null;
  readonly depositoCodigo: string | null;
}

suite('Sucursales', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let cuitCliente: string;
  let clienteId: string;
  let centro: string;
  let norte: string;
  let sur: string;
  let numeroCbte = 8000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  // Las dos salen de la base: acá se comparan contra vigencias que la base
  // evalúa con , y después de las 21:00 el reloj del proceso
  // —que cuenta en UTC— ya está en otro día.
  let hoy: string;
  const haceDias = (dias: number): Promise<string> => diasDeLaBase(db, -dias);

  /** Una venta desde un punto de venta y una fecha dados. */
  const venta = async (puntoVenta: number, neto: string, fecha: string): Promise<string> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="suc-${stamp}-${numeroCbte}.xml"\r\n` +
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
      puntoVenta,
      numero: numeroCbte,
      fecha,
      cuitContraparte: cuitCliente,
      razonSocial: 'Cliente',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto, iva: '0', noGravado: '0', exento: '0', percepciones: '0', total: neto,
    });
    expect(op.statusCode, op.body).toBe(201);
    return op.json<{ taxTransactionId: string }>().taxTransactionId;
  };

  const listar = async (): Promise<Sucursal[]> =>
    (await pedir('GET', '/branches')).json<{ sucursales: Sucursal[] }>().sucursales;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    hoy = await hoyDeLaBase(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-suc-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio suc ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa suc ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-suc-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `gerente-suc-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Gerente de sucursales', password: PASSWORD, level: 'MEMBER' },
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

    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: cuitCliente,
        razonSocial: `Cliente suc ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
    expect(clienteId).toBeDefined();

    // Sin ejercicio no hay períodos, y una operación fiscal vive en un período.
    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    centro = `CC-N-${stamp}`;
    expect(
      (await pedir('POST', '/cost-centers', { code: centro, name: 'Sucursal norte' })).statusCode,
    ).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin sucursales declaradas, la bandeja no reclama por los puntos de venta', async () => {
    await venta(1, '10000.00', await haceDias(40));

    const items = (await pedir('GET', '/work-queue?limite=200'))
      .json<{ items: { rama: string }[] }>().items;

    // En una empresa que no vende por bocas no falta nada, y avisar sería
    // inventarle un problema.
    expect(items.some((i) => i.rama === 'PUNTO_DE_VENTA_SIN_SUCURSAL')).toBe(false);
  });

  it('la sucursal sin punto de venta existe solo en el maestro, y la bandeja lo dice', async () => {
    const r = await pedir('POST', '/branches', {
      codigo: `NORTE-${stamp}`,
      nombre: 'Sucursal Norte',
      centroDeCosto: centro,
      localidad: 'San Miguel de Tucumán',
    });
    expect(r.statusCode, r.body).toBe(201);
    norte = r.json<{ id: string }>().id;

    const s = (await listar()).find((x) => x.id === norte)!;
    expect(s.puntosDeVenta).toBe(0);
    expect(s.comprobantes, 'sin punto de venta no se le atribuye nada').toBe(0);

    const items = (await pedir('GET', '/work-queue?entidad=branches&limite=200'))
      .json<{ items: { rama: string; entityId: string; evidenciaFaltante: string[] | null }[] }>()
      .items;

    const aviso = items.find(
      (i) => i.rama === 'SUCURSAL_SIN_PUNTO_DE_VENTA' && i.entityId === norte,
    );
    expect(aviso).toBeDefined();
    expect(aviso!.evidenciaFaltante).toContain('PUNTO_DE_VENTA');

    // Y ahora sí aparece la otra rama: hay una boca declarada y una venta cuyo
    // punto de venta no es de nadie.
    expect(
      items.some((i) => i.rama === 'PUNTO_DE_VENTA_SIN_SUCURSAL'),
      'la venta del punto 1 no pertenece a ninguna sucursal',
    ).toBe(true);
  });

  it('la atribución se deriva del punto de venta: no hay columna en la factura', async () => {
    expect(
      (await pedir('POST', `/branches/${norte}/points-of-sale`, {
        puntoVenta: 1, vigenciaDesde: await haceDias(60),
      })).statusCode,
    ).toBe(201);

    const s = (await listar()).find((x) => x.id === norte)!;
    // La venta de antes se atribuye sola: nadie la tocó.
    expect(s.puntosDeVenta).toBe(1);
    expect(s.comprobantes).toBe(1);
    expect(s.ventasNeto).toBe('10000.00');

    const columnas = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'tax_transactions'`,
      )
    ).rows.map((c) => c.column_name);
    expect(columnas, 'la sucursal no se guarda: se deriva del punto de venta')
      .not.toContain('branch_id');
  });

  it('reasignar un punto de venta no reescribe el histórico', async () => {
    const r = await pedir('POST', '/branches', {
      codigo: `SUR-${stamp}`, nombre: 'Sucursal Sur',
    });
    expect(r.statusCode, r.body).toBe(201);
    sur = r.json<{ id: string }>().id;

    // El punto 1 se muda al sur a partir de hoy. La vigencia del norte se
    // cierra ayer.
    await db.query(
      `UPDATE branch_points_of_sale SET vigencia_hasta = $3
        WHERE company_id = $1 AND branch_id = $2 AND punto_venta = 1`,
      [empresa, norte, await haceDias(1)],
    );
    expect(
      (await pedir('POST', `/branches/${sur}/points-of-sale`, {
        puntoVenta: 1, vigenciaDesde: hoy,
      })).statusCode,
    ).toBe(201);

    // Una venta de hoy va al sur; la de hace 40 días sigue siendo del norte.
    await venta(1, '7000.00', hoy);

    const sucursales = await listar();
    const n = sucursales.find((x) => x.id === norte)!;
    const s = sucursales.find((x) => x.id === sur)!;

    expect(n.comprobantes, 'la venta vieja no se mudó').toBe(1);
    expect(n.ventasNeto).toBe('10000.00');
    expect(s.comprobantes).toBe(1);
    expect(s.ventasNeto).toBe('7000.00');
  });

  it('un punto de venta no puede ser de dos sucursales a la vez', async () => {
    const r = await pedir('POST', `/branches/${norte}/points-of-sale`, {
      puntoVenta: 1, vigenciaDesde: hoy,
    });
    // Se superpone con la vigencia del sur: el mismo comprobante se contaría
    // dos veces y el total de la empresa dejaría de cerrar.
    expect(r.statusCode).toBe(409);

    // Y el candado vive en la base, no en el handler.
    await expect(
      db.query(
        `INSERT INTO branch_points_of_sale
           (company_id, branch_id, punto_venta, vigencia_desde, created_by)
         VALUES ($1,$2,1,$3,'test')`,
        [empresa, norte, hoy],
      ),
    ).rejects.toThrow(/E_SUC_PUNTO_SUPERPUESTO/);
  });

  it('lo que ninguna sucursal se lleva se informa aparte', async () => {
    // Una venta desde un punto que nadie declaró.
    await venta(9, '3000.00', hoy);

    const a = (await pedir('GET', '/analysis/sucursales')).json<{
      sucursales: { codigo: string; ventasNeto: string; brechaDeAtribucion: string | null;
                    metodologia: string }[];
      sinAtribuir: { comprobantes: number; neto: string };
      alcance: string;
    }>();

    expect(a.sinAtribuir.comprobantes).toBe(1);
    expect(a.sinAtribuir.neto).toBe('3000.00');
    // Sin esto, la suma de las bocas parecería el total de la empresa.
    expect(a.alcance).toContain('sin eso, la suma de las sucursales');

    const sur2 = a.sucursales.find((x) => x.codigo === `SUR-${stamp}`)!;
    expect(sur2.brechaDeAtribucion, 'sin centro de costo no se calcula la brecha').toBeNull();
    expect(sur2.metodologia).toContain('Sin centro de costo');
  });

  it('las dos atribuciones se muestran, y su diferencia también', async () => {
    const a = (await pedir('GET', '/analysis/sucursales')).json<{
      sucursales: { codigo: string; ventasNeto: string; ingresosImputados: string;
                    brechaDeAtribucion: string | null; metodologia: string }[];
    }>();

    const n = a.sucursales.find((x) => x.codigo === `NORTE-${stamp}`)!;
    // Ventas por punto de venta: 10.000. Ingresos imputados al centro de costo:
    // 0, porque nadie asentó nada contra él. La brecha es exactamente eso, y se
    // informa en vez de promediarse.
    expect(n.ventasNeto).toBe('10000.00');
    expect(n.ingresosImputados).toBe('0');
    expect(n.brechaDeAtribucion).toBe('10000.00');
    // Su punto de venta se mudó al sur, así que hoy no tiene ninguno vigente —
    // y el texto lo dice sin negar las ventas que sí tiene atribuidas.
    expect(n.metodologia).toContain('Sus ventas anteriores siguen');
  });

  it('un depósito no puede ser de dos sucursales', async () => {
    const deposito = `DEP-${stamp}`;
    expect(
      (await pedir('POST', '/warehouses', { codigo: deposito, nombre: 'Depósito norte' }))
        .statusCode,
    ).toBe(201);

    // Se lo asigna al norte por SQL: el alta de sucursal ya pasó.
    const w = await db.query<{ id: string }>(
      'SELECT id FROM warehouses WHERE company_id = $1 AND code = $2',
      [empresa, deposito],
    );
    await db.query('UPDATE branches SET warehouse_id = $3 WHERE id = $1 AND company_id = $2', [
      norte, empresa, w.rows[0]!.id,
    ]);

    // Con dos, la existencia de una boca sería también la de la otra y el
    // recuento dejaría de significar algo.
    await expect(
      db.query('UPDATE branches SET warehouse_id = $3 WHERE id = $1 AND company_id = $2', [
        sur, empresa, w.rows[0]!.id,
      ]),
    ).rejects.toThrow();
  });

  it('cerrar una sucursal no le saca sus ventas', async () => {
    const cierre = await pedir('POST', `/branches/${sur}/close`, {
      fecha: hoy, motivo: 'No alcanzó el punto de equilibrio en dos ejercicios',
    });
    expect(cierre.statusCode, cierre.body).toBe(200);
    expect(cierre.json<{ alcance: string }>().alcance).toContain('siguen atribuidas');

    const s = (await listar()).find((x) => x.id === sur)!;
    expect(s.status).toBe('CERRADA');
    expect(s.comprobantes, 'cerrar una boca no cambia de dónde salieron sus facturas').toBe(1);

    // No se cierra dos veces, y no se borra.
    expect(
      (await pedir('POST', `/branches/${sur}/close`, { fecha: hoy, motivo: 'otra vez' }))
        .statusCode,
    ).toBe(409);
    await expect(
      db.query('DELETE FROM branches WHERE id = $1', [sur]),
    ).rejects.toThrow(/E_SUC_NO_BORRA/);
  });

  it('las vistas de sucursales conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('branch_sales', 'branch_status', 'analytics_sucursales',
                          'work_queue_sucursales')`,
    );
    expect(r.rowCount).toBe(4);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
