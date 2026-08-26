/**
 * Los candados de la conciliación bancaria, contra PostgreSQL real.
 *
 * El criterio de la FASE 9 dice **0 conciliaciones confirmadas sin intervención
 * humana**. Un invariante así no se cumple midiéndolo: se cumple cuando no hay
 * forma de violarlo. Estos tests intentan violarlo con SQL directo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  expectFailure,
  expectFailureCode,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Candados de la conciliación bancaria', () => {
  let client: Client;
  let fx: Fixture;
  let bankAccountId = '';

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
    const cuenta = await client.query<{ id: string }>(
      `INSERT INTO bank_accounts (company_id, bank_name, account_id)
       VALUES ($1, 'Banco de prueba', $2) RETURNING id`,
      [fx.companyA, fx.cashA],
    );
    bankAccountId = cuenta.rows[0]!.id;
  });

  afterAll(async () => {
    await client?.end();
  });

  async function nuevoExtracto(): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO bank_statements
         (company_id, bank_account_id, desde, hasta, saldo_inicial, saldo_final, imported_by)
       VALUES ($1, $2, '2025-01-01', '2025-01-31', 0, '100.00', 'tester')
       RETURNING id`,
      [fx.companyA, bankAccountId],
    );
    return result.rows[0]!.id;
  }

  async function nuevoMovimiento(statementId: string, sentido = 'SALIDA'): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO bank_transactions
         (company_id, statement_id, fecha, descripcion, importe, sentido, crudo, huella)
       VALUES ($1, $2, '2025-01-15', 'Movimiento', '100.00', $3, 'crudo', $4)
       RETURNING id`,
      [fx.companyA, statementId, sentido, `2025-01-15|${sentido}|10000|`],
    );
    return result.rows[0]!.id;
  }

  async function nuevaLineaContable(): Promise<string> {
    await client.query('BEGIN');
    const cabecera = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, kind, status, total_debit, total_credit, source_type, created_by)
       VALUES ($1, 'BANCOS', $2, $3, next_entry_number($1, 'BANCOS', $3), '2025-01-15',
               'Pago', 'NORMAL', 'PROPUESTO', '100.00', '100.00', 'MANUAL', 'tester')
       RETURNING id`,
      [fx.companyA, fx.periodA, fx.fiscalYearA],
    );
    const linea = await client.query<{ id: string }>(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, '100.00', 0) RETURNING id`,
      [fx.companyA, cabecera.rows[0]!.id, fx.cashA],
    );
    await client.query(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 2, $3, 0, '100.00')`,
      [fx.companyA, cabecera.rows[0]!.id, fx.salesA],
    );
    await client.query('COMMIT');
    return linea.rows[0]!.id;
  }

  async function nuevaConciliacion(
    overrides: Partial<Record<string, string | number>> = {},
  ): Promise<string> {
    const valores = { saldo_extracto: '100.00', saldo_libro: '100.00', ajuste: '0', ...overrides };
    const result = await client.query<{ id: string }>(
      `INSERT INTO bank_reconciliations
         (company_id, bank_account_id, period_id, desde, hasta,
          saldo_extracto, saldo_libro, ajuste_neto, created_by)
       VALUES ($1, $2, $3, '2025-01-01', '2025-01-31', $4, $5, $6, 'tester')
       RETURNING id`,
      [
        fx.companyA,
        bankAccountId,
        fx.periodA,
        valores.saldo_extracto,
        valores.saldo_libro,
        valores.ajuste,
      ],
    );
    return result.rows[0]!.id;
  }

  it('confirmar sin firma es imposible', async () => {
    const id = await nuevaConciliacion();
    const codigo = await expectFailureCode(async () =>
      client.query(`UPDATE bank_reconciliations SET status = 'CONFIRMADA' WHERE id = $1`, [id]),
    );

    expect(codigo.code).toBe('23514');
    await client.query(`UPDATE bank_reconciliations SET status = 'ANULADA', anulada_motivo = 'test' WHERE id = $1`, [id]);
  });

  it('un match propuesto y no revisado impide confirmar, aunque tenga score 100', async () => {
    const id = await nuevaConciliacion();
    const statementId = await nuevoExtracto();
    const movimientoId = await nuevoMovimiento(statementId);
    const lineaId = await nuevaLineaContable();

    await client.query(
      `INSERT INTO bank_reconciliation_matches
         (company_id, reconciliation_id, bank_transaction_id, journal_entry_line_id,
          match_type, score)
       VALUES ($1, $2, $3, $4, 'EXACTO', 100)`,
      [fx.companyA, id, movimientoId, lineaId],
    );

    const mensaje = await expectFailure(async () =>
      client.query(
        `UPDATE bank_reconciliations
            SET status = 'CONFIRMADA', confirmed_by = 'contador', confirmed_at = now()
          WHERE id = $1`,
        [id],
      ),
    );

    expect(mensaje).toMatch(/nadie revisó/);
    expect(mensaje).toMatch(/score 100 tampoco se confirma solo/);

    // Con el match confirmado por una persona, sí.
    await client.query(
      `UPDATE bank_reconciliation_matches
          SET confirmed_by = 'contador', confirmed_at = now()
        WHERE reconciliation_id = $1`,
      [id],
    );
    await client.query(
      `UPDATE bank_reconciliations
          SET status = 'CONFIRMADA', confirmed_by = 'contador', confirmed_at = now()
        WHERE id = $1`,
      [id],
    );

    const estado = await client.query<{ status: string }>(
      'SELECT status FROM bank_reconciliations WHERE id = $1',
      [id],
    );
    expect(estado.rows[0]?.status).toBe('CONFIRMADA');
  });

  it('una conciliación confirmada tiene sus matches congelados', async () => {
    const confirmada = await client.query<{ id: string }>(
      `SELECT id FROM bank_reconciliations WHERE company_id = $1 AND status = 'CONFIRMADA' LIMIT 1`,
      [fx.companyA],
    );
    const id = confirmada.rows[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;

    const mensaje = await expectFailure(async () =>
      client.query(`UPDATE bank_reconciliation_matches SET score = 50 WHERE reconciliation_id = $1`, [
        id,
      ]),
    );

    expect(mensaje).toMatch(/sus matches son inmutables/);
    expect(mensaje).toMatch(/Anulala con motivo/);
  });

  it('un acta que no cierra no se puede confirmar', async () => {
    // Se anula la del período para poder crear otra: el índice único lo exige.
    await client.query(
      `UPDATE bank_reconciliations SET status = 'ANULADA', anulada_motivo = 'test'
        WHERE company_id = $1 AND status = 'CONFIRMADA'`,
      [fx.companyA],
    );

    const id = await nuevaConciliacion({ saldo_extracto: '100.00', saldo_libro: '150.00', ajuste: '0' });
    const codigo = await expectFailureCode(async () =>
      client.query(
        `UPDATE bank_reconciliations
            SET status = 'CONFIRMADA', confirmed_by = 'contador', confirmed_at = now()
          WHERE id = $1`,
        [id],
      ),
    );

    // rec_acta_cierra: saldo_extracto + ajuste_neto = saldo_libro.
    expect(codigo.code).toBe('23514');

    // Con la partida conciliatoria cargada, cierra y se confirma.
    await client.query(`UPDATE bank_reconciliations SET ajuste_neto = '50.00' WHERE id = $1`, [id]);
    await client.query(
      `UPDATE bank_reconciliations
          SET status = 'CONFIRMADA', confirmed_by = 'contador', confirmed_at = now()
        WHERE id = $1`,
      [id],
    );
    const estado = await client.query<{ status: string }>(
      'SELECT status FROM bank_reconciliations WHERE id = $1',
      [id],
    );
    expect(estado.rows[0]?.status).toBe('CONFIRMADA');
  });

  it('no hay dos conciliaciones vigentes del mismo período', async () => {
    const codigo = await expectFailureCode(async () => nuevaConciliacion());

    expect(codigo.code).toBe('23505');
  });

  it('un movimiento del banco tiene importe positivo: el signo va aparte', async () => {
    const statementId = await nuevoExtracto();
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO bank_transactions
           (company_id, statement_id, fecha, descripcion, importe, sentido, crudo, huella)
         VALUES ($1, $2, '2025-01-15', 'X', '-100.00', 'SALIDA', 'c', 'h')`,
        [fx.companyA, statementId],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('el sentido es ENTRADA o SALIDA, nunca DEBITO ni CREDITO', async () => {
    const statementId = await nuevoExtracto();
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO bank_transactions
           (company_id, statement_id, fecha, descripcion, importe, sentido, crudo, huella)
         VALUES ($1, $2, '2025-01-15', 'X', '100.00', 'DEBITO', 'c', 'h')`,
        [fx.companyA, statementId],
      ),
    );

    // La palabra "débito" significa cosas opuestas en el extracto y en el libro.
    // La base no la acepta para que nadie tenga que acordarse de cuál era.
    expect(codigo.code).toBe('23514');
  });

  it('descartar un movimiento exige motivo', async () => {
    const statementId = await nuevoExtracto();
    const movimientoId = await nuevoMovimiento(statementId);

    const codigo = await expectFailureCode(async () =>
      client.query(`UPDATE bank_transactions SET status = 'DESCARTADO' WHERE id = $1`, [
        movimientoId,
      ]),
    );
    expect(codigo.code).toBe('23514');

    await client.query(
      `UPDATE bank_transactions SET status = 'DESCARTADO', descarte_motivo = 'Duplicado del extracto anterior'
        WHERE id = $1`,
      [movimientoId],
    );
    const estado = await client.query<{ status: string }>(
      'SELECT status FROM bank_transactions WHERE id = $1',
      [movimientoId],
    );
    expect(estado.rows[0]?.status).toBe('DESCARTADO');
  });

  it('un mapeo con esquema de columnas separadas exige las dos columnas', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO bank_statement_layouts
           (company_id, bank_account_id, nombre, columna_fecha, columna_descripcion,
            esquema_signo, columna_debito, formato_fecha, formato_importe, created_by)
         VALUES ($1, $2, 'Incompleto', 0, 1, 'COLUMNAS_SEPARADAS', 3, 'DD/MM/AAAA', 'ES_AR', 'tester')`,
        [fx.companyA, bankAccountId],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('nada se borra: ni extractos, ni movimientos, ni matches', async () => {
    const statementId = await nuevoExtracto();
    const mensaje = await expectFailure(async () =>
      client.query('DELETE FROM bank_statements WHERE id = $1', [statementId]),
    );

    expect(mensaje).toMatch(/[Bb]orrado/);
  });

  it('bank_trace lleva del movimiento del banco al asiento', async () => {
    const trace = await client.query<{
      bank_transaction_id: string;
      entry_number: number;
      journal_code: string;
    }>(
      `SELECT bank_transaction_id, entry_number, journal_code
         FROM bank_trace WHERE company_id = $1 LIMIT 1`,
      [fx.companyA],
    );

    expect(trace.rows[0]?.journal_code).toBe('BANCOS');
    expect(trace.rows[0]?.entry_number).toBeGreaterThan(0);
  });
});
