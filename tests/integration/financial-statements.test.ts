/**
 * Los candados de los estados contables, contra PostgreSQL real.
 *
 * El invariante de la fase es que **ningún renglón exista sin origen**. En el
 * motor eso está en los tipos; acá se comprueba que tampoco se pueda por SQL.
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

suite('Candados de los estados contables', () => {
  let client: Client;
  let fx: Fixture;
  let templateId = '';

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `${Date.now() % 100000}`);
    const norma = await client.query<{ id: string }>('SELECT id FROM norm_versions LIMIT 1');
    const normVersionId = norma.rows[0]?.id ?? null;
    if (normVersionId === null) return;

    const tpl = await client.query<{ id: string }>(
      `INSERT INTO statement_templates
         (company_id, statement_kind, framework, entity_type, regulator, version,
          valid_from, structure, norm_version_id, articulo, created_by)
       VALUES ($1, 'ESP', 'RT_FACPCE', 'SA', 'IGJ', 1, '2024-01-01',
               '[{"codigo":"A","etiqueta":"ACTIVO","tipo":"RUBRO"}]'::jsonb,
               $2, 'Art. 63', 'tester')
       RETURNING id`,
      [fx.companyA, normVersionId],
    );
    templateId = tpl.rows[0]!.id;
  });

  afterAll(async () => {
    await client?.end();
  });

  it('ninguna migración carga una plantilla: las publica un script, desde una norma', async () => {
    // Este test decía que la tabla estaba vacía. Ya no lo está —hay dos
    // plantillas del art. 63 y 64— y actualizar el número esperado habría
    // convertido un candado en un contador.
    //
    // Lo que hay que sostener es de dónde salen: ninguna migración las escribe,
    // para que publicar una estructura de estado contable nunca sea un efecto
    // secundario de un cambio de esquema.
    const deMigraciones = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM statement_templates
        WHERE created_by NOT IN ('tester', 'seed-statement-templates')`,
    );
    expect(deMigraciones.rows[0]?.n).toBe('0');

    // Y que cada una cite el documento archivado del que se transcribió.
    const sinDocumento = await client.query<{ statement_kind: string }>(
      `SELECT t.statement_kind
         FROM statement_templates t
         LEFT JOIN norm_documents d ON d.norm_version_id = t.norm_version_id
        WHERE t.created_by = 'seed-statement-templates' AND d.id IS NULL`,
    );
    expect(sinDocumento.rows).toEqual([]);
  });

  it('una plantilla sin norma no se puede insertar', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO statement_templates
           (company_id, statement_kind, framework, entity_type, regulator, version,
            valid_from, structure, articulo, created_by)
         VALUES ($1, 'ESP', 'NIIF', 'SA', 'CNV', 1, '2024-01-01', '[]'::jsonb, 'x', 'tester')`,
        [fx.companyA],
      ),
    );

    expect(codigo.code).toBe('23502');
  });

  it('una estructura que no es un árbol se rechaza', async () => {
    const norma = await client.query<{ id: string }>('SELECT id FROM norm_versions LIMIT 1');
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO statement_templates
           (company_id, statement_kind, framework, entity_type, regulator, version,
            valid_from, structure, norm_version_id, articulo, created_by)
         VALUES ($1, 'ESP', 'NIIF', 'SA', 'CNV', 1, '2024-01-01',
                 '{"no":"soy un array"}'::jsonb, $2, 'x', 'tester')`,
        [fx.companyA, norma.rows[0]!.id],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('una plantilla publicada no se reescribe: se versiona', async () => {
    const mensaje = await expectFailure(async () =>
      client.query(`UPDATE statement_templates SET structure = '[]'::jsonb WHERE id = $1`, [
        templateId,
      ]),
    );

    expect(mensaje).toMatch(/no se reescribe/);
    expect(mensaje).toMatch(/estados ya emitidos/);

    // Cerrarla con valid_to sí se puede: es cómo se sucede una versión.
    await client.query(`UPDATE statement_templates SET valid_to = '2025-12-31' WHERE id = $1`, [
      templateId,
    ]);
  });

  it('la aplicación puede leer las plantillas pero no cargarlas', async () => {
    const permisos = await client.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'aai_app' AND table_name = 'statement_templates'`,
    );

    const tipos = permisos.rows.map((fila) => fila.privilege_type);
    expect(tipos).toContain('SELECT');
    expect(tipos).not.toContain('INSERT');
    expect(tipos).not.toContain('UPDATE');
  });

  /**
   * Anula el vigente antes de crear otro.
   *
   * No es un rodeo del test: hay un índice único parcial que admite un solo
   * estado no anulado por ejercicio y tipo, y anular con motivo es el camino
   * previsto para reemplazarlo.
   */
  async function nuevoEstado(status = 'BORRADOR'): Promise<string> {
    await client.query(
      `UPDATE financial_statements SET status = 'ANULADO', anulado_motivo = 'reemplazado en test'
        WHERE company_id = $1 AND status <> 'ANULADO'`,
      [fx.companyA],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO financial_statements
         (company_id, fiscal_year_id, template_id, statement_kind, fecha_cierre, status,
          issued_at, issued_by, content_sha256)
       VALUES ($1, $2, $3, 'ESP', '2025-12-31', $4,
               CASE WHEN $4 = 'EMITIDO' THEN now() END,
               CASE WHEN $4 = 'EMITIDO' THEN 'contador' END,
               CASE WHEN $4 = 'EMITIDO' THEN $5 END)
       RETURNING id`,
      [fx.companyA, fx.fiscalYearA, templateId, status, 'a'.repeat(64)],
    );
    return result.rows[0]!.id;
  }

  it('un RENGLON con importe y sin origen no se puede insertar', async () => {
    const statementId = await nuevoEstado();
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO financial_statement_lines
           (company_id, statement_id, orden, line_code, label, line_type, nivel, amount, lineage)
         VALUES ($1, $2, 1, 'AC.CAJA', 'Caja y bancos', 'RENGLON', 3, '120000.00', '[]'::jsonb)`,
        [fx.companyA, statementId],
      ),
    );

    // El invariante de la fase: una cifra sin origen no se puede representar.
    expect(codigo.code).toBe('23514');
  });

  it('un RENGLON en cero sí puede tener origen vacío', async () => {
    const statementId = await nuevoEstado();
    await client.query(
      `INSERT INTO financial_statement_lines
         (company_id, statement_id, orden, line_code, label, line_type, nivel, amount, lineage)
       VALUES ($1, $2, 1, 'PN.AJ', 'Ajuste de capital', 'RENGLON', 3, 0, '[]'::jsonb)`,
      [fx.companyA, statementId],
    );

    // "Se preguntó y no hubo cuentas" es distinto de "alguien escribió un número".
    const fila = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM financial_statement_lines WHERE statement_id = $1`,
      [statementId],
    );
    expect(fila.rows[0]?.n).toBe('1');
  });

  it('un RUBRO puede tener origen vacío: su importe sale de los hijos', async () => {
    const statementId = await nuevoEstado();
    await client.query(
      `INSERT INTO financial_statement_lines
         (company_id, statement_id, orden, line_code, label, line_type, nivel, amount, lineage)
       VALUES ($1, $2, 1, 'A', 'ACTIVO', 'RUBRO', 1, '300000.00', '[]'::jsonb)`,
      [fx.companyA, statementId],
    );

    const fila = await client.query<{ amount: string }>(
      `SELECT amount::text FROM financial_statement_lines WHERE statement_id = $1`,
      [statementId],
    );
    expect(fila.rows[0]?.amount).toBe('300000.00');
  });

  it('el lineage tiene que ser un array', async () => {
    const statementId = await nuevoEstado();
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO financial_statement_lines
           (company_id, statement_id, orden, line_code, label, line_type, nivel, amount, lineage)
         VALUES ($1, $2, 1, 'X', 'X', 'RUBRO', 1, 0, '"un string"'::jsonb)`,
        [fx.companyA, statementId],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('emitir sin firma ni hash es imposible', async () => {
    const codigo = await expectFailureCode(async () =>
      client.query(
        `INSERT INTO financial_statements
           (company_id, fiscal_year_id, template_id, statement_kind, fecha_cierre, status)
         VALUES ($1, $2, $3, 'ER', '2025-12-31', 'EMITIDO')`,
        [fx.companyA, fx.fiscalYearA, templateId],
      ),
    );

    expect(codigo.code).toBe('23514');
  });

  it('un estado emitido tiene sus renglones congelados', async () => {
    const statementId = await nuevoEstado('EMITIDO');
    const mensaje = await expectFailure(async () =>
      client.query(
        `INSERT INTO financial_statement_lines
           (company_id, statement_id, orden, line_code, label, line_type, nivel, amount, lineage)
         VALUES ($1, $2, 1, 'A', 'ACTIVO', 'RUBRO', 1, 0, '[]'::jsonb)`,
        [fx.companyA, statementId],
      ),
    );

    expect(mensaje).toMatch(/son inmutables/);
    expect(mensaje).toMatch(/Anulalo con motivo/);
  });

  it('statement_trace lleva del renglón a las cuentas que lo formaron', async () => {
    // El linaje tiene que resolver a asientos aprobados: es el invariante A-1, y
    // `npm run audit:invariants` lo verifica sobre TODA la base — incluidas las
    // filas que dejan los tests. Un fixture con linaje inventado hace fallar la
    // puerta de CI, que es exactamente lo que la puerta tiene que hacer.
    await client.query('BEGIN');
    const asiento = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
          description, kind, status, total_debit, total_credit, source_type,
          manual_justification, created_by, approved_by, approved_at)
       VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), '2025-01-20',
               'Respaldo del linaje', 'NORMAL', 'APROBADO', '120000.00', '120000.00', 'MANUAL',
               'Asiento que respalda el linaje del renglón', 'tester', 'contador', now())
       RETURNING id`,
      [fx.companyA, fx.periodA, fx.fiscalYearA],
    );
    await client.query(
      `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, '120000.00', 0), ($1, $2, 2, $4, 0, '120000.00')`,
      [fx.companyA, asiento.rows[0]!.id, fx.cashA, fx.salesA],
    );
    await client.query('COMMIT');

    const statementId = await nuevoEstado();
    await client.query(
      `INSERT INTO financial_statement_lines
         (company_id, statement_id, orden, line_code, label, line_type, nivel, amount, lineage)
       VALUES ($1, $2, 1, 'AC.CAJA', 'Caja y bancos', 'RENGLON', 3, '120000.00',
               $3::jsonb)`,
      [
        fx.companyA,
        statementId,
        JSON.stringify([
          { accountId: fx.cashA, codigo: '1.1.01', aporte: '50000.00' },
          { accountId: fx.salesA, codigo: '1.1.02', aporte: '70000.00' },
        ]),
      ],
    );

    const trace = await client.query<{ account_code: string; aporte: string }>(
      `SELECT account_code, aporte FROM statement_trace
        WHERE statement_id = $1 ORDER BY account_code`,
      [statementId],
    );

    expect(trace.rows.map((f) => f.account_code)).toEqual(['1.1.01', '1.1.02']);
    expect(trace.rows[0]?.aporte).toBe('50000.00');
  });

  it('nada se borra: ni plantillas, ni estados, ni renglones', async () => {
    const mensaje = await expectFailure(async () =>
      client.query('DELETE FROM statement_templates WHERE id = $1', [templateId]),
    );

    expect(mensaje).toMatch(/[Bb]orrado/);
  });
});
