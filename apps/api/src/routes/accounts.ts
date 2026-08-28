/** Plan de cuentas y centros de costo (§8). El plan es POR EMPRESA. */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound } from '../http/errors.js';

const ACCOUNT_TYPES = ['ACTIVO', 'PASIVO', 'PN', 'INGRESO', 'COSTO', 'GASTO', 'ORDEN'] as const;
const TAX_ROLES = ['IVA_CF', 'IVA_DF', 'PERCEPCION', 'RETENCION', 'DIFERENCIA_CAMBIO'] as const;

/**
 * Naturaleza esperada por tipo de cuenta.
 *
 * Se valida en el alta porque una cuenta de ingresos con naturaleza deudora
 * produce un Mayor que suma al revés, y el error aparece recién en el balance
 * —a veces meses después— cuando ya hay cientos de asientos imputados.
 */
const EXPECTED_NATURE: Record<(typeof ACCOUNT_TYPES)[number], 'DEUDORA' | 'ACREEDORA'> = {
  ACTIVO: 'DEUDORA',
  PASIVO: 'ACREEDORA',
  PN: 'ACREEDORA',
  INGRESO: 'ACREEDORA',
  COSTO: 'DEUDORA',
  GASTO: 'DEUDORA',
  ORDEN: 'DEUDORA',
};

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'account:read');
    const auth = requireAuth(request);

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const result = await tx.query(
        `SELECT id, code, name, parent_id AS "parentId", type, nature,
                is_postable AS "isPostable", currency, tax_role AS "taxRole",
                closing_role AS "closingRole",
                requires_cost_center AS "requiresCostCenter",
                requires_third_party AS "requiresThirdParty", status
           FROM accounts
          WHERE company_id = $1
          ORDER BY code`,
        [tenant.companyId],
      );
      return { accounts: result.rows };
    });
  });

  app.post('/accounts', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'account:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        chartId: z.string().uuid().optional(),
        code: z.string().min(1).max(40).regex(/^[0-9.]+$/, 'El código admite dígitos y puntos'),
        name: z.string().min(1).max(200),
        parentId: z.string().uuid().nullish(),
        type: z.enum(ACCOUNT_TYPES),
        nature: z.enum(['DEUDORA', 'ACREEDORA']).optional(),
        isPostable: z.boolean().default(true),
        currency: z.string().length(3).default('ARS'),
        taxRole: z.enum(TAX_ROLES).nullish(),
        requiresCostCenter: z.boolean().default(false),
        requiresThirdParty: z.boolean().default(false),
      })
      .parse(request.body);

    const nature = body.nature ?? EXPECTED_NATURE[body.type];

    try {
      const created = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          let chartId = body.chartId;
          if (chartId === undefined) {
            const existing = await tx.query<{ id: string }>(
              'SELECT id FROM account_charts WHERE company_id = $1 ORDER BY version DESC LIMIT 1',
              [tenant.companyId],
            );
            chartId =
              existing.rows[0]?.id ??
              (
                await tx.query<{ id: string }>(
                  `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan de cuentas')
                   RETURNING id`,
                  [tenant.companyId],
                )
              ).rows[0]!.id;
          }

          const result = await tx.query<{ id: string }>(
            `INSERT INTO accounts
               (company_id, chart_id, code, name, parent_id, type, nature, is_postable,
                currency, tax_role, requires_cost_center, requires_third_party)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING id`,
            [
              tenant.companyId, chartId, body.code, body.name, body.parentId ?? null,
              body.type, nature, body.isPostable, body.currency, body.taxRole ?? null,
              body.requiresCostCenter, body.requiresThirdParty,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CAMBIAR_PLAN_CUENTAS',
            objectType: 'account',
            objectId: result.rows[0]!.id,
            newValue: { ...body, nature },
            motivo: 'Alta de cuenta',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return result.rows[0]!.id;
        },
      );

      reply.code(201);
      return { id: created, nature };
    } catch (error) {
      const failure = error as { code?: string };
      if (failure.code === '23505') throw conflict('Ya existe una cuenta con ese código');
      if (failure.code === '23503') throw notFound('La cuenta padre no existe en esta empresa');
      throw error;
    }
  });

  app.patch('/accounts/:accountId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'account:write');
    const auth = requireAuth(request);
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
        requiresCostCenter: z.boolean().optional(),
        requiresThirdParty: z.boolean().optional(),
        /**
         * Designa la cuenta que recibe el resultado del ejercicio.
         *
         * `null` la desmarca. La base impide que haya dos por empresa y que la
         * marcada no sea de PN imputable (migración 0038): el sistema no elige
         * esta cuenta, solo registra cuál eligió la empresa.
         */
        closingRole: z.enum(['RESULTADO_DEL_EJERCICIO']).nullish(),
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const before = await tx.query(
          `SELECT id, name, status, requires_cost_center, requires_third_party, closing_role
             FROM accounts WHERE id = $1`,
          [params.accountId],
        );
        if (before.rowCount === 0) throw notFound('Cuenta no encontrada');

        const result = await tx.query(
          `UPDATE accounts
              SET name = COALESCE($2, name),
                  status = COALESCE($3, status),
                  requires_cost_center = COALESCE($4, requires_cost_center),
                  requires_third_party = COALESCE($5, requires_third_party),
                  -- Distinto de los demás: acá NULL significa desmarcar, no
                  -- "dejar como estaba". Por eso viaja aparte un booleano que
                  -- dice si el campo vino en el cuerpo.
                  closing_role = CASE WHEN $6 THEN $7 ELSE closing_role END
            WHERE id = $1
            RETURNING id, name, status, closing_role AS "closingRole"`,
          [
            params.accountId,
            body.name ?? null,
            body.status ?? null,
            body.requiresCostCenter ?? null,
            body.requiresThirdParty ?? null,
            body.closingRole !== undefined,
            body.closingRole ?? null,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'CAMBIAR_PLAN_CUENTAS',
          objectType: 'account',
          objectId: params.accountId,
          oldValue: before.rows[0],
          newValue: result.rows[0],
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return result.rows[0];
      },
    );
  });

  app.get('/cost-centers', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cost_center:read');
    const auth = requireAuth(request);

    return withCompany({ companyId: tenant.companyId, actorId: `user:${auth.user.userId}` }, async (tx) => {
      const result = await tx.query(
        `SELECT id, code, name, parent_id AS "parentId", status
           FROM cost_centers WHERE company_id = $1 ORDER BY code`,
        [tenant.companyId],
      );
      return { costCenters: result.rows };
    });
  });

  app.post('/cost-centers', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'cost_center:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        parentId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const result = await tx.query<{ id: string }>(
            `INSERT INTO cost_centers (company_id, code, name, parent_id)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [tenant.companyId, body.code, body.name, body.parentId ?? null],
          );
          return result.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('Ya existe un centro de costo con ese código');
      }
      throw error;
    }
  });
}
