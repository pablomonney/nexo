/**
 * El recorrido productivo entero, por HTTP y sin fixtures de por medio:
 *
 *   PDF real  →  POST /documents
 *             →  POST /documents/:id/tax-transaction
 *             →  POST /comprobantes/:id/decision
 *             →  POST /journal-entries  (citando decisionId)
 *             →  Libro Diario
 *
 * El PDF sale de `var/corpus-homologacion/documentos/`: es uno de los que ARCA
 * autorizó en homologación, con CAE real. Los importes que se declaran salen de
 * `comprobantes.json`, que es la respuesta del organismo — no de una constante
 * escrita acá.
 *
 * Lo que este test agrega respecto del anterior es el primer eslabón: hasta hoy
 * `tax_transactions` se insertaba a mano en el `beforeAll`. Ahora la crea la API.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const RAIZ = join(import.meta.dirname, '..', '..');
const CORPUS = join(RAIZ, 'var', 'corpus-homologacion');
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

/** El comprobante y su PDF. Si el corpus no está, la suite se saltea. */
function delCorpus(): { datos: DelCorpus; pdf: Buffer; nombre: string } | null {
  try {
    const lista = JSON.parse(
      readFileSync(join(CORPUS, 'comprobantes.json'), 'utf8'),
    ) as DelCorpus[];
    const datos = lista[0];
    if (datos === undefined) return null;
    const nombre = `${String(datos.cbteNro).padStart(8, '0')}.pdf`;
    const ruta = join(CORPUS, 'documentos', nombre);
    if (!existsSync(ruta)) return null;
    return { datos, pdf: readFileSync(ruta), nombre };
  } catch {
    return null;
  }
}

const CASO = delCorpus();
const suite = hasDatabase && CASO !== null ? describe : describe.skip;

suite('flujo productivo completo — del PDF al Libro Diario', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let companyId: string;
  let otraEmpresa: string;
  let fecha: string;

  let documentId: string;
  let taxTransactionId: string;
  let decisionId: string;
  let entryId: string;

  const pedir = (
    metodo: 'POST' | 'GET',
    url: string,
    payload?: unknown,
    empresa: string = companyId,
  ) =>
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
    const email = `contadora-flujo-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const user = await db.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, 'Contadora', hash],
    );
    const userId = user.rows[0]!.id;

    const org = await db.query<{ create_organization: string }>(
      'SELECT create_organization($1,$2,$3)',
      [`Estudio flujo ${stamp}`, withCheckDigit(`30${stamp}`), userId],
    );

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> => {
      const r = await db.query<{ create_company: string }>(
        'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          userId,
          org.rows[0]!.create_organization,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SRL',
          'AR-C',
          'IGJ',
          '12-31',
        ],
      );
      const id = r.rows[0]!.create_company;
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, id, userId, 'CONTADOR']);
      return id;
    };
    companyId = await crearEmpresa('Empresa flujo', '33');
    otraEmpresa = await crearEmpresa('Empresa ajena', '34');

    // MFA: CONTADOR no llega a la empresa sin segundo factor.
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

    // Ejercicio, período y plan de cuentas.
    const c = CASO!.datos;
    fecha = `${c.cbteFch.slice(0, 4)}-${c.cbteFch.slice(4, 6)}-${c.cbteFch.slice(6, 8)}`;
    const anio = fecha.slice(0, 4);
    const mes = Number(fecha.slice(5, 7));

    const fy = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [companyId, `EJ${anio}-flujo`, `${anio}-01-01`, `${anio}-12-31`],
    );
    await db.query(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        companyId,
        fy.rows[0]!.id,
        mes,
        `${fecha.slice(0, 7)}-01`,
        new Date(Date.UTC(Number(anio), mes, 0)).toISOString().slice(0, 10),
      ],
    );

    const chart = await db.query<{ id: string }>(
      `INSERT INTO account_charts (company_id, name) VALUES ($1,'Plan') RETURNING id`,
      [companyId],
    );
    for (const [code, name, tipo, nat] of [
      ['1.1.01', 'Caja', 'ACTIVO', 'DEUDORA'],
      ['4.1.01', 'Ventas', 'INGRESO', 'ACREEDORA'],
    ] as const) {
      await db.query(
        `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, chart.rows[0]!.id, code, name, tipo, nat],
      );
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ── 1 · el comprobante entra ─────────────────────────────────────────────
  it('1 · el PDF real se archiva con su hash', async () => {
    const limite = '----flujo';
    const cuerpo = Buffer.concat([
      Buffer.from(
        `--${limite}\r\nContent-Disposition: form-data; name="file"; filename="${CASO!.nombre}"\r\n` +
          'Content-Type: application/pdf\r\n\r\n',
      ),
      CASO!.pdf,
      Buffer.from(`\r\n--${limite}--\r\n`),
    ]);

    const r = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: cuerpo,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': companyId,
        'content-type': `multipart/form-data; boundary=${limite}`,
      },
    });

    expect(r.statusCode, r.body).toBe(201);
    documentId = r.json<{ id: string }>().id;

    const d = await db.query<{ sha256: string; bytes: string }>(
      'SELECT sha256, bytes::text FROM documents WHERE id = $1',
      [documentId],
    );
    expect(d.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(d.rows[0]!.bytes)).toBe(CASO!.pdf.length);
  });

  // ── 2 · la operación fiscal ──────────────────────────────────────────────
  const cuerpoOperacion = () => ({
    direction: 'VENTAS' as const,
    cbteTipo: CASO!.datos.cbteTipo,
    puntoVenta: CASO!.datos.ptoVta,
    numero: CASO!.datos.cbteNro,
    fecha,
    // Consumidor final sin identificar: el comprobante trae DocTipo 99.
    cuitContraparte: null,
    razonSocial: 'Consumidor final',
    condicionIva: 'CONSUMIDOR_FINAL' as const,
    // Factura C: el total va al neto y no se discrimina IVA.
    neto: CASO!.datos.impTotal.toFixed(2),
    iva: '0',
    noGravado: '0',
    exento: '0',
    percepciones: '0',
    total: CASO!.datos.impTotal.toFixed(2),
    constatacion: 'OK' as const,
  });

  it('2 · el documento produce su tax_transaction, creada por la API', async () => {
    const r = await pedir('POST', `/documents/${documentId}/tax-transaction`, cuerpoOperacion());
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ taxTransactionId: string; yaExistia: boolean }>();
    taxTransactionId = cuerpo.taxTransactionId;
    expect(cuerpo.yaExistia).toBe(false);

    const t = await db.query<{ document_id: string; created_by: string; total: string }>(
      'SELECT document_id, created_by, total::text FROM tax_transactions WHERE id = $1',
      [taxTransactionId],
    );
    expect(t.rows[0]!.document_id).toBe(documentId);
    // La escribió un usuario por HTTP, no un fixture.
    expect(t.rows[0]!.created_by).toMatch(/^user:/);
    expect(t.rows[0]!.total).toBe(CASO!.datos.impTotal.toFixed(2));
  });

  /**
   * Los rechazos se prueban sobre OTRO documento.
   *
   * El candado de idempotencia contesta antes que las validaciones, y hace bien:
   * si el documento ya tiene operación fiscal, no hay nada que validar. Probarlos
   * sobre el documento ya registrado devolvía 200, y el test medía el candado
   * equivocado.
   */
  async function subirOtro(): Promise<string> {
    const limite = '----otro';
    // Se le agregan bytes al final para que el hash difiera: si no, el motor
    // documental lo detecta como el mismo archivo.
    const contenido = Buffer.concat([
      CASO!.pdf,
      Buffer.from(`%%unico-${Math.random()}-${Date.now()}`),
    ]);
    const cuerpo = Buffer.concat([
      Buffer.from(
        `--${limite}\r\nContent-Disposition: form-data; name="file"; filename="otro.pdf"\r\n` +
          'Content-Type: application/pdf\r\n\r\n',
      ),
      contenido,
      Buffer.from(`\r\n--${limite}--\r\n`),
    ]);
    const r = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: cuerpo,
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': companyId,
        'content-type': `multipart/form-data; boundary=${limite}`,
      },
    });
    return r.json<{ id: string }>().id;
  }

  it('2b · un total que no cierra con sus partes se rechaza', async () => {
    const otro = await subirOtro();
    const r = await pedir('POST', `/documents/${otro}/tax-transaction`, {
      ...cuerpoOperacion(),
      neto: '100.00',
      total: '150.00',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('no es la suma');
  });

  it('2c · sin período que contenga la fecha, se rechaza en vez de inventarlo', async () => {
    const otro = await subirOtro();
    const r = await pedir('POST', `/documents/${otro}/tax-transaction`, {
      ...cuerpoOperacion(),
      fecha: '1999-05-05',
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('No hay período');
  });

  it('7a · registrar el mismo documento otra vez devuelve la operación que ya había', async () => {
    const r = await pedir('POST', `/documents/${documentId}/tax-transaction`, cuerpoOperacion());
    expect(r.statusCode).toBe(200);
    expect(r.json<{ yaExistia: boolean; taxTransactionId: string }>()).toMatchObject({
      yaExistia: true,
      taxTransactionId,
    });

    const cuantas = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tax_transactions WHERE document_id = $1',
      [documentId],
    );
    expect(cuantas.rows[0]!.n).toBe('1');
  });

  it('la otra empresa no ve el documento ni puede registrarlo', async () => {
    const r = await pedir(
      'POST',
      `/documents/${documentId}/tax-transaction`,
      cuerpoOperacion(),
      otraEmpresa,
    );
    expect(r.statusCode).toBe(404);
  });

  // ── 3 y 4 · la decisión ──────────────────────────────────────────────────
  it('3 y 4 · la operación produce una decisión persistida y trazable', async () => {
    const r = await pedir('POST', `/comprobantes/${taxTransactionId}/decision`);
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ decisionId: string; resultado: string; ruleKey: string | null }>();
    decisionId = cuerpo.decisionId;

    // Sin regla ACTIVE que cubra el caso: la respuesta correcta es revisión.
    expect(cuerpo.resultado).toBe('REQUIERE_REVISION');
    expect(cuerpo.ruleKey).toBeNull();

    const d = await db.query<{ tax_transaction_id: string; document_id: string; hechos: unknown[] }>(
      'SELECT tax_transaction_id, document_id, hechos FROM accounting_decisions WHERE id = $1',
      [decisionId],
    );
    // La decisión conserva el enlace al comprobante Y al documento.
    expect(d.rows[0]!.tax_transaction_id).toBe(taxTransactionId);
    expect(d.rows[0]!.document_id).toBe(documentId);
    expect(d.rows[0]!.hechos.length).toBeGreaterThan(5);
  });

  it('7b · pedir la decisión otra vez no emite una segunda', async () => {
    const r = await pedir('POST', `/comprobantes/${taxTransactionId}/decision`);
    expect(r.statusCode).toBe(200);
    expect(r.json<{ yaExistia: boolean }>().yaExistia).toBe(true);
  });

  // ── 5 y 6 · el asiento ───────────────────────────────────────────────────
  it('5 y 6 · el asiento se crea citando la decisión, y la referencia queda', async () => {
    // La decisión automática pide revisión, así que la que funda el asiento es
    // manual: se supersede la anterior y se emite la del contador.
    await db.query(
      `UPDATE accounting_decisions SET estado = 'SUPERSEDIDA' WHERE tax_transaction_id = $1`,
      [taxTransactionId],
    );
    const manual = await pedir('POST', `/comprobantes/${taxTransactionId}/decision`, {
      manual: {
        resultado: 'PROPUESTA_DE_ASIENTO',
        justificacion:
          'Venta a consumidor final registrada por la contadora. No hay regla activa que funde ' +
          'el tratamiento; se decide a mano y queda dicho.',
      },
    });
    expect(manual.statusCode, manual.body).toBe(201);
    const decisionManual = manual.json<{ decisionId: string }>().decisionId;

    const importe = CASO!.datos.impTotal.toFixed(2);
    const r = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: `Venta C ${CASO!.datos.ptoVta}-${CASO!.datos.cbteNro} — CAE ${CASO!.datos.cae}`,
      kind: 'NORMAL',
      status: 'PROPUESTO',
      currency: 'ARS',
      source: { type: 'INVOICE', id: taxTransactionId },
      decisionId: decisionManual,
      // GAP conocido: E_NO_TRACEABILITY (§24) todavía no reconoce decision_id
      // como origen demostrable, así que el asiento lleva las dos cosas.
      manualJustification: 'Decidido por la contadora; ver decision_id.',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0', currency: 'ARS' },
        { accountCode: '4.1.01', debit: '0', credit: importe, currency: 'ARS' },
      ],
    });

    expect(r.statusCode, r.body).toBe(201);
    entryId = r.json<{ id: string }>().id;
    decisionId = decisionManual;

    const e = await db.query<{ decision_id: string; total_debit: string; total_credit: string }>(
      'SELECT decision_id, total_debit::text, total_credit::text FROM journal_entries WHERE id = $1',
      [entryId],
    );
    expect(e.rows[0]!.decision_id).toBe(decisionManual);
    expect(e.rows[0]!.total_debit).toBe(e.rows[0]!.total_credit);
    expect(e.rows[0]!.total_debit).toBe(importe);
  });

  it('7c · el mismo comprobante no puede respaldar un segundo asiento', async () => {
    const r = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: fecha,
      description: 'Duplicado',
      kind: 'NORMAL',
      status: 'PROPUESTO',
      currency: 'ARS',
      source: { type: 'INVOICE', id: taxTransactionId },
      manualJustification: 'Intento de duplicado, debe fallar',
      lines: [
        { accountCode: '1.1.01', debit: '1.00', credit: '0', currency: 'ARS' },
        { accountCode: '4.1.01', debit: '0', credit: '1.00', currency: 'ARS' },
      ],
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ── el recorrido entero ──────────────────────────────────────────────────
  it('el recorrido llega del asiento al documento archivado, y vuelve', async () => {
    const ida = await db.query<{
      entry_id: string;
      origen: string;
      justificacion: string;
      rule_key: string | null;
      cbte_numero: string;
      document_id: string;
      sha256: string;
    }>(
      `SELECT t.entry_id, t.origen, t.justificacion, t.rule_key, t.cbte_numero,
              doc.id AS document_id, doc.sha256
         FROM decision_trace t
         JOIN accounting_decisions d ON d.id = t.decision_id
         JOIN documents doc ON doc.id = d.document_id
        WHERE t.entry_id = $1`,
      [entryId],
    );
    expect(ida.rowCount).toBe(1);
    expect(ida.rows[0]!.origen).toBe('MANUAL');
    // No se inventa una regla para completar el recorrido.
    expect(ida.rows[0]!.rule_key).toBeNull();
    expect(Number(ida.rows[0]!.cbte_numero)).toBe(CASO!.datos.cbteNro);
    expect(ida.rows[0]!.document_id).toBe(documentId);
    expect(ida.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Y del documento al asiento.
    const vuelta = await db.query<{ entry_id: string }>(
      `SELECT e.id AS entry_id
         FROM documents doc
         JOIN tax_transactions t ON t.document_id = doc.id
         JOIN accounting_decisions d ON d.tax_transaction_id = t.id
         JOIN journal_entries e ON e.decision_id = d.id
        WHERE doc.id = $1`,
      [documentId],
    );
    expect(vuelta.rows.map((x) => x.entry_id)).toContain(entryId);
  });

  it('el asiento aparece en el Libro Diario con Debe = Haber', async () => {
    const r = await db.query<{ n: string; debe: string; haber: string }>(
      `SELECT count(*)::text AS n,
              sum(l.debit)::text AS debe,
              sum(l.credit)::text AS haber
         FROM journal_entry_lines l WHERE l.entry_id = $1`,
      [entryId],
    );
    expect(r.rows[0]!.n).toBe('2');
    expect(r.rows[0]!.debe).toBe(r.rows[0]!.haber);
  });

  it('todo el recorrido quedó auditado', async () => {
    const r = await db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs
        WHERE company_id = $1
          AND action IN ('OPERACION_FISCAL_REGISTRADA','DECISION_REGISTRADA','DECISION_EMITIDA')`,
      [companyId],
    );
    const acciones = r.rows.map((x) => x.action);
    expect(acciones).toContain('OPERACION_FISCAL_REGISTRADA');
    expect(acciones).toContain('DECISION_REGISTRADA');
  });
});
