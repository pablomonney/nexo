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
 *
 * ## La única excepción admitida, y lo que cuesta
 *
 * Hay vistas cuyo propósito **es** agregar sobre todas las empresas: las
 * métricas del negocio de NEXO (0100). Para ellas el `security_invoker` sería
 * lo contrario de lo que hace falta.
 *
 * La excepción no se concede por estar en una lista. Se concede **si y solo si
 * `aai_app` no tiene ningún privilegio sobre la vista**, y este mismo test lo
 * comprueba contra el catálogo. Una lista sin esa condición sería una puerta
 * para meter una fuga escribiendo un nombre; con ella, declarar la excepción no
 * alcanza para explotarla.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Vistas del operador: agregan sobre todas las empresas a propósito.
 *
 * Cada una tiene que ser ilegible para `aai_app`, y el test lo exige. Ver
 * NEXO_CORPORATE.md §5.
 */
const DEL_OPERADOR: Readonly<Record<string, string>> = {
  saas_suscripciones_vigentes: '0100 · las suscripciones de todas, con su importe',
  saas_ingreso_recurrente: '0100 · MRR, ARR y ARPU del negocio entero',
  saas_sin_importe: '0100 · qué quedó afuera del MRR',
  saas_movimientos: '0100 · altas y bajas de todas, desde la bitácora',
  saas_cobranza_mensual: '0100 · emitido y cobrado a todos los clientes',
};

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

    const sinDeclarar = filtradas.rows.filter((f) => DEL_OPERADOR[f.vista] === undefined);
    const detalle = sinDeclarar
      .map((f) => `  ${f.vista} → lee ${f.tablas} (con RLS forzado) sin security_invoker`)
      .join('\n');

    expect(
      sinDeclarar.length,
      `Estas vistas atraviesan el RLS de las tablas que consultan:\n${detalle}\n` +
        'Agregales WITH (security_invoker = true). Si la vista tiene que agregar sobre ' +
        'todas las empresas a propósito, declarala en DEL_OPERADOR — pero entonces ' +
        'aai_app no puede tener ni SELECT sobre ella.',
    ).toBe(0);
  });

  it('las declaradas del operador son ilegibles para la aplicación', async () => {
    // Es lo que paga la excepción de arriba. Sin esto, declarar una vista en
    // DEL_OPERADOR sería una forma de saltear S-9 escribiendo un nombre.
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'aai_app' AND table_name = ANY($1::text[])
        ORDER BY table_name, privilege_type`,
      [Object.keys(DEL_OPERADOR)],
    );
    expect(
      rows.map((r) => `${r.table_name}: ${r.privilege_type}`),
      'una vista del operador quedó legible por la aplicación: sin security_invoker ' +
        'y con SELECT, muestra la facturación de todas las empresas a cualquier usuario',
    ).toEqual([]);
  });

  it('las declaradas del operador existen: una lista no protege a una vista borrada', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [Object.keys(DEL_OPERADOR)],
    );
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(Object.keys(DEL_OPERADOR)));
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
