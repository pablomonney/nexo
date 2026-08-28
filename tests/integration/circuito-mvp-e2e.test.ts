/**
 * El circuito productivo completo, por las interfaces reales.
 *
 * ```
 * DOCUMENTO → CONSTATACIÓN ARCA → TAX TRANSACTION → AFECTACIÓN PROFESIONAL
 *   → DECISIÓN → ASIENTO → DIARIO → MAYOR → ESTADO CONTABLE → TRAZABILIDAD
 * ```
 *
 * Ni un `INSERT` directo, ni un fixture que saltee la API: cada eslabón lo
 * escribe la misma ruta que lo escribiría en producción. Es la diferencia entre
 * probar que las piezas existen y probar que el circuito **anda**.
 *
 * ## La regla sigue en DRAFT, y eso es parte de lo que se prueba
 *
 * `AR-IVA-CF-VINCULACION-001.v1` no está ACTIVE —la bloquea el gap de vigencia
 * del Decreto 280/1997— y no se activa para que este test pase. Al contrario: el
 * recorrido tiene que demostrar **qué hace el sistema cuando no hay regla**, que
 * es el estado real del producto hoy.
 *
 * La respuesta correcta no es «no se puede asentar». Es:
 *
 *   · la vía determinística devuelve `REQUIERE_REVISION` y nombra qué falta;
 *   · la persona puede resolver por su cuenta con una decisión MANUAL, que exige
 *     justificación escrita y **no cita ninguna regla**;
 *   · el asiento entra fundado en esa decisión, y la trazabilidad lo dice.
 *
 * Un sistema que en esa situación asentara igual, o que no asentara nunca, sería
 * peor que este. El primero inventaría un fundamento; el segundo dejaría la
 * contabilidad detenida esperando una fuente normativa.
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

/** Coincide con un fixture del mock de ARCA: da APROBADO en vez del rechazo por defecto. */
const PROVEEDOR = '30710000001';
const CAE = '75000000000001';
const TOTAL = '121000.00';

suite('Circuito MVP de punta a punta', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresa: string;
  let stamp: string;
  let userId: string;

  let documentId = '';
  let taxTransactionId = '';
  let afectacionId = '';
  let decisionId = '';
  let entryId = '';
  let statementId = '';
  let cuentaCompras = '';

  const cab = () => ({ authorization: `Bearer ${token}`, 'x-company-id': empresa });
  const pedir = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: cab(), ...(payload === undefined ? {} : { payload }) });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    stamp = await sufijoUnico(db);
    const email = `e2e-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    userId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [email, 'Contadora', hash],
      )
    ).rows[0]!.id;
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio e2e ${stamp}`, withCheckDigit(`30${stamp}`), userId,
      ])
    ).rows[0]!.create_organization;

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

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        userId, organizationId, 'Circuito MVP SA', withCheckDigit(`33${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, empresa, userId, rol]);
    }

    await pedir('POST', '/companies/current/reporting-framework', {
      framework: 'RT_FACPCE', validFrom: '2026-01-01',
    });
    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
      { code: '3.1.01', name: 'Capital suscripto', type: 'PN' },
      { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
      { code: '5.1.01', name: 'Compras', type: 'COSTO' },
    ]) {
      const r = await pedir('POST', '/accounts', cuenta);
      expect(r.statusCode, r.body).toBe(201);
      if (cuenta.code === '5.1.01') cuentaCompras = r.json<{ id: string }>().id;
      if (cuenta.code === '3.4.01') {
        await pedir('PATCH', `/accounts/${r.json<{ id: string }>().id}`, {
          closingRole: 'RESULTADO_DEL_EJERCICIO',
          motivo: 'Designación de la cuenta de resultado del ejercicio',
        });
      }
    }
    const ej = await pedir('POST', '/fiscal-years', {
      code: `EJ2026-e2e-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
    });
    expect(ej.statusCode, ej.body).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------

  it('0 · la regla sigue en DRAFT y no hay ninguna ACTIVE de producto', async () => {
    // Se afirma al principio y se vuelve a afirmar al final: el circuito no
    // puede haber activado nada para completarse.
    const r = await db.query<{ status: string; approved_by: string | null }>(
      `SELECT status, approved_by FROM accounting_rules
        WHERE rule_key = 'AR-IVA-CF-VINCULACION-001'`,
    );
    expect(r.rows[0]!.status).toBe('DRAFT');
    expect(r.rows[0]!.approved_by).toBeNull();
  });

  it('1 · DOCUMENTO — el comprobante entra, se archiva y queda con su hash', async () => {
    const contenido = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><comprobante><cae>${CAE}</cae><total>${TOTAL}</total></comprobante>`,
    );
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="factura-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n${contenido.toString()}\r\n--X--\r\n`;

    const r = await app.inject({
      method: 'POST', url: '/documents',
      headers: { ...cab(), 'content-type': 'multipart/form-data; boundary=X' },
      payload: forma,
    });
    expect(r.statusCode, r.body).toBe(201);
    documentId = r.json<{ id: string }>().id;

    const d = await db.query<{ sha256: string; company_id: string }>(
      'SELECT sha256, company_id FROM documents WHERE id = $1',
      [documentId],
    );
    expect(d.rows[0]!.sha256).toHaveLength(64);
    expect(d.rows[0]!.company_id).toBe(empresa);
  });

  it('2 · TAX TRANSACTION — la operación fiscal nace SIN constatar', async () => {
    const r = await pedir('POST', `/documents/${documentId}/tax-transaction`, {
      direction: 'COMPRAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero: 1001,
      fecha: '2026-03-15',
      cuitContraparte: PROVEEDOR,
      razonSocial: 'Proveedor de insumos',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: TOTAL,
      iva: '0',
      noGravado: '0',
      exento: '0',
      percepciones: '0',
      total: TOTAL,
    });
    expect(r.statusCode, r.body).toBe(201);
    taxTransactionId = r.json<{ taxTransactionId: string }>().taxTransactionId;

    // Nace en NO_CONSULTADO y no en "OK declarado": ya no hay forma de afirmar
    // una constatación en el mismo pedido que crea la operación.
    const t = await db.query<{ constatacion: string; constatacion_origen: string }>(
      'SELECT constatacion, constatacion_origen FROM tax_transactions WHERE id = $1',
      [taxTransactionId],
    );
    expect(t.rows[0]!.constatacion).toBe('NO_CONSULTADO');
    expect(t.rows[0]!.constatacion_origen).toBe('NO_CONSULTADO');
  });

  it('3 · ARCA — el sistema pregunta, y guarda la respuesta con su procedencia', async () => {
    const r = await pedir('POST', `/tax-transactions/${taxTransactionId}/constatar`, {
      modalidad: 'CAE',
      cae: CAE,
      tipoDocReceptor: '80',
      nroDocReceptor: PROVEEDOR,
    });
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ constatacion: string; origen: string; arcaQueryId: string }>();

    expect(cuerpo.origen).toBe('ARCA');
    expect(cuerpo.constatacion).toBe('OK');

    // La prueba de que la consulta ocurrió: sin la fila del log, el CHECK
    // `tt_constatacion_arca_con_consulta` no deja escribir el resultado.
    const q = await db.query<{ service: string; outcome: string }>(
      'SELECT service, outcome FROM arca_query_log WHERE id = $1',
      [cuerpo.arcaQueryId],
    );
    expect(q.rows[0]!.service).toBe('wscdc');
    expect(q.rows[0]!.outcome).toBe('APROBADO');
  });

  it('4 · AFECTACIÓN — la persona declara, con evidencia que apunta a objetos reales', async () => {
    const r = await pedir('POST', `/tax-transactions/${taxTransactionId}/afectacion`, {
      afectacion: 'GRAVADAS',
      evidencia: [
        { tipo: 'DOCUMENTO', id: documentId },
        { tipo: 'CUENTA', id: cuentaCompras },
      ],
      motivo: 'Insumos aplicados íntegramente a la actividad gravada del ente',
    });
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ id: string; hecho: { estado: string; valor: boolean } }>();
    afectacionId = cuerpo.id;

    expect(cuerpo.hecho.estado).toBe('PROVISTO');
    expect(cuerpo.hecho.valor).toBe(true);
  });

  it('5 · DECISIÓN — sin regla ACTIVE, la vía determinística pide revisión y dice qué falta', async () => {
    // Se prueba sobre OTRO comprobante, no sobre el del circuito.
    //
    // Una operación admite una sola decisión vigente —índice único de la 0035— y
    // no hay ruta productiva para superseder una: hoy eso se hace por SQL. Así
    // que emitir primero la determinística y después la manual sobre el mismo
    // comprobante no es un camino que el producto ofrezca, y este test no lo
    // finge. El gap queda anotado en el informe.
    const contenido = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><comprobante><id>otro-${stamp}</id></comprobante>`,
    );
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="otro-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n${contenido.toString()}\r\n--X--\r\n`;
    const doc = await app.inject({
      method: 'POST', url: '/documents',
      headers: { ...cab(), 'content-type': 'multipart/form-data; boundary=X' },
      payload: forma,
    });
    const otroDoc = doc.json<{ id: string }>().id;

    const op = await pedir('POST', `/documents/${otroDoc}/tax-transaction`, {
      direction: 'COMPRAS', cbteTipo: 1, puntoVenta: 1, numero: 1002, fecha: '2026-03-16',
      cuitContraparte: PROVEEDOR, razonSocial: 'Proveedor', condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '1000.00', iva: '0', noGravado: '0', exento: '0', percepciones: '0', total: '1000.00',
    });
    const otraOperacion = op.json<{ taxTransactionId: string }>().taxTransactionId;

    // El resultado correcto con el estado real del sistema. No se activa nada
    // para que dé otro: la regla que resolvería esto está bloqueada por un gap
    // normativo abierto, y el sistema lo dice en vez de suponer.
    const r = await pedir('POST', `/comprobantes/${otraOperacion}/decision`);
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ resultado: string; motivos: { motivo: string }[]; decisionId: string }>();

    expect(cuerpo.resultado).toBe('REQUIERE_REVISION');
    expect(cuerpo.motivos.length).toBeGreaterThan(0);

    const d = await db.query<{ origen: string; rule_keys: unknown }>(
      `SELECT origen,
              (SELECT count(*)::int FROM rule_applications ra WHERE ra.decision_id = d.id) AS rule_keys
         FROM accounting_decisions d WHERE d.id = $1`,
      [cuerpo.decisionId],
    );
    expect(d.rows[0]!.origen).toBe('DETERMINISTICA');
    // Cero aplicaciones de regla: no había ninguna que aplicar, y no se inventó.
    expect(Number(d.rows[0]!.rule_keys)).toBe(0);
  });

  it('6 · DECISIÓN MANUAL — la persona resuelve, con justificación y sin citar reglas', async () => {
    const r = await pedir('POST', `/comprobantes/${taxTransactionId}/decision`, {
      manual: {
        justificacion:
          'Compra de insumos con comprobante constatado por ARCA y afectación declarada a ' +
          'operaciones gravadas. Se imputa a Compras contra Proveedores.',
        resultado: 'PROPUESTA_DE_ASIENTO',
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    decisionId = r.json<{ decisionId: string }>().decisionId;

    const d = await db.query<{ origen: string; ambiente: string; justificacion: string; n: string }>(
      `SELECT d.origen, d.ambiente, d.justificacion,
              (SELECT count(*)::text FROM rule_applications ra WHERE ra.decision_id = d.id) AS n
         FROM accounting_decisions d WHERE d.id = $1`,
      [decisionId],
    );
    expect(d.rows[0]!.origen).toBe('MANUAL');
    expect(d.rows[0]!.ambiente).toBe('PRODUCTIVO');
    expect(d.rows[0]!.justificacion.length).toBeGreaterThan(30);
    // `assert_decision_manual_sin_regla`: una decisión manual no inventa una regla.
    expect(d.rows[0]!.n).toBe('0');
  });

  it('7 · ASIENTO — entra al Diario fundado en esa decisión', async () => {
    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'COMPRAS',
      entryDate: '2026-03-15',
      description: `Compra de insumos — factura 0001-00001001`,
      currency: 'ARS',
      lines: [
        { accountCode: '5.1.01', debit: TOTAL, credit: '0' },
        { accountCode: '2.1.01', debit: '0', credit: TOTAL },
      ],
      source: { type: 'INVOICE', id: taxTransactionId },
      decisionId,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    entryId = alta.json<{ id: string }>().id;
    expect(entryId, alta.body).toBeTruthy();

    const aprobado = await pedir('POST', `/journal-entries/${entryId}/approve`);
    expect(aprobado.statusCode, aprobado.body).toBe(200);
  });

  it('8 · DIARIO — el asiento aparece, y cuadra', async () => {
    const r = await pedir('GET', '/books/diario?desde=2026-01-01&hasta=2026-12-31');
    expect(r.statusCode, r.body).toBe(200);
    const libro = r.json<{ folios: { asientos: { id: string; totalDebe: string; totalHaber: string }[] }[] }>();
    const asientos = libro.folios.flatMap((f) => f.asientos);
    const mio = asientos.find((a) => a.id === entryId);

    expect(mio, 'el asiento no llegó al Libro Diario').toBeDefined();
    expect(mio!.totalDebe).toBe(mio!.totalHaber);
  });

  it('9 · MAYOR — el movimiento se proyectó, y coincide con el Diario', async () => {
    const r = await pedir('GET', '/books/mayor?desde=2026-01-01&hasta=2026-12-31');
    expect(r.statusCode, r.body).toBe(200);

    const m = await db.query<{ n: string; debe: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(m.debit),0)::text AS debe
         FROM ledger_movements m
         JOIN journal_entry_lines l ON l.id = m.entry_line_id
        WHERE l.entry_id = $1`,
      [entryId],
    );
    expect(m.rows[0]!.n).toBe('2');
    expect(m.rows[0]!.debe).toBe(TOTAL);
  });

  it('10 · ESTADO CONTABLE — se emite con este asiento adentro', async () => {
    const ejercicio = await db.query<{ id: string }>(
      'SELECT id FROM fiscal_years WHERE company_id = $1',
      [empresa],
    );
    const r = await pedir('POST', '/statements/issue', {
      ejercicio: ejercicio.rows[0]!.id,
      tipo: 'ESP',
    });
    expect(r.statusCode, r.body).toBe(201);
    statementId = r.json<{ estadoId: string }>().estadoId;

    const lineas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM financial_statement_lines
        WHERE statement_id = $1 AND line_type = 'RENGLON' AND amount <> 0`,
      [statementId],
    );
    expect(Number(lineas.rows[0]!.n)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // La trazabilidad, recorrida en las dos direcciones
  // -------------------------------------------------------------------------

  it('11 · del asiento se llega al comprobante, a la decisión y al documento', async () => {
    const r = await db.query<{
      decision_id: string; decision_origen: string; source_id: string;
    }>(
      `SELECT decision_id::text, decision_origen, source_id::text
         FROM ledger_trace WHERE entry_id = $1 LIMIT 1`,
      [entryId],
    );
    expect(r.rows[0]!.decision_id).toBe(decisionId);
    expect(r.rows[0]!.decision_origen).toBe('MANUAL');
    expect(r.rows[0]!.source_id).toBe(taxTransactionId);
  });

  it('12 · del comprobante se llega a su constatación y a su afectación', async () => {
    const r = await db.query<{
      constatacion: string; constatacion_origen: string; arca_query_id: string; afectacion: string;
    }>(
      `SELECT t.constatacion, t.constatacion_origen, t.arca_query_id::text,
              (SELECT a.afectacion FROM tax_affectations_declaradas a
                WHERE a.tax_transaction_id = t.id) AS afectacion
         FROM tax_transactions t WHERE t.id = $1`,
      [taxTransactionId],
    );
    expect(r.rows[0]!.constatacion).toBe('OK');
    expect(r.rows[0]!.constatacion_origen).toBe('ARCA');
    expect(r.rows[0]!.arca_query_id).toBeTruthy();
    expect(r.rows[0]!.afectacion).toBe('GRAVADAS');
  });

  it('13 · la evidencia de la afectación apunta a objetos que existen', async () => {
    const r = await db.query<{ evidencia: { tipo: string; id: string }[] }>(
      'SELECT evidencia FROM tax_affectations WHERE id = $1',
      [afectacionId],
    );
    const referencias = r.rows[0]!.evidencia.filter((e) => e.tipo !== 'NOTA');
    expect(referencias.length).toBeGreaterThan(0);

    for (const ref of referencias) {
      const tabla = ref.tipo === 'DOCUMENTO' ? 'documents' : 'accounts';
      const existe = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${tabla} WHERE id = $1 AND company_id = $2`,
        [ref.id, empresa],
      );
      expect(existe.rows[0]!.n, `la evidencia ${ref.tipo} no apunta a nada`).toBe('1');
    }
  });

  it('14 · todo el recorrido quedó en la bitácora, encadenado', async () => {
    const r = await db.query<{ action: string; prev_hash: string; hash: string }>(
      'SELECT action, prev_hash, hash FROM audit_logs WHERE company_id = $1 ORDER BY seq',
      [empresa],
    );
    const acciones = r.rows.map((x) => x.action);

    for (const esperada of [
      'ROL_OTORGADO',
      'OPERACION_FISCAL_REGISTRADA',
      'CONSTATAR_COMPROBANTE',
      'DECLARAR_AFECTACION',
      'DECISION_REGISTRADA',
    ]) {
      expect(acciones, `falta ${esperada} en la bitácora`).toContain(esperada);
    }

    // Y la cadena es continua: cada prev_hash es el hash de la entrada anterior.
    let anterior = '0'.repeat(64);
    for (const fila of r.rows) {
      expect(fila.prev_hash).toBe(anterior);
      anterior = fila.hash;
    }
  });

  it('15 · y al final la regla sigue DRAFT: nada se activó para completar el circuito', async () => {
    const r = await db.query<{ status: string; approved_by: string | null }>(
      `SELECT status, approved_by FROM accounting_rules
        WHERE rule_key = 'AR-IVA-CF-VINCULACION-001'`,
    );
    expect(r.rows[0]!.status).toBe('DRAFT');
    expect(r.rows[0]!.approved_by).toBeNull();

    const activas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_rules
        WHERE status = 'ACTIVE' AND rule_key NOT LIKE 'R-%'`,
    );
    expect(activas.rows[0]!.n, 'se activó una regla real durante el circuito').toBe('0');
  });
});
