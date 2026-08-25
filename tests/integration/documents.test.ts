/**
 * Candados del esquema documental (§9, §10, §38).
 *
 * Los invariantes que importan acá no son de la aplicación: son de la base. Si
 * dependieran del código, bastaría con un `UPDATE` desde una consola para que la
 * lectura original del OCR quedara reemplazada por lo que escribió una persona,
 * y la métrica de calidad de extracción pasaría a medir, sin que nadie lo note,
 * el trabajo del contador.
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

describe.skipIf(!hasDatabase)('esquema documental', () => {
  let client: Client;
  let fixture: Fixture;

  const hash = (semilla: string): string => semilla.repeat(64).slice(0, 64);

  beforeAll(async () => {
    client = await connect();
    fixture = await seed(client, 'documentos');
  });

  afterAll(async () => {
    await client.end();
  });

  async function crearDocumento(companyId: string, sha: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO documents
         (company_id, storage_key, sha256, bytes, mime, content_type, original_name,
          source, uploaded_by)
       VALUES ($1, $2, $3, 1024, 'application/pdf', 'PDF', 'factura.pdf', 'UPLOAD', 'user:test')
       RETURNING id`,
      [companyId, `empresa/${companyId}/${sha.slice(0, 2)}/${sha}.pdf`, sha],
    );
    return result.rows[0]!.id;
  }

  async function crearExtraccion(companyId: string, documentId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO document_extractions
         (company_id, document_id, engine, engine_version, available, overall_confidence, created_by)
       VALUES ($1, $2, 'mock', '1', true, 0.9, 'user:test')
       RETURNING id`,
      [companyId, documentId],
    );
    return result.rows[0]!.id;
  }

  it('el mismo archivo entra una sola vez por empresa, pero sí entra en otra', async () => {
    const sha = hash('a');
    await crearDocumento(fixture.companyA, sha);

    const repetido = await expectFailureCode(() => crearDocumento(fixture.companyA, sha));
    expect(repetido.code).toBe('23505');

    // La otra empresa no se ve afectada: el mismo proveedor le factura a las dos
    // y unificarlos filtraría información de un tercero.
    await expect(crearDocumento(fixture.companyB, sha)).resolves.toBeTruthy();
  });

  it('un documento no se borra nunca', async () => {
    const documentId = await crearDocumento(fixture.companyA, hash('b'));
    const mensaje = await expectFailure(() =>
      client.query('DELETE FROM documents WHERE id = $1', [documentId]),
    );
    expect(mensaje).toMatch(/Borrado físico prohibido/i);
  });

  it('una lectura extraída no se puede sobrescribir: la corrección se inserta', async () => {
    const documentId = await crearDocumento(fixture.companyA, hash('c'));
    const extractionId = await crearExtraccion(fixture.companyA, documentId);

    await client.query(
      `INSERT INTO document_extraction_fields
         (company_id, extraction_id, field_path, raw_value, parsed_value, confidence, method)
       VALUES ($1, $2, 'importes.total', '1.234,00', '{"kind":"MONEY","amount":"123400","currency":"ARS"}', 0.9, 'REGEX')`,
      [fixture.companyA, extractionId],
    );

    const mensaje = await expectFailure(() =>
      client.query(
        `UPDATE document_extraction_fields SET raw_value = '9.999,00' WHERE extraction_id = $1`,
        [extractionId],
      ),
    );
    expect(mensaje).toMatch(/inmutables/i);

    // La corrección del contador convive con la lectura original.
    await client.query(
      `INSERT INTO document_extraction_fields
         (company_id, extraction_id, field_path, raw_value, confidence, method, nota)
       VALUES ($1, $2, 'importes.total', '1.334,00', 1, 'MANUAL', 'Corregido contra el papel')`,
      [fixture.companyA, extractionId],
    );

    const filas = await client.query<{ method: string; raw_value: string }>(
      `SELECT method, raw_value FROM document_extraction_fields
        WHERE extraction_id = $1 AND field_path = 'importes.total'
        ORDER BY method`,
      [extractionId],
    );
    expect(filas.rows.map((fila) => fila.method)).toEqual(['MANUAL', 'REGEX']);
    expect(filas.rows.map((fila) => fila.raw_value)).toEqual(['1.334,00', '1.234,00']);
  });

  it('solo un dato estructurado o una corrección humana llegan a confianza 1', async () => {
    const documentId = await crearDocumento(fixture.companyA, hash('d'));
    const extractionId = await crearExtraccion(fixture.companyA, documentId);

    const fallo = await expectFailureCode(() =>
      client.query(
        `INSERT INTO document_extraction_fields
           (company_id, extraction_id, field_path, raw_value, confidence, method)
         VALUES ($1, $2, 'importes.total', '1.234,00', 1, 'OCR')`,
        [fixture.companyA, extractionId],
      ),
    );
    expect(fallo.code).toBe('23514'); // check_violation

    await expect(
      client.query(
        `INSERT INTO document_extraction_fields
           (company_id, extraction_id, field_path, raw_value, confidence, method)
         VALUES ($1, $2, 'importes.total', '1234.00', 1, 'XML')`,
        [fixture.companyA, extractionId],
      ),
    ).resolves.toBeTruthy();
  });

  it('un campo interpretado exige haber leído algo', async () => {
    const documentId = await crearDocumento(fixture.companyA, hash('e'));
    const extractionId = await crearExtraccion(fixture.companyA, documentId);

    const fallo = await expectFailureCode(() =>
      client.query(
        `INSERT INTO document_extraction_fields
           (company_id, extraction_id, field_path, raw_value, parsed_value, confidence, method)
         VALUES ($1, $2, 'importes.total', NULL, '{"kind":"TEXT","value":"x"}', 0, 'OCR')`,
        [fixture.companyA, extractionId],
      ),
    );
    expect(fallo.code).toBe('23514');
  });

  it('una extracción no disponible tiene que decir por qué', async () => {
    const documentId = await crearDocumento(fixture.companyA, hash('f'));

    const fallo = await expectFailureCode(() =>
      client.query(
        `INSERT INTO document_extractions
           (company_id, document_id, engine, engine_version, available, created_by)
         VALUES ($1, $2, 'null', '0', false, 'user:test')`,
        [fixture.companyA, documentId],
      ),
    );
    expect(fallo.code).toBe('23514');

    await expect(
      client.query(
        `INSERT INTO document_extractions
           (company_id, document_id, engine, engine_version, available, unavailable_reason, created_by)
         VALUES ($1, $2, 'null', '0', false, 'SIN_MOTOR_OCR', 'user:test')`,
        [fixture.companyA, documentId],
      ),
    ).resolves.toBeTruthy();
  });

  it('un duplicado resuelto exige quién lo resolvió y por qué', async () => {
    const uno = await crearDocumento(fixture.companyA, hash('1'));
    const dos = await crearDocumento(fixture.companyA, hash('2'));

    const dup = await client.query<{ id: string }>(
      `INSERT INTO document_duplicates
         (company_id, document_id, duplicate_of_id, nivel, explicacion, bloquea)
       VALUES ($1, $2, $3, 'COMPROBANTE_REPETIDO', 'Mismo número', true)
       RETURNING id`,
      [fixture.companyA, uno, dos],
    );

    const fallo = await expectFailureCode(() =>
      client.query(`UPDATE document_duplicates SET resolucion = 'ES_DUPLICADO' WHERE id = $1`, [
        dup.rows[0]!.id,
      ]),
    );
    expect(fallo.code).toBe('23514');
  });

  it('un documento no puede ser duplicado de sí mismo', async () => {
    const uno = await crearDocumento(fixture.companyA, hash('3'));
    const fallo = await expectFailureCode(() =>
      client.query(
        `INSERT INTO document_duplicates
           (company_id, document_id, duplicate_of_id, nivel, explicacion, bloquea)
         VALUES ($1, $2, $2, 'ARCHIVO_IDENTICO', 'x', false)`,
        [fixture.companyA, uno],
      ),
    );
    expect(fallo.code).toBe('23514');
  });

  it('RLS aísla los documentos entre empresas del mismo estudio', async () => {
    await crearDocumento(fixture.companyA, hash('7'));

    const visibles = await asCompany(client, fixture.companyB, async () => {
      const result = await client.query('SELECT count(*)::int AS total FROM documents');
      return (result.rows[0] as { total: number }).total;
    });

    const propios = await asCompany(client, fixture.companyA, async () => {
      const result = await client.query('SELECT count(*)::int AS total FROM documents');
      return (result.rows[0] as { total: number }).total;
    });

    expect(propios).toBeGreaterThan(0);
    // La empresa B solo ve lo suyo: el documento de A no está entre sus filas.
    const deB = await asCompany(client, fixture.companyB, async () => {
      const result = await client.query('SELECT count(*)::int AS total FROM documents WHERE sha256 = $1', [
        hash('7'),
      ]);
      return (result.rows[0] as { total: number }).total;
    });
    expect(deB).toBe(0);
    expect(visibles).toBeGreaterThanOrEqual(0);
  });

  it('la aplicación no tiene permiso de UPDATE sobre las lecturas extraídas', async () => {
    const documentId = await crearDocumento(fixture.companyA, hash('8'));
    const extractionId = await crearExtraccion(fixture.companyA, documentId);

    // Además del trigger, el privilegio tampoco está: dos candados
    // independientes. Hizo falta un REVOKE explícito (migración 0017) — las
    // default privileges de la 0009 le conceden UPDATE a `aai_app` sobre toda
    // tabla nueva, y enumerar menos privilegios en un GRANT no revoca nada.
    const fallo = await asCompany(client, fixture.companyA, async () =>
      expectFailureCode(() =>
        client.query(`UPDATE document_extraction_fields SET nota = 'x' WHERE extraction_id = $1`, [
          extractionId,
        ]),
      ),
    );
    expect(fallo.code).toBe('42501');
  });

  it('el catálogo de comprobantes guarda la fuente y si la vigencia fue verificada', async () => {
    const result = await client.query<{
      descripcion: string;
      fuente: string;
      vigencia_verificada: boolean;
      verification_level: string;
    }>('SELECT descripcion, fuente, vigencia_verificada, verification_level FROM arca_comprobante_types WHERE codigo = 1');

    // La semilla se carga con `npm run catalog:seed`; si no corrió, no hay fila.
    if (result.rowCount === 0) return;

    expect(result.rows[0]!.descripcion).toBe('Factura A');
    expect(result.rows[0]!.verification_level).toBe('V1');
    expect(result.rows[0]!.fuente).toMatch(/wsfev1/);
    // El manual enumera los códigos pero no sus fechas de vigencia.
    expect(result.rows[0]!.vigencia_verificada).toBe(false);
  });
});
