/**
 * Motor normativo y bitácora, contra PostgreSQL real.
 *
 * Cubre dos invariantes que el pliego trata como no negociables:
 *   · N-5 / A-8 — ninguna regla se activa sin norma V1, documento archivado y firma.
 *   · A-5 — la cadena de hashes de la bitácora es continua y detecta manipulación.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

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

    // El número sale de la secuencia de PostgreSQL, no del reloj.
    // `Date.now() % 100000` da un contador que **se repite cada 100 segundos**,
    // así que dos corridas seguidas de `npm run verify` chocaban contra
    // `norms_organismo_tipo_numero_anio_key`. Es el mismo defecto que
    // `identificadores.ts` ya documenta para los CUIT: un recorte del reloj no
    // es un identificador único, es un identificador que todavía no chocó.
    const base = await sufijoUnico(client);
    normV1 = await makeNorm(`T${base}1`, 'V1', true);
    normV2 = await makeNorm(`T${base}2`, 'V2', true);
    normV1SinDocumento = await makeNorm(`T${base}3`, 'V1', false);
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

  /**
   * La rama que faltaba, y que costó cara.
   *
   * Durante siete migraciones el único test de esta función fue el de arriba:
   * que **no** reporte roturas en una cadena sana. Un verificador que no
   * verificara nada también lo habría pasado. Y de hecho la función estaba
   * rota: su parámetro de salida se llamaba `found`, que es una variable
   * booleana de PL/pgSQL, así que al encontrar una adulteración intentaba meter
   * un SHA-256 en un booleano y moría con un error de tipos en lugar de
   * reportarla (migración 0059).
   *
   * Este test adultera de verdad. Para lograrlo hay que apagar el trigger que
   * lo impide, que es exactamente el atacante contra el que la cadena defiende:
   * alguien con acceso directo a la base. Todo va dentro de una transacción que
   * se revierte, así que la bitácora queda como estaba.
   */
  it('verify_audit_chain SÍ reporta una entrada adulterada', async () => {
    const objetivo = await client.query<{ id: string }>(
      'SELECT id FROM audit_logs WHERE company_id = $1 ORDER BY seq DESC LIMIT 1',
      [fx.companyA],
    );
    expect(objetivo.rowCount, 'hace falta al menos una entrada para poder adulterarla').toBe(1);

    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE audit_logs DISABLE TRIGGER USER');
      await client.query(`UPDATE audit_logs SET motivo = 'adulterado' WHERE id = $1`, [
        objetivo.rows[0]!.id,
      ]);

      const rotura = await client.query<{
        roto_en: string;
        hash_esperado: string;
        hash_guardado: string;
      }>('SELECT * FROM verify_audit_chain($1)', [fx.companyA]);

      expect(rotura.rowCount, 'la adulteración tiene que salir a la luz').toBe(1);
      expect(rotura.rows[0]!.roto_en).toBe(objetivo.rows[0]!.id);
      // Los dos hashes, y distintos: un reporte que no dice qué se esperaba no
      // sirve para investigar, y uno donde coinciden no está comparando nada.
      expect(rotura.rows[0]!.hash_esperado).not.toBe(rotura.rows[0]!.hash_guardado);
    } finally {
      // Deshace también el DISABLE TRIGGER: en PostgreSQL el DDL es
      // transaccional, así que la tabla vuelve con sus candados puestos.
      await client.query('ROLLBACK');
    }
  });

  it('después de revertir, la cadena vuelve a estar sana y el trigger puesto', async () => {
    // Que el test anterior no deje daño no es un detalle de higiene: si dejara
    // la bitácora rota o el trigger apagado, todo lo que corra después estaría
    // pasando por motivos equivocados.
    const result = await client.query('SELECT * FROM verify_audit_chain($1)', [fx.companyA]);
    expect(result.rowCount).toBe(0);

    const mensaje = await expectFailure(() =>
      client.query(`UPDATE audit_logs SET motivo = 'otra vez' WHERE company_id = $1`, [
        fx.companyA,
      ]),
    );
    expect(mensaje).toMatch(/append-only/);
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
