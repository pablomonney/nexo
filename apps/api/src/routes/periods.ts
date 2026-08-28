/**
 * Ejercicios y períodos.
 *
 * El estado del período gobierna la mutabilidad de todo lo contable. La
 * reapertura exige DOS personas distintas y un motivo: es el único camino de
 * vuelta desde CERRADO y por eso no puede quedar en manos de una sola firma
 * (SECURITY.md §3).
 */

import { type EstadoPeriodo, transicionar } from '@aai/accounting-engine';
import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Se espera YYYY-MM-DD');

export async function periodRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fiscal-years', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'period:read');
    const auth = requireAuth(request);

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const result = await tx.query(
        `SELECT fy.id, fy.code, fy.start_date AS "startDate", fy.end_date AS "endDate", fy.status,
                (SELECT count(*)::int FROM periods p WHERE p.fiscal_year_id = fy.id) AS "periodCount"
           FROM fiscal_years fy
          WHERE fy.company_id = $1
          ORDER BY fy.start_date DESC`,
        [tenant.companyId],
      );
      return { fiscalYears: result.rows };
    });
  });

  app.post('/fiscal-years', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'period:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        code: z.string().min(1).max(40),
        startDate: dateField,
        endDate: dateField,
        /** Si es true, se generan los doce períodos mensuales del ejercicio. */
        generateMonthlyPeriods: z.boolean().default(true),
      })
      .parse(request.body);

    if (body.endDate <= body.startDate) {
      throw badRequest('El cierre del ejercicio debe ser posterior a su inicio');
    }

    try {
      const result = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const created = await tx.query<{ id: string }>(
            `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [tenant.companyId, body.code, body.startDate, body.endDate],
          );
          const fiscalYearId = created.rows[0]!.id;

          let periods = 0;
          if (body.generateMonthlyPeriods) {
            // Los períodos se recortan al ejercicio: si empieza el 15 o cierra a
            // mitad de mes, el primero y el último son parciales.
            const generated = await tx.query<{ n: string }>(
              `WITH bounds AS (
                 SELECT $2::date AS start_date, $3::date AS end_date
               ), months AS (
                 SELECT generate_series(date_trunc('month', start_date), end_date, interval '1 month')::date AS month_start,
                        start_date, end_date
                   FROM bounds
               ), ranges AS (
                 SELECT row_number() OVER (ORDER BY month_start) AS number,
                        greatest(month_start, start_date) AS from_date,
                        least((month_start + interval '1 month - 1 day')::date, end_date) AS to_date
                   FROM months
               )
               INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
               SELECT $1, $4, number, from_date, to_date FROM ranges
               RETURNING 1`,
              [tenant.companyId, body.startDate, body.endDate, fiscalYearId],
            );
            periods = generated.rowCount ?? 0;
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_EJERCICIO',
            objectType: 'fiscal_year',
            objectId: fiscalYearId,
            newValue: body,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { id: fiscalYearId, periods };
        },
      );

      reply.code(201);
      return result;
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.constraint === 'fiscal_years_no_overlap') {
        throw conflict('El ejercicio se superpone con otro ya existente');
      }
      if (failure.code === '23505') throw conflict('Ya existe un ejercicio con ese código');
      throw error;
    }
  });

  app.get('/periods', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'period:read');
    const auth = requireAuth(request);
    const query = z.object({ fiscalYearId: z.string().uuid().optional() }).parse(request.query);

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const result = await tx.query(
        `SELECT id, fiscal_year_id AS "fiscalYearId", number,
                start_date AS "startDate", end_date AS "endDate", status,
                closed_at AS "closedAt", closed_by AS "closedBy"
           FROM periods
          WHERE company_id = $1 AND ($2::uuid IS NULL OR fiscal_year_id = $2)
          ORDER BY start_date`,
        [tenant.companyId, query.fiscalYearId ?? null],
      );
      return { periods: result.rows };
    });
  });

  /**
   * BLOQUEADO: "solo los ajustes de cierre".
   *
   * El estado existía en el CHECK de la 0004 y el guard de asientos lo
   * contemplaba desde la 0010 —`BLOQUEADO` admite AJUSTE y CIERRE y nada más—,
   * pero no había forma de llegar a él: ni permiso, ni endpoint. Un candado que
   * protege un estado inalcanzable no protege nada, y por eso no se podía saber
   * si funcionaba.
   */
  app.post('/periods/:periodId/block', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'period:block');
    const auth = requireAuth(request);
    const params = z.object({ periodId: z.string().uuid() }).parse(request.params);

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const current = await tx.query<{ status: EstadoPeriodo; number: number }>(
        'SELECT status, number FROM periods WHERE id = $1',
        [params.periodId],
      );
      if (current.rowCount === 0) throw notFound('Período no encontrado');

      const paso = transicionar({
        desde: current.rows[0]!.status,
        transicion: 'BLOQUEAR',
        actorId: `user:${auth.user.userId}`,
      });
      if (!paso.ok) throw conflict(paso.motivo);

      await tx.query(`UPDATE periods SET status = 'BLOQUEADO' WHERE id = $1`, [params.periodId]);

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId: `user:${auth.user.userId}`,
        action: 'BLOQUEAR_PERIODO',
        objectType: 'period',
        objectId: params.periodId,
        oldValue: current.rows[0],
        newValue: { status: 'BLOQUEADO' },
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { status: 'BLOQUEADO' };
    });
  });

  app.post('/periods/:periodId/close', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'period:close');
    const auth = requireAuth(request);
    const params = z.object({ periodId: z.string().uuid() }).parse(request.params);

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const current = await tx.query<{ status: EstadoPeriodo; number: number }>(
        'SELECT status, number FROM periods WHERE id = $1',
        [params.periodId],
      );
      if (current.rowCount === 0) throw notFound('Período no encontrado');

      // La transición la decide la máquina de estados del motor, no un `if`
      // acá. Tenerla escrita en `periods.ts` y no usarla dejaba dos definiciones
      // de lo mismo, y la que gobernaba era la que nadie había revisado.
      const paso = transicionar({
        desde: current.rows[0]!.status,
        transicion: 'CERRAR',
        actorId: `user:${auth.user.userId}`,
      });
      if (!paso.ok) throw conflict(paso.motivo);

      // Checklist de cierre (§36): asientos sin aprobar bloquean.
      const pending = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_entries
          WHERE period_id = $1 AND status IN ('BORRADOR', 'PROPUESTO')`,
        [params.periodId],
      );
      if (pending.rows[0]!.n !== '0') {
        throw conflict(
          `No se puede cerrar: quedan ${pending.rows[0]!.n} asiento(s) sin aprobar`,
          { pendingEntries: Number(pending.rows[0]!.n) },
        );
      }

      await tx.query(
        `UPDATE periods SET status = 'CERRADO', closed_at = now(), closed_by = $2 WHERE id = $1`,
        [params.periodId, auth.user.email],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId: `user:${auth.user.userId}`,
        action: 'CERRAR_PERIODO',
        objectType: 'period',
        objectId: params.periodId,
        oldValue: current.rows[0],
        newValue: { status: 'CERRADO' },
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { status: 'CERRADO' };
    });
  });

  /**
   * Reapertura: exige dos firmantes distintos y motivo.
   *
   * La base también lo exige (CHECK en `periods`), así que aunque este handler
   * tuviera un bug, la fila no entraría.
   */
  app.post('/periods/:periodId/reopen', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'period:reopen');
    const auth = requireAuth(request);
    const params = z.object({ periodId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        motivo: z.string().min(10).max(1000),
        /** Email del segundo firmante, que debe tener el mismo permiso. */
        countersignedBy: z.string().email(),
      })
      .parse(request.body);

    if (body.countersignedBy.toLowerCase() === auth.user.email.toLowerCase()) {
      throw forbidden('La reapertura exige dos personas distintas');
    }

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const current = await tx.query<{ status: EstadoPeriodo }>(
        'SELECT status FROM periods WHERE id = $1',
        [params.periodId],
      );
      if (current.rowCount === 0) throw notFound('Período no encontrado');

      const paso = transicionar({
        desde: current.rows[0]!.status,
        transicion: 'REABRIR',
        actorId: auth.user.email,
        refrendadoPor: body.countersignedBy,
        motivo: body.motivo,
      });
      if (!paso.ok) throw conflict(paso.motivo);

      await tx.query(
        `UPDATE periods
            SET status = 'ABIERTO', reopened_at = now(), reopened_by = $2,
                reopened_countersigned_by = $3, reopen_reason = $4
          WHERE id = $1`,
        [params.periodId, auth.user.email, body.countersignedBy, body.motivo],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId: `user:${auth.user.userId}`,
        action: 'REABRIR_PERIODO',
        objectType: 'period',
        objectId: params.periodId,
        oldValue: { status: 'CERRADO' },
        newValue: { status: 'ABIERTO', countersignedBy: body.countersignedBy },
        motivo: body.motivo,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { status: 'ABIERTO' };
    });
  });
}
