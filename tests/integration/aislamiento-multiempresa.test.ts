/**
 * Aislamiento entre empresas, barrido completo.
 *
 * Hasta ahora el aislamiento se probaba **de a pedazos**: cada fase agregaba un
 * "la empresa B no ve esto" al final de su propia suite. Once tests sueltos,
 * cada uno correcto, y ninguno capaz de responder la pregunta que importa: ¿hay
 * alguna tabla con `company_id` que se haya quedado sin política?
 *
 * La diferencia no es de cantidad. Un test por rasgo comprueba las tablas que
 * ese rasgo tocó; el catálogo de PostgreSQL comprueba **todas**, incluidas las
 * que se agreguen mañana. Por eso la primera sección no enumera tablas: las
 * descubre, y falla sobre las que encuentre sin RLS forzado.
 *
 * ## Dos empresas y dos personas
 *
 * `x-company-id` no es una preferencia: es la afirmación de en nombre de quién
 * se pide. Que A no pueda leer a B con su propio token es la mitad del asunto;
 * la otra mitad es que tampoco pueda leerla **pidiéndolo explícitamente**, y esa
 * solo se prueba si el usuario de A no tiene ningún rol en B.
 *
 * No hay atajos para el test: el mismo login, el mismo MFA, el mismo
 * `withCompany`, la misma conexión con `SET LOCAL ROLE aai_app` que usa
 * producción. Un aislamiento que solo se sostiene cuando el que consulta se
 * porta bien no es aislamiento.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, expectFailureCode, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

/**
 * Las tablas cuyo aislamiento se comprueba fila por fila.
 *
 * Es la lista del enunciado de la fase, más las que cuelgan de ellas. No
 * reemplaza al barrido del catálogo: aquel prueba que la política EXISTE; este,
 * que además FUNCIONA sobre filas reales de las dos empresas.
 */
const TABLAS_CON_DATOS = [
  'accounts',
  'fiscal_years',
  'periods',
  'journal_entries',
  'journal_entry_lines',
  'ledger_movements',
  'financial_statements',
  'financial_statement_lines',
  'notes',
  'note_figures',
  'audit_logs',
] as const;

/** Vistas que atraviesan varias tablas: el lugar natural para una fuga. */
const VISTAS = ['ledger_trace', 'trial_balance', 'note_trace', 'statement_trace'] as const;

interface Montaje {
  companyId: string;
  fiscalYearId: string;
  statementId: string;
  entryId: string;
  accountId: string;
  noteId: string;
}

suite('Aislamiento multiempresa', () => {
  let app: FastifyInstance;
  let db: Client;
  let tokenA: string;
  let tokenB: string;
  let A: Montaje;
  let B: Montaje;

  const pedir = (
    token: string,
    empresa: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  /** Login + MFA completo. El mismo camino que hace una persona. */
  async function ingresar(email: string): Promise<string> {
    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
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
    const token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
    return token;
  }

  async function crearUsuario(email: string): Promise<string> {
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const r = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Persona', hash],
    );
    return r.rows[0]!.id;
  }

  /** Una empresa con plan, ejercicio, un asiento aprobado, un ESP emitido y sus notas. */
  async function montar(
    token: string,
    userId: string,
    organizationId: string,
    nombre: string,
    prefijo: string,
    stamp: string,
    importe: string,
  ): Promise<Montaje> {
    const c = await db.query<{ create_company: string }>(
      'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, organizationId, nombre, withCheckDigit(`${prefijo}${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31'],
    );
    const companyId = c.rows[0]!.create_company;
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, companyId, userId, rol]);
    }

    const marco = await pedir(token, companyId, 'POST', '/companies/current/reporting-framework', {
      framework: 'RT_FACPCE',
      validFrom: '2026-01-01',
    });
    expect(marco.statusCode, marco.body).toBe(200);

    let accountId = '';
    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '3.1.01', name: 'Capital suscripto', type: 'PN' },
      { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      const r = await pedir(token, companyId, 'POST', '/accounts', cuenta);
      expect(r.statusCode, r.body).toBe(201);
      if (cuenta.code === '1.1.01') accountId = r.json<{ id: string }>().id;
      if (cuenta.code === '3.4.01') {
        await pedir(token, companyId, 'PATCH', `/accounts/${r.json<{ id: string }>().id}`, {
          closingRole: 'RESULTADO_DEL_EJERCICIO',
          motivo: 'Designación de la cuenta de resultado del ejercicio',
        });
      }
    }

    const ej = await pedir(token, companyId, 'POST', '/fiscal-years', {
      code: `EJ2026-${prefijo}-${stamp}`,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(ej.statusCode, ej.body).toBe(201);
    const fiscalYearId = ej.json<{ id: string }>().id;

    const alta = await pedir(token, companyId, 'POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: '2026-03-10',
      description: 'Venta de contado',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: importe },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Venta registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const entryId = alta.json<{ id: string }>().id;
    expect((await pedir(token, companyId, 'POST', `/journal-entries/${entryId}/approve`)).statusCode).toBe(200);

    const emision = await pedir(token, companyId, 'POST', '/statements/issue', {
      ejercicio: fiscalYearId,
      tipo: 'ESP',
    });
    expect(emision.statusCode, emision.body).toBe(201);
    const statementId = emision.json<{ estadoId: string }>().estadoId;

    // El rubro a desagregar sale del estado emitido, no de una constante: qué
    // renglones tiene depende de la plantilla vigente, y una nota sin cifras
    // dejaría `note_figures` vacío, que es justamente la tabla que hay que
    // probar.
    const conSaldo = await db.query<{ line_code: string }>(
      `SELECT line_code FROM financial_statement_lines
        WHERE statement_id = $1 AND line_type = 'RENGLON' AND amount <> 0
        ORDER BY line_code LIMIT 1`,
      [statementId],
    );
    expect(conSaldo.rowCount, 'el estado emitido no trajo ni un renglón con saldo').toBeGreaterThan(0);

    const notas = await pedir(token, companyId, 'POST', `/statements/${statementId}/notes/generate`, {
      rubros: [conSaldo.rows[0]!.line_code],
    });
    expect(notas.statusCode, notas.body).toBe(201);

    const cual = await db.query<{ id: string }>(
      'SELECT id FROM notes WHERE company_id = $1 ORDER BY numero LIMIT 1',
      [companyId],
    );

    return {
      companyId,
      fiscalYearId,
      statementId,
      entryId,
      accountId,
      noteId: cual.rows[0]!.id,
    };
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const userA = await crearUsuario(`persona-a-${stamp}@estudio.test`);
    const userB = await crearUsuario(`persona-b-${stamp}@estudio.test`);

    // Dos organizaciones distintas. Que el aislamiento aguante DENTRO de un
    // mismo estudio ya está probado en otras suites; acá interesa el caso donde
    // no hay ninguna relación entre las partes.
    const orgA = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio A ${stamp}`,
        withCheckDigit(`30${stamp}`),
        userA,
      ])
    ).rows[0]!.create_organization;
    const orgB = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio B ${stamp}`,
        withCheckDigit(`33${stamp}`),
        userB,
      ])
    ).rows[0]!.create_organization;

    tokenA = await ingresar(`persona-a-${stamp}@estudio.test`);
    tokenB = await ingresar(`persona-b-${stamp}@estudio.test`);

    A = await montar(tokenA, userA, orgA, 'Aislada A', '33', stamp, '500000.00');
    B = await montar(tokenB, userB, orgB, 'Aislada B', '27', stamp, '777777.00');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · El barrido: ninguna tabla con company_id sin RLS forzado
  // -------------------------------------------------------------------------

  describe('1 · el catálogo, no la lista', () => {
    it('toda tabla con company_id tiene RLS FORZADO y su política', async () => {
      // `ENABLE` sin `FORCE` deja que el dueño de la tabla la lea entera, y el
      // dueño es quien corre las migraciones. Es la diferencia entre "hay una
      // política" y "la política se aplica a todos".
      const sinCandado = await db.query<{ relname: string; rowsecurity: boolean; forzado: boolean; politicas: number }>(
        `SELECT c.relname,
                c.relrowsecurity AS rowsecurity,
                c.relforcerowsecurity AS forzado,
                (SELECT count(*)::int FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS politicas
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND EXISTS (
              SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public'
                 AND col.table_name = c.relname
                 AND col.column_name = 'company_id')
            AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
          ORDER BY c.relname`,
      );

      expect(
        sinCandado.rows.map((f) => f.relname),
        'tablas con company_id sin RLS forzado',
      ).toEqual([]);
    });

    it('ninguna política de empresa deja pasar filas de otra', async () => {
      // Una política escrita `USING (true)` o comparando contra una constante
      // existe, cuenta en el inventario y no aísla nada. Se exige que el
      // predicado nombre `app_company_id()`.
      const flojas = await db.query<{ tablename: string; qual: string | null }>(
        `SELECT tablename, qual
           FROM pg_policies
          WHERE schemaname = 'public'
            AND EXISTS (
              SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public'
                 AND col.table_name = pg_policies.tablename
                 AND col.column_name = 'company_id')
            AND (qual IS NULL OR qual NOT LIKE '%app_company_id()%')`,
      );

      expect(flojas.rows, 'políticas que no comparan contra app_company_id()').toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2 · Lectura cruzada: 1 y 2 del enunciado
  // -------------------------------------------------------------------------

  describe('2 · A no lee a B, y B no lee a A', () => {
    it.each(TABLAS_CON_DATOS)('%s: cada empresa ve las suyas y solo las suyas', async (tabla) => {
      const deA = await asCompany(db, A.companyId, async () =>
        (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabla} WHERE company_id = $1`, [B.companyId]))
          .rows[0]!.n,
      );
      const deB = await asCompany(db, B.companyId, async () =>
        (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabla} WHERE company_id = $1`, [A.companyId]))
          .rows[0]!.n,
      );

      expect(deA, `${tabla}: A vio filas de B`).toBe('0');
      expect(deB, `${tabla}: B vio filas de A`).toBe('0');
    });

    it.each(TABLAS_CON_DATOS)('%s: y las propias sí se ven — el filtro no es "no ve nada"', async (tabla) => {
      // Sin esta comprobación el test anterior pasaría con una base vacía, que
      // es el mismo falso verde que el gate de invariantes documenta.
      const propias = await asCompany(db, A.companyId, async () =>
        Number(
          (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabla}`)).rows[0]!.n,
        ),
      );
      expect(propias, `${tabla}: A no vio ni sus propias filas`).toBeGreaterThan(0);
    });

    it.each(VISTAS)('%s: la vista no atraviesa el RLS de las tablas de abajo', async (vista) => {
      // La 0032 arregló nueve vistas que corrían con los permisos de quien las
      // creó. Una vista sin `security_invoker` es un `SELECT` con el RLS de
      // otro, y por eso es el lugar exacto donde vuelve a aparecer una fuga.
      const filas = await asCompany(db, A.companyId, async () =>
        (await db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${vista}`)).rows,
      );
      expect(filas.every((f) => f.company_id === A.companyId), `${vista} devolvió filas ajenas`).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3 · Por HTTP: el scoping de producción
  // -------------------------------------------------------------------------

  describe('3 · el mismo mecanismo que producción', () => {
    it('el token de A pidiendo explícitamente la empresa B es rechazado', async () => {
      // Es la mitad que un test "A ve lo suyo" nunca cubre: no alcanza con que
      // el listado esté filtrado, tiene que fallar el pedido directo.
      const r = await pedir(tokenA, B.companyId, 'GET', '/accounts');
      expect(r.statusCode).toBe(403);
    });

    /**
     * Estos dos reemplazan a un par de tests que **no probaban nada**.
     *
     * Afirmaban 404 sobre `GET /journal-entries/:id` y `GET /statements/:id`,
     * que **no existen**: el 404 lo devolvía Fastify por ruta desconocida, sin
     * llegar nunca al handler. Habrían pasado igual con el aislamiento roto —
     * es el mismo defecto que el gate de invariantes existe para no repetir,
     * cometido dentro de un test de aislamiento.
     *
     * Los reemplazos usan rutas que sí existen y que sí llegan al handler: el
     * listado filtrado y el detalle de un renglón por id. No se fabricó ningún
     * endpoint para hacerlos verdes; el gap de las rutas de detalle queda
     * documentado aparte.
     */
    it('el listado de asientos de A no contiene ninguno de B', async () => {
      const deA = await pedir(tokenA, A.companyId, 'GET', '/journal-entries');
      expect(deA.statusCode, deA.body).toBe(200);
      const ids = deA.json<{ asientos: { id: string }[] }>().asientos.map((e) => e.id);

      // Las dos mitades: A ve lo suyo, y entre lo suyo no está lo de B.
      expect(ids).toContain(A.entryId);
      expect(ids).not.toContain(B.entryId);
    });

    it('y el de B tampoco contiene ninguno de A', async () => {
      const deB = await pedir(tokenB, B.companyId, 'GET', '/journal-entries');
      expect(deB.statusCode, deB.body).toBe(200);
      const ids = deB.json<{ asientos: { id: string }[] }>().asientos.map((e) => e.id);

      expect(ids).toContain(B.entryId);
      expect(ids).not.toContain(A.entryId);
    });

    it('A no puede trazar un renglón del estado contable de B', async () => {
      // `/statements/trace/:lineId` sí existe y llega al handler: el 404 de acá
      // lo produce el RLS, que es lo que se quiere probar.
      const renglonDeB = await db.query<{ id: string }>(
        `SELECT id FROM financial_statement_lines
          WHERE statement_id = $1 AND line_type = 'RENGLON' LIMIT 1`,
        [B.statementId],
      );
      const ajeno = await pedir(
        tokenA,
        A.companyId,
        'GET',
        `/statements/trace/${renglonDeB.rows[0]!.id}`,
      );
      expect(ajeno.statusCode).toBe(404);

      // Y la mitad que falta: el propio sí se traza. Sin esto, la ruta podría
      // estar devolviendo 404 para todo el mundo y el test no lo notaría.
      const renglonDeA = await db.query<{ id: string }>(
        `SELECT id FROM financial_statement_lines
          WHERE statement_id = $1 AND line_type = 'RENGLON' LIMIT 1`,
        [A.statementId],
      );
      const propio = await pedir(
        tokenA,
        A.companyId,
        'GET',
        `/statements/trace/${renglonDeA.rows[0]!.id}`,
      );
      expect(propio.statusCode, propio.body).toBe(200);
    });

    it('A no puede leer el paquete de notas de B', async () => {
      const r = await pedir(tokenA, A.companyId, 'GET', `/statements/${B.statementId}/package`);
      expect(r.statusCode).toBe(404);
    });

    it('A no puede aprobar una nota de B', async () => {
      const r = await pedir(tokenA, A.companyId, 'POST', `/notes/${B.noteId}/approve`);
      expect([403, 404]).toContain(r.statusCode);
    });

    it('A no puede cerrar un ejercicio de B', async () => {
      const r = await pedir(tokenA, A.companyId, 'POST', `/fiscal-years/${B.fiscalYearId}/pre-close`);
      expect([400, 403, 404]).toContain(r.statusCode);
    });
  });

  // -------------------------------------------------------------------------
  // 4 · Escritura cruzada: 3 a 7 y 9 del enunciado
  // -------------------------------------------------------------------------

  describe('4 · una referencia ajena no entra', () => {
    it('A no puede imputar a una cuenta de B', async () => {
      // Por HTTP el asiento se arma por código de cuenta, así que el intento
      // directo es el que vale: insertar la línea apuntando al id ajeno.
      const { code } = await expectFailureCode(() =>
        asCompany(db, A.companyId, async () => {
          const e = await db.query<{ id: string }>(
            `INSERT INTO journal_entries
               (company_id, journal_id, fiscal_year_id, period_id, entry_number, entry_date,
                description, currency, total_debit, total_credit, kind, source_type,
                manual_justification, created_by)
             SELECT $1, j.id, p.fiscal_year_id, p.id, 999001, '2026-03-11',
                    'Intento de imputar a una cuenta ajena', 'ARS', 100, 100, 'MANUAL', 'MANUAL',
                    'prueba de aislamiento', 'test'
               FROM journals j, periods p
              WHERE j.company_id = $1 AND p.company_id = $1 AND p.number = 3
              LIMIT 1
             RETURNING id`,
            [A.companyId],
          );
          await db.query(
            `INSERT INTO journal_entry_lines (company_id, entry_id, line_number, account_id, debit, credit)
             VALUES ($1, $2, 1, $3, 100, 0)`,
            [A.companyId, e.rows[0]!.id, B.accountId],
          );
        }),
      );
      // La cuenta ajena es invisible bajo el RLS de A, así que el guard de
      // cuenta imputable no la encuentra: falla, que es lo que importa.
      expect(code).not.toBe('');
    });

    it('A no puede insertar una fila declarándola de B', async () => {
      const { code } = await expectFailureCode(() =>
        asCompany(db, A.companyId, () =>
          db.query(
            `INSERT INTO accounts (company_id, account_chart_id, code, name, type, is_postable)
             SELECT $1, ac.id, '9.9.99', 'Cuenta plantada', 'ACTIVO', true
               FROM account_charts ac WHERE ac.company_id = $2 LIMIT 1`,
            [B.companyId, A.companyId],
          ),
        ),
      );
      expect(code).not.toBe('');
    });

    it('una decisión de A no puede fundar un asiento de B', async () => {
      // `journal_entries_decision_coherente` (0034) lo impone en la base: la
      // decisión tiene que ser de la misma empresa que el asiento.
      const decisionDeA = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, origen, resultado, motivos, hechos, evidencia, ambiente, decidida_por, justificacion)
         VALUES ($1, 'MANUAL', 'PROPUESTA_DE_ASIENTO', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 'PRODUCTIVO', 'test',
                 'Decisión de la empresa A, para probar que no cruza a la B')
         RETURNING id`,
        [A.companyId],
      );

      const { message } = await expectFailureCode(() =>
        db.query('UPDATE journal_entries SET decision_id = $1 WHERE id = $2', [
          decisionDeA.rows[0]!.id,
          B.entryId,
        ]),
      );
      expect(message).toMatch(/otra empresa|no se edita|aprobado/i);
    });

    it('una cifra de nota de A no puede apuntar a un renglón de B', async () => {
      const renglonDeB = await db.query<{ id: string }>(
        `SELECT id FROM financial_statement_lines WHERE statement_id = $1 AND line_type = 'RENGLON' LIMIT 1`,
        [B.statementId],
      );

      const { code } = await expectFailureCode(() =>
        asCompany(db, A.companyId, () =>
          db.query(
            `INSERT INTO note_figures (company_id, note_id, statement_line_id, etiqueta, importe)
             VALUES ($1, $2, $3, 'Cifra robada', 1)`,
            [A.companyId, A.noteId, renglonDeB.rows[0]!.id],
          ),
        ),
      );
      expect(code).not.toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 5 · La fuga por JOIN: 10 del enunciado
  // -------------------------------------------------------------------------

  describe('5 · un JOIN no es una puerta de atrás', () => {
    it('recorrer asiento → línea → cuenta desde A nunca alcanza una fila de B', async () => {
      // El caso que un test por tabla no cubre: cada tabla filtrada, y aun así
      // una fuga si alguna arista del recorrido perdiera el filtro.
      const filas = await asCompany(db, A.companyId, async () =>
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n
               FROM journal_entries e
               JOIN journal_entry_lines l ON l.entry_id = e.id
               JOIN accounts a ON a.id = l.account_id
               JOIN ledger_movements m ON m.entry_line_id = l.id
              WHERE e.company_id <> $1 OR l.company_id <> $1
                 OR a.company_id <> $1 OR m.company_id <> $1`,
            [A.companyId],
          )
        ).rows[0]!.n,
      );
      expect(filas).toBe('0');
    });

    it('y el mismo recorrido sí devuelve las filas propias', async () => {
      const filas = await asCompany(db, A.companyId, async () =>
        Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*)::text AS n
                 FROM journal_entries e
                 JOIN journal_entry_lines l ON l.entry_id = e.id
                 JOIN accounts a ON a.id = l.account_id
                 JOIN ledger_movements m ON m.entry_line_id = l.id`,
            )
          ).rows[0]!.n,
        ),
      );
      expect(filas).toBeGreaterThan(0);
    });

    it('estado → renglón → nota → cifra tampoco cruza', async () => {
      const filas = await asCompany(db, A.companyId, async () =>
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n
               FROM financial_statements s
               JOIN financial_statement_lines fl ON fl.statement_id = s.id
               LEFT JOIN note_figures nf ON nf.statement_line_id = fl.id
               LEFT JOIN notes n ON n.id = nf.note_id
              WHERE s.company_id <> $1
                 OR fl.company_id <> $1
                 OR (nf.id IS NOT NULL AND nf.company_id <> $1)
                 OR (n.id IS NOT NULL AND n.company_id <> $1)`,
            [A.companyId],
          )
        ).rows[0]!.n,
      );
      expect(filas).toBe('0');
    });

    it('la bitácora de A no contiene ni una entrada de B', async () => {
      // `audit_logs` es el caso más sensible: es donde queda escrito quién hizo
      // qué, y una fuga acá expone la operación entera de la otra empresa.
      const ajenas = await asCompany(db, A.companyId, async () =>
        (
          await db.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM audit_logs WHERE company_id <> $1',
            [A.companyId],
          )
        ).rows[0]!.n,
      );
      expect(ajenas).toBe('0');
    });
  });
});
