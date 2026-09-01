/**
 * S-10 — el aislamiento de las superficies de lectura nuevas.
 *
 * `GET /companies` es la ruta más delicada de la FASE 3, y por un motivo
 * estructural: **corre sin empresa en contexto**, así que RLS no la protege. Lo
 * que la protege es `user_companies()`, y esta suite comprueba las dos cosas que
 * hay que comprobar de una función `SECURITY DEFINER`:
 *
 *   1. que por HTTP devuelva solo lo del usuario;
 *   2. que **por SQL directo** —evitando Fastify entero— tampoco devuelva de más.
 *
 * La segunda es la que importa. Una autorización que solo existe en el handler
 * es una autorización que desaparece en cuanto alguien escribe otra consulta.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';


suite('S-10 — lectura de empresas y bandeja', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;

  let usuarioA = '';
  let usuarioB = '';
  let usuarioMudo = '';
  let empresaA = '';
  let empresaB = '';
  let tokenMudo = '';

  /** Corre una consulta como `aai_app`, fijando el contexto que se le indique. */
  async function comoApp<T>(
    contexto: { empresa?: string; actor?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      if (contexto.empresa !== undefined) {
        await db.query('SELECT set_config($1,$2,true)', ['app.company_id', contexto.empresa]);
      }
      if (contexto.actor !== undefined) {
        await db.query('SELECT set_config($1,$2,true)', ['app.actor_id', contexto.actor]);
      }
      return await fn();
    } finally {
      await db.query('ROLLBACK');
    }
  }

  const contarEmpresas = async (): Promise<string[]> =>
    (await db.query<{ id: string }>('SELECT id FROM user_companies()')).rows.map((f) => f.id);

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const alta = async (etiqueta: string): Promise<string> =>
      (
        await db.query<{ id: string }>(
          'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
          [`${etiqueta}-iso-${stamp}@estudio.test`, etiqueta, hash],
        )
      ).rows[0]!.id;

    const duenoId = await alta('dueno');
    usuarioA = await alta('usuarioa');
    usuarioB = await alta('usuariob');
    usuarioMudo = await alta('mudo');

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio iso ${stamp}`,
        withCheckDigit(`30${stamp}`),
        duenoId,
      ])
    ).rows[0]!.create_organization;

    for (const id of [usuarioA, usuarioB, usuarioMudo]) {
      await db.query(
        'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,$3)',
        [organizationId, id, 'MEMBER'],
      );
    }

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          duenoId,
          organizationId,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SA',
          'AR-C',
          'IGJ',
          '12-31',
        ])
      ).rows[0]!.create_company;

    empresaA = await crearEmpresa(`Iso A ${stamp}`, '33');
    empresaB = await crearEmpresa(`Iso B ${stamp}`, '27');

    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [duenoId, empresaA, usuarioA, 'CONTADOR']);
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [duenoId, empresaB, usuarioB, 'CONTADOR']);

    // El CARGADOR es el rol de menor alcance del producto: sube documentos y no
    // lee la contabilidad. Sirve para ejercitar el filtro por permiso de la
    // bandeja con un rol **real**, y no con uno inventado para el test —el CHECK
    // de `roles.code` es un catálogo cerrado, y está bien que lo sea.
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
      duenoId,
      empresaA,
      usuarioMudo,
      'CARGADOR',
    ]);

    tokenMudo = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `mudo-iso-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ── SQL directo: la función privilegiada ──────────────────────────────

  it('user_companies() no acepta un usuario por parámetro', async () => {
    // Es la garantía estructural, no una de comportamiento: si aceptara un uuid
    // sería un oráculo para preguntar por la cartera de cualquier otro.
    const r = await db.query<{ args: string }>(
      `SELECT pg_get_function_arguments(oid) AS args
         FROM pg_proc WHERE proname = 'user_companies'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.args).toBe('');
  });

  it('sin actor en contexto no devuelve nada', async () => {
    expect(await comoApp({}, contarEmpresas)).toEqual([]);
  });

  it('con un actor que no es una persona no devuelve nada', async () => {
    expect(await comoApp({ actor: 'system:migraciones' }, contarEmpresas)).toEqual([]);
    expect(await comoApp({ actor: 'ai:clasificador' }, contarEmpresas)).toEqual([]);
  });

  it('con un actor mal formado no devuelve nada, y no revienta', async () => {
    expect(await comoApp({ actor: 'user:no-es-un-uuid' }, contarEmpresas)).toEqual([]);
    expect(await comoApp({ actor: 'user:' }, contarEmpresas)).toEqual([]);
  });

  it('cada usuario ve la suya y solo la suya, por SQL directo', async () => {
    const deA = await comoApp({ actor: `user:${usuarioA}` }, contarEmpresas);
    expect(deA).toContain(empresaA);
    expect(deA).not.toContain(empresaB);

    const deB = await comoApp({ actor: `user:${usuarioB}` }, contarEmpresas);
    expect(deB).toContain(empresaB);
    expect(deB).not.toContain(empresaA);
  });

  it('fijar app.company_id no agrega empresas: la pertenencia manda', async () => {
    // Aunque la transacción diga que la empresa activa es B, el usuario A sigue
    // viendo solo A. El contexto de empresa no es una credencial.
    const filas = await comoApp(
      { actor: `user:${usuarioA}`, empresa: empresaB },
      contarEmpresas,
    );
    expect(filas).toEqual([empresaA]);
  });

  // ── SQL directo: la vista de bandeja ──────────────────────────────────

  it('work_queue declara security_invoker', async () => {
    const r = await db.query<{ reloptions: string[] | null }>(
      `SELECT reloptions FROM pg_class WHERE relname = 'work_queue'`,
    );
    expect(r.rows[0]!.reloptions).toContain('security_invoker=true');
  });

  it('work_queue sin empresa en contexto no devuelve nada', async () => {
    const filas = await comoApp({ actor: `user:${usuarioA}` }, async () =>
      (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM work_queue')).rows[0]!.n,
    );
    expect(filas).toBe('0');
  });

  it('work_queue con una empresa en contexto no deja ver la otra', async () => {
    // Se siembra trabajo en las dos: un barrido que pasa porque no hay filas no
    // prueba nada.
    for (const [empresa, nombre] of [
      [empresaA, `wq-a-${stamp}`],
      [empresaB, `wq-b-${stamp}`],
    ] as const) {
      await db.query(
        `INSERT INTO documents (company_id, storage_key, sha256, bytes, mime, content_type,
                                original_name, source, uploaded_by)
         VALUES ($1, $2, repeat('a', 64), 10, 'application/xml', 'XML', $3, 'UPLOAD', 'system:test')`,
        [empresa, `${empresa}/${nombre}`, `${nombre}.xml`],
      );
    }

    const propias = await comoApp({ empresa: empresaA, actor: `user:${usuarioA}` }, async () =>
      (
        await db.query<{ company_id: string }>('SELECT DISTINCT company_id FROM work_queue')
      ).rows.map((f) => f.company_id),
    );

    // La mitad positiva: se ve trabajo propio. Sin esto el test pasaría vacío.
    expect(propias).toEqual([empresaA]);
  });

  // ── HTTP: la ruta ─────────────────────────────────────────────────────

  it('el filtro por permiso de /companies discrimina de verdad', async () => {
    // Los seis roles del producto conceden `company:read`: hoy el filtro no
    // excluye a nadie, y por eso hay que comprobar que **puede** excluir. Se
    // corre el mismo predicado del handler con un permiso que existe y que no
    // tiene ningún rol —`rule:activate`, sin rol a propósito por el §32— y con
    // el permiso real, sobre el mismo usuario.
    const conPermiso = async (permiso: string): Promise<number> =>
      comoApp({ actor: `user:${usuarioA}` }, async () => {
        const r = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM user_companies() uc
            WHERE EXISTS (
                    SELECT 1 FROM roles r
                      JOIN role_permissions rp ON rp.role_id = r.id
                      JOIN permissions p ON p.id = rp.permission_id
                     WHERE r.code = ANY (uc.roles) AND p.code = $1)`,
          [permiso],
        );
        return Number(r.rows[0]!.n);
      });

    expect(await conPermiso('company:read')).toBe(1);
    expect(await conPermiso('rule:activate')).toBe(0);
  });

  it('un rol vencido deja de dar acceso a la empresa', async () => {
    await db.query(
      `UPDATE user_company_roles SET valid_to = CURRENT_DATE - 1
        WHERE user_id = $1 AND company_id = $2`,
      [usuarioB, empresaB],
    );
    try {
      expect(await comoApp({ actor: `user:${usuarioB}` }, contarEmpresas)).toEqual([]);
    } finally {
      await db.query(
        `UPDATE user_company_roles SET valid_to = NULL
          WHERE user_id = $1 AND company_id = $2`,
        [usuarioB, empresaB],
      );
    }
    expect(await comoApp({ actor: `user:${usuarioB}` }, contarEmpresas)).toEqual([empresaB]);
  });

  it('la bandeja de un CARGADOR trae documentos y no trae contabilidad', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/work-queue',
      headers: { authorization: `Bearer ${tokenMudo}`, 'x-company-id': empresaA },
    });
    expect(r.statusCode, r.body).toBe(200);
    const entidades = new Set(r.json<{ items: { entidad: string }[] }>().items.map((i) => i.entidad));

    // Tiene `document:read`: ve sus documentos pendientes.
    expect(entidades.has('documents')).toBe(true);
    // No tiene `journal_entry:read` ni `period:read`: esas ramas no se consultan.
    expect(entidades.has('tax_transactions')).toBe(false);
    expect(entidades.has('journal_entries')).toBe(false);
    expect(entidades.has('periods')).toBe(false);
  });

  it('pedir una rama que el rol no puede leer devuelve vacío, no un 403', async () => {
    // Distinguir «no tenés permiso» de «no hay nada» convertiría la ruta en un
    // oráculo sobre lo que existe en la empresa.
    const r = await app.inject({
      method: 'GET',
      url: '/work-queue?entidad=journal_entries',
      headers: { authorization: `Bearer ${tokenMudo}`, 'x-company-id': empresaA },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ items: unknown[]; resumen: object }>()).toEqual({
      items: [],
      cursor: null,
      limite: 50,
      resumen: {},
    });
  });
});
