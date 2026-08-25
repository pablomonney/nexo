/**
 * Candados de FASE 4 en la base.
 *
 * El más importante del sistema entero es `je_ai_requires_human_approval`: un
 * asiento originado en una predicción de IA no puede llegar a `APROBADO` sin
 * `approved_by`. Es la promesa central del producto —la IA propone, no escribe—
 * escrita como constraint y no como intención.
 *
 * El resto son los que hacen que la propuesta sea auditable dos años después:
 * el prompt archivado e inmutable, y la coherencia entre la banda de confianza y
 * los disparadores duros.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  connect,
  expectFailure,
  expectFailureCode,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

describe.skipIf(!hasDatabase)('candados de clasificación asistida', () => {
  let client: Client;
  let fixture: Fixture;
  let promptHash: string;

  beforeAll(async () => {
    client = await connect();
    fixture = await seed(client, 'ia');

    const texto = `prompt de prueba ${process.pid} ${Date.now()}`;
    promptHash = createHash('sha256').update(texto, 'utf8').digest('hex');
    await client.query(
      'INSERT INTO prompt_versions (hash, name, version, texto) VALUES ($1, $2, $3, $4)',
      [promptHash, `test-${process.pid}${Date.now()}`, 'v1', texto],
    );
  });

  afterAll(async () => {
    await client.end();
  });

  /** Números de asiento únicos: la numeración por empresa y ejercicio es única. */
  let siguienteNumero = 0;
  function numeroDeAsiento(): number {
    siguienteNumero += 1;
    return siguienteNumero;
  }

  async function crearPrediccion(
    banda: string,
    bloqueos: string[] = [],
    hash = promptHash,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ai_predictions
         (company_id, agent, model_provider, model_id, prompt_hash, input_ref,
          output, confidence, reason, triage_band, hard_blocks)
       VALUES ($1, 'CLASSIFICATION', 'mock', 'mock-1', $2, 'doc-1',
               '{"cuentaId":"x"}'::jsonb, 0.9, 'porque sí', $3, $4)
       RETURNING id`,
      [fixture.companyA, hash, banda, bloqueos],
    );
    return result.rows[0]!.id;
  }

  // -------------------------------------------------------------------------
  // El candado central
  // -------------------------------------------------------------------------

  it('un asiento originado en IA no puede aprobarse sin firma humana', async () => {
    const predictionId = await crearPrediccion('MEDIA');

    // El asiento se arma completo dentro de una transacción: el trigger diferido
    // `je_entry_consistent` exige al menos dos líneas cuadradas al commitear.
    const crear = async (status: string, approvedBy: string | null): Promise<string> => {
      await client.query('BEGIN');
      try {
        const entrada = await client.query<{ id: string }>(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, status, total_debit, total_credit, source_type, ai_prediction_id,
              created_by, approved_by, approved_at)
           VALUES ($1, 'GRAL', $2, $3, $4, '2025-01-15', 'Asiento propuesto por IA', $5,
                   100.00, 100.00, 'INVOICE', $6, 'ai:CLASSIFICATION', $7,
                   CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
           RETURNING id`,
          [
            fixture.companyA,
            fixture.periodA,
            fixture.fiscalYearA,
            numeroDeAsiento(),
            status,
            predictionId,
            approvedBy,
          ],
        );
        const entryId = entrada.rows[0]!.id;
        await client.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, description)
           VALUES ($1, $2, 1, $3, 100.00, 0, 'debe'),
                  ($1, $2, 2, $4, 0, 100.00, 'haber')`,
          [fixture.companyA, entryId, fixture.cashA, fixture.salesA],
        );
        await client.query('COMMIT');
        return entryId;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };

    // Propuesto sin aprobador: bien.
    await expect(crear('PROPUESTO', null)).resolves.toBeTruthy();

    // Aprobado sin aprobador: imposible. Es ADR-001 hecho constraint.
    const fallo = await expectFailureCode(() => crear('APROBADO', null));
    expect(fallo.code).toBe('23514');

    // Aprobado con una persona detrás: permitido.
    await expect(crear('APROBADO', 'user:contador')).resolves.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Prompts
  // -------------------------------------------------------------------------

  it('no se puede registrar una predicción con un prompt que no está archivado', async () => {
    const inventado = 'f'.repeat(64);
    const fallo = await expectFailureCode(() => crearPrediccion('MEDIA', [], inventado));
    expect(fallo.code).toBe('23503'); // foreign_key_violation
  });

  it('un prompt archivado es inmutable', async () => {
    const mensaje = await expectFailure(() =>
      client.query('UPDATE prompt_versions SET texto = $2 WHERE hash = $1', [
        promptHash,
        'otro texto',
      ]),
    );
    expect(mensaje).toMatch(/inmutable/i);

    // Cambiar metadatos que no alteran el contenido sí se puede.
    await expect(
      client.query('UPDATE prompt_versions SET version = $2 WHERE hash = $1', [promptHash, 'v1.1']),
    ).resolves.toBeTruthy();
  });

  it('un prompt no se borra: hay predicciones que lo citan', async () => {
    const mensaje = await expectFailure(() =>
      client.query('DELETE FROM prompt_versions WHERE hash = $1', [promptHash]),
    );
    expect(mensaje).toMatch(/Borrado físico prohibido/i);
  });

  // -------------------------------------------------------------------------
  // Coherencia del triage
  // -------------------------------------------------------------------------

  it('una propuesta con disparadores duros no puede quedar en banda ALTA', async () => {
    // Sin este candado, un bug en el código podría escribir "ALTA" con bloqueos
    // y la propuesta entraría al lote de aprobación.
    const fallo = await expectFailureCode(() => crearPrediccion('ALTA', ['PROVEEDOR_APOCRIFO']));
    expect(fallo.code).toBe('23514');

    await expect(crearPrediccion('BAJA', ['PROVEEDOR_APOCRIFO'])).resolves.toBeTruthy();
    await expect(crearPrediccion('ALTA', [])).resolves.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Revisión
  // -------------------------------------------------------------------------

  it('una modificación tiene que decir a qué se corrigió, y un rechazo por qué', async () => {
    const predictionId = await crearPrediccion('MEDIA');

    const revisar = (decision: string, corrected: string | null, motivo: string | null) =>
      client.query(
        `INSERT INTO ai_reviews (company_id, prediction_id, reviewer_id, decision, corrected_output, motivo)
         VALUES ($1, $2, 'user:contador', $3, $4::jsonb, $5)`,
        [fixture.companyA, predictionId, decision, corrected, motivo],
      );

    expect((await expectFailureCode(() => revisar('MODIFICADA', null, 'x'))).code).toBe('23514');
    expect((await expectFailureCode(() => revisar('RECHAZADA', null, null))).code).toBe('23514');
    await expect(revisar('APROBADA', null, null)).resolves.toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Preferencias
  // -------------------------------------------------------------------------

  it('una señal admite varias cuentas candidatas compitiendo', async () => {
    const signal = `proveedor:${Date.now()}`;
    const insertar = (cuenta: string, apoyo: number) =>
      client.query(
        `INSERT INTO classification_preferences
           (company_id, signal, suggested_account_id, support_count)
         VALUES ($1, $2, $3, $4)`,
        [fixture.companyA, signal, cuenta, apoyo],
      );

    await insertar(fixture.cashA, 3);
    // La misma señal con otra cuenta: antes de la 0018 esto era imposible, y un
    // cambio de criterio pisaba las confirmaciones anteriores.
    await expect(insertar(fixture.salesA, 1)).resolves.toBeTruthy();

    // Repetir el mismo par sí choca.
    expect((await expectFailureCode(() => insertar(fixture.cashA, 1))).code).toBe('23505');
  });

  it('un rechazo automático se registra y distingue invención de error de criterio', async () => {
    const insertar = (motivo: string, esAlucinacion: boolean) =>
      client.query(
        `INSERT INTO ai_rejections
           (company_id, agent, model_provider, model_id, prompt_hash, motivo, es_alucinacion, detalle)
         VALUES ($1, 'CLASSIFICATION', 'mock', 'mock-1', $2, $3, $4, 'detalle')`,
        [fixture.companyA, promptHash, motivo, esAlucinacion],
      );

    await expect(insertar('CITA_NO_RESOLUBLE', true)).resolves.toBeTruthy();
    await expect(insertar('CUENTA_NO_IMPUTABLE', false)).resolves.toBeTruthy();

    const conteo = await client.query<{ alucinaciones: string }>(
      `SELECT count(*) FILTER (WHERE es_alucinacion)::text AS alucinaciones
         FROM ai_rejections WHERE company_id = $1`,
      [fixture.companyA],
    );
    expect(Number(conteo.rows[0]!.alucinaciones)).toBeGreaterThan(0);
  });

  it('la bandeja solo muestra lo que todavía nadie revisó', async () => {
    const sinRevisar = await crearPrediccion('MEDIA');
    const revisada = await crearPrediccion('MEDIA');
    await client.query(
      `INSERT INTO ai_reviews (company_id, prediction_id, reviewer_id, decision)
       VALUES ($1, $2, 'user:contador', 'APROBADA')`,
      [fixture.companyA, revisada],
    );

    const pendientes = await client.query<{ id: string }>(
      'SELECT id FROM predictions_pendientes WHERE company_id = $1',
      [fixture.companyA],
    );
    const ids = pendientes.rows.map((fila) => fila.id);
    expect(ids).toContain(sinRevisar);
    expect(ids).not.toContain(revisada);
  });
});
