/**
 * S-20 — de dónde sale un número, hasta las tablas.
 *
 * Cada respuesta de Intelligence dice con qué vista la contestó. Eso alcanza
 * para un escalón. `GET /lineage/:relacion` contesta la cadena entera, y la
 * saca del catálogo de PostgreSQL —`pg_rewrite`, `pg_depend`— que es como el
 * motor ejecuta la vista: no hay un mapa declarado que pueda envejecer.
 *
 * ## Lo que este archivo defiende
 *
 *   1. **Que el linaje llegue a tablas.** Una vista cuyo linaje no termina en
 *      ninguna tabla no viene de ningún lado.
 *   2. **Que los `origen` que el catálogo de preguntas promete existan.** Una
 *      respuesta que cita una vista renombrada dice de dónde sale un número y
 *      manda a un lugar que no está.
 *   3. **Que no sea un oráculo del esquema entero**: solo relaciones del
 *      esquema público, y un nombre inventado contesta 404 en vez de rebotar
 *      con el error de PostgreSQL.
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

/**
 * Las vistas que el catálogo de preguntas nombra como origen.
 *
 * Copiadas de `apps/api/src/intelligence/catalogo.ts`: si alguien renombra una
 * vista y actualiza el catálogo, este test lo obliga a actualizar la lista
 * también — y si renombra la vista **sin** tocar el catálogo, falla, que es el
 * caso que importa.
 */
const ORIGENES_DEL_CATALOGO = [
  'analysis_signals',
  'analytics_comisiones',
  'analytics_costo_de_ventas',
  'analytics_disponible',
  'analytics_margen_por_producto',
  'analytics_operaciones_mensuales',
  'analytics_por_producto',
  'analytics_proyectos',
  'analytics_resumen',
  'analytics_sucursales',
  'checks_en_cartera',
  'cogs_por_mes',
  'invoice_settlement',
  'party_aging',
  'party_allocations',
  'payment_order_status',
  'stock_valuation',
  'work_queue',
  // Agregado con la pregunta por centro de costo (0088).
  'cost_center_results',
];

suite('S-20 — el linaje de un número', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresa: string;

  const pedir = (url: string) =>
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
          `fundador-lin-${stamp}@estudio.test`,
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
        `Estudio lin ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa lin ${stamp}`,
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
        payload: { email: `fundador-lin-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-lin-${stamp}@estudio.test`;
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
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('el resumen del tablero se abre hasta las tablas donde se escribieron los hechos', async () => {
    const r = await pedir('/lineage/analytics_resumen');
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<{
      tipo: string;
      tablas: string[];
      vistas: { nombre: string; nivel: number }[];
      alcance: string;
    }>();

    expect(v.tipo).toBe('VISTA');
    // De qué está hecho el resumen: operaciones del mes, antigüedad de saldos,
    // existencias y la bandeja.
    const nombres = v.vistas.map((x) => x.nombre);
    expect(nombres).toContain('analytics_operaciones_mensuales');
    expect(nombres).toContain('party_aging');
    expect(nombres).toContain('stock_by_product');

    // Y las hojas son tablas: si no llegara a ninguna, el número no vendría de
    // ningún lado.
    expect(v.tablas).toContain('tax_transactions');
    expect(v.tablas.length).toBeGreaterThan(3);
    expect(v.alcance).toContain('pg_rewrite');
  });

  it('una tabla también contesta, y se dice a sí misma como origen', async () => {
    const v = (await pedir('/lineage/journal_entry_lines')).json<{
      tipo: string;
      vistas: unknown[];
      tablas: string[];
    }>();

    expect(v.tipo).toBe('TABLA');
    expect(v.vistas).toEqual([]);
    expect(v.tablas, 'una tabla es su propia hoja').toContain('journal_entry_lines');
  });

  it('cada origen que promete el catálogo de preguntas existe de verdad', async () => {
    // Una respuesta que cita una vista renombrada dice de dónde sale un número y
    // manda a un lugar que no está. Es peor que no decirlo.
    const faltantes: string[] = [];
    for (const origen of ORIGENES_DEL_CATALOGO) {
      const r = await pedir(`/lineage/${origen}`);
      if (r.statusCode !== 200) faltantes.push(`${origen} → ${r.statusCode}`);
    }

    expect(
      faltantes,
      'El catálogo de Intelligence cita estos orígenes y no existen en la base:\n  ' +
        faltantes.join('\n  '),
    ).toEqual([]);
  });

  it('un nombre inventado contesta 404, no el error de PostgreSQL', async () => {
    const r = await pedir('/lineage/analytics_de_la_nada');
    expect(r.statusCode).toBe(404);
    expect(r.json<{ message: string }>().message).toContain('analytics_de_la_nada');
  });

  it('no es un oráculo del esquema: solo lo que vive en el público', async () => {
    // `pg_authid` existe, y no en `public`. Que conteste 404 es la respuesta
    // correcta: este endpoint habla de las vistas del producto.
    expect((await pedir('/lineage/pg_authid')).statusCode).toBe(404);
    // Y un nombre que no es un identificador ni siquiera llega a la consulta.
    expect((await pedir('/lineage/DROP TABLE')).statusCode).toBe(400);
  });
});
