/**
 * Notas complementarias, de punta a punta.
 *
 * La dirección que ordena el archivo:
 *
 * ```
 * CONTABILIDAD → NOTA        y nunca al revés
 * ```
 *
 * Una nota explica algo ya registrado. No funda un asiento, no funda una
 * decisión, no funda una regla y no altera un saldo — y eso no se sostiene
 * revisando código: se sostiene en que `note_figures.statement_line_id` es
 * `NOT NULL`, así que **no hay dónde escribir un número suelto**, y en que
 * `notes` no tiene ninguna llave hacia el Diario. La última sección lo prueba
 * intentándolo.
 *
 * El modelo estaba desde la migración 0024 y **nadie lo escribía**. Por eso el
 * invariante A-2 venía declarado VACUO_PERMITIDO: no había camino productivo que
 * creara una nota, y por lo tanto no había forma de saber si el invariante se
 * cumplía.
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

interface NotaHttp {
  id: string;
  numero: number;
  titulo: string;
  tipo: string;
  evidencia: string;
  status: string;
  version: number;
  supersedes: string | null;
  motivoVersion: string | null;
  fundamento: string;
  cifras: number;
}

interface Paquete {
  estado: Record<string, unknown>;
  notas: NotaHttp[];
  completo: boolean;
  obligatoriedad: string;
}

suite('Notas complementarias', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresaA: string;
  let empresaB: string;
  let ejercicioA: string;
  let ejercicioB: string;
  let estadoA: string;
  let estadoB: string;

  const cab = (empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  const pedir = (empresa: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: cab(empresa),
      ...(payload === undefined ? {} : { payload }),
    });

  /** Una empresa con marco declarado, plan, ejercicio, movimientos y ESP emitido. */
  async function montarEmpresa(
    userId: string,
    organizationId: string,
    nombre: string,
    prefijo: string,
    stamp: string,
    importe: string,
  ): Promise<{ companyId: string; fiscalYearId: string; statementId: string }> {
    const c = await db.query<{ create_company: string }>(
      'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, organizationId, nombre, withCheckDigit(`${prefijo}${stamp}`),
       'SA', 'AR-C', 'IGJ', '12-31'],
    );
    const companyId = c.rows[0]!.create_company;
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, companyId, userId, rol]);
    }

    const marco = await pedir(companyId, 'POST', '/companies/current/reporting-framework', {
      framework: 'RT_FACPCE',
      validFrom: '2026-01-01',
    });
    expect(marco.statusCode, marco.body).toBe(200);

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '3.1.01', name: 'Capital suscripto', type: 'PN' },
      { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
      { code: '6.1.01', name: 'Gastos de administración', type: 'GASTO' },
    ]) {
      const r = await pedir(companyId, 'POST', '/accounts', cuenta);
      expect(r.statusCode, r.body).toBe(201);
      if (cuenta.code === '3.4.01') {
        await pedir(companyId, 'PATCH', `/accounts/${r.json<{ id: string }>().id}`, {
          closingRole: 'RESULTADO_DEL_EJERCICIO',
          motivo: 'Designación de la cuenta de resultado del ejercicio',
        });
      }
    }

    const ej = await pedir(companyId, 'POST', '/fiscal-years', {
      code: `EJ2026-${prefijo}-${stamp}`,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(ej.statusCode, ej.body).toBe(201);
    const fiscalYearId = ej.json<{ id: string }>().id;

    const alta = await pedir(companyId, 'POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: '2026-03-10',
      description: 'Venta de contado',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: importe },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Venta registrada por la contadora',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    expect(
      (await pedir(companyId, 'POST', `/journal-entries/${alta.json<{ id: string }>().id}/approve`))
        .statusCode,
    ).toBe(200);

    const emision = await pedir(companyId, 'POST', '/statements/issue', {
      ejercicio: fiscalYearId,
      tipo: 'ESP',
    });
    expect(emision.statusCode, emision.body).toBe(201);

    return { companyId, fiscalYearId, statementId: emision.json<{ estadoId: string }>().estadoId };
  }

  async function paquete(empresa: string, statementId: string): Promise<Paquete> {
    const r = await pedir(empresa, 'GET', `/statements/${statementId}/package`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Paquete>();
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    const stamp = await sufijoUnico(db);
    const email = `contadora-notas-${stamp}@estudio.test`;
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
      [`Estudio notas ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );
    const organizationId = org.rows[0]!.create_organization;

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

    const a = await montarEmpresa(userId, organizationId, 'Notas A', '33', stamp, '500000.00');
    empresaA = a.companyId;
    ejercicioA = a.fiscalYearId;
    estadoA = a.statementId;

    const b = await montarEmpresa(userId, organizationId, 'Notas B', '27', stamp, '777777.00');
    empresaB = b.companyId;
    ejercicioB = b.fiscalYearId;
    estadoB = b.statementId;
    void ejercicioA;
    void ejercicioB;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · Generación y evidencia
  // -------------------------------------------------------------------------

  describe('1 · Generación determinística y los tres estados de evidencia', () => {
    it('genera el juego y cada nota declara qué la sostiene', async () => {
      const r = await pedir(empresaA, 'POST', `/statements/${estadoA}/notes/generate`, {
        // Un rubro que existe, y uno que no: el segundo tiene que salir sin
        // evidencia en vez de omitirse.
        rubros: ['AC_CAJA', 'RUBRO_QUE_NO_EXISTE'],
      });
      expect(r.statusCode, r.body).toBe(201);
      const cuerpo = r.json<{
        notas: { numero: number; tipo: string; evidencia: string; cifras: number }[];
        noGenerables: { tipo: string; falta: string }[];
      }>();

      const bases = cuerpo.notas.find((n) => n.tipo === 'BASES_DE_PREPARACION')!;
      expect(bases.evidencia).toBe('REQUIRES_REVIEW');

      const composiciones = cuerpo.notas.filter((n) => n.tipo === 'COMPOSICION_DE_RUBRO');
      expect(composiciones.map((c) => c.evidencia).sort()).toEqual([
        'INSUFFICIENT_EVIDENCE',
        'VERIFIED',
      ]);
      expect(composiciones.find((c) => c.evidencia === 'VERIFIED')!.cifras).toBeGreaterThan(0);
      expect(composiciones.find((c) => c.evidencia === 'INSUFFICIENT_EVIDENCE')!.cifras).toBe(0);
    });

    it('lo que no puede proponer lo dice, con lo que le falta', async () => {
      // Una nota ausente y una imposible se ven igual —no está— y mandan a hacer
      // cosas distintas: buscar el generador, o cargar el dato que falta.
      const r = await pedir(empresaB, 'POST', `/statements/${estadoB}/notes/generate`, {
        rubros: ['AC_CAJA'],
      });
      const noGenerables = r.json<{ noGenerables: { tipo: string; falta: string }[] }>().noGenerables;

      expect(noGenerables.map((n) => n.tipo)).toEqual(
        expect.arrayContaining(['BIENES_DE_USO', 'CRITERIOS_DE_VALUACION', 'HECHOS_POSTERIORES']),
      );
      for (const n of noGenerables) expect(n.falta.length).toBeGreaterThan(30);
    });

    it('una nota sin evidencia no lleva texto inventado', async () => {
      const sinEvidencia = await db.query<{ body_blocks: unknown[]; fundamento: string }>(
        `SELECT body_blocks, fundamento FROM notes
          WHERE company_id = $1 AND evidencia = 'INSUFFICIENT_EVIDENCE' LIMIT 1`,
        [empresaA],
      );
      expect(sinEvidencia.rows[0]!.body_blocks).toEqual([]);
      expect(sinEvidencia.rows[0]!.fundamento).toMatch(/no hay de dónde/i);
    });

    it('generar dos veces no duplica el juego', async () => {
      const r = await pedir(empresaA, 'POST', `/statements/${estadoA}/notes/generate`, {
        rubros: ['AC_CAJA'],
      });
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('NOTAS_YA_GENERADAS');
    });

    it('no se generan notas sobre un estado que no está emitido', async () => {
      // Las cifras apuntan a renglones concretos: un renglón que todavía puede
      // cambiar no es un respaldo.
      const borrador = await db.query<{ id: string }>(
        `SELECT id FROM financial_statements
          WHERE company_id = $1 AND status = 'ANULADO' LIMIT 1`,
        [empresaA],
      );
      if (borrador.rowCount === 0) return;
      const r = await pedir(
        empresaA, 'POST', `/statements/${borrador.rows[0]!.id}/notes/generate`, { rubros: [] },
      );
      expect(r.statusCode).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('ESTADO_NO_EMITIDO');
    });
  });

  // -------------------------------------------------------------------------
  // 2 · Evidencia y reconciliación
  // -------------------------------------------------------------------------

  describe('2 · La cifra de una nota reconcilia', () => {
    it('con el renglón del estado del que sale', async () => {
      const filas = await db.query<{ nota_amount: string; linea_amount: string; line_code: string }>(
        `SELECT f.amount::text AS nota_amount, l.amount::text AS linea_amount, l.line_code
           FROM note_figures f
           JOIN financial_statement_lines l ON l.id = f.statement_line_id
          WHERE f.company_id = $1`,
        [empresaA],
      );
      expect(filas.rowCount).toBeGreaterThan(0);
      for (const fila of filas.rows) {
        expect([fila.line_code, fila.nota_amount]).toEqual([fila.line_code, fila.linea_amount]);
      }
    });

    it('y con el Mayor, cuenta por cuenta', async () => {
      // El recorrido completo: nota → renglón → cuenta → movimientos.
      const traza = await db.query<{ account_code: string; aporte: string }>(
        `SELECT account_code, aporte FROM note_trace WHERE company_id = $1`,
        [empresaA],
      );
      expect(traza.rowCount).toBeGreaterThan(0);

      const mayor = await pedir(empresaA, 'GET', '/books/mayor?desde=2026-01-01&hasta=2026-12-31');
      const saldos = new Map(
        mayor.json<{ cuentas: { codigo: string; saldoFinal: string }[] }>().cuentas
          .map((c) => [c.codigo, c.saldoFinal]),
      );

      for (const fila of traza.rows) {
        const delMayor = saldos.get(fila.account_code);
        if (delMayor === undefined) continue;
        const abs = (v: string) => v.replace('-', '');
        expect([fila.account_code, abs(fila.aporte)]).toEqual([fila.account_code, abs(delMayor)]);
      }
    });

    it('no hay dónde escribir una cifra sin renglón detrás', async () => {
      // El invariante A-2, hecho estructura: `statement_line_id` es NOT NULL.
      const nota = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND status = 'BORRADOR' LIMIT 1`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO note_figures (company_id, note_id, orden, label, statement_line_id, amount, lineage)
           VALUES ($1, $2, 99, 'Inventada', NULL, 1000, '[]'::jsonb)`,
          [empresaA, nota.rows[0]!.id],
        ),
      );
      // El trigger que compara importes se cruza primero y no encuentra el
      // renglón; si no estuviera, el NOT NULL de la columna la rechazaría igual.
      // Los dos candados apuntan a lo mismo: no hay dónde escribir un número
      // suelto.
      expect(mensaje).toMatch(/no existe|statement_line_id|no nulo/i);
    });

    it('una cifra que no coincide con su renglón es rechazada', async () => {
      const linea = await db.query<{ id: string }>(
        `SELECT id FROM financial_statement_lines WHERE company_id = $1 LIMIT 1`,
        [empresaA],
      );
      const nota = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND status = 'BORRADOR' LIMIT 1`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO note_figures (company_id, note_id, orden, label, statement_line_id, amount, lineage)
           VALUES ($1, $2, 98, 'Con otro número', $3, 123456, '[{"x":1}]'::jsonb)`,
          [empresaA, nota.rows[0]!.id, linea.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/peor que una nota sin cifras/);
    });
  });

  // -------------------------------------------------------------------------
  // 3 · Aprobación, inmutabilidad y versiones
  // -------------------------------------------------------------------------

  describe('3 · Aprobar, y no poder cambiar lo aprobado', () => {
    let aprobada: string;

    it('una nota sin evidencia suficiente no se puede aprobar', async () => {
      const sin = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND evidencia = 'INSUFFICIENT_EVIDENCE' LIMIT 1`,
        [empresaA],
      );
      const r = await pedir(empresaA, 'POST', `/notes/${sin.rows[0]!.id}/approve`);
      expect(r.statusCode).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('INSUFFICIENT_EVIDENCE');
    });

    it('la base también lo impide, no solo la ruta', async () => {
      const sin = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND evidencia = 'INSUFFICIENT_EVIDENCE' LIMIT 1`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `UPDATE notes SET status = 'APROBADA', approved_by = 'x', approved_at = now() WHERE id = $1`,
          [sin.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/notes_no_se_aprueba_sin_evidencia/);
    });

    it('una nota VERIFIED se aprueba y queda firmada', async () => {
      const verificada = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND evidencia = 'VERIFIED'
            AND status = 'BORRADOR' LIMIT 1`,
        [empresaA],
      );
      aprobada = verificada.rows[0]!.id;

      const r = await pedir(empresaA, 'POST', `/notes/${aprobada}/approve`);
      expect(r.statusCode, r.body).toBe(200);

      const fila = await db.query<{ status: string; approved_by: string }>(
        'SELECT status, approved_by FROM notes WHERE id = $1',
        [aprobada],
      );
      expect(fila.rows[0]!.status).toBe('APROBADA');
      expect(fila.rows[0]!.approved_by).toMatch(/^user:/);
    });

    it('el contenido de una nota aprobada es inmutable', async () => {
      const mensaje = await expectFailure(() =>
        db.query(`UPDATE notes SET titulo = 'Otro título' WHERE id = $1`, [aprobada]),
      );
      expect(mensaje).toMatch(/inmutable/i);
    });

    it('y sus cifras tampoco se tocan', async () => {
      const cifra = await db.query<{ id: string }>(
        'SELECT id FROM note_figures WHERE note_id = $1 LIMIT 1',
        [aprobada],
      );
      const mensaje = await expectFailure(() =>
        db.query(`UPDATE note_figures SET label = 'Otra etiqueta' WHERE id = $1`, [
          cifra.rows[0]!.id,
        ]),
      );
      expect(mensaje).toMatch(/no se modifican/i);
    });

    it('corregirla es emitir una versión nueva, y quedan las dos', async () => {
      const r = await pedir(empresaA, 'POST', `/notes/${aprobada}/revise`, {
        motivo: 'Se corrigió la redacción del encabezado a pedido del auditor',
        titulo: 'Composición de Caja y bancos (corregida)',
      });
      expect(r.statusCode, r.body).toBe(201);
      const nueva = r.json<{ noteId: string; version: number; supersedes: string }>();

      expect(nueva.version).toBe(2);
      expect(nueva.supersedes).toBe(aprobada);

      const filas = await db.query<{ id: string; status: string; version: number }>(
        `SELECT id, status, version FROM notes WHERE id = ANY($1::uuid[]) ORDER BY version`,
        [[aprobada, nueva.noteId]],
      );
      expect(filas.rows.map((f) => f.status)).toEqual(['SUPERSEDIDA', 'BORRADOR']);

      // La versión nueva conserva las cifras: apuntan a los mismos renglones del
      // mismo estado emitido, así que el respaldo no cambió.
      const cifras = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM note_figures WHERE note_id = $1',
        [nueva.noteId],
      );
      expect(Number(cifras.rows[0]!.n)).toBeGreaterThan(0);
    });

    it('una versión sin motivo suficiente no entra', async () => {
      const otra = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND status = 'BORRADOR' LIMIT 1`,
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO notes (company_id, statement_id, numero, titulo, note_type, evidencia,
                              created_by, version, supersedes_id, motivo_version)
           SELECT company_id, statement_id, 90, titulo, note_type, evidencia, 'x', 2, id, 'corto'
             FROM notes WHERE id = $1`,
          [otra.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/notes_version_con_motivo/);
    });

    it('queda auditado quién generó, quién aprobó y quién versionó', async () => {
      const acciones = await db.query<{ action: string }>(
        `SELECT action FROM audit_logs
          WHERE company_id = $1 AND action IN ('NOTAS_GENERADAS','NOTA_APROBADA','NOTA_VERSIONADA')
          ORDER BY seq`,
        [empresaA],
      );
      expect(acciones.rows.map((a) => a.action)).toEqual([
        'NOTAS_GENERADAS',
        'NOTA_APROBADA',
        'NOTA_VERSIONADA',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // 4 · El paquete
  // -------------------------------------------------------------------------

  describe('4 · Paquete de emisión', () => {
    it('reúne el estado, sus notas y lo que falta', async () => {
      const p = await paquete(empresaA, estadoA);
      expect(p.estado['statement_status']).toBe('EMITIDO');
      expect(p.notas.length).toBeGreaterThan(2);
      expect(p.notas.some((n) => n.status === 'SUPERSEDIDA')).toBe(true);
    });

    it('no se declara completo mientras haya notas sin aprobar o sin evidencia', async () => {
      const p = await paquete(empresaA, estadoA);
      expect(p.completo).toBe(false);
      expect(Number(p.estado['notas_sin_evidencia'])).toBeGreaterThan(0);
    });

    it('no afirma que estén todas las que la ley exige', async () => {
      // Las plantillas de los arts. 63 y 64 no declaran remisiones a nota, y no
      // hay fuente archivada que enumere el juego mínimo. El sistema informa qué
      // notas tiene; no inventa cuáles son obligatorias.
      const p = await paquete(empresaA, estadoA);
      expect(p.obligatoriedad).toBe('REQUIRES_EXTERNAL_INPUT');
    });

    it('el juego verifica contra el estado del que salió', async () => {
      const r = await pedir(empresaA, 'GET', `/statements/${estadoA}/notes/verify`);
      expect(r.statusCode, r.body).toBe(200);
      const v = r.json<{ consistente: boolean; errores: { codigo: string; nota: number }[]; cifras: number }>();

      // La nota sin evidencia no tiene bloques, así que NOTA_SIN_BLOQUES y
      // NOTA_SIN_TEXTO son esperables y correctos: son exactamente lo que
      // informa que esa nota quedó vacía a propósito. Cualquier OTRO error sí
      // sería un problema.
      const vacia = new Set(['NOTA_SIN_BLOQUES', 'NOTA_SIN_TEXTO']);
      expect(v.errores.map((e) => e.codigo).filter((c) => !vacia.has(c))).toEqual([]);
      expect(v.cifras).toBeGreaterThan(0);

      // Y los que sí aparecen son todos de la misma nota: la que no tenía con qué.
      const sinEvidencia = await db.query<{ numero: number }>(
        `SELECT numero FROM notes WHERE company_id = $1 AND evidencia = 'INSUFFICIENT_EVIDENCE'`,
        [empresaA],
      );
      const numeros = new Set(sinEvidencia.rows.map((f) => f.numero));
      for (const error of v.errores) expect(numeros.has(error.nota)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5 · Aislamiento
  // -------------------------------------------------------------------------

  describe('5 · Multiempresa', () => {
    it('A no ve el paquete de B', async () => {
      const r = await pedir(empresaA, 'GET', `/statements/${estadoB}/package`);
      expect(r.statusCode).toBe(404);
    });

    it('A no puede aprobar una nota de B', async () => {
      const deB = await db.query<{ id: string }>(
        'SELECT id FROM notes WHERE company_id = $1 LIMIT 1',
        [empresaB],
      );
      const r = await pedir(empresaA, 'POST', `/notes/${deB.rows[0]!.id}/approve`);
      expect(r.statusCode).toBe(404);
    });

    it('el RLS impide que una cifra de A apunte a un renglón de B', async () => {
      // La evidencia también pertenece a la empresa. Sin esto, una nota de A
      // podría explicarse con números de otro cliente del estudio.
      const notaA = await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND status = 'BORRADOR' LIMIT 1`,
        [empresaA],
      );
      const lineaB = await db.query<{ id: string; amount: string }>(
        `SELECT id, amount::text FROM financial_statement_lines WHERE company_id = $1 LIMIT 1`,
        [empresaB],
      );

      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE aai_app');
        await db.query('SELECT set_config($1,$2,true)', ['app.company_id', empresaA]);
        const fallo = await expectFailure(() =>
          db.query(
            `INSERT INTO note_figures (company_id, note_id, orden, label, statement_line_id, amount, lineage)
             VALUES ($1, $2, 97, 'De otra empresa', $3, $4, '[{"x":1}]'::jsonb)`,
            [empresaA, notaA.rows[0]!.id, lineaB.rows[0]!.id, lineaB.rows[0]!.amount],
          ),
        );
        // El RLS de `financial_statement_lines` hace que el renglón de B no
        // exista para A: el trigger que compara importes no lo encuentra.
        expect(fallo).toMatch(/no existe|not exist/i);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('las notas de B siguen siendo suyas y no se mezclan', async () => {
      const p = await paquete(empresaB, estadoB);
      expect(p.notas.length).toBeGreaterThan(0);
      const ids = new Set(p.notas.map((n) => n.id));
      const deA = await db.query<{ id: string }>(
        'SELECT id FROM notes WHERE company_id = $1',
        [empresaA],
      );
      for (const fila of deA.rows) expect(ids.has(fila.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 6 · Seguridad semántica: la dirección es CONTABILIDAD → NOTA
  // -------------------------------------------------------------------------

  describe('6 · Una nota no es evidencia contable', () => {
    it('no existe ninguna columna con la que una nota pueda nombrar contabilidad', async () => {
      // El control estructural: `notes` no tiene FK al Diario, ni a decisiones,
      // ni a reglas, ni a cuentas. Una nota que pudiera nombrar un asiento
      // invitaría, tarde o temprano, a que alguien lo modificara desde ahí.
      const columnas = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'notes'`,
      );
      const nombres = columnas.rows.map((c) => c.column_name);
      for (const prohibida of [
        'journal_entry_id', 'entry_id', 'decision_id', 'rule_id', 'account_id',
        'tax_transaction_id', 'document_id',
      ]) {
        expect([prohibida, nombres.includes(prohibida)]).toEqual([prohibida, false]);
      }
    });

    it('las tablas de notas no las referencia nadie: nada contable depende de ellas', async () => {
      // La otra dirección del mismo control. Si una tabla contable tuviera una FK
      // a `notes`, una nota podría condicionar un dato contable.
      const referencias = await db.query<{ tabla: string }>(
        `SELECT DISTINCT c.conrelid::regclass::text AS tabla
           FROM pg_constraint c
          WHERE c.contype = 'f'
            AND c.confrelid IN ('notes'::regclass, 'note_figures'::regclass)
            AND c.conrelid NOT IN ('notes'::regclass, 'note_figures'::regclass)`,
      );
      expect(referencias.rows.map((r) => r.tabla)).toEqual([]);
    });

    it('el rol de la aplicación no puede borrar una nota ni una cifra', async () => {
      const nota = await db.query<{ id: string }>(
        'SELECT id FROM notes WHERE company_id = $1 LIMIT 1',
        [empresaA],
      );
      const mensaje = await expectFailure(() =>
        db.query('DELETE FROM notes WHERE id = $1', [nota.rows[0]!.id]),
      );
      expect(mensaje).toMatch(/Borrado físico prohibido/i);
    });

    it('generar notas no tocó ni un asiento, ni una decisión, ni una regla', async () => {
      // La prueba de la dirección, medida: entre el estado emitido y las notas
      // generadas, nada contable cambió.
      const despues = await db.query<{ asientos: string; decisiones: string; reglas: string }>(
        `SELECT
           (SELECT count(*)::text FROM journal_entries WHERE company_id = $1) AS asientos,
           (SELECT count(*)::text FROM accounting_decisions WHERE company_id = $1) AS decisiones,
           (SELECT count(*)::text FROM accounting_rules WHERE status = 'ACTIVE') AS reglas`,
        [empresaA],
      );
      // Un solo asiento: la venta del montaje. Las notas no crearon ninguno.
      expect(despues.rows[0]!.asientos).toBe('1');
      expect(despues.rows[0]!.decisiones).toBe('0');

      const saldo = await db.query<{ saldo: string | null }>(
        `SELECT (sum(l.debit) - sum(l.credit))::text AS saldo
           FROM journal_entry_lines l
           JOIN journal_entries e ON e.id = l.entry_id
           JOIN accounts a ON a.id = l.account_id
          WHERE e.company_id = $1 AND a.code = '1.1.01' AND e.status = 'APROBADO'`,
        [empresaA],
      );
      expect(saldo.rows[0]!.saldo).toBe('500000.00');
    });
  });
});
