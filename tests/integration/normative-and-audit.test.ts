/**
 * Motor normativo y bitácora, contra PostgreSQL real.
 *
 * Cubre dos invariantes que el pliego trata como no negociables:
 *   · N-5 / A-8 — ninguna regla se activa sin norma V1, documento archivado y firma.
 *   · A-5 — la cadena de hashes de la bitácora es continua y detecta manipulación.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Motor normativo — una regla no se activa sin fuente verificada', () => {
  let client: Client;
  let normV1: string;
  let normV2: string;
  let normV1SinDocumento: string;

  beforeAll(async () => {
    client = await connect();

    const makeNorm = async (numero: string, level: string, withDocument: boolean) => {
      const norm = await client.query<{ id: string }>(
        `INSERT INTO norms (organismo, tipo, numero, anio, titulo, jurisdiccion, hierarchy_level)
         VALUES ('ARCA', 'RG', $1, 2024, 'Norma de prueba', 'AR', 2) RETURNING id`,
        [numero],
      );
      const version = await client.query<{ id: string }>(
        `INSERT INTO norm_versions (norm_id, version, fecha_emision, fecha_vigencia, verification_level)
         VALUES ($1, 1, '2024-01-01', '2024-01-01', $2) RETURNING id`,
        [norm.rows[0]!.id, level],
      );
      const versionId = version.rows[0]!.id;
      if (withDocument) {
        await client.query(
          `INSERT INTO norm_documents (norm_version_id, url_oficial, storage_key, sha256, mime, bytes, captured_by)
           VALUES ($1, 'https://servicios.infoleg.gob.ar/x', 'norms/x.htm', $2, 'text/html', 1234, 'tester')`,
          [versionId, 'a'.repeat(64)],
        );
      }
      return versionId;
    };

    normV1 = await makeNorm(`T${Date.now() % 100000}`, 'V1', true);
    normV2 = await makeNorm(`T${(Date.now() % 100000) + 1}`, 'V2', true);
    normV1SinDocumento = await makeNorm(`T${(Date.now() % 100000) + 2}`, 'V1', false);
  });

  afterAll(async () => {
    await client?.end();
  });

  const insertRule = (normVersionId: string, status: string, approvedBy: string | null) =>
    client.query(
      `INSERT INTO accounting_rules
        (rule_key, version, norm_version_id, domain, valid_from, jurisdiction,
         conditions, action, status, proposed_by, approved_by, approved_at)
       -- El cast explícito de $4 es necesario: dentro de un CASE, PostgreSQL no
       -- puede inferir el tipo de un parámetro que solo aparece en IS NULL.
       VALUES ($1, 1, $2, 'tax', '2024-01-01', 'AR', '{}'::jsonb, '{}'::jsonb, $3, 'proponente', $4::text,
               CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`,
      [`R-${Math.random().toString(36).slice(2, 10)}`, normVersionId, status, approvedBy],
    );

  it('permite activar una regla con norma V1, documento y aprobador', async () => {
    await expect(insertRule(normV1, 'ACTIVE', 'aprobador')).resolves.toBeDefined();
  });

  it('rechaza activar una regla sin aprobador', async () => {
    const message = await expectFailure(() => insertRule(normV1, 'ACTIVE', null));
    expect(message).toMatch(/rule_active_requires_approval/);
  });

  it('rechaza activar una regla apoyada en una norma que no está en V1', async () => {
    const message = await expectFailure(() => insertRule(normV2, 'ACTIVE', 'aprobador'));
    expect(message).toMatch(/nivel V2|se requiere V1/);
  });

  it('rechaza activar una regla cuya norma no tiene documento archivado', async () => {
    const message = await expectFailure(() => insertRule(normV1SinDocumento, 'ACTIVE', 'aprobador'));
    expect(message).toMatch(/documento original archivado/);
  });

  it('rechaza que la misma persona proponga y apruebe', async () => {
    const message = await expectFailure(() => insertRule(normV1, 'ACTIVE', 'proponente'));
    expect(message).toMatch(/rule_segregation_of_duties/);
  });

  it('sí permite dejarla en DRAFT sin aprobación', async () => {
    await expect(insertRule(normV2, 'DRAFT', null)).resolves.toBeDefined();
  });

  it('el documento normativo archivado no se puede borrar', async () => {
    const message = await expectFailure(() =>
      client.query('DELETE FROM norm_documents WHERE norm_version_id = $1', [normV1]),
    );
    expect(message).toMatch(/Borrado físico prohibido/);
  });
});

suite('Bitácora — cadena de hashes', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, `aud${Date.now() % 100000}`);
    for (let i = 0; i < 5; i += 1) {
      await client.query(
        `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id)
         VALUES ($1, 'USER', 'contador', 'APROBAR_ASIENTO', 'journal_entry', $2)`,
        [fx.companyA, `obj-${i}`],
      );
    }
  });

  afterAll(async () => {
    await client?.end();
  });

  it('el primer registro encadena desde ceros y los siguientes desde el anterior', async () => {
    const rows = await client.query<{ prev_hash: string; hash: string }>(
      `SELECT prev_hash, hash FROM audit_logs WHERE company_id = $1 ORDER BY occurred_at, id`,
      [fx.companyA],
    );
    expect(rows.rows[0]!.prev_hash).toBe('0'.repeat(64));
    for (let i = 1; i < rows.rows.length; i += 1) {
      expect(rows.rows[i]!.prev_hash).toBe(rows.rows[i - 1]!.hash);
    }
  });

  it('verify_audit_chain no reporta roturas en una cadena sana', async () => {
    const result = await client.query('SELECT * FROM verify_audit_chain($1)', [fx.companyA]);
    expect(result.rowCount).toBe(0);
  });

  it('la bitácora no admite UPDATE ni DELETE ni siquiera como superusuario', async () => {
    const updateMessage = await expectFailure(() =>
      client.query(`UPDATE audit_logs SET motivo = 'alterado' WHERE company_id = $1`, [fx.companyA]),
    );
    expect(updateMessage).toMatch(/append-only/);

    const deleteMessage = await expectFailure(() =>
      client.query('DELETE FROM audit_logs WHERE company_id = $1', [fx.companyA]),
    );
    expect(deleteMessage).toMatch(/append-only/);
  });

  it('exige motivo en las acciones excepcionales', async () => {
    const message = await expectFailure(() =>
      client.query(
        `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id)
         VALUES ($1, 'USER', 'admin', 'REABRIR_PERIODO', 'period', 'p1')`,
        [fx.companyA],
      ),
    );
    expect(message).toMatch(/audit_reason_required/);
  });
});
