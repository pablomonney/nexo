/**
 * Caja: apertura, movimientos y arqueo.
 *
 * ## El saldo teórico no se manda, se deriva
 *
 * No hay endpoint que fije el saldo de una caja. Se declara cuánto había al
 * abrir, se registran los movimientos, y el teórico sale de la suma. Lo único
 * que el sistema no puede derivar es **el contado**, porque sale de contar
 * billetes — y por eso es lo único que el cierre pide.
 *
 * ## La diferencia no se corrige: se explica
 *
 * Cerrar con diferencia está permitido. Lo que no está permitido es hacerla
 * desaparecer: la sesión queda cerrada con su diferencia y va a la bandeja
 * hasta que alguien escriba por qué. Ajustar el contado para que dé cero sería
 * exactamente lo que un arqueo existe para impedir.
 *
 * ## Este módulo no escribe en el Mayor
 *
 * El movimiento de caja del período es un asiento, y ese asiento lo firma una
 * persona por el camino de siempre. La sesión puede **citarlo**.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');

export async function cajaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/cash-boxes', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT b.id, b.code AS codigo, b.name AS nombre, b.currency AS moneda,
                  b.status, a.code AS "cuentaCodigo",
                  (SELECT s.id FROM cash_sessions s
                    WHERE s.cash_box_id = b.id AND s.company_id = b.company_id
                      AND s.status = 'ABIERTA') AS "sesionAbierta"
             FROM cash_boxes b
             LEFT JOIN accounts a ON a.id = b.account_id AND a.company_id = b.company_id
            WHERE b.company_id = $1
            ORDER BY b.code`,
          [tenant.companyId],
        );
        return { cajas: r.rows };
      },
    );
  });

  app.post('/cash-boxes', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        moneda: z.string().length(3).default('ARS'),
        // La cuenta llega por código y se resuelve dentro de la empresa: un
        // uuid del cuerpo dejaría al cliente eligiendo una fila que podría no
        // ser suya.
        cuenta: z.string().min(1).max(40).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          let accountId: string | null = null;
          if (body.cuenta !== null && body.cuenta !== undefined) {
            const a = await tx.query<{ id: string }>(
              'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
              [tenant.companyId, body.cuenta],
            );
            if (a.rowCount === 0) throw notFound(`No existe la cuenta ${body.cuenta}`);
            accountId = a.rows[0]!.id;
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO cash_boxes (company_id, code, name, currency, account_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.moneda,
              accountId, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_CAJA',
            objectType: 'cash_boxes',
            objectId: r.rows[0]!.id,
            newValue: { codigo: body.codigo, nombre: body.nombre },
            motivo: 'Alta de caja',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('Ya existe una caja con ese código en esta empresa');
      }
      throw error;
    }
  });

  /** Las sesiones y su arqueo, derivado. */
  app.get('/cash-sessions', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:read');
    const auth = requireAuth(request);
    const query = z
      .object({ status: z.enum(['ABIERTA', 'CERRADA']).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT session_id AS id, cash_box_id AS "cajaId",
                  caja_codigo AS "cajaCodigo", caja_nombre AS "cajaNombre",
                  moneda, status,
                  abierta_el::text AS "abiertaEl", cerrada_el::text AS "cerradaEl",
                  saldo_inicial::text AS "saldoInicial",
                  ingresos::text, egresos::text,
                  saldo_teorico::text AS "saldoTeorico",
                  saldo_contado::text AS "saldoContado",
                  diferencia::text,
                  motivo_diferencia AS "motivoDiferencia",
                  journal_entry_id AS "asientoId",
                  movimientos
             FROM cash_session_status
            WHERE company_id = $1
              AND ($2::text IS NULL OR status = $2)
            ORDER BY abierta_el DESC, session_id DESC
            LIMIT 100`,
          [tenant.companyId, query.status ?? null],
        );

        return {
          sesiones: r.rows,
          alcance:
            'El saldo teórico se deriva de los movimientos: no hay columna que mantener. La ' +
            'diferencia es `null` mientras no se contó — distinto de cero, que sería afirmar ' +
            'que coincidía.',
        };
      },
    );
  });

  app.get('/cash-sessions/:sessionId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:read');
    const auth = requireAuth(request);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const sesion = await tx.query(
          `SELECT session_id AS id, caja_codigo AS "cajaCodigo", status,
                  abierta_el::text AS "abiertaEl", cerrada_el::text AS "cerradaEl",
                  saldo_inicial::text AS "saldoInicial",
                  ingresos::text, egresos::text,
                  saldo_teorico::text AS "saldoTeorico",
                  saldo_contado::text AS "saldoContado", diferencia::text,
                  motivo_diferencia AS "motivoDiferencia", journal_entry_id AS "asientoId"
             FROM cash_session_status WHERE session_id = $1 AND company_id = $2`,
          [sessionId, tenant.companyId],
        );
        if (sesion.rowCount === 0) throw notFound('Sesión de caja no encontrada');

        const movimientos = await tx.query(
          `SELECT m.id, m.tipo, m.importe::text, m.fecha::text, m.concepto,
                  m.party_id AS "terceroId", p.razon_social AS "razonSocial",
                  m.created_by AS "registradoPor"
             FROM cash_movements m
             LEFT JOIN parties p ON p.id = m.party_id AND p.company_id = m.company_id
            WHERE m.session_id = $1 AND m.company_id = $2
            ORDER BY m.fecha, m.created_at`,
          [sessionId, tenant.companyId],
        );

        return { sesion: sesion.rows[0], movimientos: movimientos.rows };
      },
    );
  });

  app.post('/cash-sessions', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        cajaId: z.string().uuid(),
        fecha,
        // Se declara. No se arrastra del cierre anterior: arrastrarlo haría que
        // un error de conteo se propague sin que nadie lo vuelva a mirar.
        saldoInicial: monto,
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO cash_sessions
               (company_id, cash_box_id, abierta_el, saldo_inicial, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              tenant.companyId, body.cajaId, body.fecha,
              body.saldoInicial, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ABRIR_CAJA',
            objectType: 'cash_sessions',
            objectId: r.rows[0]!.id,
            newValue: { cajaId: body.cajaId, saldoInicial: body.saldoInicial },
            motivo: 'Se declara cuánto había al abrir. El teórico se deriva desde acá.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCaja(error);
    }
  });

  app.post('/cash-sessions/:sessionId/movimientos', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:write');
    const auth = requireAuth(request);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        tipo: z.enum(['INGRESO', 'EGRESO']),
        importe: monto,
        fecha,
        // Obligatorio: un movimiento de caja sin concepto es plata que se movió
        // porque sí, y al arquear nadie puede reconstruir qué pasó (§24).
        concepto: z.string().min(3).max(300),
        terceroId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO cash_movements
               (company_id, session_id, tipo, importe, fecha, concepto, party_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              tenant.companyId, sessionId, body.tipo, body.importe, body.fecha,
              body.concepto, body.terceroId ?? null, `user:${auth.user.userId}`,
            ],
          );
          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCaja(error);
    }
  });

  /**
   * Arqueo: se declara lo contado y la sesión se cierra.
   *
   * Cerrar con diferencia está permitido. Lo que no está permitido es hacerla
   * desaparecer: queda escrita y va a la bandeja hasta que alguien explique por
   * qué. Ajustar el contado para que dé cero es exactamente lo que un arqueo
   * existe para impedir.
   */
  app.post('/cash-sessions/:sessionId/close', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:write');
    const auth = requireAuth(request);
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        fecha,
        saldoContado: monto,
        motivo: z.string().max(500).nullish(),
        asientoId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ status: string; saldo_teorico: string }>(
            `SELECT status, saldo_teorico::text
               FROM cash_session_status WHERE session_id = $1 AND company_id = $2`,
            [sessionId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Sesión de caja no encontrada');
          if (antes.rows[0]!.status !== 'ABIERTA') {
            throw conflict('La sesión ya está cerrada: se arqueó una sola vez.');
          }

          await tx.query(
            `UPDATE cash_sessions
                SET status = 'CERRADA', cerrada_el = $3, saldo_contado = $4,
                    motivo_diferencia = $5, journal_entry_id = $6, closed_by = $7
              WHERE id = $1 AND company_id = $2`,
            [
              sessionId, tenant.companyId, body.fecha, body.saldoContado,
              body.motivo ?? null, body.asientoId ?? null, `user:${auth.user.userId}`,
            ],
          );

          // La diferencia se lee de la vista después de cerrar: se deriva, y
          // calcularla acá sería una segunda aritmética que puede diverger.
          const despues = await tx.query<{ diferencia: string; saldo_teorico: string }>(
            `SELECT diferencia::text, saldo_teorico::text
               FROM cash_session_status WHERE session_id = $1 AND company_id = $2`,
            [sessionId, tenant.companyId],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ARQUEAR_CAJA',
            objectType: 'cash_sessions',
            objectId: sessionId,
            oldValue: { status: 'ABIERTA' },
            newValue: {
              status: 'CERRADA',
              saldoContado: body.saldoContado,
              saldoTeorico: despues.rows[0]!.saldo_teorico,
              diferencia: despues.rows[0]!.diferencia,
            },
            motivo:
              body.motivo ??
              'Arqueo de caja. La diferencia queda escrita: hacerla desaparecer es lo que un ' +
                'arqueo existe para impedir.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            sessionId,
            saldoTeorico: despues.rows[0]!.saldo_teorico,
            saldoContado: body.saldoContado,
            diferencia: despues.rows[0]!.diferencia,
            alcance:
              'La diferencia queda registrada tal cual. **No se generó ningún asiento**: el ' +
              'movimiento de caja del período lo firma una persona, por el camino de siempre.',
          };
        },
      );
    } catch (error) {
      throw traducirCaja(error);
    }
  });

  /**
   * Desde cuánta plata se arranca, por fuente.
   *
   * Es lo que le faltaba al flujo de fondos para contestar «¿llego a fin de
   * mes?»: entra 100 y sale 80 no dice nada si no se sabe que había 5.
   */
  app.get('/analysis/disponible', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cash:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT fuente, saldo::text, partidas, metodologia
             FROM analytics_disponible WHERE company_id = $1 ORDER BY fuente`,
          [tenant.companyId],
        );

        const total = await tx.query<{ total: string }>(
          `SELECT coalesce(sum(saldo), 0)::text AS total
             FROM analytics_disponible WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          porFuente: r.rows,
          total: total.rows[0]!.total,
          alcance:
            'Caja es el saldo **teórico** de las sesiones abiertas: lo que debería haber, no ' +
            'lo contado — para eso está el arqueo. Bancos es el saldo del **Mayor** y no el ' +
            'del extracto: la diferencia entre los dos la resuelve la conciliación, no esta ' +
            'lectura.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirCaja(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_CAJA_CERRADA')) {
    return conflict(
      'La sesión ya fue arqueada: agregarle un movimiento cambiaría el saldo teórico contra ' +
        'el que se contó y dejaría la diferencia sin sentido.',
    );
  }
  if (fallo.code === '23505' && mensaje.includes('cs_una_abierta_por_caja')) {
    return conflict(
      'Esa caja ya tiene una sesión abierta. Con dos, un movimiento no sabría a cuál ' +
        'pertenece y el arqueo dejaría de significar algo.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('cs_cierre_no_anterior')) {
    return unprocessable(
      'CIERRE_ANTERIOR_A_LA_APERTURA',
      'La fecha de cierre no puede ser anterior a la de apertura.',
    );
  }
  if (fallo.code === '23503') {
    return notFound('La caja, el tercero o el asiento no existen en esta empresa');
  }
  return error;
}
