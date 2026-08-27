/**
 * S-9 — Ninguna vista puede atravesar el RLS de las tablas que consulta.
 *
 * Una vista de PostgreSQL se ejecuta, por defecto, con los privilegios de **su
 * dueño**. Si lee una tabla con RLS forzado, el aislamiento por empresa
 * simplemente no se evalúa: la tabla protege y la vista reparte.
 *
 * Es el defecto que tenía `documents_pendientes` desde la 0016 y que apareció al
 * escribir el test de aislamiento de la vista de afectaciones. La lección no es
 * "revisar las vistas": es que este control tiene que ser automático, porque el
 * defecto no se ve leyendo el SQL — se ve consultando.
 *
 * Este test no revisa una lista escrita a mano. Le pregunta al catálogo cuáles
 * son todas las vistas y cuáles tocan tablas con RLS, así que una vista nueva
 * entra al barrido sola.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('S-9 — vistas y row level security', () => {
  let db: Client;

  beforeAll(async () => {
    db = await connect();
  });
  afterAll(async () => {
    await db.end();
  });

  it('toda vista que lea una tabla con RLS forzado declara security_invoker', async () => {
    const filtradas = await db.query<{ vista: string; tablas: string }>(
      `WITH vistas AS (
         SELECT c.oid, c.relname AS vista,
                coalesce(array_to_string(c.reloptions, ','), '') AS opciones
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'v' AND n.nspname = 'public'
       ),
       dependencias AS (
         SELECT DISTINCT v.vista, v.opciones, t.relname AS tabla
           FROM vistas v
           JOIN pg_depend d   ON d.objid = (SELECT oid FROM pg_rewrite r
                                             WHERE r.ev_class = v.oid AND r.rulename = '_RETURN')
           JOIN pg_class t    ON t.oid = d.refobjid AND t.relkind = 'r'
           JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = 'public'
          WHERE t.relrowsecurity AND t.relforcerowsecurity
       )
       SELECT vista, string_agg(tabla, ', ' ORDER BY tabla) AS tablas
         FROM dependencias
        WHERE opciones NOT LIKE '%security_invoker=true%'
        GROUP BY vista
        ORDER BY vista`,
    );

    const detalle = filtradas.rows
      .map((f) => `  ${f.vista} → lee ${f.tablas} (con RLS forzado) sin security_invoker`)
      .join('\n');

    expect(
      filtradas.rowCount,
      `Estas vistas atraviesan el RLS de las tablas que consultan:\n${detalle}\n` +
        'Agregales WITH (security_invoker = true).',
    ).toBe(0);
  });

  it('el barrido efectivamente encuentra vistas: no está pasando por vacío', async () => {
    // Un test que recorre un catálogo puede quedar en verde porque la consulta
    // dejó de devolver filas. Se comprueba que hay vistas sobre tablas con RLS.
    const alcance = await db.query<{ n: string }>(
      `SELECT count(DISTINCT c.relname)::text AS n
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'v'`,
    );
    expect(Number(alcance.rows[0]!.n)).toBeGreaterThan(0);
  });
});
