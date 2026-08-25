/**
 * Los candados del IVA, verificados contra PostgreSQL real.
 *
 * El primero es el que sostiene todo el módulo: **no se puede insertar una
 * alícuota sin decir de qué norma sale**. Es ADR-005 convertido en un
 * `NOT NULL`, y por eso no depende de que la aplicación se porte bien.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asCompany,
  connect,
  expectFailure,
  expectFailureCode,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Candados del IVA', () => {
  let client: Client;
  let fx: Fixture;
  let normVersionId: string | null = null;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
    const norma = await client.query<{ id: string }>('SELECT id FROM norm_versions LIMIT 1');
    normVersionId = norma.rows[0]?.id ?? null;
  });

  afterAll(async () => {
    await client?.end();
  });

  it('el sistema no trae ninguna alícuota de fábrica', async () => {
    // Se excluyen las que cargan los tests de más abajo. La afirmación es sobre
    // las que carga el *sistema*: ninguna migración ni ningún seed inserta una
    // alícuota de IVA, porque la Ley 23.349 no está archivada.
    //
    // No es "todavía no lo hicimos". Es que el motor prefiere responder
    // SIN_ALICUOTAS_RELEVADAS antes que suponer 21%.
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tax_rates WHERE created_by <> 'tester'`,
    );

    expect(result.rows[0]?.n).toBe('0');

    // Y el impuesto sí existe: lo que falta es su alícuota, no el impuesto.
    const impuesto = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM taxes WHERE code = 'IVA'`,
    );
    expect(impuesto.rows[0]?.n).toBe('1');
  });

  it('una alícuota sin norma no se puede insertar', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO tax_rates (tax_id, label, numerator, denominator, valid_from, articulo, created_by)
         SELECT id, '21%', 21, 100, '2020-01-01', 'Art. 28', 'tester' FROM taxes WHERE code = 'IVA'`,
      ),
    );

    // 23502 = not_null_violation. Se compara el SQLSTATE y no el mensaje porque
    // los de PostgreSQL vienen traducidos según el lc_messages del servidor.
    expect(codigo.code).toBe('23502');
  });

  it('una alícuota mayor a uno no es una alícuota', async () => {
    if (normVersionId === null) return;
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO tax_rates (tax_id, label, numerator, denominator, valid_from, norm_version_id, articulo, created_by)
         SELECT id, '2100%', 2100, 100, '2020-01-01', $1, 'Art. 28', 'tester' FROM taxes WHERE code = 'IVA'`,
        [normVersionId],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('una alícuota publicada no se reescribe: se cierra y se carga otra', async () => {
    if (normVersionId === null) return;
    const insertada = await client.query<{ id: string }>(
      `INSERT INTO tax_rates (tax_id, label, numerator, denominator, valid_from, norm_version_id, articulo, created_by)
       SELECT id, 'test', 21, 100, '2020-01-01', $1, 'Art. 28', 'tester' FROM taxes WHERE code = 'IVA'
       RETURNING id`,
      [normVersionId],
    );
    const rateId = insertada.rows[0]!.id;

    const mensaje = await expectFailure(async () =>
      client.query('UPDATE tax_rates SET numerator = 105, denominator = 1000 WHERE id = $1', [
        rateId,
      ]),
    );
    expect(mensaje).toMatch(/no se reescribe/);

    // Cerrarla con valid_to sí se puede: es cómo se sucede una alícuota.
    await client.query(`UPDATE tax_rates SET valid_to = '2025-12-31' WHERE id = $1`, [rateId]);
    const cerrada = await client.query<{ valid_to: string }>(
      'SELECT valid_to::text FROM tax_rates WHERE id = $1',
      [rateId],
    );
    expect(cerrada.rows[0]?.valid_to).toBe('2025-12-31');
  });

  it('la aplicación puede leer las alícuotas pero no cargarlas', async () => {
    const mensaje = await expectFailure(async () =>
      asCompany(client, fx.companyA, async () => {
        await client.query(
          `INSERT INTO tax_rates (tax_id, label, numerator, denominator, valid_from, norm_version_id, articulo, created_by)
           SELECT id, 'por HTTP', 21, 100, '2020-01-01', $1, 'x', 'atacante' FROM taxes WHERE code = 'IVA'`,
          [normVersionId],
        );
      }),
    );

    expect(mensaje).toMatch(/permis|permission|denied|denegado/i);
  });

  it('el total de una operación es la suma de sus partes, sin tolerancia', async () => {
    const codigo = await expectFailureCode(async () =>
      insertarOperacion({ neto: '100000.00', iva: '21000.00', total: '121000.01' }),
    );

    expect(codigo.code).toBe('23514');
  });

  it('una percepción entra en el total sin descuadrarlo', async () => {
    const id = await insertarOperacion({
      neto: '100000.00',
      iva: '21000.00',
      percepciones: '3000.00',
      total: '124000.00',
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('un mismo comprobante no entra dos veces al mismo subdiario', async () => {
    await insertarOperacion({ numero: '777', total: '121000.00' });
    const codigo = await expectFailureCode(async () =>
      insertarOperacion({ numero: '777', total: '121000.00' }),
    );

    expect(codigo.code).toBe('23505');
  });

  it('un libro SIN MOVIMIENTO con comprobantes cargados es una DDJJ falsa', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO vat_books
           (company_id, anio, mes, vencimiento, status, comprobantes_compras,
            generated_at, generated_by)
         VALUES ($1, 2026, 3, '2026-04-15', 'SIN_MOVIMIENTO', 5, now(), 'tester')`,
        [fx.companyA],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('un libro generado lleva quién y cuándo', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO vat_books (company_id, anio, mes, vencimiento, status)
         VALUES ($1, 2026, 5, '2026-06-15', 'GENERADO')`,
        [fx.companyA],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('una línea de asiento no puede apuntar a una operación fiscal inexistente', async () => {
    await client.query('BEGIN');
    const cabecera = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
        (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
         description, kind, status, total_debit, total_credit, source_type, created_by)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-15',
               'Con IVA', 'NORMAL', 'PROPUESTO', '100.00', '100.00', 'MANUAL', 'tester')
       RETURNING id`,
      [fx.companyA, fx.periodA, fx.fiscalYearA],
    );

    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO journal_entry_lines
           (company_id, entry_id, line_no, account_id, debit, credit, tax_transaction_id)
         VALUES ($1, $2, 1, $3, '100.00', 0, '00000000-0000-0000-0000-000000000000')`,
        [fx.companyA, cabecera.rows[0]!.id, fx.cashA],
      ),
    );
    await client.query('ROLLBACK');

    // 23503 = foreign_key_violation. Antes de la 0021 la columna existía sin FK
    // y esto pasaba sin ruido.
    expect(codigo.code).toBe('23503');
  });

  async function insertarOperacion(
    overrides: Partial<Record<string, string>> = {},
  ): Promise<string> {
    const valores = {
      neto: '100000.00',
      iva: '21000.00',
      no_gravado: '0',
      exento: '0',
      percepciones: '0',
      total: '121000.00',
      numero: '1',
      ...overrides,
    };
    const result = await client.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
          cbte_fecha, cuit_contraparte, neto, iva, no_gravado, exento, percepciones, total, created_by)
       SELECT $1, t.id, $2, 'COMPRAS', 1, 1, $3, '2025-01-15', '30500010912',
              $4, $5, $6, $7, $8, $9, 'tester'
         FROM taxes t WHERE t.code = 'IVA'
       RETURNING id`,
      [
        fx.companyA,
        fx.periodA,
        valores.numero,
        valores.neto,
        valores.iva,
        valores.no_gravado,
        valores.exento,
        valores.percepciones,
        valores.total,
      ],
    );
    return result.rows[0]!.id;
  }
});
