/**
 * La infraestructura de afectación fiscal, contra PostgreSQL de verdad.
 *
 * Los candados que se prueban acá viven en la base, no en la aplicación: se
 * ejercitan con SQL directo justamente para comprobar que no dependen de que el
 * código se acuerde de llamarlos.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HECHO_VINCULACION,
  hechosDeAfectacion,
  proveerVinculacion,
  type DeclaracionDeAfectacion,
} from '@aai/tax-engine';
import { evaluar, ErrorDeRegla } from '@aai/normative-engine';
import {
  connect,
  expectFailureCode,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const AST_DE_LA_REGLA = { op: 'eq', field: HECHO_VINCULACION, value: false };

suite('afectación fiscal — infraestructura', () => {
  let db: Client;
  let fx: Fixture;
  /** Operación fiscal de la empresa A, y otra de la B para los tests de fuga. */
  let opA: string;
  let opB: string;
  let cuentaA: string;

  async function crearOperacion(companyId: string, numero: number): Promise<string> {
    // `taxes` es un catálogo global, no por empresa: el IVA es el mismo impuesto
    // para todas. Se toma el que ya sembró `tax:seed`.
    const impuesto = await db.query<{ id: string }>(
      "SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1",
    );
    const r = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero, cbte_fecha,
          cuit_contraparte, razon_social, condicion_iva, neto, iva, no_gravado, exento,
          percepciones, total, created_by)
       VALUES ($1, $2, $4, 'COMPRAS', 1, 1, $3, '2026-03-15', '30710000001', 'Proveedor',
               'RESPONSABLE_INSCRIPTO', 100000, 21000, 0, 0, 0, 121000, 'test')
       RETURNING id`,
      [companyId, impuesto.rows[0]!.id, numero, fx.periodA],
    );
    return r.rows[0]!.id;
  }

  /** Lee la vista y arma la declaración de dominio, que es el camino real. */
  async function declaracionDe(
    companyId: string,
    taxTransactionId: string,
  ): Promise<DeclaracionDeAfectacion | null> {
    const r = await db.query<{
      company_id: string;
      tax_transaction_id: string;
      afectacion: DeclaracionDeAfectacion['afectacion'];
      proporcion_gravada: number | null;
      declarada_por: string;
      declarada_at: Date;
      evidencia: DeclaracionDeAfectacion['evidencia'];
    }>(
      `SELECT company_id, tax_transaction_id, afectacion, proporcion_gravada,
              declarada_por, declarada_at, evidencia
         FROM tax_affectations_declaradas
        WHERE company_id = $1 AND tax_transaction_id = $2`,
      [companyId, taxTransactionId],
    );
    const fila = r.rows[0];
    if (fila === undefined) return null;
    return {
      companyId: fila.company_id,
      taxTransactionId: fila.tax_transaction_id,
      afectacion: fila.afectacion,
      proporcionGravada: fila.proporcion_gravada,
      declaradaPor: fila.declarada_por,
      declaradaAt: fila.declarada_at.toISOString(),
      evidencia: fila.evidencia,
    };
  }

  const declarar = (
    companyId: string,
    txId: string,
    afectacion: string,
    opciones: { origen?: string; por?: string | null; evidencia?: unknown; proporcion?: number | null } = {},
  ) =>
    db.query(
      `INSERT INTO tax_affectations
         (company_id, tax_transaction_id, afectacion, proporcion_gravada,
          evidencia, origen, declarada_por, declarada_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)`,
      [
        companyId,
        txId,
        afectacion,
        opciones.proporcion ?? null,
        JSON.stringify(opciones.evidencia ?? [{ tipo: 'CUENTA', id: cuentaA }]),
        opciones.origen ?? 'DECLARACION_PROFESIONAL',
        opciones.por === undefined ? 'user:contadora' : opciones.por,
      ],
    );

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'afectacion');
    cuentaA = fx.cashA;
    opA = await crearOperacion(fx.companyA, 1);
    opB = await crearOperacion(fx.companyB, 2);
  });

  afterAll(async () => {
    await db.end();
  });

  // ── FASE C: fail closed ───────────────────────────────────────────────────
  it('1 · sin declaración, el hecho está ausente y la regla lanza', async () => {
    const d = await declaracionDe(fx.companyA, opA);
    expect(d).toBeNull();
    const hechos = hechosDeAfectacion(proveerVinculacion(d));
    expect(hechos).toEqual({});
    expect(() => evaluar(AST_DE_LA_REGLA, hechos)).toThrow(ErrorDeRegla);
  });

  it('5 · una SUGERIDA_POR_PRECEDENTE existe en la tabla y NO en la vista', async () => {
    await declarar(fx.companyA, opA, 'EXENTAS', { origen: 'SUGERIDA_POR_PRECEDENTE', por: null });

    const enTabla = await db.query(
      'SELECT origen FROM tax_affectations WHERE tax_transaction_id = $1',
      [opA],
    );
    expect(enTabla.rowCount).toBe(1);
    expect(enTabla.rows[0]).toMatchObject({ origen: 'SUGERIDA_POR_PRECEDENTE' });

    // La sugerencia se ve en la bandeja y no resuelve la regla.
    expect(await declaracionDe(fx.companyA, opA)).toBeNull();
    expect(() => evaluar(AST_DE_LA_REGLA, hechosDeAfectacion(proveerVinculacion(null)))).toThrow();
  });

  it('6 · una DECLARACION_PROFESIONAL sin declarada_por la rechaza la base', async () => {
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyB, opB, 'EXENTAS', { por: null }),
    );
    expect(fallo.message).toMatch(/affectation_declaration_requires_author/);
  });

  it('9 · NO_DETERMINADA queda fuera de la vista: es ausencia', async () => {
    await db.query(
      `UPDATE tax_affectations
          SET afectacion = 'NO_DETERMINADA', origen = 'DECLARACION_PROFESIONAL',
              declarada_por = 'user:contadora', declarada_at = now(), evidencia = '[]'::jsonb
        WHERE tax_transaction_id = $1`,
      [opA],
    );
    expect(await declaracionDe(fx.companyA, opA)).toBeNull();
  });

  it('2 · GRAVADAS declarada profesionalmente provee TRUE', async () => {
    await db.query(
      `UPDATE tax_affectations
          SET afectacion = 'GRAVADAS', evidencia = $2::jsonb
        WHERE tax_transaction_id = $1`,
      [opA, JSON.stringify([{ tipo: 'CUENTA', id: cuentaA }])],
    );
    const d = await declaracionDe(fx.companyA, opA);
    expect(d?.afectacion).toBe('GRAVADAS');
    expect(hechosDeAfectacion(proveerVinculacion(d))).toEqual({ [HECHO_VINCULACION]: true });
    // La regla del art. 12 NO se cumple: no puede afirmar computabilidad.
    expect(evaluar(AST_DE_LA_REGLA, hechosDeAfectacion(proveerVinculacion(d)))).toBe(false);
  });

  it('3 y 4 · EXENTAS y NO_GRAVADAS proveen FALSE y la regla se cumple', async () => {
    for (const valor of ['EXENTAS', 'NO_GRAVADAS']) {
      await db.query('UPDATE tax_affectations SET afectacion = $2 WHERE tax_transaction_id = $1', [
        opA,
        valor,
      ]);
      const d = await declaracionDe(fx.companyA, opA);
      const hechos = hechosDeAfectacion(proveerVinculacion(d));
      expect(hechos).toEqual({ [HECHO_VINCULACION]: false });
      expect(evaluar(AST_DE_LA_REGLA, hechos)).toBe(true);
    }
  });

  it('8 · MIXTA aparece en la vista pero no resuelve la regla', async () => {
    await db.query(
      `UPDATE tax_affectations SET afectacion = 'MIXTA', proporcion_gravada = 6000
        WHERE tax_transaction_id = $1`,
      [opA],
    );
    const d = await declaracionDe(fx.companyA, opA);
    expect(d?.afectacion).toBe('MIXTA');
    const provision = proveerVinculacion(d);
    expect(provision.estado).toBe('REQUIERE_REVISION');
    expect(hechosDeAfectacion(provision)).toEqual({});
  });

  it('MIXTA sin proporción la rechaza la base, y no-MIXTA con proporción también', async () => {
    const sinProporcion = await expectFailureCode(() =>
      db.query('UPDATE tax_affectations SET proporcion_gravada = NULL WHERE tax_transaction_id = $1', [opA]),
    );
    expect(sinProporcion.message).toMatch(/affectation_proportion_only_when_mixed/);

    const conProporcionDeMas = await expectFailureCode(() =>
      db.query(
        `UPDATE tax_affectations SET afectacion = 'EXENTAS', proporcion_gravada = 5000
          WHERE tax_transaction_id = $1`,
        [opA],
      ),
    );
    expect(conProporcionDeMas.message).toMatch(/affectation_proportion_only_when_mixed/);
  });

  // ── FASE D: evidencia ─────────────────────────────────────────────────────
  it('7 · evidencia que apunta a un id inexistente se rechaza', async () => {
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyB, opB, 'EXENTAS', {
        evidencia: [{ tipo: 'CUENTA', id: '01a03589-0000-7000-8000-00000000dead' }],
      }),
    );
    expect(fallo.message).toMatch(/no existe en esta empresa/);
  });

  it('evidencia que apunta a una cuenta de OTRA empresa se rechaza', async () => {
    // Es el caso peligroso: el id existe, así que un FK lo dejaría pasar.
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyB, opB, 'EXENTAS', { evidencia: [{ tipo: 'CUENTA', id: cuentaA }] }),
    );
    expect(fallo.message).toMatch(/no existe en esta empresa/);
  });

  it('una declaración profesional no puede tener SOLO una nota de texto', async () => {
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyB, opB, 'EXENTAS', {
        evidencia: [{ tipo: 'NOTA', texto: 'El contador dice que no se vincula.' }],
      }),
    );
    expect(fallo.message).toMatch(/no puede ser solo notas/);
  });

  it('una declaración profesional sin evidencia se rechaza', async () => {
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyB, opB, 'EXENTAS', { evidencia: [] }),
    );
    expect(fallo.message).toMatch(/necesita al menos un ítem de evidencia/);
  });

  it('un tipo de evidencia inventado se rechaza', async () => {
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyB, opB, 'EXENTAS', {
        evidencia: [{ tipo: 'RAZONAMIENTO_DEL_MODELO', id: cuentaA }],
      }),
    );
    expect(fallo.message).toMatch(/Tipo de evidencia desconocido/);
  });

  // ── FASE A: tenencia ──────────────────────────────────────────────────────
  it('13 · una declaración no puede apuntar a la operación de otra empresa', async () => {
    const fallo = await expectFailureCode(() =>
      declarar(fx.companyA, opB, 'EXENTAS', { evidencia: [{ tipo: 'CUENTA', id: cuentaA }] }),
    );
    expect(fallo.message).toMatch(/pertenece a otra empresa/);
  });

  it('una operación fiscal tiene una sola afectación vigente', async () => {
    const fallo = await expectFailureCode(() => declarar(fx.companyA, opA, 'GRAVADAS'));
    expect(fallo.code).toBe('23505');
  });

  // ── FASE E: auditoría ─────────────────────────────────────────────────────
  it('11 · cada cambio deja su fila en la bitácora, con valor anterior y nuevo', async () => {
    const antes = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE object_type = 'tax_affectations' AND company_id = $1`,
      [fx.companyA],
    );

    await db.query(
      `UPDATE tax_affectations SET afectacion = 'GRAVADAS', proporcion_gravada = NULL
        WHERE tax_transaction_id = $1`,
      [opA],
    );

    const despues = await db.query<{
      action: string;
      old_value: { afectacion: string } | null;
      new_value: { afectacion: string };
    }>(
      `SELECT action, old_value, new_value FROM audit_logs
        WHERE object_type = 'tax_affectations' AND company_id = $1
        ORDER BY seq DESC LIMIT 1`,
      [fx.companyA],
    );

    expect(Number(despues.rowCount)).toBe(1);
    expect(despues.rows[0]!.action).toBe('AFFECTATION_CHANGED');
    expect(despues.rows[0]!.old_value?.afectacion).toBe('MIXTA');
    expect(despues.rows[0]!.new_value.afectacion).toBe('GRAVADAS');

    const total = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE object_type = 'tax_affectations' AND company_id = $1`,
      [fx.companyA],
    );
    expect(Number(total.rows[0]!.n)).toBeGreaterThan(Number(antes.rows[0]!.n));
  });

  it('no hay borrado silencioso: DELETE está prohibido', async () => {
    const fallo = await expectFailureCode(() =>
      db.query('DELETE FROM tax_affectations WHERE tax_transaction_id = $1', [opA]),
    );
    expect(fallo.message).toMatch(/no se borra|forbid|prohib/i);
  });

  // ── FASE F: aislamiento ───────────────────────────────────────────────────
  it('12 y 14 · con RLS activo, una empresa no ve la declaración de otra', async () => {
    await declarar(fx.companyB, opB, 'GRAVADAS', {
      evidencia: [{ tipo: 'COMPROBANTE', id: opB }],
    });

    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      await db.query('SELECT set_config($1, $2, true)', ['app.company_id', fx.companyA]);

      const propias = await db.query('SELECT company_id FROM tax_affectations');
      expect(propias.rows.every((f) => (f as { company_id: string }).company_id === fx.companyA)).toBe(true);

      // La vista tampoco filtra sola: hereda el RLS de la tabla.
      const vista = await db.query('SELECT company_id FROM tax_affectations_declaradas');
      expect(vista.rows.every((f) => (f as { company_id: string }).company_id === fx.companyA)).toBe(true);

      const deB = await db.query('SELECT 1 FROM tax_affectations WHERE tax_transaction_id = $1', [opB]);
      expect(deB.rowCount).toBe(0);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
