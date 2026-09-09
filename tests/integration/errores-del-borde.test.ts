/**
 * Los errores que Fastify produce antes de llegar al handler.
 *
 * Un cuerpo vacío con `content-type: application/json`, un JSON mal formado o un
 * cuerpo demasiado grande no llegan nunca a la función que atiende la ruta:
 * Fastify los rechaza antes, con un error que trae su propio `statusCode` 4xx.
 *
 * El manejador los miraba como cualquier excepción desconocida y contestaba
 * **500 «Error interno»**, anotándolos en el log como «error no controlado».
 * Lo encontró la auditoría del 2026-09-09, y por accidente: un script de
 * medición mandaba `content-type: application/json` sin cuerpo, la API contestó
 * 500, y buscando ese 500 apareció que el error decía 400 desde el principio.
 *
 * Los dos daños son reales:
 *
 *   · **Al cliente** se le dice que el problema es del servidor cuando el
 *     pedido está mal armado. No tiene nada que corregir, así que reintenta.
 *   · **Al operador** se le llena el log de errores nivel 50. La tasa de 500 es
 *     lo que se mira para saber si el sistema está sano y para decidir si hay
 *     que levantarse a la madrugada; un cliente mal programado la subía solo.
 */

import { buildServer } from '@aai/api/server';
import { closePool, initPool } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('un pedido mal armado no es una falla del servidor', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('cuerpo vacío con content-type de JSON contesta 4xx, no 500', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    expect(r.statusCode, r.body).toBeLessThan(500);
  });

  it('JSON mal formado contesta 4xx, no 500', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });

    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    expect(r.statusCode, r.body).toBeLessThan(500);
  });

  it('el cuerpo del error dice qué pasó, sin filtrar nada de adentro', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    const cuerpo = r.json() as { error?: string; message?: string };
    expect(cuerpo.error, 'un error sin código no se puede tratar del otro lado').toBeTruthy();
    expect(cuerpo.message, 'un error sin mensaje no le dice al cliente qué corregir').toBeTruthy();

    // La regla de siempre: nada de adentro sale. Un mensaje de PostgreSQL puede
    // llevar nombres de tablas, constraints y datos de la fila.
    const texto = JSON.stringify(cuerpo);
    for (const filtracion of ['SELECT', 'INSERT', 'pg_', 'relation ', 'at Object.']) {
      expect(texto, `el error filtra «${filtracion}»`).not.toContain(filtracion);
    }
  });

  it('un 500 de verdad sigue siendo 500: esto no ablanda el manejador', async () => {
    // El control positivo. Sin él, contestar 4xx a todo dejaría los tests de
    // arriba en verde y escondería las fallas reales del servidor.
    const app2 = await buildServer();
    app2.get('/ruta-que-explota-a-proposito', async () => {
      throw new Error('esto es una falla del servidor');
    });
    await app2.ready();
    try {
      const r = await app2.inject({ method: 'GET', url: '/ruta-que-explota-a-proposito' });
      expect(r.statusCode).toBe(500);
      expect((r.json() as { error: string }).error).toBe('INTERNAL_ERROR');
    } finally {
      await app2.close();
    }
  });
});
