/**
 * Libro Diario de punta a punta — criterio de salida de la FASE 5.
 *
 * Cubre los tres casos que el §33 exige explícitamente: intento de descuadre,
 * posteo en período cerrado y borrado físico. Y dos más que solo aparecen al
 * correr contra la base: que la numeración no deje huecos bajo concurrencia, y
 * que un asiento anulado conserve su número.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('Libro Diario por HTTP', () => {
  let app: FastifyInstance;
  let raw: Client;
  let token: string;
  let companyId: string;
  let periodoEneroId: string;
  let periodoFebreroId: string;

  const cab = () => ({ authorization: `Bearer ${token}`, 'x-company-id': companyId });

  const asiento = (overrides: Record<string, unknown> = {}) => ({
    journalCode: 'GENERAL',
    entryDate: '2026-01-15',
    description: 'Venta de contado',
    currency: 'ARS',
    lines: [
      { accountCode: '1.1.01', debit: '1210.00', credit: '0' },
      { accountCode: '4.1.01', debit: '0', credit: '1210.00' },
    ],
    source: { type: 'MANUAL', id: null },
    manualJustification: 'Carga manual del contador',
    ...overrides,
  });

  const postear = (cuerpo: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/journal-entries', headers: cab(), payload: cuerpo });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    const stamp = await sufijoUnico(raw);
    const email = `contador-diario-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const passwordHash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });

    const usuario = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email, 'Contador', passwordHash],
    );
    const userId = usuario.rows[0]!.id;

    const org = await raw.query<{ create_organization: string }>(
      'SELECT create_organization($1, $2, $3)',
      [`Estudio diario ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );
    const company = await raw.query<{ create_company: string }>(
      'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        userId, org.rows[0]!.create_organization, 'Empresa diario', withCheckDigit(`33${stamp}`),
        'SRL', 'AR-C', 'IGJ', '12-31',
      ],
    );
    companyId = company.rows[0]!.create_company;
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      userId, companyId, userId, 'CONTADOR',
    ]);

    // MFA: el rol CONTADOR no llega a la empresa sin segundo factor.
    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST', url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      await app.inject({ method: 'POST', url: '/accounts', headers: cab(), payload: cuenta });
    }

    await app.inject({
      method: 'POST',
      url: '/fiscal-years',
      headers: cab(),
      payload: { code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31' },
    });

    const periodos = (
      await app.inject({ method: 'GET', url: '/periods', headers: cab() })
    ).json<{ periods: { id: string; number: number }[] }>().periods;
    periodoEneroId = periodos.find((p) => p.number === 1)!.id;
    periodoFebreroId = periodos.find((p) => p.number === 2)!.id;
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------

  it('postea un asiento cuadrado y lo numera desde 1', async () => {
    const respuesta = await postear(asiento());
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    const cuerpo = respuesta.json<{ entryNumber: number; totalDebit: string; status: string }>();
    expect(cuerpo.entryNumber).toBe(1);
    expect(cuerpo.totalDebit).toBe('1210.00');
    expect(cuerpo.status).toBe('PROPUESTO');
  });

  it('rechaza el descuadre con el error tipado, sin ajustarlo', async () => {
    const respuesta = await postear(
      asiento({
        lines: [
          { accountCode: '1.1.01', debit: '1210.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '1200.00' },
        ],
      }),
    );
    expect(respuesta.statusCode).toBe(422);
    const errores = respuesta.json<{ errores: { code: string; message: string }[] }>().errores;
    expect(errores.map((e) => e.code)).toContain('E_UNBALANCED');
    expect(errores.find((e) => e.code === 'E_UNBALANCED')?.message).toMatch(/no ajusta/);
  });

  it('devuelve TODOS los errores, no solo el primero', async () => {
    const respuesta = await postear(
      asiento({
        manualJustification: undefined,
        entryDate: '2027-05-05',
        lines: [
          { accountCode: '1.1.01', debit: '100.00', credit: '0' },
          { accountCode: '9.9.99', debit: '0', credit: '90.00' },
        ],
      }),
    );
    expect(respuesta.statusCode).toBe(422);
    const codigos = respuesta.json<{ errores: { code: string }[] }>().errores.map((e) => e.code);
    expect(new Set(codigos)).toEqual(
      new Set(['E_ACCOUNT_NOT_POSTABLE', 'E_DATE_OUT_OF_PERIOD', 'E_NO_TRACEABILITY']),
    );
  });

  it('un asiento sin origen demostrable no se postea ni a mano', async () => {
    const respuesta = await postear(asiento({ manualJustification: undefined }));
    expect(respuesta.statusCode).toBe(422);
    expect(respuesta.json<{ errores: { code: string }[] }>().errores.map((e) => e.code)).toContain(
      'E_NO_TRACEABILITY',
    );
  });

  it('la numeración es correlativa y no deja huecos bajo concurrencia', async () => {
    // Diez posteos simultáneos. Con una `sequence` de PostgreSQL esto dejaría
    // huecos ante cualquier rollback; con el contador tomado para actualización,
    // no. Un libro rubricado con saltos no se puede defender ante nadie.
    const respuestas = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postear(asiento({ description: `Concurrente ${i}` })),
      ),
    );
    expect(respuestas.every((r) => r.statusCode === 201)).toBe(true);

    const numeros = await raw.query<{ entry_number: number }>(
      `SELECT entry_number FROM journal_entries
        WHERE company_id = $1 AND journal_code = 'GENERAL' ORDER BY entry_number`,
      [companyId],
    );
    const secuencia = numeros.rows.map((f) => f.entry_number);
    expect(secuencia).toEqual(Array.from({ length: secuencia.length }, (_, i) => i + 1));
  });

  it('no postea en un período cerrado', async () => {
    await app.inject({
      method: 'POST',
      url: `/periods/${periodoFebreroId}/close`,
      headers: cab(),
    });

    const respuesta = await postear(asiento({ entryDate: '2026-02-10' }));
    expect(respuesta.statusCode).toBe(422);
    const errores = respuesta.json<{ errores: { code: string; message: string }[] }>().errores;
    expect(errores.map((e) => e.code)).toContain('E_PERIOD_CLOSED');
    expect(errores.find((e) => e.code === 'E_PERIOD_CLOSED')?.message).toMatch(/reapertura/);
  });

  it('un comprobante no genera dos asientos vigentes', async () => {
    const documento = await raw.query<{ id: string }>(
      `INSERT INTO documents
         (company_id, storage_key, sha256, bytes, mime, content_type, original_name, source, uploaded_by)
       VALUES ($1, 'k', $2, 10, 'application/xml', 'XML', 'c.xml', 'UPLOAD', 'user:test')
       RETURNING id`,
      [companyId, 'e'.repeat(64)],
    );
    const sourceId = documento.rows[0]!.id;

    const primera = await postear(asiento({ source: { type: 'INVOICE', id: sourceId } }));
    expect(primera.statusCode).toBe(201);

    const segunda = await postear(asiento({ source: { type: 'INVOICE', id: sourceId } }));
    expect(segunda.statusCode).toBe(422);
    expect(segunda.json<{ errores: { code: string }[] }>().errores.map((e) => e.code)).toContain(
      'E_DUPLICATE_SOURCE',
    );
  });

  it('aprobar, contraponer, y el original conserva su número', async () => {
    const creado = (await postear(asiento({ description: 'A contraponer' }))).json<{
      id: string;
      entryNumber: number;
    }>();

    const aprobado = await app.inject({
      method: 'POST',
      url: `/journal-entries/${creado.id}/approve`,
      headers: cab(),
    });
    expect(aprobado.statusCode, aprobado.body).toBe(200);

    const reversion = await app.inject({
      method: 'POST',
      url: `/journal-entries/${creado.id}/reverse`,
      headers: cab(),
      payload: { motivo: 'Error de imputación detectado en la revisión' },
    });
    expect(reversion.statusCode, reversion.body).toBe(201);

    const original = await raw.query<{ status: string; entry_number: number }>(
      'SELECT status, entry_number FROM journal_entries WHERE id = $1',
      [creado.id],
    );
    expect(original.rows[0]!.status).toBe('ANULADO');
    // El hueco en la secuencia sería peor que el asiento anulado.
    expect(original.rows[0]!.entry_number).toBe(creado.entryNumber);

    const contra = await raw.query<{ kind: string; reverses_entry_id: string; total_debit: string }>(
      'SELECT kind, reverses_entry_id, total_debit::text FROM journal_entries WHERE id = $1',
      [reversion.json<{ contraasientoId: string }>().contraasientoId],
    );
    expect(contra.rows[0]!.kind).toBe('REVERSION');
    expect(contra.rows[0]!.reverses_entry_id).toBe(creado.id);
    expect(contra.rows[0]!.total_debit).toBe('1210.00');
  });

  it('no se contrapone un asiento que no está aprobado', async () => {
    const creado = (await postear(asiento({ description: 'Propuesto' }))).json<{ id: string }>();
    const respuesta = await app.inject({
      method: 'POST',
      url: `/journal-entries/${creado.id}/reverse`,
      headers: cab(),
      payload: { motivo: 'no debería poder' },
    });
    expect(respuesta.statusCode).toBe(409);
  });

  it('el borrado físico está prohibido', async () => {
    const alguno = await raw.query<{ id: string }>(
      'SELECT id FROM journal_entries WHERE company_id = $1 LIMIT 1',
      [companyId],
    );
    const mensaje = await expectFailure(() =>
      raw.query('DELETE FROM journal_entries WHERE id = $1', [alguno.rows[0]!.id]),
    );
    expect(mensaje).toMatch(/Borrado físico prohibido/i);
  });

  it('el balance de sumas y saldos cumple las tres igualdades', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/reports/trial-balance?desde=2026-01-01&hasta=2026-12-31',
      headers: cab(),
    });
    expect(respuesta.statusCode, respuesta.body).toBe(200);

    const cuerpo = respuesta.json<{
      cuadra: boolean;
      verificaciones: { codigo: string; cumple: boolean }[];
      totales: { debitos: string; creditos: string };
      lineas: { codigo: string; saldoFinal: string }[];
      modoDegradado?: boolean;
    }>();

    expect(cuerpo.cuadra).toBe(true);
    expect(cuerpo.verificaciones.every((v) => v.cumple)).toBe(true);
    expect(cuerpo.totales.debitos).toBe(cuerpo.totales.creditos);
    expect(cuerpo.modoDegradado).toBeUndefined();
    // Solo entran los asientos aprobados: los propuestos todavía no son
    // contabilidad, y sumarlos daría un balance que nadie aprobó.
    expect(cuerpo.lineas.length).toBeGreaterThan(0);
  });

  it('el período de enero sigue abierto y admite asientos', async () => {
    const respuesta = await postear(asiento({ description: 'Enero sigue abierto' }));
    expect(respuesta.statusCode).toBe(201);
    expect(periodoEneroId).toBeTruthy();
  });
});
