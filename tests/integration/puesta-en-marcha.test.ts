/**
 * La puesta en marcha: qué le falta a una empresa para poder trabajar.
 *
 * ## Qué defiende
 *
 *   1. **Que ningún paso se tilde.** Se cuenta lo que hay, así que la lista no
 *      puede decir «listo» sobre algo que no está.
 *   2. **Que solo bloqueen los tres que bloquean de verdad.** Reclamarle
 *      depósitos a un estudio contable enseña a ignorar la lista.
 *   3. **Que lo que bloquea llegue a la bandeja**, que es la primera pantalla
 *      donde alguien mira.
 *   4. **Que el estado sea real**: cada contador tiene que moverse cuando se
 *      crea la cosa que cuenta. Es el control que atrapa un `ACTIVA` escrito
 *      donde la base guarda `ACTIVE` — que pasó, en esta misma migración.
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

interface Paso {
  readonly paso: string;
  readonly estado: string;
  readonly bloquea: boolean;
  readonly hechos: number;
  readonly listo: boolean;
  readonly afecta: string[];
  readonly motivoNoAplica: string | null;
}

interface Arranque {
  readonly pasos: Paso[];
  readonly puedeOperar: boolean;
  readonly bloqueantesPendientes: string[];
  readonly pendientes: string[];
  readonly afectado: string[];
  readonly yaOpera: boolean;
}

suite('Puesta en marcha', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const arranque = async (): Promise<Arranque> =>
    (await pedir('GET', '/onboarding')).json<Arranque>();

  const paso = (a: Arranque, nombre: string): Paso => a.pasos.find((p) => p.paso === nombre)!;

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
          `fundador-arr-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio arr ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa arr ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-arr-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `admin-arr-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Administradora', password: PASSWORD, level: 'MEMBER' },
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('una empresa recién creada no puede operar, y dice exactamente por qué', async () => {
    const a = await arranque();

    expect(a.puedeOperar).toBe(false);
    expect(a.yaOpera).toBe(false);
    // Los tres que bloquean, por su nombre. No «faltan datos».
    expect(a.bloqueantesPendientes).toEqual([
      'PLAN_DE_CUENTAS',
      'EJERCICIO',
      'PERIODO_ABIERTO',
    ]);

    // Y ninguno de los que no bloquean se presenta como impedimento.
    expect(paso(a, 'DEPOSITO').bloquea).toBe(false);
    expect(paso(a, 'CREDENCIAL_ARCA').bloquea).toBe(false);
    expect(paso(a, 'MAPEO_CONTABLE').bloquea).toBe(false);
  });

  it('lo que impide trabajar llega a la bandeja', async () => {
    const items = (await pedir('GET', '/work-queue?entidad=companies&limite=50'))
      .json<{ items: { rama: string; bloquea: boolean }[] }>().items;

    const ramas = items.map((i) => i.rama);
    expect(ramas).toContain('SIN_PLAN_DE_CUENTAS');
    expect(ramas).toContain('SIN_EJERCICIO');
    // Sin ejercicio, la rama del período no aparece: sería decir dos veces lo
    // mismo, y la segunda no se puede resolver sin la primera.
    expect(ramas).not.toContain('SIN_PERIODO_ABIERTO');
    expect(items.every((i) => i.bloquea)).toBe(true);
  });

  it('cada contador se mueve cuando se crea la cosa que cuenta', async () => {
    // Este es el control que atrapa un valor de estado escrito en el idioma
    // equivocado: comparar contra `ACTIVA` donde la base guarda `ACTIVE` no
    // falla, cuenta cero y nadie se entera.
    const antes = await arranque();
    expect(paso(antes, 'PLAN_DE_CUENTAS').hechos).toBe(0);

    expect(
      (await pedir('POST', '/accounts', { code: '1.1.01', name: 'Caja', type: 'ACTIVO' }))
        .statusCode,
    ).toBe(201);

    const conCuenta = await arranque();
    expect(paso(conCuenta, 'PLAN_DE_CUENTAS').hechos).toBe(1);
    expect(paso(conCuenta, 'PLAN_DE_CUENTAS').listo).toBe(true);
    expect(conCuenta.bloqueantesPendientes).toEqual(['EJERCICIO', 'PERIODO_ABIERTO']);

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    const conEjercicio = await arranque();
    expect(paso(conEjercicio, 'EJERCICIO').listo).toBe(true);
    // El ejercicio crea los períodos: el tercer paso se resuelve con el segundo.
    expect(paso(conEjercicio, 'PERIODO_ABIERTO').listo).toBe(true);
    expect(conEjercicio.puedeOperar).toBe(true);
    expect(conEjercicio.bloqueantesPendientes).toEqual([]);

    // Y los pasos que habilitan siguen sin estar, sin impedir nada.
    expect(paso(conEjercicio, 'TERCEROS').listo).toBe(false);
    expect(paso(conEjercicio, 'MAPEO_CONTABLE').listo).toBe(false);
  });

  it('resuelto lo bloqueante, la bandeja deja de reclamarlo', async () => {
    const items = (await pedir('GET', '/work-queue?entidad=companies&limite=50'))
      .json<{ items: { rama: string }[] }>().items;

    // Desaparece porque el hecho cambió, no porque alguien lo marcara: no hay
    // forma de marcarlo.
    expect(items).toHaveLength(0);
  });

  it('los pasos que habilitan se completan y se ven', async () => {
    expect(
      (await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Cliente arr ${stamp}`,
        roles: ['CLIENTE'],
      })).statusCode,
    ).toBe(201);

    const a = await arranque();
    expect(paso(a, 'TERCEROS').hechos).toBe(1);
    expect(paso(a, 'TERCEROS').listo).toBe(true);
    // Sigue pudiendo operar: ninguno de estos era condición.
    expect(a.puedeOperar).toBe(true);
  });

  it('«no declarado» no es «pendiente»: son declaraciones, no altas', async () => {
    const a = await arranque();

    // Cargar una cuenta es un alta; declarar cuál es la de deudores por ventas
    // es otra cosa. Confundirlas haría que «todavía no lo cargué» y «nadie
    // decidió esto» se vieran igual.
    expect(paso(a, 'MAPEO_CONTABLE').estado).toBe('NO_DECLARADO');
    expect(paso(a, 'MARCO_DE_REPORTE').estado).toBe('NO_DECLARADO');
    expect(paso(a, 'CENTROS_DE_COSTO').estado).toBe('PENDIENTE');

    // Y lo que queda afectado se dice, sin repetir.
    expect(a.afectado).toContain('Estados contables');
    expect(a.afectado).toContain('Propuesta de asiento a partir de un comprobante');
  });

  it('«no aplica» se deriva de lo declarado, y deja de aplicar cuando cambia', async () => {
    // Sin sucursales, declarar puntos de venta por sucursal no aplica: no hay a
    // qué atribuirlos. No es una suposición: es que no existe la otra punta.
    const sinSucursales = await arranque();
    expect(paso(sinSucursales, 'PUNTOS_DE_VENTA').estado).toBe('NO_APLICA');
    expect(paso(sinSucursales, 'PUNTOS_DE_VENTA').motivoNoAplica).toContain('ninguna sucursal');
    // Y no cuenta como pendiente ni ensucia la lista de lo afectado.
    expect(sinSucursales.pendientes).not.toContain('PUNTOS_DE_VENTA');
    expect(sinSucursales.afectado).not.toContain('Ventas por sucursal');

    expect(
      (await pedir('POST', '/branches', { codigo: `SUC-${stamp}`, nombre: 'Casa central' }))
        .statusCode,
    ).toBe(201);

    // Creada la sucursal, el paso vuelve a pedirse solo.
    const conSucursal = await arranque();
    expect(paso(conSucursal, 'SUCURSALES').estado).toBe('COMPLETO');
    expect(paso(conSucursal, 'PUNTOS_DE_VENTA').estado).toBe('NO_DECLARADO');
    expect(conSucursal.afectado).toContain('Ventas por sucursal');
  });

  it('un depósito no aplica si todos los productos son servicios', async () => {
    const servicio = await pedir('POST', '/products', {
      codigo: `SERV-${stamp}`,
      nombre: 'Honorarios profesionales',
      tipo: 'SERVICIO',
      llevaStock: false,
      // Un producto gravado dice qué impuesto le aplica; la alícuota la
      // resuelve el sistema por la fecha de cada operación.
      impuesto: 'IVA',
    });
    expect(servicio.statusCode, servicio.body).toBe(201);

    const soloServicios = await arranque();
    expect(paso(soloServicios, 'PRODUCTOS').estado).toBe('COMPLETO');
    // La evidencia es la declaración de los propios productos.
    expect(paso(soloServicios, 'DEPOSITO').estado).toBe('NO_APLICA');
    expect(paso(soloServicios, 'DEPOSITO').motivoNoAplica).toContain('servicios');

    expect(
      (await pedir('POST', '/products', {
        codigo: `PROD-${stamp}`,
        nombre: 'Mercadería',
        tipo: 'PRODUCTO',
        llevaStock: true,
        impuesto: 'IVA',
      })).statusCode,
    ).toBe(201);

    // Con un producto que lleva existencias, el depósito vuelve a hacer falta.
    const conStock = await arranque();
    expect(paso(conStock, 'DEPOSITO').estado).toBe('PENDIENTE');
    expect(paso(conStock, 'DEPOSITO').motivoNoAplica).toBeNull();
    expect(conStock.afectado).toContain('Existencias');
  });

  it('consultar el estado no escribe nada', async () => {
    // Un asistente que registra algo por el solo hecho de mirar convertiría una
    // consulta en un hecho, y la bitácora dejaría de decir qué pasó de verdad.
    const antes = await db.query<{ bitacora: string; asientos: string; movs: string }>(
      `SELECT (SELECT count(*) FROM audit_logs WHERE company_id = $1)::text        AS bitacora,
              (SELECT count(*) FROM journal_entries WHERE company_id = $1)::text   AS asientos,
              (SELECT count(*) FROM ledger_movements WHERE company_id = $1)::text  AS movs`,
      [empresa],
    );

    await arranque();
    await arranque();

    const despues = await db.query<{ bitacora: string; asientos: string; movs: string }>(
      `SELECT (SELECT count(*) FROM audit_logs WHERE company_id = $1)::text        AS bitacora,
              (SELECT count(*) FROM journal_entries WHERE company_id = $1)::text   AS asientos,
              (SELECT count(*) FROM ledger_movements WHERE company_id = $1)::text  AS movs`,
      [empresa],
    );

    expect(despues.rows[0]).toEqual(antes.rows[0]);
  });

  it('no hay ningún tilde guardado: la lista se cuenta', async () => {
    // Un tilde es una segunda verdad que puede decir «listo» sobre una empresa
    // sin período abierto.
    const tablas = (
      await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND (table_name LIKE '%onboarding%' OR table_name LIKE '%checklist%')`,
      )
    ).rows;
    expect(tablas).toHaveLength(0);
  });
});
