/**
 * Los candados del Libro Diario, verificados contra PostgreSQL real.
 *
 * Estos tests no comprueban que la aplicación se porte bien: comprueban que la
 * base IMPIDE portarse mal. Cada caso intenta hacer, con SQL directo, algo que
 * el pliego prohíbe — y verifica que la base lo rechaza.
 *
 * Corresponden a las validaciones de ACCOUNTING_ENGINE.md §2 y al §38 del pliego.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Candados del Libro Diario', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
  });

  afterAll(async () => {
    await client?.end();
  });

  /** Inserta una cabecera de asiento y devuelve su id. */
  async function insertEntry(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const values = {
      status: 'PROPUESTO',
      kind: 'NORMAL',
      entry_date: '2025-01-15',
      total_debit: '100.00',
      total_credit: '100.00',
      ...overrides,
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, kind, status, total_debit, total_credit, source_type, created_by)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), $4,
               'Test', $5, $6, $7, $8, 'MANUAL', 'tester')
       RETURNING id`,
      [
        fx.companyA,
        fx.periodA,
        fx.fiscalYearA,
        values.entry_date,
        values.kind,
        values.status,
        values.total_debit,
        values.total_credit,
      ],
    );
    return result.rows[0]!.id;
  }

  async function insertLine(
    entryId: string,
    accountId: string,
    lineNo: number,
    debit: string,
    credit: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO journal_entry_lines
        (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fx.companyA, entryId, lineNo, accountId, debit, credit],
    );
  }

  it('acepta un asiento balanceado de dos líneas', async () => {
    await client.query('BEGIN');
    const entryId = await insertEntry();
    await insertLine(entryId, fx.cashA, 1, '100.00', '0');
    await insertLine(entryId, fx.salesA, 2, '0', '100.00');
    await client.query('COMMIT');

    const check = await client.query<{ total_debit: string }>(
      'SELECT total_debit FROM journal_entries WHERE id = $1',
      [entryId],
    );
    expect(check.rows[0]?.total_debit).toBe('100.00');
  });

  it('CANDADO 1 — rechaza al COMMIT un asiento con Debe ≠ Haber', async () => {
    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      const entryId = await insertEntry({ total_debit: '100.00', total_credit: '90.00' });
      await insertLine(entryId, fx.cashA, 1, '100.00', '0');
      await insertLine(entryId, fx.salesA, 2, '0', '90.00');
      await client.query('COMMIT');
    });
    expect(message).toMatch(/je_balanced|E_UNBALANCED/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 2 — rechaza una línea con débito y crédito a la vez', async () => {
    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      const entryId = await insertEntry();
      await insertLine(entryId, fx.cashA, 1, '100.00', '100.00');
      await client.query('COMMIT');
    });
    expect(message).toMatch(/jel_one_side/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 2 — rechaza una línea sin importe en ningún lado', async () => {
    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      const entryId = await insertEntry();
      await insertLine(entryId, fx.cashA, 1, '0', '0');
      await client.query('COMMIT');
    });
    expect(message).toMatch(/jel_one_side/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 3 — rechaza un asiento de una sola línea', async () => {
    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      const entryId = await insertEntry({ total_debit: '100.00', total_credit: '100.00' });
      await insertLine(entryId, fx.cashA, 1, '100.00', '0');
      await client.query('COMMIT');
    });
    expect(message).toMatch(/E_MIN_LINES|E_UNBALANCED/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 3 — rechaza una cabecera cuyos totales no coinciden con sus líneas', async () => {
    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      const entryId = await insertEntry({ total_debit: '500.00', total_credit: '500.00' });
      await insertLine(entryId, fx.cashA, 1, '100.00', '0');
      await insertLine(entryId, fx.salesA, 2, '0', '100.00');
      await client.query('COMMIT');
    });
    expect(message).toMatch(/E_UNBALANCED/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 4 — rechaza postear en un período CERRADO', async () => {
    await client.query('BEGIN');
    const fy = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1, 'EJ2024-CERR', '2024-01-01', '2024-12-31') RETURNING id`,
      [fx.companyA],
    );
    const closed = await client.query<{ id: string }>(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date,
                            status, closed_at, closed_by)
       VALUES ($1, $2, 1, '2024-01-01', '2024-01-31', 'CERRADO', now(), 'contador')
       RETURNING id`,
      [fx.companyA, fy.rows[0]!.id],
    );
    await client.query('COMMIT');

    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO journal_entries
          (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
           description, status, total_debit, total_credit, source_type, created_by)
         VALUES ($1, 'GENERAL', $2, $3, 1, '2024-01-15', 'Test', 'PROPUESTO', 0, 0, 'MANUAL', 'tester')`,
        [fx.companyA, closed.rows[0]!.id, fy.rows[0]!.id],
      );
      await client.query('COMMIT');
    });
    expect(message).toMatch(/E_PERIOD_CLOSED/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 4 — rechaza una fecha fuera del rango del período', async () => {
    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      await insertEntry({ entry_date: '2025-03-15' });
      await client.query('COMMIT');
    });
    expect(message).toMatch(/E_DATE_OUT_OF_PERIOD/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('CANDADO 6 — el borrado físico de un asiento es imposible', async () => {
    await client.query('BEGIN');
    const entryId = await insertEntry();
    await insertLine(entryId, fx.cashA, 1, '100.00', '0');
    await insertLine(entryId, fx.salesA, 2, '0', '100.00');
    await client.query('COMMIT');

    const message = await expectFailure(() =>
      client.query('DELETE FROM journal_entries WHERE id = $1', [entryId]),
    );
    expect(message).toMatch(/Borrado físico prohibido/);
  });

  it('CANDADO 5 — un asiento APROBADO no se puede modificar ni anular sin contraasiento', async () => {
    await client.query('BEGIN');
    const entryId = await insertEntry();
    await insertLine(entryId, fx.cashA, 1, '100.00', '0');
    await insertLine(entryId, fx.salesA, 2, '0', '100.00');
    await client.query(
      `UPDATE journal_entries SET status = 'APROBADO', approved_by = 'contador', approved_at = now()
       WHERE id = $1`,
      [entryId],
    );
    await client.query('COMMIT');

    const importe = await expectFailure(() =>
      client.query(`UPDATE journal_entries SET total_debit = 999 WHERE id = $1`, [entryId]),
    );
    expect(importe).toMatch(/inmutables/);

    const anulacion = await expectFailure(() =>
      client.query(`UPDATE journal_entries SET status = 'ANULADO' WHERE id = $1`, [entryId]),
    );
    expect(anulacion).toMatch(/sin su contraasiento/);
  });

  it('CANDADO 7 — rechaza imputar en una cuenta no imputable', async () => {
    await client.query('BEGIN');
    const chart = await client.query<{ id: string }>(
      `SELECT chart_id AS id FROM accounts WHERE id = $1`,
      [fx.cashA],
    );
    const parent = await client.query<{ id: string }>(
      `INSERT INTO accounts (company_id, chart_id, code, name, type, nature, is_postable)
       VALUES ($1, $2, '1.9', 'Rubro no imputable', 'ACTIVO', 'DEUDORA', false) RETURNING id`,
      [fx.companyA, chart.rows[0]!.id],
    );
    await client.query('COMMIT');

    const message = await expectFailure(async () => {
      await client.query('BEGIN');
      const entryId = await insertEntry();
      await insertLine(entryId, parent.rows[0]!.id, 1, '100.00', '0');
      await client.query('COMMIT');
    });
    expect(message).toMatch(/E_ACCOUNT_NOT_POSTABLE/);
    await client.query('ROLLBACK').catch(() => undefined);
  });

  it('la numeración es correlativa y sin huecos por libro y ejercicio', async () => {
    const numbers: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await client.query('BEGIN');
      const entryId = await insertEntry();
      await insertLine(entryId, fx.cashA, 1, '100.00', '0');
      await insertLine(entryId, fx.salesA, 2, '0', '100.00');
      await client.query('COMMIT');
      const row = await client.query<{ entry_number: number }>(
        'SELECT entry_number FROM journal_entries WHERE id = $1',
        [entryId],
      );
      numbers.push(row.rows[0]!.entry_number);
    }
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i]).toBe(numbers[i - 1]! + 1);
    }
  });
});
