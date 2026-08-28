/**
 * La tercera vía de trazabilidad, contra la base y por HTTP.
 *
 * El motor puro ya tiene sus tests en `packages/accounting-engine`. Lo que se
 * prueba acá es lo que el motor **no puede** probar: que el contexto resuelva la
 * decisión solo cuando corresponde. Un `decisionId` de otra empresa, de ambiente
 * PRUEBA o de otro comprobante tiene que llegar al motor como `null`, y el motor
 * no tiene forma de averiguarlo por su cuenta.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';
const FECHA = '2026-04-15';

suite('trazabilidad por decisión — el contexto resuelve o no resuelve', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let companyA: string;
  let companyB: string;
  let opA: string;
  let otraOpA: string;
  let opB: string;

  const pedir = (url: string, payload: unknown, empresa: string = companyA) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });

  /** El cuerpo mínimo de un asiento que cuadra. */
  const asiento = (extra: Record<string, unknown>, sourceId: string | null) => ({
    journalCode: 'GENERAL',
    entryDate: FECHA,
    description: 'Prueba de trazabilidad',
    kind: 'NORMAL',
    status: 'PROPUESTO',
    currency: 'ARS',
    source: { type: 'INVOICE', id: sourceId },
    lines: [
      { accountCode: '1.1.01', debit: '100.00', credit: '0', currency: 'ARS' },
      { accountCode: '4.1.01', debit: '0', credit: '100.00', currency: 'ARS' },
    ],
    ...extra,
  });

  async function decisionSobre(
    taxTransactionId: string,
    empresa: string,
    ambiente: 'PRODUCTIVO' | 'PRUEBA' = 'PRODUCTIVO',
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO accounting_decisions
         (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
          ambiente, decidida_por, justificacion)
       VALUES ($1,$2,'MANUAL','PROPUESTA_DE_ASIENTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
               $3,'user:contadora','Decidido a mano, con justificacion suficientemente larga')
       RETURNING id`,
      [empresa, taxTransactionId, ambiente],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const email = `contadora-traza-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    const user = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Contadora', hash],
    );
    const userId = user.rows[0]!.id;
    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1,$2,$3)',
      [`Estudio traza ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );

    const armar = async (nombre: string, prefijo: string): Promise<string> => {
      const c = await db.query<{ create_company: string }>(
        'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, org.rows[0]!.create_organization, nombre, withCheckDigit(`${prefijo}${stamp}`),
         'SRL', 'AR-C', 'IGJ', '12-31'],
      );
      const id = c.rows[0]!.create_company;
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, 'CONTADOR']);

      const fy = await db.query<{ id: string }>(
        `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
         VALUES ($1,$2,'2026-01-01','2026-12-31') RETURNING id`,
        [id, `EJ2026-${prefijo}${stamp}`],
      );
      await db.query(
        `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
         VALUES ($1,$2,4,'2026-04-01','2026-04-30')`,
        [id, fy.rows[0]!.id],
      );
      const chart = await db.query<{ id: string }>(
        `INSERT INTO account_charts (company_id, name) VALUES ($1,'Plan') RETURNING id`, [id],
      );
      for (const [code, name, tipo, nat] of [
        ['1.1.01', 'Caja', 'ACTIVO', 'DEUDORA'],
        ['4.1.01', 'Ventas', 'INGRESO', 'ACREEDORA'],
      ] as const) {
        await db.query(
          `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, chart.rows[0]!.id, code, name, tipo, nat],
        );
      }
      return id;
    };
    companyA = await armar('Empresa traza A', '33');
    companyB = await armar('Empresa traza B', '34');

    const inicial = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } }))
      .json<{ token: string }>().token;
    const secret = (await app.inject({
      method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` },
    })).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST', url: '/auth/mfa/confirm', payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } }))
      .json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify', payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    const tax = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    const crearOp = async (empresa: string, numero: number): Promise<string> => {
      const p = await db.query<{ id: string }>(
        'SELECT id FROM periods WHERE company_id = $1 LIMIT 1', [empresa],
      );
      const r = await db.query<{ id: string }>(
        `INSERT INTO tax_transactions
           (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
            cbte_fecha, condicion_iva, neto, iva, no_gravado, exento, percepciones, total, created_by)
         VALUES ($1,$2,$3,'VENTAS',11,1,$4,$5,'CONSUMIDOR_FINAL',100,0,0,0,0,100,'traza')
         RETURNING id`,
        [empresa, tax.rows[0]!.id, p.rows[0]!.id, numero, FECHA],
      );
      return r.rows[0]!.id;
    };
    opA = await crearOp(companyA, 930001);
    otraOpA = await crearOp(companyA, 930002);
    opB = await crearOp(companyB, 930003);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('B · decisión válida, sin reglas y sin justificación manual → el asiento entra', async () => {
    const d = await decisionSobre(opA, companyA);
    const r = await pedir('/journal-entries', asiento({ decisionId: d }, opA));
    expect(r.statusCode, r.body).toBe(201);

    const e = await db.query<{ decision_id: string; manual_justification: string | null }>(
      'SELECT decision_id, manual_justification FROM journal_entries WHERE id = $1',
      [r.json<{ id: string }>().id],
    );
    expect(e.rows[0]!.decision_id).toBe(d);
    // Lo que este cambio vino a eliminar: la justificación repetida.
    expect(e.rows[0]!.manual_justification).toBeNull();
  });

  it('C · sin decisión, sin reglas y sin justificación → E_NO_TRACEABILITY', async () => {
    const r = await pedir('/journal-entries', asiento({}, null));
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('E_NO_TRACEABILITY');
    expect(r.body).toContain('decisión contable');
  });

  it('D · un decisionId inexistente se rechaza con E_DECISION_NOT_FOUND', async () => {
    const r = await pedir(
      '/journal-entries',
      asiento({ decisionId: '01a04000-0000-7000-8000-0000dead0001' }, otraOpA),
    );
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('E_DECISION_NOT_FOUND');
  });

  it('E · una decisión de OTRA empresa no se resuelve', async () => {
    // El RLS la esconde del contexto, así que el motor la recibe como `null` y
    // el asiento se rechaza antes de que el trigger de la base tenga que actuar.
    const ajena = await decisionSobre(opB, companyB);
    const r = await pedir('/journal-entries', asiento({ decisionId: ajena }, otraOpA));
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('E_DECISION_NOT_FOUND');
  });

  it('F · una decisión de OTRO comprobante de la misma empresa tampoco', async () => {
    const deOpA = await decisionSobre(otraOpA, companyA);
    // Se cita esa decisión para un asiento cuyo origen es `opA`, no `otraOpA`.
    const r = await pedir('/journal-entries', asiento({ decisionId: deOpA }, opA));
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('E_DECISION_NOT_FOUND');
  });

  it('una decisión de ambiente PRUEBA no funda un asiento productivo', async () => {
    // Su propia operación: el índice `accounting_decisions_una_vigente` impide
    // que dos decisiones vivas compartan comprobante, y reusar una del test
    // anterior estaría midiendo ese candado en vez de éste.
    const tax = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    const periodo = await db.query<{ id: string }>(
      'SELECT id FROM periods WHERE company_id = $1 LIMIT 1',
      [companyA],
    );
    const op = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
          cbte_fecha, condicion_iva, neto, iva, no_gravado, exento, percepciones, total, created_by)
       VALUES ($1,$2,$3,'VENTAS',11,1,930009,$4,'CONSUMIDOR_FINAL',100,0,0,0,0,100,'traza')
       RETURNING id`,
      [companyA, tax.rows[0]!.id, periodo.rows[0]!.id, FECHA],
    );
    const dePrueba = await db.query<{ id: string }>(
      `INSERT INTO accounting_decisions
         (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
          ambiente, decidida_por, justificacion)
       VALUES ($1,$2,'MANUAL','SIN_EFECTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'PRUEBA',
               'user:contadora','De prueba, con justificacion suficientemente larga')
       RETURNING id`,
      [companyA, op.rows[0]!.id],
    );
    const r = await pedir('/journal-entries', asiento({ decisionId: dePrueba.rows[0]!.id }, null));
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('E_DECISION_NOT_FOUND');
  });

  it('I · el asiento tradicional con justificación manual sigue entrando', async () => {
    const r = await pedir(
      '/journal-entries',
      asiento({ manualJustification: 'Ajuste resuelto por la contadora, como siempre.' }, null),
    );
    expect(r.statusCode, r.body).toBe(201);
  });

  it('K · el contraasiento sigue funcionando sin decision_id', async () => {
    // Un contraasiento se funda en `reverses_entry_id`, no en una decisión. Que
    // la trazabilidad ahora admita decisiones no puede haberle cambiado nada.
    const original = await pedir(
      '/journal-entries',
      asiento({ manualJustification: 'Asiento a revertir, con su justificacion.' }, null),
    );
    expect(original.statusCode, original.body).toBe(201);
    const entryId = original.json<{ id: string }>().id;

    await db.query(
      `UPDATE journal_entries SET status = 'APROBADO', approved_by = 'user:otra', approved_at = now()
        WHERE id = $1`,
      [entryId],
    );

    const contra = await pedir(`/journal-entries/${entryId}/reverse`, {
      motivo: 'Se revierte por error en la imputación de la cuenta.',
      entryDate: FECHA,
    });
    expect(contra.statusCode, contra.body).toBeLessThan(300);

    const c = await db.query<{ decision_id: string | null; reverses_entry_id: string }>(
      'SELECT decision_id, reverses_entry_id FROM journal_entries WHERE reverses_entry_id = $1',
      [entryId],
    );
    expect(c.rowCount).toBe(1);
    expect(c.rows[0]!.decision_id).toBeNull();
    expect(c.rows[0]!.reverses_entry_id).toBe(entryId);
  });
});
