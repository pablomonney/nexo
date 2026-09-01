/**
 * El contrato de paginación por keyset.
 *
 * Dos mitades. La primera es pura —codificar, decodificar, rechazar— y corre sin
 * base. La segunda es la que importa de verdad: **qué pasa cuando llegan filas
 * nuevas mientras alguien pagina**, que es exactamente donde `OFFSET` pierde
 * comprobantes sin avisar.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import {
  armarPagina,
  codificarCursor,
  corteDe,
  decodificarCursor,
  parametrosDeCorte,
} from '@aai/api/http/paginacion';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const UUID_A = '01a04860-0000-7000-8000-000000000001';
const UUID_B = '01a04860-0000-7000-8000-000000000002';

// ───────────────────────────────────────────────────────────────────────
// Parte pura
// ───────────────────────────────────────────────────────────────────────

describe('Cursor: codificación y validación', () => {
  it('ida y vuelta conserva la fecha y el id', () => {
    const cursor = codificarCursor({ fecha: '2026-03-15', id: UUID_A });
    expect(decodificarCursor(cursor)).toEqual({ fecha: '2026-03-15', id: UUID_A });
  });

  it('acepta un timestamp completo, no solo una fecha', () => {
    const momento = new Date('2026-03-15T12:34:56.789Z');
    const corte = decodificarCursor(codificarCursor({ fecha: momento, id: UUID_A }));
    expect(corte.fecha).toBe('2026-03-15T12:34:56.789Z');
  });

  it('es opaco: no se lee de un vistazo', () => {
    const cursor = codificarCursor({ fecha: '2026-03-15', id: UUID_A });
    expect(cursor).not.toContain('2026');
    expect(cursor).not.toContain(UUID_A);
  });

  it('NO transporta la empresa', () => {
    // La empresa sale de X-Company-Id y la filtra RLS. Dos canales para decir de
    // qué empresa es un pedido terminan, algún día, no coincidiendo.
    const cursor = codificarCursor({ fecha: '2026-03-15', id: UUID_A });
    const plano = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(plano.split('|')).toHaveLength(2);
  });

  it('rechaza basura, sobras y partes de más', () => {
    for (const malo of [
      'no-es-base64-@@@',
      Buffer.from('solo-una-parte').toString('base64url'),
      Buffer.from('2026-03-15|uno|dos').toString('base64url'),
      Buffer.from(`no-es-fecha|${UUID_A}`).toString('base64url'),
      Buffer.from('2026-03-15|no-es-uuid').toString('base64url'),
      Buffer.from('2026-13-45|' + UUID_A).toString('base64url').slice(0, 4),
    ]) {
      expect(() => decodificarCursor(malo), malo).toThrow(/cursor no es válido/);
    }
  });

  it('sin cursor no hay corte, y los parámetros van en NULL', () => {
    expect(corteDe(undefined)).toBeUndefined();
    expect(corteDe('')).toBeUndefined();
    expect(parametrosDeCorte(undefined)).toEqual([null, null]);
    expect(parametrosDeCorte({ fecha: '2026-03-15', id: UUID_B })).toEqual(['2026-03-15', UUID_B]);
  });

  it('la página devuelve cursor solo si hay más', () => {
    const filas = [
      { id: UUID_A, fecha: '2026-03-15' },
      { id: UUID_B, fecha: '2026-03-14' },
    ];
    const clave = (f: { id: string; fecha: string }) => ({ fecha: f.fecha, id: f.id });

    // Se pidieron 2 y llegaron 2: no hay una de más, así que no hay siguiente.
    const completa = armarPagina(filas, 2, clave);
    expect(completa.items).toHaveLength(2);
    expect(completa.cursor).toBeNull();

    // Se pidió 1 y llegaron 2: la de más se descarta y marca que hay siguiente.
    const parcial = armarPagina(filas, 1, clave);
    expect(parcial.items).toHaveLength(1);
    expect(parcial.cursor).toBe(codificarCursor({ fecha: '2026-03-15', id: UUID_A }));
    expect(parcial.limite).toBe(1);
  });

  it('una página vacía no inventa cursor', () => {
    const vacia = armarPagina([], 10, () => ({ fecha: '2026-01-01', id: UUID_A }));
    expect(vacia.items).toEqual([]);
    expect(vacia.cursor).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Parte con base: el comportamiento bajo inserciones
// ───────────────────────────────────────────────────────────────────────

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('Cursor sobre datos reales', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let tokenA = '';
  let tokenB = '';
  let empresaA = '';
  let empresaB = '';

  const cab = (token: string, empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  async function subir(token: string, empresa: string, nombre: string): Promise<string> {
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="${nombre}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c>${nombre}</c>\r\n--X--\r\n`;
    const r = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...cab(token, empresa), 'content-type': 'multipart/form-data; boundary=X' },
      payload: forma,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }

  async function listar(
    token: string,
    empresa: string,
    parametros: string,
  ): Promise<{ documentos: { id: string }[]; cursor: string | null }> {
    const r = await app.inject({
      method: 'GET',
      url: `/documents?${parametros}`,
      headers: cab(token, empresa),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }

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
          [`${etiqueta}-cur-${stamp}@estudio.test`, etiqueta, hash],
        )
      ).rows[0]!.id;

    const duenoId = await alta('dueno');
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio cursor ${stamp}`,
        withCheckDigit(`30${stamp}`),
        duenoId,
      ])
    ).rows[0]!.create_organization;

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

    empresaA = await crearEmpresa(`Cursor A ${stamp}`, '33');
    empresaB = await crearEmpresa(`Cursor B ${stamp}`, '27');
    for (const empresa of [empresaA, empresaB]) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
        duenoId,
        empresa,
        duenoId,
        'CONTADOR',
      ]);
    }

    // El dueño opera en las dos: acá lo que se aísla es el cursor, no el usuario.
    const inicial = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `dueno-cur-${stamp}@estudio.test`, password: PASSWORD },
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
    tokenA = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `dueno-cur-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${tokenA}` },
    });
    tokenB = tokenA;

    for (let n = 1; n <= 6; n += 1) await subir(tokenA, empresaA, `a-${stamp}-${n}`);
    for (let n = 1; n <= 2; n += 1) await subir(tokenB, empresaB, `b-${stamp}-${n}`);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('recorre todas las filas sin repetir ninguna', async () => {
    const vistos: string[] = [];
    let cursor: string | null = null;
    let vueltas = 0;

    do {
      const pagina: { documentos: { id: string }[]; cursor: string | null } = await listar(
        tokenA,
        empresaA,
        `limite=2${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      vistos.push(...pagina.documentos.map((d) => d.id));
      cursor = pagina.cursor;
      vueltas += 1;
      expect(vueltas, 'la paginación no termina').toBeLessThan(10);
    } while (cursor !== null);

    expect(vistos).toHaveLength(6);
    expect(new Set(vistos).size).toBe(6);
  });

  it('una inserción entre páginas no duplica ni saltea', async () => {
    const primera = await listar(tokenA, empresaA, 'limite=3');
    expect(primera.documentos).toHaveLength(3);
    expect(primera.cursor).not.toBeNull();

    // Llega un documento nuevo justo entre las dos páginas. Es el más reciente,
    // así que con OFFSET habría corrido todo un lugar: la página 2 habría
    // repetido la última de la 1 y perdido la más vieja.
    const intruso = await subir(tokenA, empresaA, `intruso-${stamp}`);

    const segunda = await listar(tokenA, empresaA, `limite=10&cursor=${primera.cursor}`);
    const idsPrimera = primera.documentos.map((d) => d.id);
    const idsSegunda = segunda.documentos.map((d) => d.id);

    // Ni una repetida.
    expect(idsSegunda.filter((id) => idsPrimera.includes(id))).toEqual([]);
    // Ni una perdida: las seis originales están entre las dos páginas.
    expect(new Set([...idsPrimera, ...idsSegunda]).size).toBe(6);
    // Y el intruso no se cuela hacia atrás: es más nuevo que el corte.
    expect(idsSegunda).not.toContain(intruso);
  });

  it('el cursor de una empresa no trae filas de la otra', async () => {
    const deA = await listar(tokenA, empresaA, 'limite=1');
    expect(deA.cursor).not.toBeNull();

    // El mismo cursor, con la otra empresa en la cabecera. Es una posición, no
    // una llave: lo único que puede hacer es mover el corte dentro de B.
    const enB = await listar(tokenB, empresaB, `limite=50&cursor=${deA.cursor}`);

    const idsDeA = new Set(
      (await db.query<{ id: string }>('SELECT id FROM documents WHERE company_id = $1', [empresaA]))
        .rows.map((f) => f.id),
    );
    for (const documento of enB.documentos) {
      expect(idsDeA.has(documento.id), 'se filtró un documento de la otra empresa').toBe(false);
    }
  });

  it('un cursor manipulado es un pedido mal formado', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/documents?cursor=esto-no-es-un-cursor',
      headers: cab(tokenA, empresaA),
    });
    expect(r.statusCode).toBe(400);
  });

  it('el Diario pagina hacia adelante, que es como se lee un libro', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/journal-entries?limite=1',
      headers: cab(tokenA, empresaA),
    });
    expect(r.statusCode).toBe(200);
    const cuerpo = r.json<{ asientos: unknown[]; cursor: string | null; limite: number }>();
    // Sin asientos todavía: lo que se comprueba es la forma del contrato.
    expect(cuerpo.asientos).toEqual([]);
    expect(cuerpo.cursor).toBeNull();
    expect(cuerpo.limite).toBe(1);
  });
});
