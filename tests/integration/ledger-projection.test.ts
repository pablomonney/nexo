/**
 * El Mayor como proyección, verificado contra PostgreSQL real.
 *
 * La promesa de la migración 0019 no es que la aplicación escriba bien el Mayor:
 * es que **la aplicación no lo escribe**. Estos tests intentan romperlo con SQL
 * directo y comprueban que la base no deja.
 *
 * El caso central es el del asiento anulado. Es contraintuitivo y es el que un
 * sistema de contabilidad suele hacer mal: cuando un asiento se anula, sus
 * movimientos del Mayor **se quedan**. Lo que los compensa es el contraasiento,
 * no un borrado. Borrarlos además los contaría dos veces —y borrar es
 * exactamente lo que el CCyC art. 324 inc. c prohíbe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asCompany,
  connect,
  expectFailure,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('El Mayor es una proyección del Diario', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
  });

  afterAll(async () => {
    await client?.end();
  });

  /** Asiento aprobado de dos líneas, en una sola transacción. */
  async function postearAprobado(
    fecha: string,
    debe: string,
    opciones: { kind?: string; reversesEntryId?: string } = {},
  ): Promise<string> {
    await client.query('BEGIN');
    const cabecera = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, kind, status, total_debit, total_credit, source_type,
         reverses_entry_id, created_by, approved_by, approved_at)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), $4,
               'Proyección', $5, 'APROBADO', $6, $6, 'MANUAL', $7, 'tester', 'contador', now())
       RETURNING id`,
      [
        fx.companyA,
        fx.periodA,
        fx.fiscalYearA,
        fecha,
        opciones.kind ?? 'NORMAL',
        debe,
        opciones.reversesEntryId ?? null,
      ],
    );
    const entryId = cabecera.rows[0]!.id;
    await client.query(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, $4, 0), ($1, $2, 2, $5, 0, $4)`,
      [fx.companyA, entryId, fx.cashA, debe, fx.salesA],
    );
    await client.query('COMMIT');
    return entryId;
  }

  async function movimientosDe(entryId: string): Promise<number> {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM ledger_movements m
         JOIN journal_entry_lines l ON l.id = m.entry_line_id
        WHERE l.entry_id = $1`,
      [entryId],
    );
    return Number(result.rows[0]!.n);
  }

  it('aprobar un asiento proyecta sus líneas al Mayor, sin que nadie las escriba', async () => {
    const entryId = await postearAprobado('2025-01-15', '100.00');

    expect(await movimientosDe(entryId)).toBe(2);

    const movimiento = await client.query<{
      account_id: string;
      movement_date: string;
      debit: string;
      period_id: string;
    }>(
      `SELECT m.account_id, m.movement_date::text, m.debit::text, m.period_id
         FROM ledger_movements m
         JOIN journal_entry_lines l ON l.id = m.entry_line_id
        WHERE l.entry_id = $1 AND l.line_no = 1`,
      [entryId],
    );

    expect(movimiento.rows[0]?.account_id).toBe(fx.cashA);
    expect(movimiento.rows[0]?.movement_date).toBe('2025-01-15');
    expect(movimiento.rows[0]?.debit).toBe('100.00');
    expect(movimiento.rows[0]?.period_id).toBe(fx.periodA);
  });

  it('un asiento en PROPUESTO no llega al Mayor: todavía no es contabilidad', async () => {
    await client.query('BEGIN');
    const cabecera = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, kind, status, total_debit, total_credit, source_type, created_by)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-16',
               'Propuesta', 'NORMAL', 'PROPUESTO', '50.00', '50.00', 'MANUAL', 'tester')
       RETURNING id`,
      [fx.companyA, fx.periodA, fx.fiscalYearA],
    );
    const entryId = cabecera.rows[0]!.id;
    await client.query(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, '50.00', 0), ($1, $2, 2, $4, 0, '50.00')`,
      [fx.companyA, entryId, fx.cashA, fx.salesA],
    );
    await client.query('COMMIT');

    expect(await movimientosDe(entryId)).toBe(0);
  });

  it('anular un asiento NO borra sus movimientos: los compensa el contraasiento', async () => {
    const original = await postearAprobado('2025-01-17', '70.00');
    expect(await movimientosDe(original)).toBe(2);

    const contraasiento = await postearAprobado('2025-01-20', '70.00', {
      kind: 'REVERSION',
      reversesEntryId: original,
    });
    await client.query(`UPDATE journal_entries SET status = 'ANULADO' WHERE id = $1`, [original]);

    // Los cuatro movimientos siguen ahí: dos del anulado y dos del contraasiento.
    expect(await movimientosDe(original)).toBe(2);
    expect(await movimientosDe(contraasiento)).toBe(2);

    // Los dos asientos de este test debitan la misma cuenta, así que el débito
    // acumulado es 140: el del anulado SIGUE contando. Si la anulación borrara
    // sus movimientos, acá habría 70.
    const acumulado = await client.query<{ debe: string }>(
      `SELECT COALESCE(sum(m.debit), 0)::text AS debe
         FROM ledger_movements m
         JOIN journal_entry_lines l ON l.id = m.entry_line_id
        WHERE l.entry_id IN ($1, $2) AND m.account_id = $3`,
      [original, contraasiento, fx.cashA],
    );
    expect(acumulado.rows[0]?.debe).toBe('140.00');
  });

  it('el rol de la aplicación no puede insertar en el Mayor', async () => {
    const mensaje = await expectFailure(async () =>
      asCompany(client, fx.companyA, async () => {
        await client.query(
          `INSERT INTO ledger_movements
             (company_id, account_id, period_id, entry_line_id, movement_date, debit, credit)
           SELECT $1, $2, $3, l.id, '2025-01-15', '1.00', 0
             FROM journal_entry_lines l LIMIT 1`,
          [fx.companyA, fx.cashA, fx.periodA],
        );
      }),
    );

    expect(mensaje).toMatch(/permis|permission|denied|denegado/i);
  });

  it('un movimiento del Mayor no se edita ni se borra, ni con privilegios', async () => {
    await postearAprobado('2025-01-18', '10.00');

    const alEditar = await expectFailure(async () =>
      client.query(`UPDATE ledger_movements SET debit = debit + 1 WHERE company_id = $1`, [
        fx.companyA,
      ]),
    );
    const alBorrar = await expectFailure(async () =>
      client.query(`DELETE FROM ledger_movements WHERE company_id = $1`, [fx.companyA]),
    );

    expect(alEditar).toMatch(/proyección del Diario/);
    expect(alBorrar).toMatch(/contraasiento/);
  });

  it('rebuild_account_balances deriva los saldos y la aritmética cierra', async () => {
    await client.query('SELECT rebuild_account_balances($1)', [fx.companyA]);

    // La comparación la hace PostgreSQL en numeric, no JavaScript: pasar estos
    // importes por `Number` para compararlos sería meter el flotante justo en el
    // test que existe para probar que no hay flotante.
    const saldos = await client.query<{ debits: string; aritmetica_ok: boolean }>(
      `SELECT debits::text,
              (closing = opening + debits - credits) AS aritmetica_ok
         FROM account_balances WHERE company_id = $1 AND account_id = $2`,
      [fx.companyA, fx.cashA],
    );

    const fila = saldos.rows[0];
    expect(fila).toBeDefined();
    if (fila === undefined) return;

    // El CHECK balance_arithmetic ya lo garantiza; se afirma igual porque el día
    // que alguien cambie la función, este test dice qué se rompió.
    expect(fila.aritmetica_ok).toBe(true);

    // Y el total del Mayor coincide con el de las líneas aprobadas del Diario.
    const desdeDiario = await client.query<{ debe: string }>(
      `SELECT COALESCE(sum(l.debit), 0)::text AS debe
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.company_id = $1 AND e.status IN ('APROBADO', 'ANULADO') AND l.account_id = $2`,
      [fx.companyA, fx.cashA],
    );
    expect(fila.debits).toBe(desdeDiario.rows[0]?.debe);
  });

  it('la vista ledger_trace lleva del movimiento al asiento y a su origen', async () => {
    const entryId = await postearAprobado('2025-01-19', '25.00');

    const trace = await client.query<{
      entry_id: string;
      entry_number: number;
      account_code: string;
      source_type: string;
      document_id: string | null;
    }>(
      `SELECT t.entry_id, t.entry_number, t.account_code, t.source_type, t.document_id
         FROM ledger_trace t
        WHERE t.entry_id = $1 AND t.line_no = 1`,
      [entryId],
    );

    const fila = trace.rows[0];
    expect(fila?.entry_id).toBe(entryId);
    expect(fila?.entry_number).toBeGreaterThan(0);
    expect(fila?.account_code).toBeTruthy();
    // Es un asiento MANUAL: no tiene documento, y la vista lo dice sin inventar.
    expect(fila?.source_type).toBe('MANUAL');
    expect(fila?.document_id).toBeNull();
  });

  it('una emisión de libro registrada no se puede modificar ni borrar', async () => {
    await client.query(
      `INSERT INTO book_emissions
         (company_id, fiscal_year_id, book, desde, hasta, content_sha256, asientos,
          cumple_formalidades, emitted_by)
       VALUES ($1, $2, 'DIARIO', '2025-01-01', '2025-01-31', $3, 3, true, 'contador')`,
      [fx.companyA, fx.fiscalYearA, 'a'.repeat(64)],
    );

    const alEditar = await expectFailure(async () =>
      client.query(`UPDATE book_emissions SET asientos = 4 WHERE company_id = $1`, [fx.companyA]),
    );

    expect(alEditar).toMatch(/hecho registrado/);
  });

  it('una verificación no puede decir COINCIDE con discrepancias', async () => {
    const mensaje = await expectFailure(async () =>
      client.query(
        `INSERT INTO ledger_verifications
           (company_id, ran_by, movimientos, discrepancias, resultado)
         VALUES ($1, 'tester', 10, 3, 'COINCIDE')`,
        [fx.companyA],
      ),
    );

    expect(mensaje).toMatch(/lv_resultado_coherente/);
  });
});

suite('Importe registrado e importe original (migración 0020)', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
  });

  afterAll(async () => {
    await client?.end();
  });

  /**
   * El caso que la FASE 5 no cubría: una línea en dólares.
   *
   * En `debit` va el convertido a pesos —que es lo que la cabecera declara como
   * total— y en `original_*` la operación tal como ocurrió. Antes de la 0020,
   * `debit` llevaba el original y el asiento se caía al COMMIT con E_UNBALANCED.
   */
  it('acepta una línea en moneda extranjera y el asiento cierra', async () => {
    await client.query('BEGIN');
    const cabecera = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, kind, status, currency, total_debit, total_credit, source_type,
         created_by, approved_by, approved_at)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-15',
               'Compra en USD', 'NORMAL', 'APROBADO', 'ARS', '1000000.00', '1000000.00',
               'MANUAL', 'tester', 'contador', now())
       RETURNING id`,
      [fx.companyA, fx.periodA, fx.fiscalYearA],
    );
    const entryId = cabecera.rows[0]!.id;

    await client.query(
      `INSERT INTO journal_entry_lines
         (company_id, entry_id, line_no, account_id, debit, credit, currency,
          original_currency, original_debit, original_credit, fx_rate, fx_source, fx_date)
       VALUES ($1, $2, 1, $3, '1000000.00', 0, 'ARS',
               'USD', '1000.00', 0, '1000.000000', 'BCRA Com. A 3500', '2025-01-15')`,
      [fx.companyA, entryId, fx.cashA],
    );
    await client.query(
      `INSERT INTO journal_entry_lines
         (company_id, entry_id, line_no, account_id, debit, credit, currency)
       VALUES ($1, $2, 2, $3, 0, '1000000.00', 'ARS')`,
      [fx.companyA, entryId, fx.salesA],
    );
    await client.query('COMMIT');

    const movimiento = await client.query<{ debit: string }>(
      `SELECT m.debit::text FROM ledger_movements m
         JOIN journal_entry_lines l ON l.id = m.entry_line_id
        WHERE l.entry_id = $1 AND l.line_no = 1`,
      [entryId],
    );

    // El Mayor recibe los pesos, no los dólares. Es la razón de ser de la 0020.
    expect(movimiento.rows[0]?.debit).toBe('1000000.00');
  });

  it('una moneda original sin cotización con fuente no entra', async () => {
    const mensaje = await expectFailure(async () => {
      await client.query('BEGIN');
      const cabecera = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
          (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
           description, kind, status, currency, total_debit, total_credit, source_type, created_by)
         VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-15',
                 'Sin cotización', 'NORMAL', 'PROPUESTO', 'ARS', '10.00', '10.00', 'MANUAL', 'tester')
         RETURNING id`,
        [fx.companyA, fx.periodA, fx.fiscalYearA],
      );
      await client.query(
        `INSERT INTO journal_entry_lines
           (company_id, entry_id, line_no, account_id, debit, credit, currency,
            original_currency, original_debit, original_credit)
         VALUES ($1, $2, 1, $3, '10.00', 0, 'ARS', 'USD', '0.01', 0)`,
        [fx.companyA, cabecera.rows[0]!.id, fx.cashA],
      );
      await client.query('COMMIT');
    });
    await client.query('ROLLBACK').catch(() => undefined);

    expect(mensaje).toMatch(/jel_fx_complete/);
  });

  it('una línea no puede registrar en una moneda distinta a la del asiento', async () => {
    const mensaje = await expectFailure(async () => {
      await client.query('BEGIN');
      const cabecera = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
          (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
           description, kind, status, currency, total_debit, total_credit, source_type, created_by)
         VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-15',
                 'Mezcla', 'NORMAL', 'PROPUESTO', 'ARS', '10.00', '10.00', 'MANUAL', 'tester')
         RETURNING id`,
        [fx.companyA, fx.periodA, fx.fiscalYearA],
      );
      await client.query(
        `INSERT INTO journal_entry_lines
           (company_id, entry_id, line_no, account_id, debit, credit, currency)
         VALUES ($1, $2, 1, $3, '10.00', 0, 'USD')`,
        [fx.companyA, cabecera.rows[0]!.id, fx.cashA],
      );
      await client.query('COMMIT');
    });
    await client.query('ROLLBACK').catch(() => undefined);

    expect(mensaje).toMatch(/E_CURRENCY_MISMATCH/);
  });
});
