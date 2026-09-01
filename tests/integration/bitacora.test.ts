/**
 * La bitácora, leída por HTTP.
 *
 * `audit_logs` se escribía desde 35 acciones y tres triggers, encadenada por
 * hash e inmutable, y **no la leía nadie**: el permiso `audit:read` estaba
 * otorgado a tres roles sin que ninguna ruta lo exigiera. Hasta esta fase,
 * «¿qué pasó con esto?» solo se contestaba con `psql`.
 *
 * Lo que esta suite comprueba no es que la ruta responda 200, sino que la
 * bitácora sirva para lo que existe: reconstruir quién hizo qué, cuándo, sobre
 * qué y por qué — sin poder ver la de otra empresa y sin filtrar secretos.
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

interface Evento {
  readonly id: string;
  readonly actorType: string;
  readonly actor: string;
  readonly accion: string;
  readonly objetoTipo: string;
  readonly objetoId: string;
  readonly antes: unknown;
  readonly despues: unknown;
  readonly motivo: string | null;
  readonly ocurridoEn: string;
}

suite('La bitácora se puede leer', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let organizationId = '';

  let empresaA = '';
  let empresaB = '';
  let contadorId = '';
  let tokenContador = '';
  let tokenCargador = '';
  let tokenFundador = '';

  const cab = (token: string, empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  const leer = async (token: string, empresa: string, query = '') =>
    app.inject({ method: 'GET', url: `/audit${query}`, headers: cab(token, empresa) });

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
          `fundador-bit-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio bit ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          fundadorId,
          organizationId,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SA',
          'AR-C',
          'IGJ',
          '12-31',
        ])
      ).rows[0]!.create_company;

    empresaA = await crearEmpresa(`Bit A ${stamp}`, '33');
    empresaB = await crearEmpresa(`Bit B ${stamp}`, '27');

    tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-bit-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    /** Alta por la ruta real del estudio, que es lo que B2 tiene que registrar. */
    const altaYRol = async (
      etiqueta: string,
      empresa: string,
      rol: string,
      conMfa: boolean,
    ): Promise<{ id: string; token: string }> => {
      const email = `${etiqueta}-bit-${stamp}@estudio.test`;
      const alta = await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: etiqueta, password: PASSWORD, level: 'MEMBER' },
      });
      expect(alta.statusCode, alta.body).toBe(200);
      const id = alta.json<{ id: string }>().id;

      const asignado = await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId: id, role: rol },
      });
      expect(asignado.statusCode, asignado.body).toBe(200);

      const primero = (
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
      ).json<{ token: string }>().token;
      if (!conMfa) return { id, token: primero };

      const secret = (
        await app.inject({
          method: 'POST',
          url: '/auth/mfa/setup',
          headers: { authorization: `Bearer ${primero}` },
        })
      ).json<{ secret: string }>().secret;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/confirm',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${primero}` },
      });
      const token = (
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
      ).json<{ token: string }>().token;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${token}` },
      });
      return { id, token };
    };

    const contador = await altaYRol('contadora', empresaA, 'CONTADOR', true);
    contadorId = contador.id;
    tokenContador = contador.token;
    tokenCargador = (await altaYRol('cargador', empresaA, 'CARGADOR', false)).token;

    // Un ejercicio y un documento: hechos reales que dejan huella.
    await app.inject({
      method: 'POST',
      url: '/fiscal-years',
      headers: cab(tokenContador, empresaA),
      payload: { code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    for (let n = 1; n <= 4; n += 1) {
      await app.inject({
        method: 'POST',
        url: '/documents',
        headers: {
          ...cab(tokenContador, empresaA),
          'content-type': 'multipart/form-data; boundary=X',
        },
        payload:
          `--X\r\nContent-Disposition: form-data; name="file"; filename="bit-${stamp}-${n}.xml"\r\n` +
          `Content-Type: application/xml\r\n\r\n<c>${n}</c>\r\n--X--\r\n`,
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ── Camino feliz ──────────────────────────────────────────────────────

  it('devuelve lo que hace falta para reconstruir un hecho', async () => {
    const r = await leer(tokenContador, empresaA);
    expect(r.statusCode, r.body).toBe(200);

    const eventos = r.json<{ eventos: Evento[] }>().eventos;
    expect(eventos.length).toBeGreaterThan(0);

    const alta = eventos.find((e) => e.accion === 'INGRESAR_DOCUMENTO');
    expect(alta, 'el alta de documento tiene que estar').toBeDefined();
    expect(alta!.actorType).toBe('USER');
    expect(alta!.actor).toBe(`user:${contadorId}`);
    expect(alta!.objetoTipo).toBe('document');
    expect(alta!.ocurridoEn).toBeTruthy();
  });

  it('el actor_type viene como columna propia, no fundido con el nombre', async () => {
    // Que un cambio lo haya propuesto un modelo y que lo haya firmado una
    // persona son hechos distintos: fundirlos es cómo una sugerencia se vuelve
    // una decisión profesional sin que nadie lo decida (ADR-001).
    const r = await leer(tokenContador, empresaA);
    for (const evento of r.json<{ eventos: Evento[] }>().eventos) {
      expect(['USER', 'SYSTEM', 'AI']).toContain(evento.actorType);
    }
  });

  it('no expone la cadena de hashes', async () => {
    // Verificar la cadena es un gate, no una columna: mostrarla invitaría a
    // compararla a ojo y a creer que eso prueba algo.
    const r = await leer(tokenContador, empresaA);
    const crudo = r.body;
    expect(crudo).not.toContain('prevHash');
    expect(crudo).not.toContain('prev_hash');
    expect(crudo.includes('"hash"')).toBe(false);
  });

  it('filtra por objeto, por acción y por tipo de actor', async () => {
    const porAccion = await leer(tokenContador, empresaA, '?action=INGRESAR_DOCUMENTO');
    const eventos = porAccion.json<{ eventos: Evento[] }>().eventos;
    expect(eventos.length).toBeGreaterThanOrEqual(4);
    expect(eventos.every((e) => e.accion === 'INGRESAR_DOCUMENTO')).toBe(true);

    const unObjeto = eventos[0]!.objetoId;
    const porObjeto = await leer(tokenContador, empresaA, `?objectId=${unObjeto}`);
    expect(
      porObjeto.json<{ eventos: Evento[] }>().eventos.every((e) => e.objetoId === unObjeto),
    ).toBe(true);

    const porActor = await leer(tokenContador, empresaA, '?actorType=AI');
    expect(porActor.json<{ eventos: Evento[] }>().eventos).toEqual([]);
  });

  // ── Autorización ──────────────────────────────────────────────────────

  it('un CARGADOR no puede leer la bitácora', async () => {
    const r = await leer(tokenCargador, empresaA);
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('audit:read');
  });

  it('sin sesión, tampoco', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/audit',
      headers: { 'x-company-id': empresaA },
    });
    expect(r.statusCode).toBe(401);
  });

  // ── Aislamiento ───────────────────────────────────────────────────────

  it('la empresa A no puede pedir la bitácora de B', async () => {
    const r = await leer(tokenContador, empresaB);
    // No tiene rol en B: corta antes de mirar nada.
    expect(r.statusCode).toBe(403);
  });

  it('ni pidiendo por el id de un objeto de otra empresa', async () => {
    const ajeno = await db.query<{ object_id: string }>(
      `SELECT object_id FROM audit_logs WHERE company_id = $1 LIMIT 1`,
      [empresaB],
    );
    if (ajeno.rowCount === 0) return; // B no tuvo actividad: nada que filtrar

    const r = await leer(tokenContador, empresaA, `?objectId=${ajeno.rows[0]!.object_id}`);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ eventos: Evento[] }>().eventos).toEqual([]);
  });

  it('por SQL directo tampoco cruza: la tabla tiene RLS forzado', async () => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      await db.query('SELECT set_config($1,$2,true)', ['app.company_id', empresaB]);
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs WHERE company_id = $1`,
        [empresaA],
      );
      expect(r.rows[0]!.n).toBe('0');
    } finally {
      await db.query('ROLLBACK');
    }
  });

  // ── Paginación ────────────────────────────────────────────────────────

  it('el cursor recorre todo sin repetir ni saltear, con inserciones en el medio', async () => {
    const primera = await leer(tokenContador, empresaA, '?limite=3');
    const p1 = primera.json<{ eventos: Evento[]; cursor: string | null }>();
    expect(p1.eventos).toHaveLength(3);
    expect(p1.cursor).not.toBeNull();

    // Un hecho nuevo entre las dos páginas. Es el más reciente: con OFFSET
    // habría corrido todo un lugar.
    await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        ...cab(tokenContador, empresaA),
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload:
        `--X\r\nContent-Disposition: form-data; name="file"; filename="bit-intruso-${stamp}.xml"\r\n` +
        `Content-Type: application/xml\r\n\r\n<c>intruso</c>\r\n--X--\r\n`,
    });

    const segunda = await leer(tokenContador, empresaA, `?limite=50&cursor=${p1.cursor}`);
    const p2 = segunda.json<{ eventos: Evento[] }>();

    const ids1 = p1.eventos.map((e) => e.id);
    const ids2 = p2.eventos.map((e) => e.id);
    expect(ids2.filter((id) => ids1.includes(id))).toEqual([]);
    expect(new Set([...ids1, ...ids2]).size).toBe(ids1.length + ids2.length);
  });

  it('un cursor mal formado es un pedido mal formado', async () => {
    const r = await leer(tokenContador, empresaA, '?cursor=no-es-un-cursor');
    expect(r.statusCode).toBe(400);
  });

  it('el cursor de una empresa no sirve para ver otra', async () => {
    const p1 = (await leer(tokenContador, empresaA, '?limite=1')).json<{ cursor: string }>();
    // Con el mismo cursor y la empresa ajena en la cabecera: corta por rol, no
    // por el cursor. El cursor es una posición, no una llave.
    const r = await leer(tokenContador, empresaB, `?cursor=${p1.cursor}`);
    expect(r.statusCode).toBe(403);
  });

  // ── B2 · El alta de usuario deja constancia, y no filtra la contraseña ──

  it('quién dio de alta a una persona queda en la propia fila', async () => {
    const fila = await db.query<{ created_by: string | null; status: string }>(
      'SELECT created_by, status FROM users WHERE email = $1',
      [`contadora-bit-${stamp}@estudio.test`],
    );
    expect(fila.rows[0]!.created_by).toMatch(/^user:/);
    expect(fila.rows[0]!.status).toBe('ACTIVE');

    const miembro = await db.query<{ created_by: string | null }>(
      `SELECT om.created_by FROM organization_members om
        WHERE om.user_id = $1 AND om.organization_id = $2`,
      [contadorId, organizationId],
    );
    expect(miembro.rows[0]!.created_by).toMatch(/^user:/);
  });

  it('el acceso a la contabilidad sí queda en la bitácora, con su empresa', async () => {
    // No se duplica el evento: el alta va en la fila y el **acceso** —que es lo
    // que de verdad hay que auditar— lo registra el trigger de la 0043.
    const r = await leer(tokenContador, empresaA, '?action=ROL_OTORGADO');
    const eventos = r.json<{ eventos: Evento[] }>().eventos;
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.some((e) => JSON.stringify(e.despues).includes(contadorId))).toBe(true);
  });

  it('la bitácora no contiene el hash de ninguna contraseña', async () => {
    const r = await leer(tokenContador, empresaA, '?limite=200');
    expect(r.body).not.toContain('$argon2');
    expect(r.body).not.toContain('password');
  });
});
