/**
 * Los agujeros que encontró la auditoría de cierre del circuito productivo.
 *
 * Los tres tenían la misma forma: un invariante que vivía **solo en el código de
 * la aplicación**. Mientras nadie corriera dos pedidos a la vez ni escribiera SQL
 * a mano, no se notaban.
 *
 * Cada test de acá reproduce el ataque que los destapó, no una versión
 * suavizada: si el candado se cae, el test vuelve a fallar por el mismo camino.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, connect, expectFailureCode, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('auditoría del circuito — integridad y concurrencia', () => {
  let db: Client;
  let fx: Fixture;
  let periodId: string;
  let fiscalYearId: string;
  let fechaPeriodo: string;

  /** Crea una operación fiscal suelta, con o sin documento. */
  async function operacion(numero: number, documentId: string | null = null): Promise<string> {
    const tax = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    const r = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, document_id, period_id, direction, cbte_tipo, punto_venta,
          cbte_numero, cbte_fecha, condicion_iva, neto, iva, no_gravado, exento,
          percepciones, total, created_by)
       VALUES ($1,$2,$3,$4,'VENTAS',11,1,$5,$6,'CONSUMIDOR_FINAL',100,0,0,0,0,100,'auditoria')
       RETURNING id`,
      [fx.companyA, tax.rows[0]!.id, documentId, periodId, numero, fechaPeriodo],
    );
    return r.rows[0]!.id;
  }

  async function decision(taxTransactionId: string | null, extra = ''): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO accounting_decisions
         (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
          decidida_por, justificacion)
       VALUES ($1,$2,'MANUAL','PROPUESTA_DE_ASIENTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
               'auditoria', $3)
       RETURNING id`,
      [fx.companyA, taxTransactionId, `Decision de auditoria, justificacion larga. ${extra}`],
    );
    return r.rows[0]!.id;
  }

  /**
   * Un asiento completo, con sus dos líneas y su COMMIT.
   *
   * No alcanza con la cabecera: `E_MIN_LINES` y el candado de `Debe = Haber` son
   * CONSTRAINT TRIGGER diferidos y disparan recién al confirmar. Un helper que
   * insertara solo la cabecera estaría probando contra un asiento que el sistema
   * no acepta.
   */
  async function asiento(
    sourceId: string | null,
    decisionId: string | null,
    sourceType = 'INVOICE',
  ): Promise<string> {
    await db.query('BEGIN');
    try {
      const r = await db.query<{ id: string }>(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, total_debit, total_credit, source_type, source_id,
            decision_id, manual_justification, created_by)
         VALUES ($1,'GENERAL',$2,$3,next_entry_number($1,'GENERAL',$3),$4,'auditoria','NORMAL',
                 'PROPUESTO',100,100,$5,$6,$7,'justificacion de auditoria','auditoria')
         RETURNING id`,
        [fx.companyA, periodId, fiscalYearId, fechaPeriodo, sourceType, sourceId, decisionId],
      );
      const id = r.rows[0]!.id;
      for (const [n, cuenta, debe, haber] of [
        [1, fx.cashA, '100', '0'],
        [2, fx.salesA, '0', '100'],
      ] as const) {
        await db.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, currency, description)
           VALUES ($1,$2,$3,$4,$5,$6,'ARS','auditoria')`,
          [fx.companyA, id, n, cuenta, debe, haber],
        );
      }
      await db.query('COMMIT');
      return id;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'auditoria');
    const p = await db.query<{ id: string; fiscal_year_id: string; start_date: Date }>(
      'SELECT id, fiscal_year_id, start_date FROM periods WHERE id = $1',
      [fx.periodA],
    );
    periodId = p.rows[0]!.id;
    fiscalYearId = p.rows[0]!.fiscal_year_id;
    fechaPeriodo = p.rows[0]!.start_date.toISOString().slice(0, 10);
  });

  afterAll(async () => {
    await db.end();
  });

  // ── Hallazgo 1 ────────────────────────────────────────────────────────────
  describe('un asiento no puede citar la decisión de otro comprobante', () => {
    it('el cruce se rechaza, y el mensaje nombra las dos operaciones', async () => {
      const opA = await operacion(910001);
      const opB = await operacion(910002);
      const decisionDeA = await decision(opA);

      const fallo = await expectFailureCode(() => asiento(opB, decisionDeA));
      expect(fallo.message).toMatch(/es sobre la operación fiscal .* y este asiento declara/s);
      expect(fallo.message).toMatch(/no puede fundarse en la decisión de otro comprobante/);
    });

    it('con el comprobante correcto sí entra', async () => {
      const op = await operacion(910003);
      const d = await decision(op);
      await expect(asiento(op, d)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it('una decisión SIN comprobante puede fundar un asiento sin origen', async () => {
      // Un ajuste de cierre es una decisión contable que no nace de un papel de
      // un tercero. La comparación solo corre cuando los dos lados dicen algo.
      const d = await decision(null, 'Ajuste de cierre sin comprobante.');
      await expect(asiento(null, d, 'CLOSING')).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ── Hallazgo 2 ────────────────────────────────────────────────────────────
  describe('una sola decisión vigente por operación fiscal', () => {
    it('la segunda decisión vigente la rechaza la base', async () => {
      const op = await operacion(910004);
      await decision(op);
      const fallo = await expectFailureCode(() => decision(op, 'La segunda.'));
      expect(fallo.code).toBe('23505');
    });

    it('dos pedidos CONCURRENTES no dejan dos vigentes', async () => {
      // Es el ataque que lo destapó: dos conexiones que miran, no encuentran
      // nada, esperan, y escriben. Antes de la 0036 quedaban las dos.
      const op = await operacion(910005);

      const intento = async (n: number): Promise<'ok' | 'rechazado'> => {
        const otra = await connect();
        try {
          await otra.query('BEGIN');
          const ya = await otra.query(
            `SELECT id FROM accounting_decisions
              WHERE tax_transaction_id = $1 AND estado <> 'SUPERSEDIDA'`,
            [op],
          );
          if (Number(ya.rowCount) > 0) {
            await otra.query('COMMIT');
            return 'rechazado';
          }
          await new Promise((r) => setTimeout(r, 60));
          await otra.query(
            `INSERT INTO accounting_decisions
               (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
                decidida_por, justificacion)
             VALUES ($1,$2,'MANUAL','SIN_EFECTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$3,
                     'Justificacion larga para pasar el minimo del candado')`,
            [fx.companyA, op, `concurrente-${n}`],
          );
          await otra.query('COMMIT');
          return 'ok';
        } catch {
          await otra.query('ROLLBACK').catch(() => undefined);
          return 'rechazado';
        } finally {
          await otra.end();
        }
      };

      const resultados = await Promise.all([intento(1), intento(2)]);
      expect(resultados.filter((r) => r === 'ok')).toHaveLength(1);

      const vigentes = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounting_decisions
          WHERE tax_transaction_id = $1 AND estado <> 'SUPERSEDIDA'`,
        [op],
      );
      expect(vigentes.rows[0]!.n).toBe('1');
    });

    it('las SUPERSEDIDAS se acumulan: son el historial de correcciones', async () => {
      const op = await operacion(910006);
      const primera = await decision(op, 'Primera.');
      await db.query(`UPDATE accounting_decisions SET estado = 'SUPERSEDIDA' WHERE id = $1`, [
        primera,
      ]);
      const segunda = await decision(op, 'La corrige.');
      await db.query(`UPDATE accounting_decisions SET estado = 'SUPERSEDIDA' WHERE id = $1`, [
        segunda,
      ]);
      await decision(op, 'La tercera.');

      const todas = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM accounting_decisions WHERE tax_transaction_id = $1',
        [op],
      );
      expect(todas.rows[0]!.n).toBe('3');
    });
  });

  // ── Hallazgo 3 ────────────────────────────────────────────────────────────
  describe('idempotencia de la operación fiscal bajo concurrencia', () => {
    it('dos INSERT concurrentes para el mismo documento dejan una sola fila', async () => {
      const doc = await db.query<{ id: string }>(
        'SELECT id FROM documents WHERE company_id = $1 LIMIT 1',
        [fx.companyA],
      );
      if (Number(doc.rowCount) === 0) return; // sin documentos en el fixture

      const documentId = doc.rows[0]!.id;
      const tax = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");

      const intento = async (n: number): Promise<string | null> => {
        const otra = await connect();
        try {
          // `ON CONFLICT DO NOTHING` es lo que hace el endpoint: el perdedor no
          // explota, devuelve cero filas y después lee la que ganó.
          const r = await otra.query<{ id: string }>(
            `INSERT INTO tax_transactions
               (company_id, tax_id, document_id, period_id, direction, cbte_tipo, punto_venta,
                cbte_numero, cbte_fecha, condicion_iva, neto, iva, no_gravado, exento,
                percepciones, total, created_by)
             VALUES ($1,$2,$3,$4,'VENTAS',11,1,$5,$6,'CONSUMIDOR_FINAL',100,0,0,0,0,100,'auditoria')
             ON CONFLICT (document_id) WHERE document_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [fx.companyA, tax.rows[0]!.id, documentId, periodId, 911000 + n, fechaPeriodo],
          );
          return r.rows[0]?.id ?? null;
        } finally {
          await otra.end();
        }
      };

      const [a, b] = await Promise.all([intento(1), intento(2)]);
      // Exactamente uno insertó; el otro recibió cero filas, no una excepción.
      expect([a, b].filter((x) => x !== null)).toHaveLength(1);

      const cuantas = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM tax_transactions WHERE document_id = $1',
        [documentId],
      );
      expect(cuantas.rows[0]!.n).toBe('1');
    });
  });

  // ── Lo que la auditoría confirmó que YA estaba bien ───────────────────────
  describe('candados que ya funcionaban', () => {
    it('DATABASE_URL apunta a la base de tests, no a la de desarrollo', () => {
      // Si esto falla, todo lo de arriba se está midiendo en el lugar equivocado.
      expect(DATABASE_URL).toMatch(/_test(\?|$)/);
    });

    it('ninguna de estas tablas admite DELETE', async () => {
      const op = await operacion(910007);
      const d = await decision(op);
      for (const [tabla, id] of [
        ['tax_transactions', op],
        ['accounting_decisions', d],
      ] as const) {
        const fallo = await expectFailureCode(() =>
          db.query(`DELETE FROM ${tabla} WHERE id = $1`, [id]),
        );
        expect(fallo.message, tabla).toMatch(/no se borra|forbid|prohib/i);
      }
    });

    it('el total de una operación fiscal tiene que cerrar con sus partes', async () => {
      const tax = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
      const fallo = await expectFailureCode(() =>
        db.query(
          `INSERT INTO tax_transactions
             (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
              cbte_fecha, condicion_iva, neto, iva, no_gravado, exento, percepciones, total, created_by)
           VALUES ($1,$2,$3,'VENTAS',11,1,910008,$4,'CONSUMIDOR_FINAL',100,0,0,0,0,150,'auditoria')`,
          [fx.companyA, tax.rows[0]!.id, periodId, fechaPeriodo],
        ),
      );
      expect(fallo.message).toMatch(/tax_tx_total_cierra/);
    });
  });
});
