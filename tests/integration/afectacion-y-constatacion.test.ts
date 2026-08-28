/**
 * Los dos eslabones que estaban desconectados, y el rastro de los permisos.
 *
 * La auditoría maestra encontró tres huecos con la misma forma —estructura
 * correcta, cero escritores— y este archivo prueba los tres caminos productivos
 * que los cierran:
 *
 *   1. **`tax_affectations` no tenía escritor.** El modelo existe desde la 0031
 *      con sus triggers, su vista y su auditoría, y las únicas filas del sistema
 *      las escribían tres suites de test. Sin declaración, el hecho
 *      `vinculadaConOperacionesGravadas` no puede salir nunca de AUSENTE.
 *   2. **ARCA no estaba en el flujo.** `constatacion` se recibía en el cuerpo
 *      del pedido y se guardaba igual que una respuesta del organismo. Un dato
 *      verificado y uno afirmado se veían idénticos.
 *   3. **Los cambios de permisos no dejaban rastro.** Ni la ruta ni la función
 *      `grant_company_role` escribían en la bitácora.
 *
 * ## Qué se prueba y qué no
 *
 * No se repiten los candados de la 0031 —que la evidencia exista, que sea de la
 * empresa, que MIXTA lleve proporción—: eso ya está en `tax-affectations.test.ts`
 * contra la base. Acá se prueba que **el camino productivo llega hasta esos
 * candados** y que sus rechazos salen como errores de dominio y no como 500.
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

/**
 * El proveedor del fixture del mock de ARCA.
 *
 * El escenario se busca por `(cuitEmisor, puntoVenta, tipo, numero)`, así que
 * estos cuatro valores son los que hacen que la constatación devuelva APROBADO
 * en vez del `RECHAZADO_INEXISTENTE` que el mock usa por defecto.
 */
const PROVEEDOR = '30710000001';
const CAE_DEL_FIXTURE = '75000000000001';

suite('Afectación profesional, constatación ARCA y auditoría de permisos', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresa: string;
  let otraEmpresa: string;
  let userId: string;
  let segundoUsuario: string;
  let organizationId: string;
  let stamp: string;
  let documentoA: string;
  let operacionA: string;
  let cuentaA: string;
  let operacionAjena: string;
  let cuentaAjena: string;

  const cab = (e: string) => ({ authorization: `Bearer ${token}`, 'x-company-id': e });
  const pedir = (e: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: cab(e), ...(payload === undefined ? {} : { payload }) });

  /** Sube un documento y registra su operación fiscal por HTTP. */
  async function montarComprobante(
    e: string,
    numero: number,
    total: string,
    cuitContraparte: string | null,
  ): Promise<{ documentId: string; taxTransactionId: string }> {
    // XML de verdad: el sniff del motor documental rechaza lo que no reconoce, y
    // hace bien. Un archivo cuyo contenido no coincide con su tipo no entra.
    const contenido = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><comprobante><id>${e}-${numero}-${stamp}</id></comprobante>`,
    );
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="c-${numero}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n${contenido.toString()}\r\n--X--\r\n`;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...cab(e), 'content-type': 'multipart/form-data; boundary=X' },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);
    const documentId = subida.json<{ id: string }>().id;

    const alta = await pedir(e, 'POST', `/documents/${documentId}/tax-transaction`, {
      direction: 'COMPRAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero,
      fecha: '2026-03-15',
      cuitContraparte,
      razonSocial: 'Proveedor de prueba',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: total,
      iva: '0',
      noGravado: '0',
      exento: '0',
      percepciones: '0',
      total,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    return { documentId, taxTransactionId: alta.json<{ taxTransactionId: string }>().taxTransactionId };
  }

  async function montarEmpresa(nombre: string, prefijo: string): Promise<string> {
    const c = await db.query<{ create_company: string }>(
      'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, organizationId, nombre, withCheckDigit(`${prefijo}${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31'],
    );
    const companyId = c.rows[0]!.create_company;
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, companyId, userId, rol]);
    }
    await pedir(companyId, 'POST', '/companies/current/reporting-framework', {
      framework: 'RT_FACPCE',
      validFrom: '2026-01-01',
    });
    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '5.1.01', name: 'Compras', type: 'COSTO' },
    ]) {
      const r = await pedir(companyId, 'POST', '/accounts', cuenta);
      expect(r.statusCode, r.body).toBe(201);
    }
    const ej = await pedir(companyId, 'POST', '/fiscal-years', {
      code: `EJ2026-${prefijo}-${stamp}`,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(ej.statusCode, ej.body).toBe(201);
    return companyId;
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    stamp = await sufijoUnico(db);
    const email = `afectacion-${stamp}@estudio.test`;
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
    segundoUsuario = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [`ayudante-${stamp}@estudio.test`, 'Ayudante', hash],
      )
    ).rows[0]!.id;

    organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio afectacion ${stamp}`, withCheckDigit(`30${stamp}`), userId,
      ])
    ).rows[0]!.create_organization;
    await db.query('INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,$3)', [
      organizationId, segundoUsuario, 'MEMBER',
    ]);

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

    empresa = await montarEmpresa('Afectacion A', '33');
    otraEmpresa = await montarEmpresa('Afectacion B', '27');

    const a = await montarComprobante(empresa, 1001, '121000.00', PROVEEDOR);
    documentoA = a.documentId;
    operacionA = a.taxTransactionId;

    const b = await montarComprobante(otraEmpresa, 2002, '5000.00', PROVEEDOR);
    operacionAjena = b.taxTransactionId;

    cuentaA = (
      await db.query<{ id: string }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '5.1.01'`,
        [empresa],
      )
    ).rows[0]!.id;
    cuentaAjena = (
      await db.query<{ id: string }>(
        `SELECT id FROM accounts WHERE company_id = $1 AND code = '5.1.01'`,
        [otraEmpresa],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · Sin declaración, el hecho no existe
  // -------------------------------------------------------------------------

  describe('1 · ausencia no es falso', () => {
    it('una operación sin afectación declarada informa el hecho como AUSENTE', async () => {
      const r = await pedir(empresa, 'GET', `/tax-transactions/${operacionA}/afectacion`);
      expect(r.statusCode, r.body).toBe(200);
      const cuerpo = r.json<{ declarada: boolean; hecho: { estado: string; motivo: string } }>();

      // 200 y no 404: la operación existe y no tiene declaración. Son estados
      // distintos y mandan a hacer cosas distintas.
      expect(cuerpo.declarada).toBe(false);
      expect(cuerpo.hecho.estado).toBe('AUSENTE');
      expect(cuerpo.hecho.motivo).toBe('SIN_DECLARACION');
    });

    it('una operación inexistente sí es 404', async () => {
      const r = await pedir(
        empresa, 'GET', '/tax-transactions/00000000-0000-0000-0000-000000000000/afectacion',
      );
      expect(r.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // 2 · La declaración profesional
  // -------------------------------------------------------------------------

  describe('2 · declarar es firmar', () => {
    it('sin evidencia no se declara, y el error dice por qué', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('EVIDENCIA_REQUERIDA');
    });

    it('la evidencia no puede ser solo texto libre', async () => {
      // Un párrafo plausible es exactamente lo que un modelo de lenguaje produce
      // mejor, y no es evidencia.
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [{ tipo: 'NOTA', texto: 'Se vincula con la actividad gravada del ente' }],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('EVIDENCIA_SIN_REFERENCIA');
    });

    it('una referencia inexistente se rechaza como error de dominio, no como 500', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [{ tipo: 'CUENTA', id: '00000000-0000-0000-0000-000000000000' }],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('EVIDENCIA_INEXISTENTE');
    });

    it('una cuenta de OTRA empresa tampoco sirve como evidencia', async () => {
      // El RLS la hace invisible y el trigger de la 0031 lo confirma. La empresa
      // A no puede respaldar su declaración con nada de B.
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [{ tipo: 'CUENTA', id: cuentaAjena }],
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('EVIDENCIA_INEXISTENTE');
    });

    it('MIXTA sin proporción no se acepta: falta la medida del cómputo', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'MIXTA',
        evidencia: [{ tipo: 'CUENTA', id: cuentaA }],
      });
      expect(r.statusCode, r.body).toBe(400);
    });

    it('con evidencia real se declara, y queda firmada por quien está autenticado', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [
          { tipo: 'CUENTA', id: cuentaA },
          { tipo: 'DOCUMENTO', id: documentoA },
          { tipo: 'NOTA', texto: 'Insumo aplicado a la actividad gravada del ente' },
        ],
        motivo: 'Compra de insumos afectados íntegramente a operaciones gravadas',
      });
      expect(r.statusCode, r.body).toBe(201);
      const cuerpo = r.json<{
        origen: string;
        declaradaPor: string;
        declaradaAt: string;
        hecho: { estado: string; valor: boolean };
      }>();

      expect(cuerpo.origen).toBe('DECLARACION_PROFESIONAL');
      // La firma la pone el servidor: aceptarla del cuerpo permitiría firmar en
      // nombre de otro.
      expect(cuerpo.declaradaPor).toBe(`afectacion-${stamp}@estudio.test`);
      expect(cuerpo.declaradaAt).toBeTruthy();
      expect(cuerpo.hecho.estado).toBe('PROVISTO');
      expect(cuerpo.hecho.valor).toBe(true);
    });

    it('GRAVADAS no significa crédito computable, y la respuesta lo dice', async () => {
      const r = await pedir(empresa, 'GET', `/tax-transactions/${operacionA}/afectacion`);
      const cuerpo = r.json<{ hecho: { explicacion: string } }>();
      expect(cuerpo.hecho.explicacion).toMatch(/no hay ninguna ACTIVE|no significa/i);
    });

    it('la declaración aparece en la vista que el motor consulta', async () => {
      // `tax_affectations_declaradas` filtra por origen y exige firma y fecha:
      // es la que separa una declaración de una sugerencia.
      const v = await db.query<{ afectacion: string }>(
        'SELECT afectacion FROM tax_affectations_declaradas WHERE tax_transaction_id = $1',
        [operacionA],
      );
      expect(v.rowCount).toBe(1);
      expect(v.rows[0]!.afectacion).toBe('GRAVADAS');
    });

    it('no se declara dos veces sobre la misma operación', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/afectacion`, {
        afectacion: 'EXENTAS',
        evidencia: [{ tipo: 'CUENTA', id: cuentaA }],
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json<{ error: string }>().error).toBe('AFECTACION_YA_DECLARADA');
    });

    it('A no puede declarar sobre una operación de B', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionAjena}/afectacion`, {
        afectacion: 'GRAVADAS',
        evidencia: [{ tipo: 'CUENTA', id: cuentaA }],
      });
      expect(r.statusCode).toBe(404);
    });

    it('el acto quedó en la bitácora, con actor y evidencia', async () => {
      const r = await db.query<{ actor_id: string; new_value: { evidencia: unknown[] }; motivo: string }>(
        `SELECT actor_id, new_value, motivo FROM audit_logs
          WHERE company_id = $1 AND action = 'DECLARAR_AFECTACION'
          ORDER BY seq DESC LIMIT 1`,
        [empresa],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.actor_id).toBe(`user:${userId}`);
      expect(r.rows[0]!.new_value.evidencia).toHaveLength(3);
      expect(r.rows[0]!.motivo).toMatch(/insumos/i);
    });

    it('y también el trigger de la 0031 dejó el suyo', async () => {
      // Dos entradas, no una: el trigger registra el cambio de la fila y la ruta
      // registra el acto por HTTP con su IP y su motivo. Son cosas distintas.
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE company_id = $1 AND action = 'AFFECTATION_DECLARED'`,
        [empresa],
      );
      expect(r.rows[0]!.n).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // 3 · La constatación contra ARCA
  // -------------------------------------------------------------------------

  describe('3 · preguntar no es afirmar', () => {
    it('una operación recién creada está NO_CONSULTADO, sin origen', async () => {
      const t = await db.query<{ constatacion: string; constatacion_origen: string }>(
        'SELECT constatacion, constatacion_origen FROM tax_transactions WHERE id = $1',
        [operacionA],
      );
      expect(t.rows[0]!.constatacion).toBe('NO_CONSULTADO');
      expect(t.rows[0]!.constatacion_origen).toBe('NO_CONSULTADO');
    });

    it('constatar contra ARCA guarda el resultado CON su procedencia', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionA}/constatar`, {
        modalidad: 'CAE',
        cae: CAE_DEL_FIXTURE,
        tipoDocReceptor: '80',
        nroDocReceptor: '30710000001',
      });
      expect(r.statusCode, r.body).toBe(200);
      const cuerpo = r.json<{
        constatacion: string;
        origen: string;
        ambiente: string;
        arcaQueryId: string;
        alcance: string;
      }>();

      expect(cuerpo.origen).toBe('ARCA');
      expect(cuerpo.arcaQueryId).toBeTruthy();
      // La respuesta dice qué NO significa, donde lo va a leer quien decide.
      expect(cuerpo.alcance).toMatch(/no dice que la operación económica/i);
    });

    it('la consulta quedó registrada en arca_query_log', async () => {
      // La tabla existía desde la 0015 con **cero escrituras**: una lectura en
      // predictions.ts y nada más. La caché nunca podía acertar.
      const q = await db.query<{
        service: string; operation: string; outcome: string; request_key: string; duration_ms: number;
      }>(
        `SELECT service, operation, outcome, request_key, duration_ms
           FROM arca_query_log WHERE company_id = $1 ORDER BY queried_at DESC LIMIT 1`,
        [empresa],
      );
      expect(q.rowCount).toBe(1);
      expect(q.rows[0]!.service).toBe('wscdc');
      expect(q.rows[0]!.operation).toBe('ComprobanteConstatar');
      expect(q.rows[0]!.request_key).toContain(PROVEEDOR);
      expect(q.rows[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('la operación quedó ligada a esa consulta, no a un valor suelto', async () => {
      const t = await db.query<{ constatacion_origen: string; arca_query_id: string }>(
        'SELECT constatacion_origen, arca_query_id FROM tax_transactions WHERE id = $1',
        [operacionA],
      );
      expect(t.rows[0]!.constatacion_origen).toBe('ARCA');
      expect(t.rows[0]!.arca_query_id).toBeTruthy();
    });

    it('una declaración profesional NO puede reemplazar una respuesta de ARCA', async () => {
      // Es el candado que impide degradar la procedencia: una vez que el
      // organismo contestó, una afirmación humana no lo sobrescribe.
      let fallo = '';
      try {
        await db.query(
          `UPDATE tax_transactions
              SET constatacion_origen = 'DECLARACION_PROFESIONAL',
                  constatacion_por = 'alguien', constatacion_at = now(), arca_query_id = NULL
            WHERE id = $1`,
          [operacionA],
        );
      } catch (error) {
        fallo = (error as Error).message;
      }
      expect(fallo).toMatch(/ya fue constatada por ARCA/);
    });

    it('un comprobante que ARCA no reconoce queda FAIL, no OK', async () => {
      const otra = await montarComprobante(empresa, 999_999, '1.00', PROVEEDOR);
      const r = await pedir(empresa, 'POST', `/tax-transactions/${otra.taxTransactionId}/constatar`, {
        cae: '00000000000000',
        nroDocReceptor: '30710000001',
      });
      expect(r.statusCode, r.body).toBe(200);
      // El mock responde RECHAZADO_INEXISTENTE por defecto: un comprobante que
      // no está en los registros no se guarda como constatado.
      expect(r.json<{ constatacion: string }>().constatacion).toBe('FAIL');
    });

    it('sin CUIT de emisor no hay nada que preguntar, y se dice', async () => {
      const sinCuit = await montarComprobante(empresa, 4004, '100.00', null);
      const r = await pedir(empresa, 'POST', `/tax-transactions/${sinCuit.taxTransactionId}/constatar`, {
        cae: '75000000000001',
        nroDocReceptor: '30710000001',
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json<{ error: string }>().error).toBe('SIN_CUIT_EMISOR');
    });

    it('A no puede constatar una operación de B', async () => {
      const r = await pedir(empresa, 'POST', `/tax-transactions/${operacionAjena}/constatar`, {
        cae: '75000000000001',
        nroDocReceptor: '30710000001',
      });
      expect(r.statusCode).toBe(404);
    });

    it('la constatación declarada por una persona queda marcada como tal', async () => {
      const decl = await montarComprobanteConDeclaracion();
      const t = await db.query<{ constatacion: string; constatacion_origen: string; constatacion_por: string }>(
        'SELECT constatacion, constatacion_origen, constatacion_por FROM tax_transactions WHERE id = $1',
        [decl],
      );
      expect(t.rows[0]!.constatacion).toBe('OK');
      expect(t.rows[0]!.constatacion_origen).toBe('DECLARACION_PROFESIONAL');
      expect(t.rows[0]!.constatacion_por).toBe(`afectacion-${stamp}@estudio.test`);
    });
  });

  async function montarComprobanteConDeclaracion(): Promise<string> {
    const contenido = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><comprobante><id>decl-${stamp}</id></comprobante>`,
    );
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="decl.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n${contenido.toString()}\r\n--X--\r\n`;
    const subida = await app.inject({
      method: 'POST', url: '/documents',
      headers: { ...cab(empresa), 'content-type': 'multipart/form-data; boundary=X' },
      payload: forma,
    });
    const documentId = subida.json<{ id: string }>().id;
    const alta = await pedir(empresa, 'POST', `/documents/${documentId}/tax-transaction`, {
      direction: 'COMPRAS', cbteTipo: 1, puntoVenta: 1, numero: 7007, fecha: '2026-03-15',
      cuitContraparte: PROVEEDOR, razonSocial: 'Proveedor', condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '500.00', iva: '0', noGravado: '0', exento: '0', percepciones: '0', total: '500.00',
      constatacionDeclarada: {
        resultado: 'OK',
        motivo: 'Verificado en el portal de ARCA con clave fiscal del cliente',
      },
    });
    expect(alta.statusCode, alta.body).toBe(201);
    return alta.json<{ taxTransactionId: string }>().taxTransactionId;
  }

  // -------------------------------------------------------------------------
  // 4 · Los permisos dejan rastro
  // -------------------------------------------------------------------------

  describe('4 · dar acceso a la contabilidad de un cliente es un acto auditable', () => {
    it('otorgar un rol deja su entrada, con actor, empresa, usuario y rol', async () => {
      const r = await pedir(empresa, 'POST', `/companies/${empresa}/roles`, {
        userId: segundoUsuario,
        role: 'SOLO_LECTURA',
      });
      expect(r.statusCode, r.body).toBe(200);

      const log = await db.query<{
        actor_id: string; company_id: string; action: string;
        old_value: unknown; new_value: { rol: string; usuario: string }; motivo: string;
      }>(
        `SELECT actor_id, company_id, action, old_value, new_value, motivo
           FROM audit_logs
          WHERE company_id = $1 AND action = 'ROL_OTORGADO'
          ORDER BY seq DESC LIMIT 1`,
        [empresa],
      );

      expect(log.rowCount, 'otorgar un rol no dejó ninguna entrada').toBe(1);
      expect(log.rows[0]!.company_id).toBe(empresa);
      expect(log.rows[0]!.actor_id).toBe(`user:${userId}`);
      expect(log.rows[0]!.new_value.rol).toBe('SOLO_LECTURA');
      expect(log.rows[0]!.new_value.usuario).toBe(`ayudante-${stamp}@estudio.test`);
      // Un alta no tiene "antes", y eso también es información.
      expect(log.rows[0]!.old_value).toBeNull();
    });

    it('revocar un rol se distingue de modificarlo', async () => {
      // Apagar un rol con `valid_to` es una revocación. Nombrarla distinto es lo
      // que permite buscarla después.
      await db.query(
        `UPDATE user_company_roles SET valid_to = CURRENT_DATE
          WHERE company_id = $1 AND user_id = $2`,
        [empresa, segundoUsuario],
      );

      const log = await db.query<{ action: string; old_value: { validTo: string | null } }>(
        `SELECT action, old_value FROM audit_logs
          WHERE company_id = $1 AND object_type = 'user_company_roles'
          ORDER BY seq DESC LIMIT 1`,
        [empresa],
      );
      expect(log.rows[0]!.action).toBe('ROL_REVOCADO');
      expect(log.rows[0]!.old_value.validTo).toBeNull();
    });

    it('el rastro también aparece cuando el cambio entra por SQL directo', async () => {
      // El candado está en la tabla y no en la ruta: cubre los tres caminos —API,
      // función y `psql`— con una sola pieza.
      const antes = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE company_id = $1 AND object_type = 'user_company_roles'`,
        [empresa],
      );

      await db.query(
        `UPDATE user_company_roles SET valid_to = NULL
          WHERE company_id = $1 AND user_id = $2`,
        [empresa, segundoUsuario],
      );

      const despues = await db.query<{ n: string; action: string }>(
        `SELECT count(*)::text AS n,
                (SELECT action FROM audit_logs
                  WHERE company_id = $1 AND object_type = 'user_company_roles'
                  ORDER BY seq DESC LIMIT 1) AS action
           FROM audit_logs
          WHERE company_id = $1 AND object_type = 'user_company_roles'`,
        [empresa],
      );
      expect(Number(despues.rows[0]!.n)).toBe(Number(antes.rows[0]!.n) + 1);
      expect(despues.rows[0]!.action).toBe('ROL_RESTITUIDO');
    });

    it('la entrada del rol es de la empresa afectada, no de otra', async () => {
      const ajenas = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE object_type = 'user_company_roles' AND company_id = $1
            AND (new_value ->> 'usuario' = $2 OR old_value ->> 'usuario' = $2)`,
        [otraEmpresa, `ayudante-${stamp}@estudio.test`],
      );
      expect(ajenas.rows[0]!.n).toBe('0');
    });
  });
});
