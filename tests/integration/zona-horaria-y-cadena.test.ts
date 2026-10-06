/**
 * La zona horaria de negocio y la cadena de auditoría — contra PostgreSQL real.
 *
 * ## Qué protege
 *
 * La aplicación abre sus conexiones en `America/Argentina/Buenos_Aires` para que
 * `CURRENT_DATE` sea el día del negocio. La base de producción está en UTC y se
 * queda así: el hash de la cadena de auditoría incluye `occurred_at::text`, y un
 * `timestamptz` en texto se escribe según la zona de la sesión. Si las funciones
 * que lo calculan dependieran de esa zona, todo el historial —hasheado en UTC—
 * se vería roto desde una sesión argentina.
 *
 * La migración 0131 fija `timezone = 'UTC'` dentro de las tres funciones. Este
 * archivo prueba que eso alcanza, y que la prueba tiene poder para detectarlo:
 * contra el estado anterior a la 0131 el mismo control **falla**.
 *
 * ## Por qué no depende de la hora a la que corre
 *
 * Todo sale de comparar dos zonas sobre el mismo dato, no de cuál es «hoy».
 * Comprobar que `CURRENT_DATE` es el de Argentina solo falla de verdad entre las
 * 21:00 y las 24:00 ART con la base en UTC, y una prueba que falla tres horas por
 * día es la que no estaba (S-37). Lo que se afirma acá es la zona de la sesión.
 *
 * Plan completo y criterios: `docs/PLAN_ZONA_HORARIA.md` (P4–P7).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, initPool, withCompany, withoutCompany } from '@aai/db';
import { ZONA_DE_NEGOCIO } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const UTC = 'UTC';
const CONSTANCIA = 'Revisado contra el articulo citado y su documento archivado con hash.';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRACION = join(RAIZ, 'infrastructure', 'db', 'migrations', '0131_funciones_de_hash_en_utc.sql');

const FUNCIONES = [
  'audit_chain_link',
  'normative_audit_chain_link',
  'verify_audit_chain',
] as const;

/**
 * Recalcula el hash de la cadena por empresa **en SQL y con la misma fórmula del
 * trigger** (0025). Es una copia deliberada: si la fórmula cambia, esto tiene
 * que cambiar con ella, y que esté escrita acá es lo que permite comprobar que
 * el valor guardado no depende de la zona en que se escribió.
 */
const RECALCULO_EMPRESA = `
  SELECT id::text AS id,
         encode(digest(concat_ws('|',
           prev_hash, seq::text, company_id::text, actor_type, actor_id, action,
           object_type, object_id,
           COALESCE(old_value::text, ''), COALESCE(new_value::text, ''),
           COALESCE(motivo, ''), occurred_at::text), 'sha256'), 'hex') = hash AS coincide
    FROM audit_logs WHERE company_id = $1 ORDER BY seq`;

/** Lo mismo para la cadena normativa (0041), que no tiene `company_id` ni verificador. */
const RECALCULO_NORMATIVO = `
  SELECT id::text AS id,
         encode(digest(concat_ws('|',
           prev_hash, seq::text, actor_type, actor_id, action, object_type, object_id,
           COALESCE(old_value::text, ''), COALESCE(new_value::text, ''),
           motivo, occurred_at::text), 'sha256'), 'hex') = hash AS coincide
    FROM normative_audit_logs WHERE object_id LIKE $1 ORDER BY seq`;

async function fijarZona(client: Client, zona: string): Promise<void> {
  // `SET` no admite parámetros; la zona sale de una constante de este archivo.
  await client.query(`SET timezone = '${zona}'`);
}

async function roturas(client: Client, empresa: string): Promise<number> {
  const r = await client.query('SELECT * FROM verify_audit_chain($1)', [empresa]);
  return r.rows.length;
}

async function escribirAuditoria(client: Client, empresa: string, etiqueta: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await client.query(
      `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id)
       VALUES ($1, 'USER', 'contador', 'APROBAR_ASIENTO', 'journal_entry', $2)`,
      [empresa, `${etiqueta}-${i}`],
    );
  }
}

suite('Zona horaria — las funciones de hash no dependen de la sesión (0131)', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, 'zona');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('P6 · las tres funciones tienen la zona fijada a UTC', async () => {
    const r = await client.query<{ proname: string; config: string }>(
      `SELECT proname, coalesce(array_to_string(proconfig, ','), '') AS config
         FROM pg_proc WHERE proname = ANY($1::text[])`,
      [FUNCIONES],
    );
    for (const nombre of FUNCIONES) {
      const fila = r.rows.find((x) => x.proname === nombre);
      expect(fila, `no existe la función ${nombre}`).toBeDefined();
      expect(fila!.config, `${nombre} no fija la zona`).toMatch(/(^|,)timezone=UTC(,|$)/i);
    }
  });

  it('P4 · el hash de una fila es el mismo se escriba en la zona que se escriba', async () => {
    const zonas = [UTC, ZONA_DE_NEGOCIO];
    for (const zona of zonas) {
      await fijarZona(client, zona);
      await escribirAuditoria(client, fx.companyA, `p4-${zona}`, 3);
    }

    // Recalculado desde una sesión UTC —la zona con que se escribió todo el
    // historial—: tienen que coincidir las seis filas, las de las dos zonas.
    await fijarZona(client, UTC);
    const filas = await client.query<{ coincide: boolean }>(RECALCULO_EMPRESA, [fx.companyA]);
    const mios = filas.rows.length;
    expect(mios).toBeGreaterThanOrEqual(6);
    expect(filas.rows.filter((f) => !f.coincide)).toEqual([]);

    // Control negativo: la misma comprobación desde una sesión argentina **no**
    // puede coincidir. Si coincidiera, esta prueba no distinguiría nada.
    await fijarZona(client, ZONA_DE_NEGOCIO);
    const desdeArgentina = await client.query<{ coincide: boolean }>(RECALCULO_EMPRESA, [
      fx.companyA,
    ]);
    expect(desdeArgentina.rows.filter((f) => f.coincide)).toEqual([]);

    // El verificador, en cambio, da lo mismo en las dos: es lo que la 0131 arregla.
    for (const zona of zonas) {
      await fijarZona(client, zona);
      expect(await roturas(client, fx.companyA), `roturas desde ${zona}`).toBe(0);
    }
  });

  it('P4 · la cadena normativa tampoco depende de la zona', async () => {
    const marca = `zona-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await client.query('BEGIN');
    try {
      for (const zona of [UTC, ZONA_DE_NEGOCIO]) {
        await fijarZona(client, zona);
        await client.query(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'user:revisora', 'RULE_APPROVED', 'accounting_rules', $1, $2, '', '', 0)`,
          [`${marca}-${zona}`, CONSTANCIA],
        );
      }
      await fijarZona(client, UTC);
      const r = await client.query<{ coincide: boolean }>(RECALCULO_NORMATIVO, [`${marca}%`]);
      expect(r.rows).toHaveLength(2);
      expect(r.rows.filter((f) => !f.coincide)).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('P5 · filas heredadas: lo escrito en UTC antes de la 0131 verifica desde Argentina después', async () => {
    // Reproduce la situación de producción sin depender del contenido de un
    // backup: se vuelve —dentro de una transacción— al estado anterior a la
    // 0131, se escribe como se escribió siempre (sesión UTC), y se aplica **el
    // archivo real de la migración**. Todo se deshace con ROLLBACK.
    const sql = await readFile(MIGRACION, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query('ALTER FUNCTION audit_chain_link() RESET timezone');
      await client.query('ALTER FUNCTION normative_audit_chain_link() RESET timezone');
      await client.query('ALTER FUNCTION verify_audit_chain(uuid) RESET timezone');

      await fijarZona(client, UTC);
      await escribirAuditoria(client, fx.companyB, 'p5-heredada', 4);

      // Antes de la 0131: UTC verifica; Argentina NO. Es el control negativo
      // (P2 del plan): demuestra que el cambio ingenuo de zona rompía la cadena.
      expect(await roturas(client, fx.companyB), 'antes de la 0131, desde UTC').toBe(0);
      await fijarZona(client, ZONA_DE_NEGOCIO);
      expect(
        await roturas(client, fx.companyB),
        'antes de la 0131, desde Argentina: tendría que detectar roturas',
      ).toBeGreaterThan(0);

      // Se aplica la migración tal como está en el repositorio.
      await client.query(sql);

      const desde: Record<string, string> = {};
      for (const zona of [UTC, ZONA_DE_NEGOCIO]) {
        await fijarZona(client, zona);
        const r = await client.query('SELECT * FROM verify_audit_chain($1)', [fx.companyB]);
        desde[zona] = JSON.stringify(r.rows);
        expect(r.rows, `después de la 0131, desde ${zona}`).toEqual([]);
      }
      expect(desde[UTC]).toBe(desde[ZONA_DE_NEGOCIO]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

suite('Zona horaria — las conexiones de la aplicación (P7)', () => {
  let fx: Fixture;
  let client: Client;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, 'zonapool');
    initPool(process.env['DATABASE_URL']!);
  });

  afterAll(async () => {
    await closePool();
    await client?.end();
  });

  it('con empresa en contexto, la sesión está en la zona del negocio', async () => {
    const zona = await withCompany(
      { companyId: fx.companyA, actorId: 'system:test' },
      async (tx) => (await tx.query<{ TimeZone: string }>('SHOW timezone')).rows[0]!.TimeZone,
    );
    expect(zona).toBe(ZONA_DE_NEGOCIO);
  });

  it('sin empresa en contexto, también', async () => {
    const zona = await withoutCompany(
      'system:test',
      async (tx) => (await tx.query<{ TimeZone: string }>('SHOW timezone')).rows[0]!.TimeZone,
    );
    expect(zona).toBe(ZONA_DE_NEGOCIO);
  });

  it('CURRENT_DATE es el día argentino, no el de UTC', async () => {
    // En una sola sentencia, así las dos fechas salen del mismo instante y la
    // prueba no cruza la medianoche a mitad de camino.
    const r = await withoutCompany('system:test', async (tx) =>
      tx.query<{ igual: boolean; hoy: string }>(
        `SELECT current_date::text = (now() AT TIME ZONE $1)::date::text AS igual,
                current_date::text AS hoy`,
        [ZONA_DE_NEGOCIO],
      ),
    );
    expect(r.rows[0]!.igual, `CURRENT_DATE devolvió ${r.rows[0]!.hoy}`).toBe(true);
  });
});
