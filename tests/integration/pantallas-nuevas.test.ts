/**
 * Las pantallas nuevas leen los campos que la API devuelve.
 *
 * Es el defecto que S-25 no puede ver. Ese barrido comprueba que cada capacidad
 * tenga por dónde entrarle; que la pantalla lea **el nombre correcto** del campo
 * es otra cosa, y falla en silencio: `escapar(undefined)` devuelve la cadena
 * vacía, así que una columna mal nombrada se dibuja como una celda en blanco y
 * nadie se entera.
 *
 * Ya pasó al escribir estas mismas pantallas: el selector de asientos leía
 * `a.entryNumber` y `a.entryDate`, y `GET /journal-entries` devuelve `numero` y
 * `fecha`. La lista habría salido con «#undefined · undefined» en cada opción.
 *
 * Este test fija los nombres que la consola espera de cada respuesta que
 * dibuja. No prueba el dibujo —no hay quién ejercite el DOM, y está anotado—:
 * prueba el contrato entre las dos mitades, que es donde estuvo el error.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

suite('las pantallas nuevas leen los campos que la API devuelve', () => {
  let app: FastifyInstance;
  let db: Client;
  let token = '';
  let empresa = '';
  let ejercicio = '';

  const pedir = async (url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    const stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-pan-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio pan ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa pan ${stamp}`,
        withCheckDigit(`27${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-pan-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-pan-${stamp}@estudio.test`;
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

    // CONTADOR exige segundo factor, y sin él la API no deja llegar a los datos
    // de ninguna empresa. Es el mismo camino que ahora tiene la consola.
    const inicial = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: PASSWORD },
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
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    const anio = new Date().getFullYear();
    ejercicio = (
      await app.inject({
        method: 'POST',
        url: '/fiscal-years',
        headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
        payload: { code: `${anio}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31` },
      })
    ).json<{ id: string }>().id;
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await closePool();
  });

  /**
   * Una empresa recién creada no tiene operaciones, y eso alcanza: lo que se
   * fija acá es **la forma de la respuesta**, no su contenido. Donde la lista
   * puede venir vacía se comprueba que la clave exista y sea una lista — que es
   * exactamente lo que la consola recorre.
   */
  it('analítica: operaciones por mes y flujo bancario', async () => {
    const ops = await pedir('/analytics/operaciones?direccion=VENTAS');
    expect(ops.statusCode, ops.body).toBe(200);
    const o = ops.json<{ meses: unknown[]; alcance: string; direccion: string }>();
    expect(Array.isArray(o.meses)).toBe(true);
    expect(typeof o.alcance).toBe('string');

    const flu = await pedir('/analytics/flujo-bancario');
    expect(flu.statusCode, flu.body).toBe(200);
    const f = flu.json<{ flujo: unknown[]; alcance: string }>();
    expect(Array.isArray(f.flujo)).toBe(true);
    expect(typeof f.alcance).toBe('string');
  });

  it('antigüedad de saldos: la tabla de terceros y su alcance', async () => {
    const r = await pedir('/reports/aging?direccion=VENTAS');
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json<{ terceros: unknown[]; alcance: string; direccion: string }>();
    expect(Array.isArray(v.terceros)).toBe(true);
    expect(v.direccion).toBe('VENTAS');
    expect(typeof v.alcance).toBe('string');
  });

  it('cuadro de amortizaciones: bienes, pendientes y alcance', async () => {
    const r = await pedir(`/reports/depreciation?ejercicioId=${ejercicio}`);
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json<{ bienes: unknown[]; pendientes: number; alcance: string }>();
    expect(Array.isArray(v.bienes)).toBe(true);
    // `pendientes` se imprime al lado del alcance: si no fuera un número, la
    // pantalla diría «undefined sin asentar».
    expect(typeof v.pendientes).toBe('number');
  });

  it('métricas del motor: las tres listas que dibuja la pantalla', async () => {
    const r = await pedir('/predictions/metrics');
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json<{
      rechazosAutomaticos: unknown[];
      revisionesHumanas: unknown[];
      distribucionPorBanda: unknown[];
      nota: string;
    }>();
    expect(Array.isArray(v.rechazosAutomaticos)).toBe(true);
    expect(Array.isArray(v.revisionesHumanas)).toBe(true);
    expect(Array.isArray(v.distribucionPorBanda)).toBe(true);
    expect(typeof v.nota).toBe('string');
  });

  /**
   * El selector de asientos del vínculo de amortización.
   *
   * Acá estuvo el error: la consola leía `entryNumber`/`entryDate`, que es como
   * se llaman **al crear** un asiento, y el listado devuelve `numero`/`fecha`.
   * Se fija con un asiento real para que la comprobación no dependa de que la
   * lista venga vacía.
   */
  it('el listado de asientos trae numero, fecha y descripcion', async () => {
    // Una empresa recién creada no trae plan de cuentas: hoy entra por la
    // siembra, y eso es justamente lo que S-25 anotó como pantalla faltante.
    // Acá se plantan dos cuentas para poder asentar.
    const chart = await db.query<{ id: string }>(
      `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan') RETURNING id`,
      [empresa],
    );
    const imputables: { id: string }[] = [];
    for (const [codigo, nombre, tipo, nat] of [
      ['1.1.01', 'Caja', 'ACTIVO', 'DEUDORA'],
      ['4.1.01', 'Ventas', 'INGRESO', 'ACREEDORA'],
    ] as const) {
      imputables.push(
        (
          await db.query<{ id: string }>(
            `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [empresa, chart.rows[0]!.id, codigo, nombre, tipo, nat],
          )
        ).rows[0]!,
      );
    }

    const alta = await app.inject({
      method: 'POST',
      url: '/journal-entries',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      payload: {
        journalCode: 'GENERAL',
        entryDate: new Date().toISOString().slice(0, 10),
        description: 'Asiento para el selector',
        kind: 'NORMAL',
        status: 'BORRADOR',
        currency: 'ARS',
        source: { type: 'MANUAL' },
        manualJustification: 'Fixture: solo existe para que el listado tenga una fila.',
        lines: [
          { accountCode: '1.1.01', debit: '100.00', credit: '0', currency: 'ARS' },
          { accountCode: '4.1.01', debit: '0', credit: '100.00', currency: 'ARS' },
        ],
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);

    const r = await pedir('/journal-entries?limite=10');
    expect(r.statusCode, r.body).toBe(200);
    const uno = r.json<{ asientos: Record<string, unknown>[] }>().asientos[0]!;

    for (const campo of ['numero', 'fecha', 'descripcion']) {
      expect(uno, `la consola arma la opción con \`${campo}\``).toHaveProperty(campo);
    }
    // Y los nombres viejos no están: si algún día se agregaran como alias, el
    // error que este test fija dejaría de doler y volvería a poder colarse.
    expect(uno).not.toHaveProperty('entryNumber');
    expect(uno).not.toHaveProperty('entryDate');
  });
});
