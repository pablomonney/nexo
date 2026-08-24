/**
 * Autenticación, tenancy y autorización como `preHandler`s de Fastify.
 *
 * Tercera pata del aislamiento junto con RLS y el storage. La regla que hace
 * cumplir este módulo es que **ningún handler pueda construir una consulta sin
 * `companyId` explícito**: el acceso a datos se hace por `withCompany`, y el
 * `companyId` sale de acá, nunca del cuerpo de la petición.
 */

import { withCompany, withoutCompany } from '@aai/db';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hashToken } from '../auth/crypto.js';
import { forbidden, HttpError, mfaRequired, unauthorized } from './errors.js';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly mfaEnabled: boolean;
}

export interface RequestAuth {
  readonly session: { id: string; mfaSatisfied: boolean };
  readonly user: AuthenticatedUser;
}

export interface RequestTenant {
  readonly companyId: string;
  readonly permissions: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
}

/** SECURITY.md §2: para estos roles el segundo factor es obligatorio, no sugerido. */
export const ROLES_REQUIRING_MFA = new Set(['ADMINISTRADOR', 'CONTADOR', 'AUDITOR']);

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
    tenant?: RequestTenant;
  }
}

function extractToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const cookie = request.cookies[config.session.cookieName];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;
}

/** Carga la sesión. No exige MFA: eso lo hace `requireAuth`. */
export async function loadSession(request: FastifyRequest): Promise<void> {
  const token = extractToken(request);
  if (token === undefined) return;

  const tokenHash = hashToken(token);
  const row = await withoutCompany('system:auth', async (tx) => {
    const result = await tx.query<{
      id: string;
      user_id: string;
      mfa_satisfied: boolean;
      email: string;
      full_name: string;
      mfa_enabled: boolean;
      user_status: string;
    }>(
      `SELECT s.id, s.user_id, s.mfa_satisfied,
              u.email, u.full_name, u.mfa_enabled, u.status AS user_status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.absolute_expires_at > now()`,
      [tokenHash],
    );
    if (result.rowCount === 0) return undefined;

    // Renovar la ventana de inactividad. La absoluta no se toca: es el techo.
    await tx.query(
      `UPDATE sessions
          SET last_seen_at = now(),
              expires_at = now() + ($2 || ' minutes')::interval
        WHERE id = $1`,
      [result.rows[0]!.id, String(config.session.idleMinutes)],
    );
    return result.rows[0]!;
  });

  if (row === undefined || row.user_status !== 'ACTIVE') return;

  request.auth = {
    session: { id: row.id, mfaSatisfied: row.mfa_satisfied },
    user: {
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      mfaEnabled: row.mfa_enabled,
    },
  };
}

/** Exige sesión válida y, si el usuario tiene MFA, que esté satisfecho. */
export function requireAuth(request: FastifyRequest): RequestAuth {
  if (request.auth === undefined) throw unauthorized();
  if (request.auth.user.mfaEnabled && !request.auth.session.mfaSatisfied) throw mfaRequired();
  return request.auth;
}

/**
 * Resuelve la empresa activa desde la cabecera `X-Company-Id` y verifica que el
 * usuario tenga un rol vigente en ella.
 *
 * La respuesta es la misma —403— tanto si la empresa no existe como si existe y
 * el usuario no tiene rol en ella. Distinguirlas convertiría el endpoint en un
 * oráculo para enumerar la cartera de clientes del estudio.
 */
export async function requireCompany(request: FastifyRequest): Promise<RequestTenant> {
  if (request.tenant !== undefined) return request.tenant;

  const auth = requireAuth(request);
  const raw = request.headers['x-company-id'];
  const companyId = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
    throw forbidden('Falta la cabecera X-Company-Id o no es un identificador válido');
  }

  // La resolución corre CON la empresa en contexto, no sin ella.
  //
  // `user_company_roles` está bajo RLS por company_id: consultada sin contexto
  // devuelve cero filas siempre, y todo el mundo quedaría sin acceso a nada.
  // Fijar `app.company_id` en la empresa pedida no debilita nada — RLS acota por
  // empresa, no autoriza: si el usuario no tiene rol ahí, la consulta sigue
  // devolviendo vacío y el acceso se rechaza igual.
  const { permissions, roles } = await withCompany(
    { companyId, actorId: `user:${auth.user.userId}` },
    async (tx) => {
      const permissionRows = await tx.query<{ code: string }>(
        'SELECT code FROM user_permissions($1, $2)',
        [auth.user.userId, companyId],
      );
      const roleRows = await tx.query<{ code: string }>(
        `SELECT r.code
           FROM user_company_roles ucr
           JOIN roles r ON r.id = ucr.role_id
          WHERE ucr.user_id = $1 AND ucr.company_id = $2
            AND ucr.valid_from <= CURRENT_DATE
            AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)`,
        [auth.user.userId, companyId],
      );
      return {
        permissions: new Set(permissionRows.rows.map((row) => row.code)),
        roles: new Set(roleRows.rows.map((row) => row.code)),
      };
    },
  );

  // Sin ningún rol vigente, el usuario no tiene acceso a esa empresa.
  if (roles.size === 0) {
    throw forbidden('No tenés acceso a esta empresa');
  }

  // El segundo factor es una condición de acceso, no una preferencia: un contador
  // sin MFA no llega a la contabilidad aunque su contraseña sea correcta.
  if (!auth.user.mfaEnabled && [...roles].some((role) => ROLES_REQUIRING_MFA.has(role))) {
    throw new HttpError(
      403,
      'MFA_SETUP_REQUIRED',
      'Tu rol exige segundo factor. Configuralo en /auth/mfa/setup antes de continuar.',
    );
  }

  const tenant: RequestTenant = { companyId, permissions, roles };
  request.tenant = tenant;
  return tenant;
}

/** Deny by default: lo que no está concedido, no existe. */
export function requirePermission(tenant: RequestTenant, code: string): void {
  if (!tenant.permissions.has(code)) {
    throw forbidden(`Requiere el permiso ${code}`);
  }
}

export function actorOf(request: FastifyRequest): string {
  return `user:${requireAuth(request).user.userId}`;
}

export function clientIp(request: FastifyRequest): string | null {
  return config.recordIpInAudit ? request.ip : null;
}

export async function attachContext(request: FastifyRequest): Promise<void> {
  await loadSession(request);
}
