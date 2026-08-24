/**
 * S-1 — Aislamiento multiempresa.
 *
 * En un estudio contable, una fuga entre dos empresas clientes no es un bug de
 * permisos: es una violación de secreto profesional. Por eso el aislamiento se
 * verifica contra la base real, con el rol de aplicación y RLS activo, y no
 * confiando en que el middleware siempre ponga el `WHERE company_id`.
 *
 * Criterio de salida de la FASE 1 (ROADMAP.md).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asCompany,
  connect,
  expectFailureCode,
  hasDatabase,
  INSUFFICIENT_PRIVILEGE,
  seed,
  type Client,
  type Fixture,
} from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('S-1 — aislamiento entre empresas', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `iso${Date.now() % 100000}`);

    // Un asiento en la empresa A, creado como superusuario (sin RLS).
    await client.query('BEGIN');
    const entry = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, status, total_debit, total_credit, source_type, created_by)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-10',
               'Secreto de la empresa A', 'PROPUESTO', '100.00', '100.00', 'MANUAL', 'tester')
       RETURNING id`,
      [fx.companyA, fx.periodA, fx.fiscalYearA],
    );
    const entryId = entry.rows[0]!.id;
    await client.query(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, '100.00', 0), ($1, $2, 2, $4, 0, '100.00')`,
      [fx.companyA, entryId, fx.cashA, fx.salesA],
    );
    await client.query('COMMIT');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('la empresa A ve sus propios asientos', async () => {
    const count = await asCompany(client, fx.companyA, async () => {
      const result = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM journal_entries');
      return Number(result.rows[0]!.n);
    });
    expect(count).toBeGreaterThan(0);
  });

  it('la empresa B NO ve los asientos de la empresa A', async () => {
    const count = await asCompany(client, fx.companyB, async () => {
      const result = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM journal_entries');
      return Number(result.rows[0]!.n);
    });
    expect(count).toBe(0);
  });

  it('la empresa B no ve las cuentas ni los períodos de la empresa A', async () => {
    const seen = await asCompany(client, fx.companyB, async () => {
      const accounts = await client.query('SELECT id FROM accounts');
      const periods = await client.query('SELECT id FROM periods');
      const ledger = await client.query('SELECT id FROM journal_entry_lines');
      return {
        accounts: accounts.rowCount,
        periods: periods.rowCount,
        lines: ledger.rowCount,
      };
    });
    expect(seen).toEqual({ accounts: 0, periods: 0, lines: 0 });
  });

  it('la empresa B no puede leer un asiento de A ni conociendo su id', async () => {
    const entry = await client.query<{ id: string }>(
      'SELECT id FROM journal_entries WHERE company_id = $1 LIMIT 1',
      [fx.companyA],
    );
    const found = await asCompany(client, fx.companyB, async () => {
      const result = await client.query('SELECT id FROM journal_entries WHERE id = $1', [
        entry.rows[0]!.id,
      ]);
      return result.rowCount;
    });
    expect(found).toBe(0);
  });

  it('la empresa B no puede insertar datos atribuidos a la empresa A', async () => {
    const failure = await expectFailureCode(() =>
      asCompany(client, fx.companyB, () =>
        client.query(
          `INSERT INTO alerts (company_id, kind, severity) VALUES ($1, 'PRUEBA', 'BAJA')`,
          [fx.companyA],
        ),
      ),
    );
    expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('sin app.company_id en contexto no se ve absolutamente nada', async () => {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aai_app');
    const result = await client.query('SELECT id FROM journal_entries');
    await client.query('ROLLBACK');
    expect(result.rowCount).toBe(0);
  });

  it('el rol de aplicación no puede borrar: no tiene el privilegio', async () => {
    // Ni siquiera llega al trigger forbid_delete: el privilegio DELETE nunca se
    // concedió. Es el primero de los dos candados.
    const failure = await expectFailureCode(() =>
      asCompany(client, fx.companyA, () => client.query('DELETE FROM journal_entries')),
    );
    expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('el rol de aplicación no puede modificar la bitácora', async () => {
    const failure = await expectFailureCode(() =>
      asCompany(client, fx.companyA, () =>
        client.query(`UPDATE audit_logs SET motivo = 'alterado'`),
      ),
    );
    expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('el rol de aplicación no puede activar una regla normativa por su cuenta', async () => {
    // Las tablas normativas son de solo lectura para la aplicación: se pueblan
    // por el proceso de carga con revisión humana, nunca desde un endpoint.
    const failure = await expectFailureCode(() =>
      asCompany(client, fx.companyA, () =>
        client.query(
          `INSERT INTO accounting_rules
            (rule_key, version, norm_version_id, domain, valid_from, jurisdiction, conditions, action)
           VALUES ('X', 1, gen_random_uuid(), 'tax', CURRENT_DATE, 'AR', '{}', '{}')`,
        ),
      ),
    );
    expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
