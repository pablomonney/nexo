/**
 * S-18 — un usuario de solo lectura no escribe nada, en ningún endpoint.
 *
 * El aislamiento por empresa ya tiene su barrido sobre **todas** las rutas
 * (`endpoint-isolation`, S-1): ningún endpoint contesta 2xx con una empresa
 * ajena. Lo que faltaba es el escalón de adentro: un usuario **con rol en esta
 * empresa** pero de solo lectura.
 *
 * Un endpoint que olvide `requirePermission` pasa los dos controles anteriores
 * sin problema: `requireCompany` lo deja entrar porque el rol existe, el RLS lo
 * deja porque la empresa es la suya, y el aislamiento no lo ve porque solo mide
 * empresas ajenas. El único que puede verlo es este.
 *
 * ## Por qué no lo mira leyendo el código
 *
 * Porque el permiso no siempre está en el cuerpo del handler: en las
 * solicitudes de compra las cinco transiciones lo piden desde un ayudante
 * compartido, y un barrido sintáctico las marcaría en rojo. Un control con
 * falsos rojos dura hasta que alguien lo apaga.
 *
 * Este los llama a todos con el cuerpo vacío y exige **403**, no «cualquier
 * cosa que no sea 2xx».
 *
 * La diferencia importa. Un 2xx es un permiso que falta. Un **400** es el
 * permiso mirado *después* del cuerpo: no filtra datos ni muta nada, pero le
 * cuenta a quien no puede entrar qué campos espera, y sobre todo deja al control
 * sin poder distinguir «rechazado por permiso» de «rechazado por forma» — que es
 * justo la distinción que hace falta para que un `requirePermission` faltante no
 * se esconda detrás de una validación. Exigir 403 encontró tres transiciones de
 * solicitudes de compra que leían el cuerpo antes de mirar el permiso.
 */

import { closePool, initPool } from '@aai/db';
import { withCheckDigit } from '@aai/shared';
import { buildServer } from '@aai/api/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

/**
 * Rutas que escriben y **no** son de empresa: pertenecen al estudio o a la
 * sesión de quien las llama, así que no hay rol de empresa que las gobierne.
 *
 * `POST /organizations` y las altas del estudio se defienden por nivel de
 * miembro (`OWNER`/`ADMIN`), que se prueba en `aislamiento-lectura`. Las de
 * `/auth/` son de la propia sesión: pedir un permiso de empresa para cerrar
 * sesión no tendría sentido.
 */
const FUERA_DE_LA_EMPRESA = new Set([
  'POST /organizations',
  'POST /organizations/:organizationId/companies',
  'POST /organizations/:organizationId/users',
  'POST /companies/:companyId/roles',
]);

/**
 * POST que el rol de lectura **sí** puede llamar, con su motivo.
 *
 * `SOLO_LECTURA` tiene `analysis:read` desde la 0058 —se lo dio a todos los
 * roles— así que en estos cuatro el permiso pasa y el 400 viene del cuerpo
 * vacío, no de la autorización. No son endpoints sin permiso: son endpoints
 * cuyo permiso este rol tiene.
 *
 * Dos de los cuatro **escriben**: guardar y archivar un escenario. Que alcance
 * un permiso de lectura para crear una fila que el resto de la empresa va a ver
 * es una pregunta de producto, anotada en NEXO_ROADMAP.md — no se decide acá.
 */
const LECTURA_PUEDE = new Map<string, string>([
  [
    'POST /analysis/simulate',
    'Es una lectura con cuerpo: proyecta y no guarda nada. El POST existe porque los ' +
      'parámetros no entran cómodos en la query.',
  ],
  [
    'POST /intelligence/preguntar',
    'Preguntar es leer, y el permiso no es uno solo: cada pregunta del catálogo declara los ' +
      'suyos y el catálogo se filtra por el rol de quien pregunta. Una pregunta que el usuario ' +
      'no puede ver ni siquiera aparece en su lista, y pedirla por id contesta 403. Por eso el ' +
      'endpoint no lleva un `requirePermission` de entrada: el permiso depende de la pregunta, ' +
      'que todavía no se leyó.',
  ],
  [
    'POST /analysis/scenarios',
    'Guarda la pregunta de un escenario (nunca su resultado). Hoy alcanza `analysis:read`: si ' +
      'guardar un escenario tiene que exigir más, es una decisión de producto.',
  ],
  [
    'POST /analysis/scenarios/:escenarioId/archive',
    'Archiva un escenario guardado. Mismo caso que el anterior y la misma decisión pendiente.',
  ],
]);

suite('S-18 — solo lectura no escribe', () => {
  let app: FastifyInstance;
  let db: Client;
  let empresa = '';
  let token = '';

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const dueno = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [`dueno-lectura-${stamp}@estudio.test`, 'Dueño', hash],
    );
    const lector = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [`lector-${stamp}@estudio.test`, 'Solo lectura', hash],
    );

    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1,$2,$3)',
      [`Estudio lectura ${stamp}`, withCheckDigit(`30${stamp}`), dueno.rows[0]!.id],
    );
    await db.query(
      'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,$3)',
      [org.rows[0]!.create_organization, lector.rows[0]!.id, 'MEMBER'],
    );

    const company = await db.query<{ create_company: string }>(
      'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        dueno.rows[0]!.id,
        org.rows[0]!.create_organization,
        `Empresa lectura ${stamp}`,
        withCheckDigit(`27${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ],
    );
    empresa = company.rows[0]!.create_company;

    // SOLO_LECTURA: ocho permisos, todos de lectura. No exige MFA, así que el
    // token de login alcanza — la exigencia de MFA se prueba en `auth`.
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
      dueno.rows[0]!.id,
      empresa,
      lector.rows[0]!.id,
      'SOLO_LECTURA',
    ]);

    token = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `lector-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('el lector entra a la empresa y ve lo suyo', async () => {
    // Si esto fallara, el barrido de abajo pasaría por la razón equivocada: un
    // token que no entra a ninguna parte no prueba nada sobre los permisos.
    const r = await app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('NINGÚN endpoint que escribe le contesta otra cosa que 403 a un usuario de solo lectura', async () => {
    const uuid = '00000000-0000-7000-8000-000000000000';
    const escrituras = app.routeTable.filter(
      (ruta) =>
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ruta.method) &&
        !ruta.url.startsWith('/auth/') &&
        !FUERA_DE_LA_EMPRESA.has(`${ruta.method} ${ruta.url}`) &&
        !LECTURA_PUEDE.has(`${ruta.method} ${ruta.url}`),
    );

    // Que el barrido esté mirando algo.
    expect(escrituras.length, 'tiene que haber endpoints de escritura').toBeGreaterThan(40);

    const filtradas: string[] = [];
    for (const ruta of escrituras) {
      const url = ruta.url.replace(/:[A-Za-z]+/gu, uuid);
      const respuesta = await app.inject({
        method: ruta.method as 'POST',
        url,
        payload: {},
        headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      });

      if (respuesta.statusCode !== 403) {
        filtradas.push(`${ruta.method} ${ruta.url} → ${respuesta.statusCode}`);
      }
    }

    expect(
      filtradas,
      'Estos endpoints escriben y aceptaron a un usuario de solo lectura. Casi siempre es un ' +
        '`requirePermission` que falta:\n  ' +
        filtradas.join('\n  '),
    ).toEqual([]);
  });

  it('las listas de excepciones no acumulan rutas que ya no existen', () => {
    const registradas = new Set(app.routeTable.map((r) => `${r.method} ${r.url}`));
    const fantasmas = [...FUERA_DE_LA_EMPRESA, ...LECTURA_PUEDE.keys()].filter(
      (r) => !registradas.has(r),
    );

    expect(
      fantasmas,
      'Estas excepciones ya no corresponden a ninguna ruta:\n  ' + fantasmas.join('\n  '),
    ).toEqual([]);
  });
});
