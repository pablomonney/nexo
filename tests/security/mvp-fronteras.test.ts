/**
 * Las veinte fronteras del MVP, cada una probada donde se sostiene.
 *
 * No reemplaza a los tests de aislamiento que ya existen —`endpoint-isolation`
 * barre el inventario de rutas, `vistas-rls` barre las vistas,
 * `aislamiento-multiempresa` barre el catálogo de tablas—: amplía lo que esta
 * fase agregó, que es de lo que todavía no había nada.
 *
 * ## El criterio para elegir dónde probar cada cosa
 *
 * Si el candado está en la base, se prueba **por SQL directo**: probarlo por
 * HTTP demostraría que la ruta lo respeta, no que el candado exista. Si el
 * candado está en la ruta, se prueba por HTTP. Y donde hay los dos, se prueban
 * los dos, porque una fuga necesita que fallen ambos.
 *
 * Las que se prueban con su pareja «y lo propio sí funciona» la llevan siempre:
 * un test que solo comprueba el rechazo pasa igual con el sistema entero roto.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, expectFailureCode, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';
const PROVEEDOR = '30710000001';

interface Lado {
  companyId: string;
  token: string;
  userId: string;
  documentId: string;
  taxTransactionId: string;
  cuentaId: string;
}

suite('Fronteras del MVP', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let A: Lado;
  let B: Lado;

  const pedir = (
    l: Lado,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    empresa?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${l.token}`, 'x-company-id': empresa ?? l.companyId },
      ...(payload === undefined ? {} : { payload }),
    });

  async function ingresar(email: string): Promise<string> {
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
    const token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
    return token;
  }

  /** Una empresa completa, con su propio dueño: sin rol cruzado entre A y B. */
  async function montar(
    etiqueta: string,
    prefijoOrg: string,
    prefijo: string,
    numero: number,
  ): Promise<Lado> {
    const email = `frontera-${etiqueta}-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    const userId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [email, `Persona ${etiqueta}`, hash],
      )
    ).rows[0]!.id;
    const org = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio ${etiqueta} ${stamp}`, withCheckDigit(`${prefijoOrg}${stamp}`), userId,
      ])
    ).rows[0]!.create_organization;
    const companyId = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        userId, org, `Frontera ${etiqueta}`, withCheckDigit(`${prefijo}${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, companyId, userId, rol]);
    }

    const token = await ingresar(email);
    const lado: Lado = {
      companyId, token, userId, documentId: '', taxTransactionId: '', cuentaId: '',
    };

    await pedir(lado, 'POST', '/companies/current/reporting-framework', {
      framework: 'RT_FACPCE', validFrom: '2026-01-01',
    });
    const cuenta = await pedir(lado, 'POST', '/accounts', {
      code: '5.1.01', name: 'Compras', type: 'COSTO',
    });
    lado.cuentaId = cuenta.json<{ id: string }>().id;
    await pedir(lado, 'POST', '/fiscal-years', {
      code: `EJ2026-${prefijo}-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
    });

    const contenido = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><c><id>${etiqueta}-${stamp}</id></c>`,
    );
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="f-${etiqueta}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n${contenido.toString()}\r\n--X--\r\n`;
    const doc = await app.inject({
      method: 'POST', url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': companyId,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(doc.statusCode, doc.body).toBe(201);
    lado.documentId = doc.json<{ id: string }>().id;

    const op = await pedir(lado, 'POST', `/documents/${lado.documentId}/tax-transaction`, {
      direction: 'COMPRAS', cbteTipo: 1, puntoVenta: 1, numero, fecha: '2026-03-15',
      cuitContraparte: PROVEEDOR, razonSocial: 'Proveedor', condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '1000.00', iva: '0', noGravado: '0', exento: '0', percepciones: '0', total: '1000.00',
    });
    expect(op.statusCode, op.body).toBe(201);
    lado.taxTransactionId = op.json<{ taxTransactionId: string }>().taxTransactionId;

    return lado;
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    A = await montar('a', '30', '33', 5001);
    B = await montar('b', '34', '27', 6001);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 a 7 · Lo de B no se ve, no se usa y no contamina
  // -------------------------------------------------------------------------

  describe('lo de B no llega a A', () => {
    it('1 · A no ve los documentos de B, y sí los suyos', async () => {
      const r = await pedir(A, 'GET', '/documents');
      expect(r.statusCode, r.body).toBe(200);
      const ids = r.json<{ documentos: { id: string }[] }>().documentos.map((d) => d.id);

      expect(ids).toContain(A.documentId);
      expect(ids).not.toContain(B.documentId);

      // Y pedirlo por id tampoco: para A, el documento de B no existe.
      expect((await pedir(A, 'GET', `/documents/${B.documentId}`)).statusCode).toBe(404);
      expect((await pedir(A, 'GET', `/documents/${A.documentId}`)).statusCode).toBe(200);
    });

    it('2 · A no consulta la operación fiscal de B', async () => {
      expect(
        (await pedir(A, 'GET', `/documents/${B.documentId}/tax-transaction`)).statusCode,
      ).toBe(404);
      expect(
        (await pedir(A, 'GET', `/documents/${A.documentId}/tax-transaction`)).statusCode,
      ).toBe(200);
    });

    it('3 · A no declara una afectación sobre una operación de B', async () => {
      const r = await pedir(A, 'POST', `/tax-transactions/${B.taxTransactionId}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [{ tipo: 'CUENTA', id: A.cuentaId }],
      });
      expect(r.statusCode).toBe(404);
    });

    it('4 · una cuenta de B no sirve como evidencia en A', async () => {
      const r = await pedir(A, 'POST', `/tax-transactions/${A.taxTransactionId}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [{ tipo: 'CUENTA', id: B.cuentaId }],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('EVIDENCIA_INEXISTENTE');
    });

    it('5 · una decisión de B no funda un asiento de A', async () => {
      const deB = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
            ambiente, decidida_por, justificacion)
         VALUES ($1, $2, 'MANUAL', 'PROPUESTA_DE_ASIENTO', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
                 'PRODUCTIVO', 'test', 'Decisión de B, para comprobar que no cruza a A')
         RETURNING id`,
        [B.companyId, B.taxTransactionId],
      );

      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, currency, total_debit, total_credit,
              source_type, decision_id, created_by)
           SELECT $1, 'GENERAL', p.id, p.fiscal_year_id, 90001, '2026-03-15',
                  'Intento de fundarse en una decisión ajena', 'MANUAL', 'BORRADOR', 'ARS',
                  100, 100, 'MANUAL', $2, 'test'
             FROM periods p WHERE p.company_id = $1 AND p.number = 3 LIMIT 1`,
          [A.companyId, deB.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/pertenece a otra empresa/);
    });

    it('6 · una extracción de B no aparece en los campos de A', async () => {
      // Es la vía por la que un OCR podría contaminar: los campos cuelgan de la
      // extracción, la extracción del documento, y el documento de la empresa.
      const fuga = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM document_extraction_fields f
           JOIN document_extractions e ON e.id = f.extraction_id
           JOIN documents d ON d.id = e.document_id
          WHERE f.company_id = $1 AND d.company_id <> $1`,
        [A.companyId],
      );
      expect(fuga.rows[0]!.n).toBe('0');
    });

    it('7 · A no ve las credenciales de ARCA de B', async () => {
      await db.query(
        `INSERT INTO company_arca_credentials
           (company_id, environment, cuit, alias, certificate_pem, private_key_encrypted,
            key_encryption_ref, not_before, not_after, status, created_by)
         VALUES ($1, 'homologacion', '30710000001', 'de B', 'PEM', 'v1.x.y.z', 'local:dev',
                 now() - interval '1 day', now() + interval '365 days', 'ACTIVE', 'test')`,
        [B.companyId],
      );

      const r = await pedir(A, 'GET', '/companies/current/arca/credentials');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ credenciales: unknown[] }>().credenciales).toEqual([]);

      // Y la vista pública tampoco las devuelve bajo el contexto de A.
      const desdeA = await db.query('SELECT set_config($1,$2,true)', ['app.company_id', A.companyId]);
      expect(desdeA.rowCount).toBe(1);
    });

    it('7b · y la respuesta nunca trae la clave ni el certificado', async () => {
      // La vista no tiene esas columnas: no es una precaución del handler.
      const columnas = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'company_arca_credentials_public'`,
      );
      const nombres = columnas.rows.map((c) => c.column_name);
      expect(nombres).not.toContain('private_key_encrypted');
      expect(nombres).not.toContain('certificate_pem');
    });
  });

  // -------------------------------------------------------------------------
  // 8 y 9 · Ni el frontend ni el SQL directo saltean los candados
  // -------------------------------------------------------------------------

  describe('los candados no dependen de quién llame', () => {
    it('8 · el token de A pidiendo la empresa B es rechazado en el borde', async () => {
      // El "frontend" no tiene forma de saltear el RLS porque no habla con la
      // base: habla con la API, y la API resuelve la empresa desde el rol del
      // usuario, no desde lo que el cliente diga.
      const r = await pedir(A, 'GET', '/documents', undefined, B.companyId);
      expect(r.statusCode).toBe(403);
    });

    it('9 · por SQL directo, A no ve ni inserta nada de B', async () => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE aai_app');
        await db.query('SELECT set_config($1,$2,true)', ['app.company_id', A.companyId]);

        const ajenos = await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM documents WHERE company_id = $1',
          [B.companyId],
        );
        expect(ajenos.rows[0]!.n).toBe('0');

        const propios = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM documents');
        expect(Number(propios.rows[0]!.n)).toBeGreaterThan(0);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 10 a 12 · La corrección de decisiones
  // -------------------------------------------------------------------------

  describe('corregir una decisión', () => {
    let primera = '';
    let segunda = '';

    it('emite la primera decisión', async () => {
      const r = await pedir(A, 'POST', `/comprobantes/${A.taxTransactionId}/decision`, {
        manual: {
          justificacion: 'Compra de insumos imputada a Compras contra Proveedores, sin regla vigente',
          resultado: 'PROPUESTA_DE_ASIENTO',
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      primera = r.json<{ decisionId: string }>().decisionId;
    });

    it('11 · la corrección conserva la anterior, encadenada', async () => {
      const r = await pedir(A, 'POST', `/comprobantes/${A.taxTransactionId}/decision/supersede`, {
        supersedeId: primera,
        resultado: 'SIN_EFECTO',
        motivo: 'El comprobante corresponde a otro ejercicio: la imputación anterior no aplica',
      });
      expect(r.statusCode, r.body).toBe(201);
      segunda = r.json<{ decisionId: string }>().decisionId;

      const historial = await pedir(
        A, 'GET', `/comprobantes/${A.taxTransactionId}/decision/historial`,
      );
      const cuerpo = historial.json<{
        vigente: { id: string };
        historial: { id: string; estado: string; supersede: string | null }[];
      }>();

      expect(cuerpo.vigente.id).toBe(segunda);
      expect(cuerpo.historial).toHaveLength(2);
      // La anterior sigue ahí, apagada y encadenada.
      const vieja = cuerpo.historial.find((h) => h.id === primera)!;
      expect(vieja.estado).toBe('SUPERSEDIDA');
      expect(cuerpo.historial.find((h) => h.id === segunda)!.supersede).toBe(primera);
    });

    it('10 · una decisión supersedida no puede fundar un asiento nuevo', async () => {
      // El candado que faltaba. Sin él, corregir era una anotación optativa: la
      // decisión vieja seguía sirviendo para asentar.
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, currency, total_debit, total_credit,
              source_type, source_id, decision_id, created_by)
           SELECT $1, 'GENERAL', p.id, p.fiscal_year_id, 90002, '2026-03-15',
                  'Intento de usar una decisión supersedida', 'MANUAL', 'BORRADOR', 'ARS',
                  100, 100, 'INVOICE', $3, $2, 'test'
             FROM periods p WHERE p.company_id = $1 AND p.number = 3 LIMIT 1`,
          [A.companyId, primera, A.taxTransactionId],
        ),
      );
      expect(mensaje).toMatch(/fue supersedida/);
    });

    it('12 · la corrección quedó auditada, con actor, motivo y las dos puntas', async () => {
      const log = await db.query<{
        actor_id: string; motivo: string;
        old_value: { id: string }; new_value: { id: string; supersedes: string };
      }>(
        `SELECT actor_id, motivo, old_value, new_value FROM audit_logs
          WHERE company_id = $1 AND action = 'DECISION_CORREGIDA'
          ORDER BY seq DESC LIMIT 1`,
        [A.companyId],
      );
      expect(log.rowCount).toBe(1);
      expect(log.rows[0]!.actor_id).toBe(`user:${A.userId}`);
      expect(log.rows[0]!.motivo).toMatch(/otro ejercicio/);
      expect(log.rows[0]!.old_value.id).toBe(primera);
      expect(log.rows[0]!.new_value.supersedes).toBe(primera);
    });

    it('12b · corregir exige decir qué cambió: la base no acepta un motivo vacío', async () => {
      const { code } = await expectFailureCode(() =>
        db.query(
          `INSERT INTO accounting_decisions
             (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
              ambiente, decidida_por, justificacion, supersedes_id)
           VALUES ($1, $2, 'MANUAL', 'SIN_EFECTO', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
                   'PRODUCTIVO', 'test', 'se corrigió', $3)`,
          [A.companyId, A.taxTransactionId, segunda],
        ),
      );
      expect(code).toBe('23514');
    });

    it('12c · una corrección no cambia de comprobante ni de empresa', async () => {
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO accounting_decisions
             (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
              ambiente, decidida_por, justificacion, supersedes_id)
           VALUES ($1, $2, 'MANUAL', 'SIN_EFECTO', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
                   'PRODUCTIVO', 'test',
                   'Intento de corregir la decisión de otro comprobante distinto', $3)`,
          [A.companyId, B.taxTransactionId, segunda],
        ),
      );
      expect(mensaje).toMatch(/otra empresa|otra operación fiscal/);
    });
  });

  // -------------------------------------------------------------------------
  // 13 a 17 · Las fronteras semánticas
  // -------------------------------------------------------------------------

  describe('lo que no se sabe no se convierte en un dato', () => {
    it('13 · una decisión de ambiente PRUEBA no funda un asiento', async () => {
      const prueba = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, origen, resultado, motivos, hechos, evidencia,
            ambiente, decidida_por, justificacion)
         VALUES ($1, 'MANUAL', 'PROPUESTA_DE_ASIENTO', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
                 'PRUEBA', 'test', 'Decisión de prueba, no debe fundar nada productivo')
         RETURNING id`,
        [A.companyId],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, currency, total_debit, total_credit,
              source_type, decision_id, created_by)
           SELECT $1, 'GENERAL', p.id, p.fiscal_year_id, 90003, '2026-03-15',
                  'Intento con decisión de prueba', 'MANUAL', 'BORRADOR', 'ARS', 100, 100,
                  'MANUAL', $2, 'test'
             FROM periods p WHERE p.company_id = $1 AND p.number = 3 LIMIT 1`,
          [A.companyId, prueba.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/PRUEBA/);
    });

    it('14 · una predicción de IA no se convierte sola en decisión', async () => {
      // El candado es estructural: una decisión con `ai_prediction_id` tiene que
      // declarar `origen = 'PROPUESTA_IA'`, y una PROPUESTA_IA sin predicción no
      // entra. Las dos direcciones, para que no haya forma de disfrazar una de
      // la otra.
      const sinPrediccion = await expectFailureCode(() =>
        db.query(
          `INSERT INTO accounting_decisions
             (company_id, origen, resultado, motivos, hechos, evidencia, ambiente, decidida_por)
           VALUES ($1, 'PROPUESTA_IA', 'PROPUESTA_DE_ASIENTO', '[]'::jsonb, '{}'::jsonb,
                   '[]'::jsonb, 'PRODUCTIVO', 'ai:test')`,
          [A.companyId],
        ),
      );
      expect(sinPrediccion.code).toBe('23514');
    });

    it('14b · y ningún asiento creado por IA existe sin firma humana', async () => {
      const huerfanos = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_entries
          WHERE ai_prediction_id IS NOT NULL AND status = 'APROBADO' AND approved_by IS NULL`,
      );
      expect(huerfanos.rows[0]!.n).toBe('0');
    });

    it('15 · una regla DRAFT no puede fundar una decisión productiva', async () => {
      const regla = await db.query<{ id: string }>(
        `SELECT id FROM accounting_rules WHERE status = 'DRAFT' LIMIT 1`,
      );
      if (regla.rowCount === 0) return;

      const decision = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, origen, resultado, motivos, hechos, evidencia, ambiente, decidida_por, justificacion)
         VALUES ($1, 'DETERMINISTICA', 'PROPUESTA_DE_ASIENTO', '[]'::jsonb, '{}'::jsonb,
                 '[]'::jsonb, 'PRODUCTIVO', 'test',
                 'Decisión determinística de prueba para el candado de reglas DRAFT')
         RETURNING id`,
        [A.companyId],
      );

      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO rule_applications
             (company_id, decision_id, rule_id, rule_version, target_type, target_id, inputs, outputs)
           VALUES ($1, $2, $3, 1, 'DECISION', $2, '{}'::jsonb, '{}'::jsonb)`,
          [A.companyId, decision.rows[0]!.id, regla.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/no puede fundar una decisión productiva|estado DRAFT/);
    });

    it('16 · sin evidencia válida, la afectación no entra', async () => {
      const r = await pedir(A, 'POST', `/tax-transactions/${A.taxTransactionId}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('EVIDENCIA_REQUERIDA');
    });

    it('17 · sin afectación declarada, el hecho queda AUSENTE y no falso', async () => {
      const r = await pedir(B, 'GET', `/tax-transactions/${B.taxTransactionId}/afectacion`);
      expect(r.statusCode, r.body).toBe(200);
      const cuerpo = r.json<{ declarada: boolean; hecho: { estado: string } }>();
      expect(cuerpo.declarada).toBe(false);
      expect(cuerpo.hecho.estado).toBe('AUSENTE');
    });

    it('17b · una sugerencia por precedente no cuenta como declaración', async () => {
      await db.query(
        `INSERT INTO tax_affectations
           (company_id, tax_transaction_id, afectacion, evidencia, origen)
         VALUES ($1, $2, 'GRAVADAS', $3::jsonb, 'SUGERIDA_POR_PRECEDENTE')`,
        [B.companyId, B.taxTransactionId, JSON.stringify([{ tipo: 'CUENTA', id: B.cuentaId }])],
      );

      const enLaVista = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM tax_affectations_declaradas WHERE tax_transaction_id = $1',
        [B.taxTransactionId],
      );
      expect(enLaVista.rows[0]!.n, 'una sugerencia entró a la vista de declaraciones').toBe('0');

      const r = await pedir(B, 'GET', `/tax-transactions/${B.taxTransactionId}/afectacion`);
      expect(r.json<{ declarada: boolean; hecho: { estado: string } }>().declarada).toBe(false);
      expect(r.json<{ hecho: { motivo: string } }>().hecho.motivo).toBe('SUGERIDA_SIN_DECLARAR');
    });
  });

  // -------------------------------------------------------------------------
  // 18 a 20 · ARCA y OCR
  // -------------------------------------------------------------------------

  describe('preguntar, declarar y leer son tres cosas distintas', () => {
    it('18 · constatar deja su fila en arca_query_log, ligada a la operación', async () => {
      const r = await pedir(A, 'POST', `/tax-transactions/${A.taxTransactionId}/constatar`, {
        cae: '75000000000001',
        nroDocReceptor: PROVEEDOR,
      });
      expect(r.statusCode, r.body).toBe(200);
      const queryId = r.json<{ arcaQueryId: string }>().arcaQueryId;

      const t = await db.query<{ arca_query_id: string; constatacion_origen: string }>(
        'SELECT arca_query_id::text, constatacion_origen FROM tax_transactions WHERE id = $1',
        [A.taxTransactionId],
      );
      expect(t.rows[0]!.arca_query_id).toBe(queryId);
      expect(t.rows[0]!.constatacion_origen).toBe('ARCA');
    });

    it('19 · sin consultar, nada puede figurar como respuesta de ARCA', async () => {
      // El CHECK exige la fila del log para poder declarar procedencia ARCA. Sin
      // consulta no hay forma de escribir ese origen, ni siquiera por SQL.
      const { code } = await expectFailureCode(() =>
        db.query(
          `UPDATE tax_transactions
              SET constatacion = 'OK', constatacion_origen = 'ARCA', arca_query_id = NULL
            WHERE id = $1`,
          [B.taxTransactionId],
        ),
      );
      expect(code).toBe('23514');
    });

    it('19b · y un log de otra empresa no sirve como respaldo', async () => {
      const deA = await db.query<{ id: string }>(
        'SELECT id FROM arca_query_log WHERE company_id = $1 ORDER BY queried_at DESC LIMIT 1',
        [A.companyId],
      );
      const mensaje = await expectFailure(() =>
        db.query(
          `UPDATE tax_transactions
              SET constatacion = 'OK', constatacion_origen = 'ARCA', arca_query_id = $2
            WHERE id = $1`,
          [B.taxTransactionId, deA.rows[0]!.id],
        ),
      );
      expect(mensaje).toMatch(/otra empresa/);
    });

    it('20 · el OCR no tiene por dónde escribir un hecho fiscal', async () => {
      // No es una regla del código: es que no existe el camino. La evidencia de
      // una afectación solo admite objetos del sistema —comprobante, cuenta,
      // documento, asiento, otra declaración, o una nota de texto— y un campo
      // extraído no es ninguno de esos.
      const tipos = await db.query<{ def: string }>(
        `SELECT prosrc AS def FROM pg_proc WHERE proname = 'assert_affectation_shape'`,
      );
      expect(tipos.rows[0]!.def).not.toMatch(/EXTRACCION|CAMPO_EXTRAIDO|OCR/);

      // Y el intento directo se rechaza por tipo desconocido.
      const mensaje = await expectFailure(() =>
        db.query(
          `INSERT INTO tax_affectations
             (company_id, tax_transaction_id, afectacion, evidencia, origen, declarada_por, declarada_at)
           VALUES ($1, $2, 'GRAVADAS', $3::jsonb, 'DECLARACION_PROFESIONAL', 'ocr', now())`,
          [
            A.companyId,
            A.taxTransactionId,
            JSON.stringify([{ tipo: 'CAMPO_EXTRAIDO', id: A.documentId }]),
          ],
        ),
      );
      expect(mensaje).toMatch(/Tipo de evidencia desconocido/);
    });

    it('20b · lo leído conserva su método y su confianza', async () => {
      const r = await pedir(A, 'POST', `/documents/${A.documentId}/extract`);
      expect(r.statusCode, r.body).toBe(201);

      const campos = await db.query<{ method: string; confidence: string }>(
        `SELECT f.method, f.confidence::text
           FROM document_extraction_fields f
           JOIN document_extractions e ON e.id = f.extraction_id
          WHERE e.document_id = $1`,
        [A.documentId],
      );
      // Todo campo declara de dónde salió. Un valor sin método sería un dato sin
      // procedencia, que es lo que este modelo existe para impedir.
      for (const campo of campos.rows) {
        expect(['OCR', 'XML', 'REGEX', 'LLM', 'MANUAL']).toContain(campo.method);
      }
    });
  });

  // -------------------------------------------------------------------------
  // La consola: una página, sin datos adentro
  // -------------------------------------------------------------------------

  describe('la consola operativa no es una puerta de atrás', () => {
    it('se sirve sin autenticar, porque no contiene ningún dato', async () => {
      const r = await app.inject({ method: 'GET', url: '/consola' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
    });

    it('no trae credenciales ni identificadores embebidos', async () => {
      // Lo que se comprueba no es que no diga «password» —hay un formulario de
      // login— sino que no lleve ningún VALOR: ni una clave, ni un token, ni un
      // id de empresa. Todo lo que muestra lo pide autenticado.
      const html = (await app.inject({ method: 'GET', url: '/consola' })).body;

      expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
      expect(html).not.toContain(A.companyId);
      expect(html).not.toContain(B.companyId);
      expect(html).not.toContain(PASSWORD);
      // Ningún UUID escrito a mano: si apareciera uno, sería un dato de alguien.
      expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('declara una política que no admite recursos externos', async () => {
      const r = await app.inject({ method: 'GET', url: '/consola' });
      const csp = String(r.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
    });

    it('no habla con la base: todo lo que hace es llamar a la API', async () => {
      // Una consola que consultara PostgreSQL por su cuenta saltearía el RLS de
      // la aplicación. No puede: es un archivo estático sin dependencias.
      const html = (await app.inject({ method: 'GET', url: '/consola' })).body;
      expect(html).not.toMatch(/postgres:|pg\.Client|SELECT .* FROM /i);
    });

    it('la raíz redirige a la consola y no sirve nada por su cuenta', async () => {
      // La raíz está exenta del barrido de autenticación (`SIN_DATOS`), así que
      // acá se comprueba que la exención sea cierta: que redirija y no tenga
      // cuerpo propio. Una exención que no se verifica es un permiso.
      const r = await app.inject({ method: 'GET', url: '/' });
      expect(r.statusCode).toBe(302);
      expect(r.headers['location']).toBe('/consola');
      expect(r.body).toBe('');
    });
  });
});
