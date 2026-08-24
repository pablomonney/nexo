/** Nivel estudio: organizaciones, alta de empresas y asignación de roles. */

import { recordAudit, withCompany, withoutCompany } from '@aai/db';
import { isValidCuit, normalizeCuit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/crypto.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, forbidden } from '../http/errors.js';

const ENTITY_TYPES = [
  'SA', 'SA_299', 'SRL', 'SAS', 'SOCIEDAD_SIMPLE', 'ASOC_CIVIL', 'FUNDACION',
  'COOPERATIVA', 'MUTUAL', 'SUCURSAL_EXTRANJERA', 'UNIPERSONAL', 'FIDEICOMISO',
] as const;

const cuitField = z
  .string()
  .transform(normalizeCuit)
  .refine(isValidCuit, 'CUIT inválido: el dígito verificador no cierra');

export async function studioRoutes(app: FastifyInstance): Promise<void> {
  app.post('/organizations', async (request) => {
    const auth = requireAuth(request);
    const body = z
      .object({ name: z.string().min(1).max(200), taxId: cuitField })
      .parse(request.body);

    const id = await withoutCompany(`user:${auth.user.userId}`, async (tx) => {
      const result = await tx.query<{ create_organization: string }>(
        'SELECT create_organization($1, $2, $3)',
        [body.name, body.taxId, auth.user.userId],
      );
      return result.rows[0]!.create_organization;
    });

    return { id };
  });

  app.get('/organizations', async (request) => {
    const auth = requireAuth(request);
    return withoutCompany(`user:${auth.user.userId}`, async (tx) => {
      const result = await tx.query(
        `SELECT o.id, o.name, o.tax_id AS "taxId", m.level
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1
          ORDER BY o.name`,
        [auth.user.userId],
      );
      return { organizations: result.rows };
    });
  });

  app.post('/organizations/:organizationId/companies', async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        legalName: z.string().min(1).max(300),
        cuit: cuitField,
        entityType: z.enum(ENTITY_TYPES),
        // ISO 3166-2:AR. Determina qué adopción normativa aplica (ADR-002).
        jurisdiction: z.string().regex(/^AR(-[A-Z])?$/),
        regulator: z.enum(['IGJ', 'CNV', 'BCRA', 'INAES', 'PROVINCIAL']).optional(),
        fiscalYearEnd: z.string().regex(/^\d{2}-\d{2}$/),
      })
      .parse(request.body);

    try {
      const id = await withoutCompany(`user:${auth.user.userId}`, async (tx) => {
        const result = await tx.query<{ create_company: string }>(
          'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            auth.user.userId,
            params.organizationId,
            body.legalName,
            body.cuit,
            body.entityType,
            body.jurisdiction,
            body.regulator ?? '',
            body.fiscalYearEnd,
          ],
        );
        return result.rows[0]!.create_company;
      });
      return { id };
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      if (failure.code === '42501') throw forbidden('No administrás este estudio');
      if (failure.code === '23505') throw conflict('Ya existe una empresa con ese CUIT en el estudio');
      throw error;
    }
  });

  /** Alta de usuario del estudio. No otorga acceso a ninguna empresa por sí sola. */
  app.post('/organizations/:organizationId/users', async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ organizationId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        email: z.string().email().max(320),
        fullName: z.string().min(1).max(200),
        password: z.string().min(12).max(1024),
        level: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
      })
      .parse(request.body);

    return withoutCompany(`user:${auth.user.userId}`, async (tx) => {
      const level = await tx.query<{ organization_level: string | null }>(
        'SELECT organization_level($1, $2)',
        [auth.user.userId, params.organizationId],
      );
      const actorLevel = level.rows[0]?.organization_level;
      if (actorLevel !== 'OWNER' && actorLevel !== 'ADMIN') {
        throw forbidden('No administrás este estudio');
      }

      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [body.email],
      );
      if (existing.rowCount! > 0) throw conflict('Ya existe un usuario con ese email');

      const created = await tx.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [body.email, body.fullName, await hashPassword(body.password)],
      );
      const userId = created.rows[0]!.id;

      await tx.query(
        'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, $3)',
        [params.organizationId, userId, body.level],
      );

      return { id: userId };
    });
  });

  /** Asigna un rol dentro de una empresa concreta. */
  app.post('/companies/:companyId/roles', async (request) => {
    const auth = requireAuth(request);
    const params = z.object({ companyId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        userId: z.string().uuid(),
        role: z.enum([
          'ADMINISTRADOR', 'CONTADOR', 'AUDITOR',
          'USUARIO_EMPRESA', 'CARGADOR', 'SOLO_LECTURA',
        ]),
      })
      .parse(request.body);

    try {
      await withoutCompany(`user:${auth.user.userId}`, (tx) =>
        tx.query('SELECT grant_company_role($1, $2, $3, $4)', [
          auth.user.userId,
          params.companyId,
          body.userId,
          body.role,
        ]),
      );
    } catch (error) {
      const failure = error as { code?: string };
      if (failure.code === '42501') throw forbidden('No autorizado a asignar roles en esta empresa');
      throw error;
    }

    return { ok: true };
  });

  /** Datos de la empresa activa. El id sale de la cabecera, nunca del cuerpo. */
  app.get('/companies/current', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'company:read');

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${requireAuth(request).user.userId}` },
      async (tx) => {
        const company = await tx.query(
          `SELECT id, legal_name AS "legalName", cuit, entity_type AS "entityType",
                  jurisdiction, regulator, fiscal_year_end AS "fiscalYearEnd", status
             FROM companies WHERE id = $1`,
          [tenant.companyId],
        );
        const framework = await tx.query(
          `SELECT framework, valid_from AS "validFrom", valid_to AS "validTo"
             FROM company_reporting_frameworks
            WHERE company_id = $1 AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
            ORDER BY valid_from DESC LIMIT 1`,
          [tenant.companyId],
        );
        return {
          company: company.rows[0] ?? null,
          reportingFramework: framework.rows[0] ?? null,
          roles: [...tenant.roles],
          permissions: [...tenant.permissions].sort(),
        };
      },
    );
  });

  /**
   * Marco contable del ente.
   *
   * La RG IGJ 9/2026 (art. 230 sustituido) dice que las sociedades "podrán optar"
   * por NIIF o NIIF para PyMES. La opción es del ente: se registra con respaldo
   * documental, no se infiere del CUIT (ADR-006, conflicto C-04).
   */
  app.post('/companies/current/reporting-framework', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'company:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        framework: z.enum(['RT_FACPCE', 'NIIF', 'NIIF_PYMES']),
        validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        evidenceDocumentId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const result = await tx.query<{ id: string }>(
            `INSERT INTO company_reporting_frameworks
               (company_id, framework, valid_from, valid_to, decided_by, evidence_document_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              tenant.companyId,
              body.framework,
              body.validFrom,
              body.validTo ?? null,
              auth.user.email,
              body.evidenceDocumentId ?? null,
            ],
          );
          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DEFINIR_MARCO_CONTABLE',
            objectType: 'company_reporting_framework',
            objectId: result.rows[0]!.id,
            newValue: body,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });
          return { id: result.rows[0]!.id };
        },
      );
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.constraint === 'company_framework_no_overlap') {
        throw conflict('Ya hay un marco contable vigente para ese período. Cerrá el anterior primero.');
      }
      throw error;
    }
  });

  app.get('/companies/current/users', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'user:read');

    return withoutCompany(`user:${requireAuth(request).user.userId}`, async (tx) => {
      const result = await tx.query(
        `SELECT u.id, u.email, u.full_name AS "fullName", u.mfa_enabled AS "mfaEnabled",
                u.status, r.code AS role,
                ucr.valid_from AS "validFrom", ucr.valid_to AS "validTo"
           FROM user_company_roles ucr
           JOIN users u ON u.id = ucr.user_id
           JOIN roles r ON r.id = ucr.role_id
          WHERE ucr.company_id = $1
          ORDER BY u.full_name`,
        [tenant.companyId],
      );
      return { users: result.rows };
    });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/db', async () => {
    const result = await withoutCompany('system:health', (tx) =>
      tx.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations'),
    );
    return { status: 'ok', migrations: Number(result.rows[0]!.n) };
  });

  app.get('/normative/gaps', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'rule:read');
    return withoutCompany('system:normative', async (tx) => {
      const result = await tx.query(
        `SELECT topic, description, blocks, status
           FROM normative_gaps WHERE status = 'ABIERTO' ORDER BY topic`,
      );
      return { gaps: result.rows };
    });
  });
}
