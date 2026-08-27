/**
 * El flujo productivo, por HTTP: comprobante → decisión → asiento → Diario.
 *
 * Lo que cambia respecto de la fase anterior es dónde vive la escritura. Antes
 * `accounting_decisions` solo se llenaba desde los tests; acá la llena la API, y
 * estos tests ejercitan el endpoint real.
 *
 * Caso: Factura C 0001-00000005 del corpus, sin modificar, con
 * `AR-IVA-CF-VINCULACION-001` en DRAFT.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailureCode, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const CLAVE = 'AR-IVA-CF-VINCULACION-001';
const RAIZ = join(import.meta.dirname, '..', '..');
const PASSWORD = 'una-contrasena-suficientemente-larga';

interface DelCorpus {
  ptoVta: number;
  cbteTipo: number;
  cbteNro: number;
  cbteFch: string;
  impTotal: number;
  cae: string;
  cuitEmisor: string;
}

function delCorpus(): DelCorpus | null {
  try {
    const l = JSON.parse(
      readFileSync(join(RAIZ, 'var', 'corpus-homologacion', 'comprobantes.json'), 'utf8'),
    ) as DelCorpus[];
    return l[0] ?? null;
  } catch {
    return null;
  }
}

const COMPROBANTE = delCorpus();
const suite = hasDatabase && COMPROBANTE !== null ? describe : describe.skip;

suite('flujo productivo — decisión por HTTP', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let companyA: string;
  let companyB: string;
  let periodId: string;
  let fiscalYearId: string;
  let opA: string;
  let opB: string;
  let fecha: string;

  const pedir = (metodo: 'POST' | 'GET', url: string, payload?: unknown, empresa = companyA) =>
    app.inject({
      method: metodo,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const user = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [`contadora-dec-${stamp}@estudio.test`, 'Contadora', hash],
    );
    const userId = user.rows[0]!.id;

    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1, $2, $3)',
      [`Estudio dec ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );
    const orgId = org.rows[0]!.create_organization;

    const hacerEmpresa = async (nombre: string, prefijo: string): Promise<string> => {
      const r = await db.query<{ create_company: string }>(
        'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
        [userId, orgId, nombre, withCheckDigit(`${prefijo}${stamp}`), 'SRL', 'AR-C', 'IGJ', '12-31'],
      );
      const id = r.rows[0]!.create_company;
      // CONTADOR y no CARGADOR: `journal_entry:create` —el permiso que exige
      // decidir sobre un comprobante— lo tiene solo ese rol.
      await db.query('SELECT grant_company_role($1, $2, $3, $4)', [userId, id, userId, 'CONTADOR']);
      return id;
    };
    companyA = await hacerEmpresa('Empresa dec A', '33');
    companyB = await hacerEmpresa('Empresa dec B', '34');

    // MFA: el rol CONTADOR no llega a la empresa sin segundo factor.
    const email = `contadora-dec-${stamp}@estudio.test`;
    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    // Ejercicio, período y plan mínimo para la empresa A.
    const c = COMPROBANTE!;
    fecha = `${c.cbteFch.slice(0, 4)}-${c.cbteFch.slice(4, 6)}-${c.cbteFch.slice(6, 8)}`;
    const anio = fecha.slice(0, 4);
    const mes = Number(fecha.slice(5, 7));

    const fy = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyA, `EJ${anio}-api`, `${anio}-01-01`, `${anio}-12-31`],
    );
    fiscalYearId = fy.rows[0]!.id;
    const p = await db.query<{ id: string }>(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        companyA,
        fiscalYearId,
        mes,
        `${fecha.slice(0, 7)}-01`,
        new Date(Date.UTC(Number(anio), mes, 0)).toISOString().slice(0, 10),
      ],
    );
    periodId = p.rows[0]!.id;

    const chart = await db.query<{ id: string }>(
      `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan') RETURNING id`,
      [companyA],
    );
    const cuenta = async (code: string, name: string, tipo: string, nat: string) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyA, chart.rows[0]!.id, code, name, tipo, nat],
      );
      return r.rows[0]!.id;
    };
    // Se crean por su efecto: el payload de asiento las referencia por código.
    await cuenta('1.1.01', 'Caja', 'ACTIVO', 'DEUDORA');
    await cuenta('4.1.01', 'Ventas', 'INGRESO', 'ACREEDORA');

    const impuesto = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    // numeric(18,2) lleva PESOS con dos decimales. Guardar centavos acá
    // multiplicaba el importe por cien y nadie lo notaba: los totales cerraban
    // igual porque el error era el mismo de los dos lados.
    const total = c.impTotal.toFixed(2);
    const crearOp = async (empresa: string, periodo: string | null, nro: number) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO tax_transactions
           (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
            cbte_fecha, cuit_contraparte, razon_social, condicion_iva, neto, iva,
            no_gravado, exento, percepciones, total, constatacion, created_by)
         VALUES ($1,$2,$3,'VENTAS',$4,$5,$6,$7,$8,'Consumidor final','CONSUMIDOR_FINAL',
                 $9,0,0,0,0,$9,'OK','api')
         RETURNING id`,
        [empresa, impuesto.rows[0]!.id, periodo, c.cbteTipo, c.ptoVta, nro, fecha, c.cuitEmisor, total],
      );
      return r.rows[0]!.id;
    };
    opA = await crearOp(companyA, periodId, c.cbteNro);

    // La empresa B necesita su propio período para poder tener una operación.
    const fyB = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [companyB, `EJ${anio}-api-b`, `${anio}-01-01`, `${anio}-12-31`],
    );
    const pB = await db.query<{ id: string }>(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        companyB,
        fyB.rows[0]!.id,
        mes,
        `${fecha.slice(0, 7)}-01`,
        new Date(Date.UTC(Number(anio), mes, 0)).toISOString().slice(0, 10),
      ],
    );
    opB = await crearOp(companyB, pB.rows[0]!.id, c.cbteNro + 900);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ── 1, 2, 5, 6 · la decisión automática ──────────────────────────────────
  let decisionId: string;

  it('1 y 6 · el comprobante produce una decisión, y es REQUIERE_REVISION', async () => {
    const r = await pedir('POST', `/comprobantes/${opA}/decision`);
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{
      decisionId: string;
      resultado: string;
      origen: string;
      ruleKey: string | null;
      motivos: { motivo: string }[];
    }>();

    decisionId = cuerpo.decisionId;
    expect(cuerpo.resultado).toBe('REQUIERE_REVISION');
    expect(cuerpo.origen).toBe('DETERMINISTICA');
    // 2 y 5 · sin regla ACTIVE: la clave es null y el motivo lo nombra.
    expect(cuerpo.ruleKey).toBeNull();
    expect(cuerpo.motivos.map((m) => m.motivo)).toEqual(
      expect.arrayContaining(['SIN_HECHO_REQUERIDO', 'SIN_REGLA_APLICABLE']),
    );
  });

  it('la decisión quedó escrita por la API, no por un test', async () => {
    const r = await db.query<{ origen: string; decidida_por: string; hechos: unknown[] }>(
      'SELECT origen, decidida_por, hechos FROM accounting_decisions WHERE id = $1',
      [decisionId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.decidida_por).toMatch(/^user:/);
    expect(r.rows[0]!.hechos.length).toBeGreaterThan(5);
  });

  it('5 · la regla en DRAFT no generó ninguna rule_application', async () => {
    const ra = await db.query('SELECT 1 FROM rule_applications WHERE decision_id = $1', [decisionId]);
    expect(ra.rowCount).toBe(0);

    const estado = await db.query<{ status: string }>(
      'SELECT status FROM accounting_rules WHERE rule_key = $1',
      [CLAVE],
    );
    expect(estado.rows[0]!.status).toBe('DRAFT');
  });

  it('10 · pedir la decisión otra vez no crea una segunda', async () => {
    const r = await pedir('POST', `/comprobantes/${opA}/decision`);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ yaExistia: boolean; decisionId: string }>()).toMatchObject({
      yaExistia: true,
      decisionId,
    });

    const cuantas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_decisions
        WHERE tax_transaction_id = $1 AND estado <> 'SUPERSEDIDA'`,
      [opA],
    );
    expect(cuantas.rows[0]!.n).toBe('1');
  });

  it('12 · la escritura quedó auditada', async () => {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE object_type = 'accounting_decisions' AND object_id = $1`,
      [decisionId],
    );
    // El trigger de la tabla y el recordAudit del endpoint.
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('11 · la empresa B no puede decidir sobre la operación de A', async () => {
    const r = await pedir('POST', `/comprobantes/${opA}/decision`, undefined, companyB);
    expect(r.statusCode).toBe(404);
  });

  it('11b · y no ve la decisión de A', async () => {
    const r = await pedir('GET', `/comprobantes/${opA}/decision`, undefined, companyB);
    expect(r.statusCode).toBe(404);
  });

  // ── 3, 7, 8, 9 · decisión manual y asiento ───────────────────────────────
  describe('la vía manual, que es la que hoy puede registrar', () => {
    let decisionManual: string;
    let entryId: string;

    it('3 · una decisión MANUAL conserva justificación, actor y comprobante', async () => {
      // La automática ya existe para `opA`, así que se supersede primero: una
      // operación tiene una decisión vigente por vez.
      await db.query(
        `UPDATE accounting_decisions SET estado = 'SUPERSEDIDA' WHERE tax_transaction_id = $1`,
        [opA],
      );

      const r = await pedir('POST', `/comprobantes/${opA}/decision`, {
        ambiente: 'PRODUCTIVO',
        manual: {
          resultado: 'PROPUESTA_DE_ASIENTO',
          justificacion:
            `Venta C ${COMPROBANTE!.ptoVta}-${COMPROBANTE!.cbteNro} registrada por la contadora. ` +
            `${CLAVE} está en DRAFT y no funda el tratamiento.`,
        },
      });
      expect(r.statusCode).toBe(201);
      decisionManual = r.json<{ decisionId: string }>().decisionId;

      const d = await db.query<{
        origen: string;
        justificacion: string;
        tax_transaction_id: string;
        decidida_por: string;
        evidencia: { tipo: string }[];
      }>(
        `SELECT origen, justificacion, tax_transaction_id, decidida_por, evidencia
           FROM accounting_decisions WHERE id = $1`,
        [decisionManual],
      );
      expect(d.rows[0]!.origen).toBe('MANUAL');
      expect(d.rows[0]!.justificacion).toContain('DRAFT');
      expect(d.rows[0]!.tax_transaction_id).toBe(opA);
      expect(d.rows[0]!.evidencia.map((e) => e.tipo)).toContain('COMPROBANTE');
    });

    it('4 · y NO inventa una rule_application', async () => {
      const ra = await db.query('SELECT 1 FROM rule_applications WHERE decision_id = $1', [
        decisionManual,
      ]);
      expect(ra.rowCount).toBe(0);
    });

    it('7, 8 y 14 · el asiento cita la decisión, y cuadra en un COMMIT real', async () => {
      const importe = COMPROBANTE!.impTotal.toFixed(2);

      const r = await pedir('POST', '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: fecha,
        description: `Venta C ${COMPROBANTE!.ptoVta}-${COMPROBANTE!.cbteNro}`,
        kind: 'NORMAL',
        status: 'PROPUESTO',
        currency: 'ARS',
        source: { type: 'INVOICE', id: opA },
        decisionId: decisionManual,
        // GAP: el control E_NO_TRACEABILITY del motor contable (§24) exige regla
        // citada o justificación manual, y todavía NO reconoce decision_id como
        // origen demostrable. Hasta que lo haga, el asiento lleva las dos cosas.
        manualJustification: 'Decidido por la contadora; ver decision_id.',
        lines: [
          { accountCode: '1.1.01', debit: importe, credit: '0', currency: 'ARS' },
          { accountCode: '4.1.01', debit: '0', credit: importe, currency: 'ARS' },
        ],
      });

      expect(r.statusCode, r.body).toBe(201);
      entryId = r.json<{ id: string }>().id;

      const e = await db.query<{ decision_id: string; total_debit: string; total_credit: string }>(
        'SELECT decision_id, total_debit::text, total_credit::text FROM journal_entries WHERE id = $1',
        [entryId],
      );
      expect(e.rows[0]!.decision_id).toBe(decisionManual);
      expect(e.rows[0]!.total_debit).toBe(e.rows[0]!.total_credit);
    });

    it('9 · "por qué existe este asiento" se contesta con decision_trace', async () => {
      const t = await db.query<{
        origen: string;
        justificacion: string;
        rule_key: string | null;
        norm_document_sha256: string | null;
        cbte_numero: string;
        hechos: { origen: string }[];
      }>('SELECT * FROM decision_trace WHERE entry_id = $1', [entryId]);

      expect(t.rowCount).toBe(1);
      const f = t.rows[0]!;
      expect(f.origen).toBe('MANUAL');
      expect(f.justificacion).toContain('DRAFT');
      // No se inventa una regla para completar el recorrido.
      expect(f.rule_key).toBeNull();
      expect(f.norm_document_sha256).toBeNull();
      expect(Number(f.cbte_numero)).toBe(COMPROBANTE!.cbteNro);
      expect(f.hechos.some((h) => h.origen === 'TRIBUTARIO')).toBe(true);
    });

    it('9b · y el recorrido inverso, del comprobante al asiento', async () => {
      const r = await db.query<{ entry_id: string }>(
        `SELECT e.id AS entry_id
           FROM accounting_decisions d
           JOIN journal_entries e ON e.decision_id = d.id
          WHERE d.tax_transaction_id = $1`,
        [opA],
      );
      expect(r.rows.map((x) => x.entry_id)).toContain(entryId);
    });

    it('10b · el mismo comprobante no puede respaldar un segundo asiento', async () => {
      const r = await pedir('POST', '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: fecha,
        description: 'Duplicado',
        kind: 'NORMAL',
        status: 'PROPUESTO',
        currency: 'ARS',
        source: { type: 'INVOICE', id: opA },
        lines: [
          { accountCode: '1.1.01', debit: '1.00', credit: '0', currency: 'ARS' },
          { accountCode: '4.1.01', debit: '0', credit: '1.00', currency: 'ARS' },
        ],
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('13 · la decisión usada por el asiento ya no se puede modificar', async () => {
      const fallo = await expectFailureCode(() =>
        db.query('UPDATE accounting_decisions SET resultado = $2 WHERE id = $1', [
          decisionManual,
          'SIN_EFECTO',
        ]),
      );
      expect(fallo.message).toMatch(/ya fundamenta un asiento/);
    });

    it('11c · la empresa B no puede crear un asiento citando la decisión de A', async () => {
      const r = await pedir(
        'POST',
        '/journal-entries',
        {
          journalCode: 'GENERAL',
          entryDate: fecha,
          description: 'Intento cruzado',
          kind: 'NORMAL',
          status: 'PROPUESTO',
          currency: 'ARS',
          source: { type: 'INVOICE', id: opB },
          decisionId: decisionManual,
          lines: [
            { accountCode: '1.1.01', debit: '1.00', credit: '0', currency: 'ARS' },
            { accountCode: '4.1.01', debit: '0', credit: '1.00', currency: 'ARS' },
          ],
        },
        companyB,
      );
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  it('una decisión de ambiente PRUEBA no puede fundar un asiento', async () => {
    const dp = await pedir('POST', `/comprobantes/${opB}/decision`, { ambiente: 'PRUEBA' }, companyB);
    expect(dp.statusCode).toBe(201);
    const idPrueba = dp.json<{ decisionId: string }>().decisionId;

    const fallo = await expectFailureCode(() =>
      db.query(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, total_debit, total_credit, source_type, source_id,
            decision_id, created_by)
         SELECT $1,'GENERAL',p.id,p.fiscal_year_id,999,$2,'x','NORMAL','PROPUESTO',0,0,
                'INVOICE',$3,$4,'tester'
           FROM periods p WHERE p.company_id = $1 LIMIT 1`,
        [companyB, fecha, opB, idPrueba],
      ),
    );
    expect(fallo.message).toMatch(/ambiente PRUEBA/);
  });
});
