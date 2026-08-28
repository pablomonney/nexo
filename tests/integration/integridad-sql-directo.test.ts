/**
 * ¿Qué pasa si alguien ignora la API y usa PostgreSQL directamente?
 *
 * Es la única pregunta de este archivo. No prueba que la aplicación valide bien
 * —eso lo hacen las suites de cada rasgo—: prueba que **la validación no viva
 * únicamente en TypeScript**. Un candado que solo existe en el handler protege
 * al que entra por la puerta, y la base es la última barrera justamente para el
 * que no entra por ahí: un `psql`, un script de migración de datos, un ORM de
 * otro equipo, un backup restaurado a mano.
 *
 * ## Los tres agujeros que encontró
 *
 * 1. **La firma del §32 no tenía dónde escribirse.** `aprobar-regla.mjs`
 *    insertaba en `audit_logs` con `company_id = NULL` —una regla no es de
 *    ninguna empresa— y esa columna es NOT NULL. La inserción fallaba con 23502
 *    DESPUÉS del UPDATE, el `catch` revertía todo, y el comando nunca pudo
 *    aprobar nada. No se notó porque nunca se aprobó una regla: el §32 exige la
 *    firma, y la firma no entraba.
 *
 * 2. **El gap normativo no bloqueaba.** La 0033 dice que registra el gap en la
 *    base «porque el motor consulta esta tabla». Nadie la consultaba salvo una
 *    pantalla.
 *
 * 3. **La reapertura de un período se podía saltear.** El CHECK que exige dos
 *    firmantes distintos solo mira si `reopened_at` está cargado, y quien
 *    saltea la API no lo carga. `UPDATE periods SET status = 'ABIERTO'` volvía
 *    a abrir un ejercicio cerrado sin que nadie firmara nada.
 *
 * Los tres tienen la misma forma que el resto del repositorio ya conoce: hay una
 * estructura correcta, hay una regla escrita, y nadie recorrió el camino entre
 * las dos.
 *
 * Lo que ya está cubierto no se repite: Debe = Haber, la inmutabilidad del
 * asiento aprobado, el período CERRADO y la cuenta no imputable viven en
 * `journal-locks.test.ts`; el cruce de decisiones, en `auditoria-circuito`.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, expectFailure, expectFailureCode, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';
const CONSTANCIA = 'Revisado contra el articulo citado y su documento archivado con hash.';

suite('Integridad contra SQL directo', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let companyId: string;
  let fiscalYearId: string;
  let periodId: string;
  let entryId: string;
  let statementId: string;
  let noteId: string;
  let stamp: string;

  const pedir = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();

    stamp = await sufijoUnico(db);
    const email = `integridad-${stamp}@estudio.test`;
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const userId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [email, 'Contadora', hash],
      )
    ).rows[0]!.id;
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio integridad ${stamp}`,
        withCheckDigit(`30${stamp}`),
        userId,
      ])
    ).rows[0]!.create_organization;

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

    companyId = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        userId,
        organizationId,
        'Integridad SA',
        withCheckDigit(`33${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ])
    ).rows[0]!.create_company;
    for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
      await db.query('SELECT grant_company_role($1,$2,$3,$4)', [userId, companyId, userId, rol]);
    }

    await pedir('POST', '/companies/current/reporting-framework', {
      framework: 'RT_FACPCE',
      validFrom: '2026-01-01',
    });

    for (const cuenta of [
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      { code: '3.1.01', name: 'Capital suscripto', type: 'PN' },
      { code: '3.4.01', name: 'Resultado del ejercicio', type: 'PN' },
      { code: '4.1.01', name: 'Ventas', type: 'INGRESO' },
    ]) {
      const r = await pedir('POST', '/accounts', cuenta);
      if (cuenta.code === '3.4.01') {
        await pedir('PATCH', `/accounts/${r.json<{ id: string }>().id}`, {
          closingRole: 'RESULTADO_DEL_EJERCICIO',
          motivo: 'Designación de la cuenta de resultado del ejercicio',
        });
      }
    }

    fiscalYearId = (
      await pedir('POST', '/fiscal-years', {
        code: `EJ2026-int-${stamp}`,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      })
    ).json<{ id: string }>().id;

    const alta = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: '2026-03-10',
      description: 'Venta de contado',
      currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: '640000.00', credit: '0' },
        { accountCode: '4.1.01', debit: '0', credit: '640000.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Venta registrada por la contadora',
    });
    entryId = alta.json<{ id: string }>().id;
    await pedir('POST', `/journal-entries/${entryId}/approve`);

    periodId = (
      await db.query<{ id: string }>(
        'SELECT period_id AS id FROM journal_entries WHERE id = $1',
        [entryId],
      )
    ).rows[0]!.id;

    statementId = (
      await pedir('POST', '/statements/issue', { ejercicio: fiscalYearId, tipo: 'ESP' })
    ).json<{ estadoId: string }>().estadoId;

    const rubro = await db.query<{ line_code: string }>(
      `SELECT line_code FROM financial_statement_lines
        WHERE statement_id = $1 AND line_type = 'RENGLON' AND amount <> 0
        ORDER BY line_code LIMIT 1`,
      [statementId],
    );
    await pedir('POST', `/statements/${statementId}/notes/generate`, {
      rubros: [rubro.rows[0]!.line_code],
    });
    noteId = (
      await db.query<{ id: string }>(
        `SELECT id FROM notes WHERE company_id = $1 AND evidencia = 'VERIFIED' ORDER BY numero LIMIT 1`,
        [companyId],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  // 1 · El acto normativo tiene dónde quedar escrito
  // -------------------------------------------------------------------------

  describe('1 · la bitácora del plano normativo', () => {
    it('audit_logs sigue exigiendo empresa: por eso un acto normativo no cabe ahí', async () => {
      // Este test fija la causa del defecto, no solo su síntoma. Si mañana
      // alguien aflojara el NOT NULL para "arreglarlo por el lado fácil", la
      // fila quedaría invisible para todos los inquilinos dentro de la bitácora
      // contable, y este test avisa antes.
      const { code } = await expectFailureCode(() =>
        db.query(
          `INSERT INTO audit_logs
             (company_id, actor_type, actor_id, action, object_type, object_id, prev_hash, hash)
           VALUES (NULL, 'USER', 'u', 'RULE_APPROVED', 'accounting_rules', 'x', '', '')`,
        ),
      );
      expect(code).toBe('23502');
    });

    it('normative_audit_logs sí lo acepta, y lo encadena', async () => {
      await db.query('BEGIN');
      try {
        const primera = await db.query<{ seq: string; prev_hash: string; hash: string }>(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'user:revisora', 'RULE_APPROVED', 'accounting_rules', $1, $2, '', '', 0)
           RETURNING seq::text, prev_hash, hash`,
          [`regla-${stamp}`, CONSTANCIA],
        );
        const segunda = await db.query<{ prev_hash: string }>(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'user:revisora', 'RULE_APPROVED', 'accounting_rules', $1, $2, '', '', 0)
           RETURNING prev_hash`,
          [`regla-b-${stamp}`, CONSTANCIA],
        );

        expect(primera.rows[0]!.hash).toHaveLength(64);
        expect(segunda.rows[0]!.prev_hash).toBe(primera.rows[0]!.hash);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('un acto normativo sin constancia escrita no se registra', async () => {
      // El §32 no pide una firma: pide una firma que diga qué se revisó. "ok" es
      // una firma sin revisión, y acá no entra.
      const { code } = await expectFailureCode(() =>
        db.query(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'u', 'RULE_APPROVED', 'accounting_rules', 'x', 'ok', '', '', 0)`,
        ),
      );
      expect(code).toBe('23514');
    });

    it('la bitácora normativa no se edita ni se borra', async () => {
      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'u', 'RULE_APPROVED', 'accounting_rules', $1, $2, '', '', 0)`,
          [`inmutable-${stamp}`, CONSTANCIA],
        );

        const alEditar = await expectFailure(() =>
          db.query('UPDATE normative_audit_logs SET motivo = $1 WHERE object_id = $2', [
            'otra cosa completamente distinta de la anterior',
            `inmutable-${stamp}`,
          ]),
        );
        expect(alEditar).toMatch(/append-only/);
      } finally {
        await db.query('ROLLBACK');
      }

      await db.query('BEGIN');
      try {
        await db.query(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'u', 'RULE_APPROVED', 'accounting_rules', $1, $2, '', '', 0)`,
          [`borrable-${stamp}`, CONSTANCIA],
        );
        const alBorrar = await expectFailure(() =>
          db.query('DELETE FROM normative_audit_logs WHERE object_id = $1', [`borrable-${stamp}`]),
        );
        expect(alBorrar).toMatch(/append-only/);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2 · Un gap abierto bloquea la activación
  // -------------------------------------------------------------------------

  describe('2 · el gap normativo bloquea de verdad', () => {
    it('AR-IVA-CF-VINCULACION-001 no pasa a ACTIVE mientras el gap siga abierto', async () => {
      // Ni por la API, ni por el script, ni por SQL. Es el caso concreto del §6:
      // la vigencia real del t.o. 1997 no está relevada, así que la regla no
      // puede aplicarse a ninguna operación.
      const gap = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM normative_gaps
          WHERE blocks_rule_key = 'AR-IVA-CF-VINCULACION-001' AND status = 'ABIERTO'`,
      );
      expect(gap.rows[0]!.n, 'el gap de vigencia dejó de estar abierto').toBe('1');

      const mensaje = await expectFailure(() =>
        db.query(
          `UPDATE accounting_rules
              SET status = 'ACTIVE', approved_by = 'otra.persona', approved_at = now()
            WHERE rule_key = 'AR-IVA-CF-VINCULACION-001'`,
        ),
      );
      expect(mensaje).toMatch(/gap normativo "vigencia_to_1997_iva" sigue ABIERTO/);
    });

    it('y sigue en DRAFT, sin aprobador', async () => {
      const r = await db.query<{ status: string; approved_by: string | null }>(
        `SELECT status, approved_by FROM accounting_rules WHERE rule_key = 'AR-IVA-CF-VINCULACION-001'`,
      );
      expect(r.rows[0]!.status).toBe('DRAFT');
      expect(r.rows[0]!.approved_by).toBeNull();
    });

    it('una regla sin gap que la nombre sí puede activarse, y deja su constancia', async () => {
      // La contracara. Sin esto el test anterior pasaría con un trigger que
      // rechaza todo, y "bloquea el gap" y "nada se activa nunca" se verían
      // igual.
      await db.query('BEGIN');
      try {
        const norma = await db.query<{ id: string }>(
          `SELECT v.id FROM norm_versions v
             JOIN norm_documents d ON d.norm_version_id = v.id
            WHERE v.verification_level = 'V1' LIMIT 1`,
        );
        const clave = `AR-TEST-SIN-GAP-${stamp}`;
        const regla = await db.query<{ id: string }>(
          `INSERT INTO accounting_rules
             (rule_key, version, norm_version_id, domain, valid_from, jurisdiction, conditions, action, status, proposed_by)
           VALUES ($1, 1, $2, 'accounting', '2026-01-01', 'AR-C', '{}'::jsonb, '{}'::jsonb, 'DRAFT', 'proponente')
           RETURNING id`,
          [clave, norma.rows[0]!.id],
        );

        await db.query(
          `UPDATE accounting_rules
              SET status = 'ACTIVE', approved_by = 'aprobadora', approved_at = now()
            WHERE id = $1`,
          [regla.rows[0]!.id],
        );

        await db.query(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, old_value, new_value, motivo, prev_hash, hash, seq)
           VALUES ('USER', 'aprobadora', 'RULE_APPROVED', 'accounting_rules', $1,
                   '{"status":"DRAFT"}'::jsonb, '{"status":"ACTIVE"}'::jsonb, $2, '', '', 0)`,
          [regla.rows[0]!.id, CONSTANCIA],
        );

        // Lo que el defecto impedía: que la firma quede escrita en la misma
        // transacción que la activación.
        const constancia = await db.query<{ motivo: string; hash: string }>(
          'SELECT motivo, hash FROM normative_audit_logs WHERE object_id = $1',
          [regla.rows[0]!.id],
        );
        expect(constancia.rowCount).toBe(1);
        expect(constancia.rows[0]!.hash).toHaveLength(64);
      } finally {
        // La regla sintética no sobrevive al test: acá no se activa nada.
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3 · La máquina de estados del período
  // -------------------------------------------------------------------------

  describe('3 · el período no cambia de estado a mano', () => {
    it('el estado BLOQUEADO se alcanza, y solo admite AJUSTE y CIERRE', async () => {
      const bloqueo = await pedir('POST', `/periods/${periodId}/block`);
      expect(bloqueo.statusCode, bloqueo.body).toBe(200);
      expect(bloqueo.json<{ status: string }>().status).toBe('BLOQUEADO');

      const corriente = await pedir('POST', '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: '2026-03-12',
        description: 'Operación corriente en período bloqueado',
        currency: 'ARS',
        lines: [
          { accountCode: '1.1.01', debit: '1000.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '1000.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'No debería entrar: el período está bloqueado',
      });
      // 422 con el código de dominio, no 500 con un RAISE EXCEPTION adentro.
      // Antes de esta fase esto era un 500: el motor dejaba pasar el asiento
      // MANUAL porque el actor tenía `period:close`, y lo rechazaba el trigger.
      expect(corriente.statusCode, corriente.body).toBe(422);
      expect(corriente.json<{ errores: { code: string }[] }>().errores[0]!.code).toBe('E_PERIOD_CLOSED');

      const ajuste = await pedir('POST', '/journal-entries', {
        journalCode: 'GENERAL',
        entryDate: '2026-03-12',
        description: 'Ajuste de cierre',
        currency: 'ARS',
        kind: 'AJUSTE',
        lines: [
          { accountCode: '1.1.01', debit: '1000.00', credit: '0' },
          { accountCode: '4.1.01', debit: '0', credit: '1000.00' },
        ],
        source: { type: 'MANUAL', id: null },
        manualJustification: 'Ajuste registrado durante el bloqueo del período',
      });
      expect(ajuste.statusCode, ajuste.body).toBe(201);
    });

    it('un período CERRADO no vuelve a ABIERTO con un UPDATE a secas', async () => {
      // El agujero. `periods_check2` exige dos firmantes distintos, pero solo si
      // `reopened_at` viene cargado — y quien saltea la API no lo carga.
      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE periods SET status = 'CERRADO', closed_at = now(), closed_by = 'x' WHERE id = $1`,
          [periodId],
        );
        const mensaje = await expectFailure(() =>
          db.query(`UPDATE periods SET status = 'ABIERTO' WHERE id = $1`, [periodId]),
        );
        expect(mensaje).toMatch(/exige registrar la reapertura/);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('con las dos firmas sí se reabre, y con una sola no', async () => {
      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE periods SET status = 'CERRADO', closed_at = now(), closed_by = 'x' WHERE id = $1`,
          [periodId],
        );

        // Con SAVEPOINT: un error aborta la transacción entera, y el segundo
        // UPDATE fallaría por eso y no por lo que se quiere probar.
        await db.query('SAVEPOINT una_sola_firma');
        const unaSola = await expectFailure(() =>
          db.query(
            `UPDATE periods SET status = 'ABIERTO', reopened_at = now(), reopened_by = 'a',
                    reopened_countersigned_by = 'a', reopen_reason = 'la misma persona dos veces'
              WHERE id = $1`,
            [periodId],
          ),
        );
        expect(unaSola).toMatch(/periods_check2|check/i);
        await db.query('ROLLBACK TO SAVEPOINT una_sola_firma');

        const conDos = await db.query(
          `UPDATE periods SET status = 'ABIERTO', reopened_at = now(), reopened_by = 'a',
                  reopened_countersigned_by = 'b', reopen_reason = 'ajuste posterior detectado'
            WHERE id = $1
          RETURNING status`,
          [periodId],
        );
        expect(conDos.rowCount).toBe(1);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('un período CERRADO no se bloquea: se reabre', async () => {
      await db.query('BEGIN');
      try {
        await db.query(
          `UPDATE periods SET status = 'CERRADO', closed_at = now(), closed_by = 'x' WHERE id = $1`,
          [periodId],
        );
        const mensaje = await expectFailure(() =>
          db.query(`UPDATE periods SET status = 'BLOQUEADO' WHERE id = $1`, [periodId]),
        );
        expect(mensaje).toMatch(/CERRADO/);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4 · Inmutabilidad de lo emitido
  // -------------------------------------------------------------------------

  describe('4 · lo emitido no cambia por atrás', () => {
    it('un renglón de un estado EMITIDO no se puede reescribir', async () => {
      const mensaje = await expectFailure(() =>
        db.query(
          `UPDATE financial_statement_lines SET amount = amount + 1
            WHERE statement_id = $1 AND line_type = 'RENGLON'`,
          [statementId],
        ),
      );
      expect(mensaje.length).toBeGreaterThan(0);
    });

    it('una cifra de nota no puede desprenderse de su renglón', async () => {
      // `note_figures.statement_line_id` es NOT NULL: no hay dónde escribir un
      // número suelto. Es la forma estructural de "CONTABILIDAD → NOTA".
      const { code } = await expectFailureCode(() =>
        db.query('UPDATE note_figures SET statement_line_id = NULL WHERE note_id = $1', [noteId]),
      );
      expect(code).not.toBe('');
    });

    it('una nota aprobada no se edita', async () => {
      const aprobada = await pedir('POST', `/notes/${noteId}/approve`);
      expect(aprobada.statusCode, aprobada.body).toBe(200);

      const mensaje = await expectFailure(() =>
        db.query('UPDATE notes SET titulo = $1 WHERE id = $2', ['Otro título', noteId]),
      );
      expect(mensaje.length).toBeGreaterThan(0);
    });

    it('el hash de la norma no se puede reescribir: el trigger lo vuelve a congelar', async () => {
      // Si el hash pudiera cambiar retroactivamente, la trazabilidad diría que
      // un asiento se fundó en un texto que hoy dice otra cosa.
      //
      // El candado no rechaza el UPDATE: lo **ignora**. `assert_rule_application_activa`
      // corre BEFORE UPDATE y reasigna `NEW.norm_document_sha256` desde la regla,
      // así que el valor plantado no llega a la fila. Es más fuerte que un
      // rechazo —no depende de que quien escribe pase por una condición— y por
      // eso lo que se afirma es el resultado, no el error.
      const hay = await db.query<{ id: string; norm_document_sha256: string }>(
        'SELECT id, norm_document_sha256 FROM rule_applications LIMIT 1',
      );
      if (hay.rowCount === 0) return;

      await db.query('BEGIN');
      try {
        await db.query(`UPDATE rule_applications SET norm_document_sha256 = repeat('a', 64) WHERE id = $1`, [
          hay.rows[0]!.id,
        ]);
        const despues = await db.query<{ norm_document_sha256: string }>(
          'SELECT norm_document_sha256 FROM rule_applications WHERE id = $1',
          [hay.rows[0]!.id],
        );
        expect(despues.rows[0]!.norm_document_sha256).toBe(hay.rows[0]!.norm_document_sha256);
        expect(despues.rows[0]!.norm_document_sha256).not.toBe('a'.repeat(64));
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5 · Los eventos de auditoría llegan a escribirse
  // -------------------------------------------------------------------------

  describe('5 · la bitácora contiene lo que dice contener', () => {
    /**
     * El defecto de `aprobar-regla.mjs` no fue un typo: fue un evento que nadie
     * había visto llegar. Así que acá no se revisa el código de los escritores
     * —eso ya se hizo—, se comprueba que cada acto **dejó su fila**, con actor,
     * fecha, objeto y el antes y el después.
     */
    const ACTOS = [
      ['CREAR_EJERCICIO', 'fiscal_year'],
      ['BLOQUEAR_PERIODO', 'period'],
    ] as const;

    it.each(ACTOS)('%s dejó su entrada, con actor y objeto', async (accion, objeto) => {
      const r = await db.query<{
        actor_id: string;
        object_id: string;
        occurred_at: string;
        new_value: unknown;
      }>(
        `SELECT actor_id, object_id, occurred_at, new_value
           FROM audit_logs
          WHERE company_id = $1 AND action = $2 AND object_type = $3
          ORDER BY seq DESC LIMIT 1`,
        [companyId, accion, objeto],
      );

      expect(r.rowCount, `${accion} no dejó ninguna entrada`).toBe(1);
      expect(r.rows[0]!.actor_id).toMatch(/^user:/);
      expect(r.rows[0]!.object_id.length).toBeGreaterThan(0);
      expect(r.rows[0]!.occurred_at).toBeTruthy();
      expect(r.rows[0]!.new_value).not.toBeNull();
    });

    it('la aprobación de un asiento dejó el antes y el después, no solo el después', async () => {
      // Un evento que solo guarda el estado nuevo no permite reconstruir qué
      // cambió, que es la única razón por la que existe una bitácora.
      const r = await db.query<{ old_value: unknown; new_value: unknown }>(
        `SELECT old_value, new_value FROM audit_logs
          WHERE company_id = $1 AND object_id = $2 AND action LIKE '%APROBA%'
          ORDER BY seq DESC LIMIT 1`,
        [companyId, entryId],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.old_value).not.toBeNull();
      expect(r.rows[0]!.new_value).not.toBeNull();
    });

    it('la cadena de la empresa es continua: cada prev_hash es el hash anterior', async () => {
      const filas = await db.query<{ prev_hash: string; hash: string }>(
        'SELECT prev_hash, hash FROM audit_logs WHERE company_id = $1 ORDER BY seq',
        [companyId],
      );
      expect(filas.rowCount).toBeGreaterThan(3);

      let anterior = '0'.repeat(64);
      for (const fila of filas.rows) {
        expect(fila.prev_hash).toBe(anterior);
        anterior = fila.hash;
      }
    });

    it('ningún evento quedó sin actor ni sin objeto', async () => {
      const huerfanos = await db.query<{ action: string }>(
        `SELECT action FROM audit_logs
          WHERE company_id = $1
            AND (btrim(actor_id) = '' OR btrim(object_type) = '' OR btrim(object_id) = '')`,
        [companyId],
      );
      expect(huerfanos.rows.map((f) => f.action)).toEqual([]);
    });
  });
});
