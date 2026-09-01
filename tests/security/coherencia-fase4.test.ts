/**
 * S-11 — que ningún estado afirme lo que los hechos niegan.
 *
 * Cuatro candados de la FASE 4:
 *
 *   A1  un documento que funda una operación fiscal no se anula — y el candado
 *       vive en la base, así que vale también por SQL directo;
 *   A3  un balance que no cuadra deja de ser invisible hasta el cierre;
 *   A4  un ítem que no se puede resolver lo dice, en vez de quedarse mudo;
 *   B3  verificar el Mayor deja una constancia firmada, y firmar no es leer.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('S-11 — coherencia entre estados y hechos', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;

  let empresaA = '';
  let empresaB = '';
  let ejercicioA = '';
  let periodoA = '';
  let cuentaCaja = '';
  let cuentaVentas = '';

  const contador = { id: '', token: '' };
  const lector = { id: '', token: '' };

  const cab = (token: string, empresa: string) => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  async function subir(nombre: string, empresa = empresaA): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...cab(contador.token, empresa), 'content-type': 'multipart/form-data; boundary=X' },
      payload:
        `--X\r\nContent-Disposition: form-data; name="file"; filename="${nombre}.xml"\r\n` +
        `Content-Type: application/xml\r\n\r\n<c>${nombre}</c>\r\n--X--\r\n`,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }

  async function operacionSobre(documentId: string, numero: number): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/documents/${documentId}/tax-transaction`,
      headers: cab(contador.token, empresaA),
      payload: {
        direction: 'COMPRAS',
        cbteTipo: 1,
        puntoVenta: 1,
        numero,
        fecha: '2026-03-10',
        cuitContraparte: '30710000001',
        razonSocial: 'Proveedor',
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: '1000.00',
        iva: '210.00',
        noGravado: '0',
        exento: '0',
        percepciones: '0',
        total: '1210.00',
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ taxTransactionId: string }>().taxTransactionId;
  }

  /** Un duplicado bloqueante sobre un documento, para poder pedir su anulación. */
  async function marcarDuplicado(documentId: string, deId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO document_duplicates
         (company_id, document_id, duplicate_of_id, nivel, explicacion, bloquea)
       VALUES ($1, $2, $3, 'COMPROBANTE_REPETIDO', 'fixture', true) RETURNING id`,
      [empresaA, documentId, deId],
    );
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const alta = async (etiqueta: string): Promise<string> =>
      (
        await db.query<{ id: string }>(
          'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
          [`${etiqueta}-coh-${stamp}@estudio.test`, etiqueta, hash],
        )
      ).rows[0]!.id;

    const duenoId = await alta('dueno');
    contador.id = await alta('contador');
    lector.id = await alta('lector');

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio coh ${stamp}`,
        withCheckDigit(`30${stamp}`),
        duenoId,
      ])
    ).rows[0]!.create_organization;

    for (const id of [contador.id, lector.id]) {
      await db.query(
        'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,$3)',
        [organizationId, id, 'MEMBER'],
      );
    }

    const crearEmpresa = async (nombre: string, prefijo: string): Promise<string> =>
      (
        await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
          duenoId,
          organizationId,
          nombre,
          withCheckDigit(`${prefijo}${stamp}`),
          'SA',
          'AR-C',
          'IGJ',
          '12-31',
        ])
      ).rows[0]!.create_company;

    empresaA = await crearEmpresa(`Coh A ${stamp}`, '33');
    empresaB = await crearEmpresa(`Coh B ${stamp}`, '27');

    for (const empresa of [empresaA, empresaB]) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
        duenoId,
        empresa,
        contador.id,
        'CONTADOR',
      ]);
    }
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
      duenoId,
      empresaA,
      lector.id,
      'SOLO_LECTURA',
    ]);
    // Declarar el marco contable exige `company:write`, que es del ADMINISTRADOR:
    // el §42 separa administrar el sistema de firmar la contabilidad, y el
    // fixture necesita las dos cosas.
    await db.query('SELECT grant_company_role($1,$2,$3,$4)', [
      duenoId,
      empresaA,
      contador.id,
      'ADMINISTRADOR',
    ]);

    /** Login con MFA solo donde el rol lo exige. */
    const ingresar = async (email: string, conMfa: boolean): Promise<string> => {
      const primero = (
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
      ).json<{ token: string }>().token;
      if (!conMfa) return primero;

      const secret = (
        await app.inject({
          method: 'POST',
          url: '/auth/mfa/setup',
          headers: { authorization: `Bearer ${primero}` },
        })
      ).json<{ secret: string }>().secret;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/confirm',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${primero}` },
      });
      const token = (
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
      ).json<{ token: string }>().token;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${token}` },
      });
      return token;
    };

    contador.token = await ingresar(`contador-coh-${stamp}@estudio.test`, true);
    lector.token = await ingresar(`lector-coh-${stamp}@estudio.test`, false);

    // El marco contable lo declara el profesional: el sistema no lo supone, y
    // sin él no se arma un estado contable. Es una precondición del fixture, no
    // un detalle.
    const marco = await app.inject({
      method: 'POST',
      url: '/companies/current/reporting-framework',
      headers: cab(contador.token, empresaA),
      payload: { framework: 'RT_FACPCE', validFrom: '2026-01-01' },
    });
    expect(marco.statusCode, marco.body).toBeLessThan(300);

    // Ejercicio y plan mínimo, por HTTP.
    const fy = await app.inject({
      method: 'POST',
      url: '/fiscal-years',
      headers: cab(contador.token, empresaA),
      payload: { code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    expect(fy.statusCode, fy.body).toBe(201);
    ejercicioA = (
      await db.query<{ id: string }>('SELECT id FROM fiscal_years WHERE company_id = $1', [empresaA])
    ).rows[0]!.id;
    periodoA = (
      await db.query<{ id: string }>(
        `SELECT id FROM periods WHERE company_id = $1 AND number = 3`,
        [empresaA],
      )
    ).rows[0]!.id;

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/accounts',
        headers: cab(contador.token, empresaA),
        payload: cuenta,
      });
      expect(r.statusCode, r.body).toBe(201);
      if (cuenta.code === '1.1.01') cuentaCaja = r.json<{ id: string }>().id;
      else cuentaVentas = r.json<{ id: string }>().id;
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // ══════════════════════════════════════════════════════════════════
  // A1 · Anulación de documentos
  // ══════════════════════════════════════════════════════════════════

  it('A1 · un documento sin operación fiscal SÍ se anula', async () => {
    const original = await subir(`a1-original-${stamp}`);
    const copia = await subir(`a1-copia-${stamp}`);
    const duplicado = await marcarDuplicado(copia, original);

    const r = await app.inject({
      method: 'POST',
      url: `/documents/${copia}/duplicates/${duplicado}`,
      headers: cab(contador.token, empresaA),
      payload: { resolucion: 'ES_DUPLICADO', motivo: 'Es el mismo comprobante' },
    });
    expect(r.statusCode, r.body).toBe(200);

    const fila = await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [
      copia,
    ]);
    expect(fila.rows[0]!.status).toBe('ANULADO');
  });

  it('A1 · un documento CON operación fiscal no se anula, por HTTP', async () => {
    const otro = await subir(`a1-otro-${stamp}`);
    const conOperacion = await subir(`a1-conop-${stamp}`);
    await operacionSobre(conOperacion, 9101);
    const duplicado = await marcarDuplicado(conOperacion, otro);

    const r = await app.inject({
      method: 'POST',
      url: `/documents/${conOperacion}/duplicates/${duplicado}`,
      headers: cab(contador.token, empresaA),
      payload: { resolucion: 'ES_DUPLICADO', motivo: 'Parece repetido' },
    });

    // Error de dominio nombrado, no un 500 ni un éxito silencioso.
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('DOCUMENTO_CON_OPERACION');

    const fila = await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [
      conOperacion,
    ]);
    expect(fila.rows[0]!.status).not.toBe('ANULADO');
  });

  it('A1 · el rechazo es transaccional: el duplicado tampoco queda resuelto', async () => {
    // La resolución del duplicado y la anulación van en la misma transacción. Si
    // la segunda falla, la primera no puede quedar escrita: si no, el duplicado
    // figuraría resuelto y el documento vivo, que es la peor de las dos verdades.
    const otro = await subir(`a1-tx-otro-${stamp}`);
    const conOperacion = await subir(`a1-tx-${stamp}`);
    await operacionSobre(conOperacion, 9102);
    const duplicado = await marcarDuplicado(conOperacion, otro);

    await app.inject({
      method: 'POST',
      url: `/documents/${conOperacion}/duplicates/${duplicado}`,
      headers: cab(contador.token, empresaA),
      payload: { resolucion: 'ES_DUPLICADO', motivo: 'Parece repetido' },
    });

    const fila = await db.query<{ resolucion: string | null }>(
      'SELECT resolucion FROM document_duplicates WHERE id = $1',
      [duplicado],
    );
    expect(fila.rows[0]!.resolucion).toBeNull();
  });

  it('A1 · el candado vale por SQL directo, sin pasar por la API', async () => {
    const conOperacion = await subir(`a1-sql-${stamp}`);
    await operacionSobre(conOperacion, 9103);

    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      await db.query('SELECT set_config($1,$2,true)', ['app.company_id', empresaA]);
      await db.query('SELECT set_config($1,$2,true)', ['app.actor_id', `user:${contador.id}`]);

      const mensaje = await expectFailure(() =>
        db.query(
          `UPDATE documents SET status = 'ANULADO', voided_at = now(),
                                voided_by = 'user:x', void_reason = 'a mano'
            WHERE id = $1`,
          [conOperacion],
        ),
      );
      expect(mensaje).toContain('ya funda una operación fiscal');
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('A1 · el candado también corta para el dueño del esquema', async () => {
    // Sin `SET ROLE`: es el trigger, no una política. Un candado que solo aplica
    // al rol de aplicación es un candado que se abre con la contraseña correcta.
    const conOperacion = await subir(`a1-owner-${stamp}`);
    await operacionSobre(conOperacion, 9104);

    const mensaje = await expectFailure(() =>
      db.query(`UPDATE documents SET status = 'ANULADO' WHERE id = $1`, [conOperacion]),
    );
    expect(mensaje).toContain('ya funda una operación fiscal');
  });

  it('A1 · desde otra empresa no se puede anular nada', async () => {
    const documento = await subir(`a1-ajeno-${stamp}`);

    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      await db.query('SELECT set_config($1,$2,true)', ['app.company_id', empresaB]);
      const r = await db.query(
        `UPDATE documents SET status = 'ANULADO' WHERE id = $1 RETURNING id`,
        [documento],
      );
      // RLS no lo ve: cero filas afectadas, no un error. El documento sigue vivo.
      expect(r.rowCount).toBe(0);
    } finally {
      await db.query('ROLLBACK');
    }

    const fila = await db.query<{ status: string }>('SELECT status FROM documents WHERE id = $1', [
      documento,
    ]);
    expect(fila.rows[0]!.status).not.toBe('ANULADO');
  });

  // ══════════════════════════════════════════════════════════════════
  // A3 · El balance que no cuadra
  // ══════════════════════════════════════════════════════════════════

  it('A3 · con el libro sano no hay ítem de balance', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/work-queue?entidad=fiscal_years',
      headers: cab(contador.token, empresaA),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('A3 · con las líneas descuadradas, la bandeja lo dice', async () => {
    // `je_balanced` es un CHECK inmediato sobre la cabecera y `jel_entry_consistent`
    // es un CONSTRAINT TRIGGER **diferido**: dentro de la transacción se pueden
    // tener líneas que no suman lo que dice la cabecera. Es exactamente la avería
    // que este ítem existe para delatar, y se prueba sin desactivar nada.
    await db.query('BEGIN');
    try {
      const entrada = await db.query<{ id: string }>(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, currency, total_debit, total_credit, source_type,
            manual_justification, created_by, approved_by, approved_at)
         VALUES ($1,'VENTAS',$2,$3,900001,'2026-03-10','descuadre de prueba','NORMAL',
                 'APROBADO','ARS',100,100,'MANUAL',
                 'Fixture: se revierte con el ROLLBACK','user:test','user:test',now())
         RETURNING id`,
        [empresaA, periodoA, ejercicioA],
      );
      const entryId = entrada.rows[0]!.id;

      await db.query(
        `INSERT INTO journal_entry_lines
           (company_id, entry_id, line_no, account_id, debit, credit, currency)
         VALUES ($1,$2,1,$3,100,0,'ARS'), ($1,$2,2,$4,0,40,'ARS')`,
        [empresaA, entryId, cuentaCaja, cuentaVentas],
      );

      const wq = await db.query<{ rama: string; motivo: string; bloquea: boolean }>(
        `SELECT rama, motivo, bloquea FROM work_queue
          WHERE company_id = $1 AND entidad = 'fiscal_years'`,
        [empresaA],
      );
      expect(wq.rowCount, 'el descuadre tiene que producir un ítem').toBe(1);
      expect(wq.rows[0]!.rama).toBe('BALANCE_NO_CUADRA');
      expect(wq.rows[0]!.bloquea).toBe(true);
      expect(wq.rows[0]!.motivo).toContain('6000'); // (100 − 40) × 100
    } finally {
      // El descuadre no se commitea: al salir de acá el trigger diferido nunca
      // llega a evaluarse y el libro queda como estaba.
      await db.query('ROLLBACK');
    }

    const despues = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM work_queue
        WHERE company_id = $1 AND rama = 'BALANCE_NO_CUADRA'`,
      [empresaA],
    );
    expect(despues.rows[0]!.n).toBe('0');
  });

  // ══════════════════════════════════════════════════════════════════
  // A4 · Pendientes que no se pueden resolver
  // ══════════════════════════════════════════════════════════════════

  it('A4 · un asiento sin aprobar en período abierto es ACCIONABLE', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/journal-entries',
      headers: cab(contador.token, empresaA),
      payload: {
        journalCode: 'VENTAS',
        entryDate: '2026-03-12',
        description: 'Venta sin aprobar',
        lines: [
          { accountCode: '1.1.01', debit: '100.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '100.00' },
        ],
        source: { type: 'MANUAL' },
        manualJustification: 'Fixture de la suite de coherencia',
        status: 'BORRADOR',
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const entryId = r.json<{ id: string }>().id;

    const wq = await app.inject({
      method: 'GET',
      url: '/work-queue?entidad=journal_entries',
      headers: cab(contador.token, empresaA),
    });
    const item = wq
      .json<{ items: { entityId: string; disponibilidad: string }[] }>()
      .items.find((i) => i.entityId === entryId);
    expect(item?.disponibilidad).toBe('ACCIONABLE');
  });

  it('A4 · bloqueado el período, el mismo ítem pasa a BLOQUEADO_POR_ESTADO', async () => {
    const bloqueo = await app.inject({
      method: 'POST',
      url: `/periods/${periodoA}/block`,
      headers: cab(contador.token, empresaA),
      payload: { motivo: 'Cierre de marzo en preparación' },
    });
    expect(bloqueo.statusCode, bloqueo.body).toBe(200);

    const wq = await app.inject({
      method: 'GET',
      url: '/work-queue?entidad=journal_entries&disponibilidad=BLOQUEADO_POR_ESTADO',
      headers: cab(contador.token, empresaA),
    });
    const items = wq.json<{ items: { estado: string; disponibilidad: string }[] }>().items;
    expect(items.length, 'el asiento en borrador queda sin camino').toBeGreaterThan(0);
    expect(items.every((i) => i.disponibilidad === 'BLOQUEADO_POR_ESTADO')).toBe(true);

    // Y la aprobación efectivamente falla: la bandeja no está adivinando.
    const entryId = (
      await db.query<{ id: string }>(
        `SELECT id FROM journal_entries
          WHERE company_id = $1 AND status = 'BORRADOR' AND kind = 'NORMAL' LIMIT 1`,
        [empresaA],
      )
    ).rows[0]!.id;
    const aprobar = await app.inject({
      method: 'POST',
      url: `/journal-entries/${entryId}/approve`,
      headers: cab(contador.token, empresaA),
    });
    expect(aprobar.statusCode).not.toBe(200);
  });

  it('A4 · la extracción no disponible es INFORMATIVA, no accionable', async () => {
    // Un PDF, no un XML: sin motor de OCR el documental responde SIN_MOTOR_OCR,
    // que es la verdad. Un XML sí se lee, y por eso no produce este ítem.
    const pdf = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        ...cab(contador.token, empresaA),
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload:
        `--X\r\nContent-Disposition: form-data; name="file"; filename="escaneo-${stamp}.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\r\n--X--\r\n`,
    });
    expect(pdf.statusCode, pdf.body).toBe(201);

    const r = await app.inject({
      method: 'GET',
      url: '/work-queue?entidad=document_extractions',
      headers: cab(contador.token, empresaA),
    });
    const items = r.json<{ items: { disponibilidad: string; rama: string }[] }>().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.rama === 'LECTURA_NO_DISPONIBLE')).toBe(true);
    expect(items.every((i) => i.disponibilidad === 'INFORMATIVO')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════
  // B3 · Verificar el Mayor es firmar
  // ══════════════════════════════════════════════════════════════════

  it('B3 · un SOLO_LECTURA no puede dejar una constancia de verificación', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/books/ledger-verification',
      headers: cab(lector.token, empresaA),
      payload: { desde: '2026-01-01', hasta: '2026-12-31' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('ledger:verify');
  });

  it('B3 · el SOLO_LECTURA sigue pudiendo leer el balance', async () => {
    // La mitad que falta: el permiso nuevo acota una escritura, no le quita al
    // rol lo que ya podía mirar.
    const r = await app.inject({
      method: 'GET',
      url: '/reports/trial-balance?desde=2026-01-01&hasta=2026-12-31',
      headers: cab(lector.token, empresaA),
    });
    expect(r.statusCode, r.body).toBe(200);
  });

  // ══════════════════════════════════════════════════════════════════
  // C · Las pantallas leen los nombres que la API devuelve
  // ══════════════════════════════════════════════════════════════════

  it('C · el contrato de campos que la consola consume no cambió', async () => {
    // El barrido S-12 comprueba que las URL existan. Esto comprueba lo otro: que
    // los nombres de campo sean los que la pantalla lee. Al escribir la consola
    // aparecieron tres suposiciones equivocadas —`/statements` no lista, el
    // Mayor no devuelve `saldo`, el Diario viaja por folios— y sin este test la
    // pantalla habría mostrado columnas vacías sin que nada fallara.
    const pedir = (url: string) =>
      app.inject({ method: 'GET', url, headers: cab(contador.token, empresaA) });

    const periodos = await pedir('/periods');
    expect(periodos.statusCode).toBe(200);
    const p = periodos.json<{ periods: Record<string, unknown>[] }>().periods[0]!;
    for (const clave of ['id', 'number', 'startDate', 'endDate', 'status']) {
      expect(Object.keys(p), `periods.${clave}`).toContain(clave);
    }

    const ejercicios = await pedir('/fiscal-years');
    const fy = ejercicios.json<{ fiscalYears: Record<string, unknown>[] }>().fiscalYears[0]!;
    for (const clave of ['id', 'code', 'startDate', 'endDate', 'status']) {
      expect(Object.keys(fy), `fiscalYears.${clave}`).toContain(clave);
    }

    const rango = '?desde=2026-01-01&hasta=2026-12-31';
    const diario = await pedir('/books/diario' + rango);
    const d = diario.json<Record<string, unknown>>();
    for (const clave of ['asientos', 'totales', 'folios', 'cumpleFormalidades']) {
      expect(Object.keys(d), `diario.${clave}`).toContain(clave);
    }

    const mayor = await pedir('/books/mayor' + rango);
    const cuenta = mayor.json<{ cuentas: Record<string, unknown>[] }>().cuentas[0];
    if (cuenta !== undefined) {
      for (const clave of ['codigo', 'nombre', 'saldoInicial', 'totalDebe', 'totalHaber', 'saldoFinal']) {
        expect(Object.keys(cuenta), `mayor.cuentas.${clave}`).toContain(clave);
      }
    }

    const balance = await pedir('/reports/trial-balance' + rango);
    const b = balance.json<Record<string, unknown>>();
    for (const clave of ['lineas', 'totales', 'cuadra']) {
      expect(Object.keys(b), `balance.${clave}`).toContain(clave);
    }

    // `GET /statements` **arma** el estado; no lista los emitidos. La consola lo
    // trata así desde que se comprobó acá.
    const estado = await pedir(`/statements?ejercicio=${ejercicioA}&tipo=ESP`);
    expect(estado.statusCode, estado.body).toBe(200);
    const e = estado.json<Record<string, unknown>>();
    for (const clave of ['tipo', 'emisible', 'controles', 'renglones']) {
      expect(Object.keys(e), `statements.${clave}`).toContain(clave);
    }
  });

  it('C · el detalle de un documento trae la evidencia y su procedencia', async () => {
    const documento = await subir(`c-detalle-${stamp}`);
    const r = await app.inject({
      method: 'GET',
      url: `/documents/${documento}`,
      headers: cab(contador.token, empresaA),
    });
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ documento: Record<string, unknown>; campos: unknown[] }>();

    // Lo que la pantalla necesita para que una persona decida con evidencia.
    for (const clave of ['id', 'nombre', 'sha256', 'mime', 'status']) {
      expect(Object.keys(cuerpo.documento), `documento.${clave}`).toContain(clave);
    }
    expect(Array.isArray(cuerpo.campos)).toBe(true);

    // Y el original se puede traer: es la evidencia, no un adjunto opcional.
    const original = await app.inject({
      method: 'GET',
      url: `/documents/${documento}/content`,
      headers: cab(contador.token, empresaA),
    });
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.length).toBeGreaterThan(0);
  });

  it('C · el original de otra empresa no se descarga', async () => {
    const documento = await subir(`c-ajeno-${stamp}`);
    const r = await app.inject({
      method: 'GET',
      url: `/documents/${documento}/content`,
      headers: cab(contador.token, empresaB),
    });
    // El contador tiene rol en B, así que llega al handler: lo corta RLS.
    expect(r.statusCode).toBe(404);
  });

  it('B3 · el CONTADOR verifica y queda auditado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/books/ledger-verification',
      headers: cab(contador.token, empresaA),
      payload: { desde: '2026-01-01', hasta: '2026-12-31' },
    });
    expect(r.statusCode, r.body).toBe(200);

    const bitacora = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE company_id = $1 AND action = 'VERIFICAR_MAYOR'`,
      [empresaA],
    );
    expect(bitacora.rows[0]!.n).not.toBe('0');
  });
});
