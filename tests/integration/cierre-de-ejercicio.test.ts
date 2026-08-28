/**
 * El ciclo del ejercicio, de punta a punta y contra PostgreSQL real.
 *
 * ```
 * EJERCICIO N → PRE-CIERRE → CIERRE → SALDOS FINALES → APERTURA EN N+1
 * ```
 *
 * Lo que estos tests persiguen no es que cada paso funcione por separado, sino
 * la propiedad que los une: **el par cierre/apertura conserva el patrimonio y no
 * conserva el resultado**. Si se rompe, no aparece ningún error — aparece un
 * balance que cuadra con un resultado contado dos veces, que es la peor forma
 * posible de estar mal.
 *
 * Los candados se prueban con COMMIT real, nunca con mocks: un `UNIQUE` que no
 * se ejercita contra la base es una intención.
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

interface RespuestaCierre {
  closureId: string;
  resultado: string;
  ingresos: string;
  gastos: string;
  cuentaResultado: string;
  refundicionEntryId: string | null;
  cierreEntryId: string | null;
  saldosFinales: { code: string; type: string; saldo: string }[];
}

suite('Cierre y apertura de ejercicio', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresaA: string;
  let empresaB: string;
  /** Ejercicio 2026 de cada empresa, y el 2027 de A para la apertura. */
  let ejercicioA26: string;
  let ejercicioA27: string;
  let ejercicioB26: string;

  const cab = (empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  const post = (empresa: string, url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: cab(empresa), ...(payload === undefined ? {} : { payload }) });

  const get = (empresa: string, url: string) =>
    app.inject({ method: 'GET', url, headers: cab(empresa) });

  /** Venta de contado aprobada, en el ejercicio de la empresa. */
  async function venta(empresa: string, fecha: string, importe: string): Promise<string> {
    const alta = await post(empresa, '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: `Venta de contado por ${importe}`,
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: importe },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Venta registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;
    const ok = await post(empresa, `/journal-entries/${id}/approve`);
    expect(ok.statusCode, ok.body).toBe(200);
    return id;
  }

  /** Gasto pagado por caja. */
  async function gasto(empresa: string, fecha: string, importe: string): Promise<string> {
    const alta = await post(empresa, '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: `Gasto por ${importe}`,
      currency: 'ARS',
      lines: [
        { accountCode: '5.1.01', debit: importe, credit: '0' },
        { accountCode: '1.1.01', debit: '0', credit: importe },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Gasto registrado por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    const id = alta.json<{ id: string }>().id;
    expect((await post(empresa, `/journal-entries/${id}/approve`)).statusCode).toBe(200);
    return id;
  }

  async function saldoDe(empresa: string, code: string, hasta: string): Promise<string> {
    const r = await db.query<{ saldo: string | null }>(
      `SELECT (sum(l.debit) - sum(l.credit))::text AS saldo
         FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE e.company_id = $1 AND a.code = $2
          AND e.status IN ('APROBADO', 'ANULADO') AND e.entry_date <= $3::date`,
      [empresa, code, hasta],
    );
    return r.rows[0]?.saldo ?? '0.00';
  }

  /**
   * Una empresa aparte, con plan de cuentas y un ejercicio 2026.
   *
   * Existe para los tests que necesitan un ejercicio en un estado que A y B ya
   * dejaron atrás. Reusar el de A obligaría a ordenar los tests por el estado
   * que van dejando, que es exactamente la dependencia que hace que un archivo
   * de tests se rompa al reordenarlo.
   */
  async function empresaAuxiliar(
    etiqueta: string,
    opciones: { conCuentaDeResultado: boolean },
  ): Promise<{ companyId: string; fiscalYearId: string }> {
    const stamp = await sufijoUnico(db);
    const org = await db.query<{ id: string }>(
      'SELECT organization_id AS id FROM companies WHERE id = $1',
      [empresaA],
    );
    const usuario = await db.query<{ user_id: string }>(
      'SELECT user_id FROM user_company_roles WHERE company_id = $1 LIMIT 1',
      [empresaA],
    );
    const userId = usuario.rows[0]!.user_id;
    const c = await db.query<{ create_company: string }>(
      'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, org.rows[0]!.id, `${etiqueta} ${stamp}`, withCheckDigit(`23${stamp}`),
       'SRL', 'AR-C', 'IGJ', '12-31'],
    );
    const companyId = c.rows[0]!.create_company;
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, companyId, userId, 'CONTADOR']);

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '3.1.01', name: 'Capital', type: 'PN' },
      { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      const r = await post(companyId, '/accounts', cuenta);
      expect(r.statusCode, r.body).toBe(201);
      if (cuenta.code === '3.4.01' && opciones.conCuentaDeResultado) {
        const marca = await app.inject({
          method: 'PATCH',
          url: `/accounts/${r.json<{ id: string }>().id}`,
          headers: cab(companyId),
          payload: {
            closingRole: 'RESULTADO_DEL_EJERCICIO',
            motivo: 'Designación de la cuenta de resultado del ejercicio',
          },
        });
        expect(marca.statusCode, marca.body).toBe(200);
      }
    }

    const fiscalYearId = await crearEjercicio(
      companyId, `EJ2026-${etiqueta}-${stamp}`, '2026-01-01', '2026-12-31',
    );
    await venta(companyId, '2026-04-01', '500.00');
    return { companyId, fiscalYearId };
  }

  async function crearEjercicio(empresa: string, code: string, desde: string, hasta: string): Promise<string> {
    const r = await post(empresa, '/fiscal-years', {
      code,
      startDate: desde,
      endDate: hasta,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const email = `contadora-cierre-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    const usuario = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Contadora', hash],
    );
    const userId = usuario.rows[0]!.id;

    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1,$2,$3)',
      [`Estudio cierre ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );
    const organizationId = org.rows[0]!.create_organization;

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> => {
      const c = await db.query<{ create_company: string }>(
        'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
        [userId, organizationId, nombre, withCheckDigit(`${prefijo}${stamp}`), 'SRL', 'AR-C', 'IGJ', '12-31'],
      );
      const id = c.rows[0]!.create_company;
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, 'CONTADOR']);
      return id;
    };

    empresaA = await crearEmpresa('Empresa A cierre', '33');
    empresaB = await crearEmpresa('Empresa B cierre', '27');

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

    for (const empresa of [empresaA, empresaB]) {
      for (const cuenta of [
        { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
        { code: '3.1.01', name: 'Capital', type: 'PN' },
        { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
        { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
        { code: '5.1.01', name: 'Gastos generales', type: 'GASTO' },
      ]) {
        const r = await post(empresa, '/accounts', cuenta);
        expect(r.statusCode, r.body).toBe(201);
        if (cuenta.code === '3.4.01') {
          // La empresa designa su cuenta de resultado. El sistema no la elige.
          const marca = await app.inject({
            method: 'PATCH',
            url: `/accounts/${r.json<{ id: string }>().id}`,
            headers: cab(empresa),
            payload: {
              closingRole: 'RESULTADO_DEL_EJERCICIO',
              motivo: 'Designación de la cuenta de resultado del ejercicio',
            },
          });
          expect(marca.statusCode, marca.body).toBe(200);
        }
      }
    }

    ejercicioA26 = await crearEjercicio(empresaA, `EJ2026-A-${stamp}`, '2026-01-01', '2026-12-31');
    ejercicioA27 = await crearEjercicio(empresaA, `EJ2027-A-${stamp}`, '2027-01-01', '2027-12-31');
    ejercicioB26 = await crearEjercicio(empresaB, `EJ2026-B-${stamp}`, '2026-01-01', '2026-12-31');

    // Empresa A: ventas 3000, gastos 1200 → ganancia 1800, Caja 1800.
    await venta(empresaA, '2026-03-10', '3000.00');
    await gasto(empresaA, '2026-06-15', '1200.00');

    // Empresa B: su propio movimiento, con un importe irrepetible.
    await venta(empresaB, '2026-03-10', '888888.00');
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · Pre-cierre
  // -------------------------------------------------------------------------

  describe('1 · Pre-cierre', () => {
    it('un ejercicio inexistente no se pre-cierra', async () => {
      const r = await post(empresaA, '/fiscal-years/01a04000-0000-7000-8000-0000000000ff/pre-close');
      expect(r.statusCode).toBe(404);
    });

    it('el ejercicio de otra empresa no existe para esta', async () => {
      // 404 y no 403: un 403 confirmaría que el ejercicio existe, que ya es
      // información sobre la contabilidad de otro cliente del estudio.
      const r = await post(empresaA, `/fiscal-years/${ejercicioB26}/pre-close`);
      expect(r.statusCode).toBe(404);
    });

    it('no se cierra un ejercicio que no pasó por el pre-cierre', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/close`);
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('E_FISCAL_YEAR_STATE');
    });

    it('un asiento PROPUESTO bloquea el pre-cierre, y no se lo arregla solo', async () => {
      const propuesto = await post(empresaA, '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: '2026-09-01',
        description: 'Venta sin aprobar',
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.01', debit: '10.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '10.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'Queda a propósito sin aprobar',
      });
      expect(propuesto.statusCode, propuesto.body).toBe(201);
      const propuestoId = propuesto.json<{ id: string }>().id;

      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/pre-close`);
      expect(r.statusCode, r.body).toBe(422);
      const cuerpo = r.json<{ error: string; details: { pendientes: { codigo: string }[] } }>();
      expect(cuerpo.error).toBe('E_CLOSURE_BLOCKED');
      expect(cuerpo.details.pendientes.map((p) => p.codigo)).toContain('SIN_PROPUESTOS');

      // Y el ejercicio no se movió: un cierre bloqueado no deja rastro de estado.
      const estado = await db.query<{ status: string }>(
        'SELECT status FROM fiscal_years WHERE id = $1',
        [ejercicioA26],
      );
      expect(estado.rows[0]!.status).toBe('ABIERTO');

      // Se resuelve aprobándolo, que es lo que el checklist pedía.
      expect((await post(empresaA, `/journal-entries/${propuestoId}/approve`)).statusCode).toBe(200);
    });

    it('con el checklist limpio, el ejercicio pasa a EN_CIERRE', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/pre-close`);
      expect(r.statusCode, r.body).toBe(201);
      const cuerpo = r.json<{ status: string; checklist: { codigo: string; cumple: boolean }[] }>();
      expect(cuerpo.status).toBe('EN_CIERRE');
      expect(cuerpo.checklist.find((i) => i.codigo === 'BALANCE_CUADRA')?.cumple).toBe(true);
    });

    it('pre-cerrar dos veces no crea un segundo expediente', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/pre-close`);
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('E_FISCAL_YEAR_STATE');

      const n = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounting_closures WHERE fiscal_year_id = $1`,
        [ejercicioA26],
      );
      expect(n.rows[0]!.n).toBe('1');
    });

    it('EN_CIERRE ya no admite un asiento normal, y sí un ajuste', async () => {
      const normal = await post(empresaA, '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: '2026-10-01',
        description: 'Operación corriente durante el pre-cierre',
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.01', debit: '5.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '5.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'No debería entrar',
      });
      expect(normal.statusCode).toBe(422);
      expect(normal.body).toMatch(/E_PERIOD_CLOSED/);
      expect(normal.body).toMatch(/en cierre/i);

      const ajuste = await post(empresaA, '/journal-entries', {
        journalCode: 'AJUSTES',
        entryDate: '2026-10-01',
        description: 'Ajuste de cierre',
        kind: 'AJUSTE',
        currency: 'ARS',
        lines: [
          { accountCode: '5.1.01', debit: '5.00', credit: '0' },
          { accountCode: '1.1.01', debit: '0', credit: '5.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'Ajuste de cierre, que sí debe entrar',
      });
      expect(ajuste.statusCode, ajuste.body).toBe(201);
      expect((await post(empresaA, `/journal-entries/${ajuste.json<{id:string}>().id}/approve`)).statusCode).toBe(200);
    });

    it('la base rechaza el asiento normal aunque el motor no corriera', async () => {
      // El mismo invariante, un nivel más abajo. Es la forma de agujero que esta
      // auditoría encontró varias veces: un control que vivía solo en la
      // aplicación y que un `psql` a mano atravesaba sin resistencia.
      const periodo = await db.query<{ id: string }>(
        `SELECT id FROM periods WHERE fiscal_year_id = $1 AND number = 11`,
        [ejercicioA26],
      );
      const cuenta = await db.query<{ id: string }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '1.1.01'`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, total_debit, total_credit, source_type,
              manual_justification, created_by)
           VALUES ($1,'GENERAL',$2,$3, next_entry_number($1,'GENERAL',$3), '2026-11-05',
                   'Directo por SQL','NORMAL','PROPUESTO',1,1,'MANUAL','A mano','tester')`,
          [empresaA, periodo.rows[0]!.id, ejercicioA26],
        ),
      );
      expect(mensaje).toMatch(/EN_CIERRE/);
      void cuenta;
    });
  });

  // -------------------------------------------------------------------------
  // 2 · Cierre
  // -------------------------------------------------------------------------

  describe('2 · Cierre', () => {
    let cierre: RespuestaCierre;

    it('determina el resultado y registra los dos asientos', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/close`);
      expect(r.statusCode, r.body).toBe(201);
      cierre = r.json<RespuestaCierre>();

      // Ventas 3000 + 10 (el que se aprobó tras destrabar el checklist);
      // gastos 1200 + 5 del ajuste.
      expect(cierre.ingresos).toBe('3010.00');
      expect(cierre.gastos).toBe('1205.00');
      expect(cierre.resultado).toBe('1805.00');
      expect(cierre.cuentaResultado).toBe('3.4.01');
      expect(cierre.refundicionEntryId).not.toBeNull();
      expect(cierre.cierreEntryId).not.toBeNull();
    });

    it('los dos asientos cuadran y son de la clase que dicen ser', async () => {
      const asientos = await db.query<{
        id: string; kind: string; total_debit: string; total_credit: string;
        fiscal_year_id: string; entry_date: string; status: string;
      }>(
        `SELECT id, kind, total_debit::text, total_credit::text, fiscal_year_id,
                entry_date::text, status
           FROM journal_entries WHERE id = ANY($1::uuid[]) ORDER BY kind`,
        [[cierre.refundicionEntryId, cierre.cierreEntryId]],
      );
      expect(asientos.rows.map((a) => a.kind)).toEqual(['CIERRE', 'REFUNDICION']);
      for (const a of asientos.rows) {
        expect(a.total_debit).toBe(a.total_credit);
        expect(a.fiscal_year_id).toBe(ejercicioA26);
        expect(a.entry_date).toBe('2026-12-31');
        expect(a.status).toBe('APROBADO');
      }
    });

    it('después del cierre, ninguna cuenta queda con saldo', async () => {
      // Es la definición operativa de «ejercicio cerrado»: la refundición llevó
      // el resultado a cero y el cierre llevó el patrimonio a cero.
      for (const code of ['1.1.01', '3.1.01', '3.4.01', '4.1.01', '5.1.01']) {
        expect(await saldoDe(empresaA, code, '2026-12-31'), `cuenta ${code}`).toBe('0.00');
      }
    });

    it('las cuentas de resultado quedaron canceladas por la refundición, no por el cierre', async () => {
      const lineas = await db.query<{ code: string; type: string }>(
        `SELECT a.code, a.type FROM journal_entry_lines l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [cierre.refundicionEntryId],
      );
      expect(lineas.rows.map((l) => l.code).sort()).toEqual(['3.4.01', '4.1.01', '5.1.01']);

      // Y el asiento de cierre no tocó ninguna cuenta de resultado.
      const patrimoniales = await db.query<{ type: string }>(
        `SELECT DISTINCT a.type FROM journal_entry_lines l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1`,
        [cierre.cierreEntryId],
      );
      expect(patrimoniales.rows.map((p) => p.type).sort()).toEqual(['ACTIVO', 'PN']);
    });

    it('los saldos archivados son patrimoniales y suman cero', async () => {
      const tipos = new Set(cierre.saldosFinales.map((s) => s.type));
      expect([...tipos].sort()).toEqual(['ACTIVO', 'PN']);
      const suma = cierre.saldosFinales.reduce(
        (acc, s) => acc + BigInt(s.saldo.replace('.', '').replace('-', '')) * (s.saldo.startsWith('-') ? -1n : 1n),
        0n,
      );
      expect(suma).toBe(0n);
    });

    it('cerrar de nuevo se rechaza: nunca dos asientos de cierre', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/close`);
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('E_FISCAL_YEAR_STATE');

      const n = await db.query<{ kind: string; n: string }>(
        `SELECT kind, count(*)::text AS n FROM journal_entries
          WHERE fiscal_year_id = $1 AND kind IN ('REFUNDICION','CIERRE')
          GROUP BY kind`,
        [ejercicioA26],
      );
      expect(n.rows.every((f) => f.n === '1')).toBe(true);
      expect(n.rows).toHaveLength(2);
    });

    it('sobre el ejercicio ya cerrado, el primer candado que responde es el del estado', async () => {
      const periodo = await db.query<{ id: string }>(
        `SELECT id FROM periods WHERE fiscal_year_id = $1 AND number = 12`,
        [ejercicioA26],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, total_debit, total_credit, source_type,
              manual_justification, created_by, approved_by, approved_at)
           VALUES ($1,'CIERRE',$2,$3, next_entry_number($1,'CIERRE',$3), '2026-12-31',
                   'Segundo cierre','CIERRE','APROBADO',1,1,'CLOSING','A mano','tester','tester',now())`,
          [empresaA, periodo.rows[0]!.id, ejercicioA26],
        ),
      );
      expect(mensaje).toMatch(/CERRADO/);
    });

    it('y el índice único frena el segundo cierre incluso durante el EN_CIERRE', async () => {
      // El test anterior no prueba el índice: el guard del ejercicio cerrado
      // responde primero. Acá el ejercicio está EN_CIERRE, que es el único
      // momento en que dos asientos de cierre podrían convivir, y lo que frena
      // al segundo es `journal_entries_un_cierre_por_ejercicio`.
      const aux = await empresaAuxiliar('Doble cierre', { conCuentaDeResultado: true });
      expect((await post(aux.companyId, `/fiscal-years/${aux.fiscalYearId}/pre-close`)).statusCode).toBe(201);

      const periodo = await db.query<{ id: string }>(
        `SELECT id FROM periods WHERE fiscal_year_id = $1 AND number = 12`,
        [aux.fiscalYearId],
      );
      const cuentas = await db.query<{ id: string; code: string }>(
        `SELECT id, code FROM accounts WHERE company_id = $1 AND code IN ('1.1.01','3.1.01')`,
        [aux.companyId],
      );

      // Cabecera y líneas en una transacción: el CANDADO 3 de la 0005 es un
      // `CONSTRAINT TRIGGER` diferido, así que una cabecera que commitea sola
      // rebota por E_MIN_LINES antes de que el índice único llegue a opinar.
      const insertarCierre = async (): Promise<void> => {
        await db.query('BEGIN');
        try {
          await insertarCierreEnTransaccion();
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        }
      };

      const insertarCierreEnTransaccion = async (): Promise<void> => {
        const cabecera = await db.query<{ id: string }>(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, total_debit, total_credit, source_type,
              manual_justification, created_by, approved_by, approved_at)
           VALUES ($1,'CIERRE',$2,$3, next_entry_number($1,'CIERRE',$3), '2026-12-31',
                   'Cierre a mano','CIERRE','APROBADO',500,500,'CLOSING','A mano','tester','tester',now())
           RETURNING id`,
          [aux.companyId, periodo.rows[0]!.id, aux.fiscalYearId],
        );
        await db.query(
          `INSERT INTO journal_entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
           VALUES ($1,$2,1,$3,500,0), ($1,$2,2,$4,0,500)`,
          [
            aux.companyId,
            cabecera.rows[0]!.id,
            cuentas.rows.find((c) => c.code === '1.1.01')!.id,
            cuentas.rows.find((c) => c.code === '3.1.01')!.id,
          ],
        );
      };

      await insertarCierre();
      const mensaje = await expectFailure(insertarCierre);
      expect(mensaje).toMatch(/journal_entries_un_cierre_por_ejercicio/);
    });

    it('un ejercicio cerrado no admite ningún asiento nuevo', async () => {
      const r = await post(empresaA, '/journal-entries', {
        journalCode: 'AJUSTES',
        entryDate: '2026-12-20',
        description: 'Ajuste tardío',
        kind: 'AJUSTE',
        currency: 'ARS',
        lines: [
          { accountCode: '5.1.01', debit: '1.00', credit: '0' },
          { accountCode: '1.1.01', debit: '0', credit: '1.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'No debería entrar en un ejercicio cerrado',
      });
      expect(r.statusCode).toBe(422);
      expect(r.body).toMatch(/E_PERIOD_CLOSED/);
    });

    it('el cierre completado no se puede modificar en silencio', async () => {
      const mensaje = await expectFailure(() =>
        db.query(`UPDATE accounting_closures SET resultado = 1 WHERE id = $1`, [cierre.closureId]),
      );
      expect(mensaje).toMatch(/inmutables/i);

      const otroEstado = await expectFailure(() =>
        db.query(`UPDATE accounting_closures SET status = 'ABORTADO' WHERE id = $1`, [
          cierre.closureId,
        ]),
      );
      expect(otroEstado).toMatch(/COMPLETADO/);
    });

    it('el expediente responde quién, cuándo, con qué y qué generó', async () => {
      const r = await get(empresaA, `/fiscal-years/${ejercicioA26}/closure`);
      expect(r.statusCode, r.body).toBe(200);
      const e = r.json<Record<string, unknown>>();
      expect(e['status']).toBe('COMPLETADO');
      expect(e['ejercicioStatus']).toBe('CERRADO');
      expect(e['preCerradoPor']).toMatch(/^user:/);
      expect(e['cerradoPor']).toMatch(/^user:/);
      expect(e['cerradoEl']).not.toBeNull();
      expect(e['resultado']).toBe('1805.00');
      expect(e['cuentaResultado']).toBe('3.4.01');
      expect(e['refundicionEntryId']).toBe(cierre.refundicionEntryId);
      expect(e['cierreEntryId']).toBe(cierre.cierreEntryId);
      expect(Array.isArray(e['saldosFinales'])).toBe(true);
      expect(e['aperturaEntryId']).toBeNull();
    });

    it('queda auditado con actor y acción', async () => {
      const r = await db.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM audit_logs
          WHERE company_id = $1 AND object_id = $2 AND action IN ('PRE_CERRAR_EJERCICIO','CERRAR_EJERCICIO')
          ORDER BY seq`,
        [empresaA, ejercicioA26],
      );
      expect(r.rows.map((x) => x.action)).toEqual(['PRE_CERRAR_EJERCICIO', 'CERRAR_EJERCICIO']);
      expect(r.rows.every((x) => x.actor_id.startsWith('user:'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3 · Apertura
  // -------------------------------------------------------------------------

  describe('3 · Apertura', () => {
    let aperturaEntryId: string;

    it('no se abre sobre un ejercicio que no cerró', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA27}/opening`, {
        siguienteEjercicioId: ejercicioA26,
      });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('E_OPENING_WITHOUT_CLOSURE');
    });

    it('deriva del cierre anterior y reproduce los saldos patrimoniales', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/opening`, {
        siguienteEjercicioId: ejercicioA27,
      });
      expect(r.statusCode, r.body).toBe(201);
      const cuerpo = r.json<{ aperturaEntryId: string; lineas: number; desdeEjercicio: string }>();
      aperturaEntryId = cuerpo.aperturaEntryId;
      expect(cuerpo.lineas).toBe(2);

      const asiento = await db.query<{
        kind: string; entry_date: string; fiscal_year_id: string;
        total_debit: string; total_credit: string; status: string;
      }>(
        `SELECT kind, entry_date::text, fiscal_year_id, total_debit::text, total_credit::text, status
           FROM journal_entries WHERE id = $1`,
        [aperturaEntryId],
      );
      const a = asiento.rows[0]!;
      expect(a.kind).toBe('APERTURA');
      expect(a.entry_date).toBe('2027-01-01');
      expect(a.fiscal_year_id).toBe(ejercicioA27);
      expect(a.total_debit).toBe(a.total_credit);
      expect(a.status).toBe('APROBADO');
    });

    it('los saldos patrimoniales cruzan el corte sin duplicarse', async () => {
      // La propiedad central. Caja terminó 2026 con 1805 (3010 − 1205); el par
      // cierre/apertura la deja en 1805 al empezar 2027, no en 3610.
      expect(await saldoDe(empresaA, '1.1.01', '2027-01-01')).toBe('1805.00');
      expect(await saldoDe(empresaA, '3.4.01', '2027-01-01')).toBe('-1805.00');
    });

    it('las cuentas de resultado NO cruzan', async () => {
      // El error que haría contar el mismo ingreso en dos ejercicios.
      expect(await saldoDe(empresaA, '4.1.01', '2027-01-01')).toBe('0.00');
      expect(await saldoDe(empresaA, '5.1.01', '2027-01-01')).toBe('0.00');

      const tipos = await db.query<{ type: string }>(
        `SELECT DISTINCT a.type FROM journal_entry_lines l
           JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = $1`,
        [aperturaEntryId],
      );
      expect(tipos.rows.map((t) => t.type).sort()).toEqual(['ACTIVO', 'PN']);
    });

    it('la apertura es el reverso exacto del asiento de cierre', async () => {
      const filas = await db.query<{ code: string; debe: string; haber: string; kind: string }>(
        `SELECT a.code, l.debit::text AS debe, l.credit::text AS haber, e.kind
           FROM journal_entry_lines l
           JOIN journal_entries e ON e.id = l.entry_id
           JOIN accounts a ON a.id = l.account_id
          WHERE e.company_id = $1 AND e.kind IN ('CIERRE','APERTURA')
          ORDER BY a.code, e.kind`,
        [empresaA],
      );
      const porCuenta = new Map<string, { cierre?: [string, string]; apertura?: [string, string] }>();
      for (const f of filas.rows) {
        const actual = porCuenta.get(f.code) ?? {};
        if (f.kind === 'CIERRE') actual.cierre = [f.debe, f.haber];
        else actual.apertura = [f.debe, f.haber];
        porCuenta.set(f.code, actual);
      }
      expect(porCuenta.size).toBe(2);
      for (const [code, par] of porCuenta) {
        expect(par.cierre, code).toBeDefined();
        expect(par.apertura, code).toBeDefined();
        expect(par.apertura![0], code).toBe(par.cierre![1]);
        expect(par.apertura![1], code).toBe(par.cierre![0]);
      }
    });

    it('abrir de nuevo se rechaza y no genera un segundo asiento', async () => {
      const r = await post(empresaA, `/fiscal-years/${ejercicioA26}/opening`, {
        siguienteEjercicioId: ejercicioA27,
      });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('E_FISCAL_YEAR_STATE');

      const n = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_entries
          WHERE company_id = $1 AND kind = 'APERTURA'`,
        [empresaA],
      );
      expect(n.rows[0]!.n).toBe('1');
    });

    it('el expediente enlaza cierre y apertura estructuralmente', async () => {
      const r = await get(empresaA, `/fiscal-years/${ejercicioA26}/closure`);
      const e = r.json<Record<string, unknown>>();
      expect(e['aperturaEntryId']).toBe(aperturaEntryId);
      expect(e['aperturaPor']).toMatch(/^user:/);
      expect(e['aperturaEl']).not.toBeNull();
      expect(typeof e['aperturaEjercicio']).toBe('string');
    });

    it('el nuevo ejercicio queda operativo: entra un asiento normal', async () => {
      const r = await post(empresaA, '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: '2027-02-10',
        description: 'Primera venta del ejercicio nuevo',
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.01', debit: '100.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '100.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'Operación del ejercicio siguiente',
      });
      expect(r.statusCode, r.body).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  // 4 · Multiempresa
  // -------------------------------------------------------------------------

  describe('4 · Multiempresa', () => {
    it('el cierre de A no cerró el ejercicio de B', async () => {
      const b = await db.query<{ status: string }>('SELECT status FROM fiscal_years WHERE id = $1', [
        ejercicioB26,
      ]);
      expect(b.rows[0]!.status).toBe('ABIERTO');
    });

    it('B no tiene expediente de cierre ni asientos de cierre', async () => {
      const expediente = await get(empresaB, `/fiscal-years/${ejercicioB26}/closure`);
      expect(expediente.statusCode).toBe(404);

      const asientos = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_entries
          WHERE company_id = $1 AND kind IN ('REFUNDICION','CIERRE','APERTURA')`,
        [empresaB],
      );
      expect(asientos.rows[0]!.n).toBe('0');
    });

    it('los saldos de B no se movieron', async () => {
      expect(await saldoDe(empresaB, '1.1.01', '2026-12-31')).toBe('888888.00');
      expect(await saldoDe(empresaB, '4.1.01', '2026-12-31')).toBe('-888888.00');
    });

    it('B sigue aceptando asientos normales en 2026', async () => {
      const id = await venta(empresaB, '2026-11-20', '100.00');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('y cierra su propio ejercicio, con su propio resultado', async () => {
      const pre = await post(empresaB, `/fiscal-years/${ejercicioB26}/pre-close`);
      expect(pre.statusCode, pre.body).toBe(201);
      const cierre = await post(empresaB, `/fiscal-years/${ejercicioB26}/close`);
      expect(cierre.statusCode, cierre.body).toBe(201);
      expect(cierre.json<RespuestaCierre>().resultado).toBe('888988.00');

      // Y el de A siguió cerrado con el suyo, sin contaminarse.
      const a = await get(empresaA, `/fiscal-years/${ejercicioA26}/closure`);
      expect(a.json<{ resultado: string }>().resultado).toBe('1805.00');
    });
  });

  // -------------------------------------------------------------------------
  // 5 · La cuenta de resultado
  // -------------------------------------------------------------------------

  describe('5 · La cuenta que recibe el resultado', () => {
    it('sin designarla, el cierre se niega en vez de elegir una', async () => {
      // Empresa nueva, sin `closing_role` marcado. El sistema no toma «la
      // primera PN» ni la que se llame Resultado: pide que la empresa la elija.
      const aux = await empresaAuxiliar('Sin cuenta de resultado', { conCuentaDeResultado: false });

      expect((await post(aux.companyId, `/fiscal-years/${aux.fiscalYearId}/pre-close`)).statusCode).toBe(201);
      const r = await post(aux.companyId, `/fiscal-years/${aux.fiscalYearId}/close`);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('E_RESULT_ACCOUNT_MISSING');

      // Y el ejercicio no quedó cerrado a medias: sigue en pre-cierre, listo
      // para reintentar una vez designada la cuenta.
      const estado = await db.query<{ status: string }>(
        'SELECT status FROM fiscal_years WHERE id = $1',
        [aux.fiscalYearId],
      );
      expect(estado.rows[0]!.status).toBe('EN_CIERRE');
    });

    it('la base impide marcar como cuenta de resultado una que no sea de PN', async () => {
      const ventas = await db.query<{ id: string }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '4.1.01'`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(`UPDATE accounts SET closing_role = 'RESULTADO_DEL_EJERCICIO' WHERE id = $1`, [
          ventas.rows[0]!.id,
        ]),
      );
      expect(mensaje).toMatch(/accounts_resultado_es_pn_imputable/);
    });

    it('la base impide designar dos cuentas de resultado en la misma empresa', async () => {
      const capital = await db.query<{ id: string }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '3.1.01'`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(`UPDATE accounts SET closing_role = 'RESULTADO_DEL_EJERCICIO' WHERE id = $1`, [
          capital.rows[0]!.id,
        ]),
      );
      expect(mensaje).toMatch(/accounts_una_cuenta_de_resultado/);
    });
  });

  // -------------------------------------------------------------------------
  // 6 · Los libros después del ciclo
  // -------------------------------------------------------------------------

  describe('6 · Diario, Mayor y balance siguen consistentes', () => {
    it('el balance de 2026 cierra en cero después del cierre', async () => {
      const r = await get(empresaA, '/reports/trial-balance?desde=2026-01-01&hasta=2026-12-31');
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json<{
        cuadra: boolean;
        totales: { debitos: string; creditos: string };
        lineas: { codigo: string; saldoFinal: string }[];
      }>();
      expect(b.cuadra).toBe(true);
      expect(b.totales.debitos).toBe(b.totales.creditos);
      expect(b.lineas.every((l) => l.saldoFinal === '0.00')).toBe(true);
    });

    it('el Diario de 2026 incluye la refundición y el cierre, y cuadra', async () => {
      const r = await get(empresaA, '/books/diario?desde=2026-01-01&hasta=2026-12-31');
      expect(r.statusCode, r.body).toBe(200);
      const d = r.json<{
        totales: { debe: string; haber: string };
        cumpleFormalidades: boolean;
        folios: { asientos: { tipo: string }[] }[];
      }>();
      const tipos = d.folios.flatMap((f) => f.asientos).map((a) => a.tipo);
      expect(tipos).toContain('REFUNDICION');
      expect(tipos).toContain('CIERRE');
      expect(d.totales.debe).toBe(d.totales.haber);
      expect(d.cumpleFormalidades).toBe(true);
    });

    it('el Mayor de 2027 arranca con los saldos que dejó la apertura', async () => {
      const r = await get(empresaA, '/books/mayor?desde=2027-02-01&hasta=2027-12-31&cuenta=1.1.01');
      expect(r.statusCode, r.body).toBe(200);
      const caja = r.json<{ cuentas: { saldoInicial: string }[] }>().cuentas[0]!;
      expect(caja.saldoInicial).toBe('1805.00');
    });
  });
});
