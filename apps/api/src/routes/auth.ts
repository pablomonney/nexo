import { withoutCompany } from '@aai/db';
import { generateSecret, otpauthUri, verifyTotp } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../auth/crypto.js';
import { requireAuth } from '../http/context.js';
import { badRequest, invalidCredentials, tooManyRequests, unauthorized } from '../http/errors.js';

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const codeSchema = z.object({ code: z.string().min(6).max(14) });

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  status: string;
  mfa_enabled: boolean;
  mfa_secret_encrypted: string | null;
  failed_login_count: number;
  locked_until: Date | null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const outcome = await withoutCompany('system:auth', async (tx) => {
      const found = await tx.query<UserRow>(
        `SELECT id, email, full_name, password_hash, status, mfa_enabled,
                mfa_secret_encrypted, failed_login_count, locked_until
           FROM users WHERE lower(email) = lower($1)`,
        [body.email],
      );
      const user = found.rows[0];

      // Se verifica siempre contra un hash, exista o no el usuario: si sólo se
      // hiciera cuando existe, el tiempo de respuesta revelaría qué cuentas hay.
      const stored =
        user?.password_hash ??
        '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000';
      const passwordOk = await verifyPassword(stored, body.password);

      if (user === undefined) return { kind: 'invalid' as const };

      if (user.locked_until !== null && user.locked_until > new Date()) {
        return { kind: 'locked' as const, until: user.locked_until };
      }

      if (!passwordOk || user.status !== 'ACTIVE') {
        const attempts = user.failed_login_count + 1;
        const shouldLock = attempts >= config.login.maxFailedAttempts;
        await tx.query(
          `UPDATE users
              SET failed_login_count = $2,
                  locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
            WHERE id = $1`,
          [user.id, shouldLock ? 0 : attempts, shouldLock, String(config.login.lockMinutes)],
        );
        return { kind: 'invalid' as const };
      }

      await tx.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [
        user.id,
      ]);

      const token = generateSessionToken();
      const session = await tx.query<{ id: string }>(
        `INSERT INTO sessions
           (user_id, token_hash, ip, user_agent, expires_at, absolute_expires_at, mfa_satisfied)
         VALUES ($1, $2, $3, $4,
                 now() + ($5 || ' minutes')::interval,
                 now() + ($6 || ' hours')::interval,
                 $7)
         RETURNING id`,
        [
          user.id,
          hashToken(token),
          config.recordIpInAudit ? request.ip : null,
          request.headers['user-agent'] ?? null,
          String(config.session.idleMinutes),
          String(config.session.absoluteHours),
          !user.mfa_enabled,
        ],
      );

      const companies = await tx.query<{ id: string; legal_name: string; role: string }>(
        `SELECT DISTINCT c.id, c.legal_name, r.code AS role
           FROM user_company_roles ucr
           JOIN companies c ON c.id = ucr.company_id
           JOIN roles r ON r.id = ucr.role_id
          WHERE ucr.user_id = $1
            AND ucr.valid_from <= CURRENT_DATE
            AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)
          ORDER BY c.legal_name`,
        [user.id],
      );

      return {
        kind: 'ok' as const,
        token,
        sessionId: session.rows[0]!.id,
        mfaRequired: user.mfa_enabled,
        companies: companies.rows,
      };
    });

    if (outcome.kind === 'locked') {
      throw tooManyRequests('Cuenta bloqueada temporalmente por intentos fallidos');
    }
    if (outcome.kind === 'invalid') {
      throw invalidCredentials();
    }

    reply.setCookie(config.session.cookieName, outcome.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.isProduction,
      path: '/',
      maxAge: config.session.absoluteHours * 3600,
    });

    return {
      // El token también se devuelve en el cuerpo para clientes no-browser.
      token: outcome.token,
      mfaRequired: outcome.mfaRequired,
      companies: outcome.companies,
    };
  });

  app.post('/auth/mfa/verify', async (request) => {
    if (request.auth === undefined) throw unauthorized();
    const { code } = codeSchema.parse(request.body);
    const { session, user } = request.auth;

    const ok = await withoutCompany(`user:${user.userId}`, async (tx) => {
      const found = await tx.query<{ mfa_secret_encrypted: string | null }>(
        'SELECT mfa_secret_encrypted FROM users WHERE id = $1',
        [user.userId],
      );
      const encrypted = found.rows[0]?.mfa_secret_encrypted;
      if (encrypted == null) return false;

      if (verifyTotp(decryptSecret(encrypted), code, Date.now())) {
        await tx.query('UPDATE sessions SET mfa_satisfied = true WHERE id = $1', [session.id]);
        return true;
      }

      // Código de recuperación: válido una sola vez.
      const used = await tx.query(
        `UPDATE mfa_recovery_codes SET used_at = now()
          WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
          RETURNING id`,
        [user.userId, hashToken(code.toUpperCase())],
      );
      if (used.rowCount === 1) {
        await tx.query('UPDATE sessions SET mfa_satisfied = true WHERE id = $1', [session.id]);
        return true;
      }
      return false;
    });

    if (!ok) throw invalidCredentials();
    return { mfaSatisfied: true };
  });

  app.post('/auth/mfa/setup', async (request) => {
    if (request.auth === undefined) throw unauthorized();
    const { user } = request.auth;
    if (user.mfaEnabled) {
      throw badRequest('El segundo factor ya está configurado. Deshabilitalo antes de rehacerlo.');
    }

    const secret = generateSecret();
    const recoveryCodes = generateRecoveryCodes();

    await withoutCompany(`user:${user.userId}`, async (tx) => {
      await tx.query(
        'UPDATE users SET mfa_secret_encrypted = $2, mfa_confirmed_at = NULL WHERE id = $1',
        [user.userId, encryptSecret(secret)],
      );
      for (const code of recoveryCodes) {
        await tx.query(
          `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
          [user.userId, hashToken(code)],
        );
      }
    });

    // Única vez que estos valores salen del servidor en claro.
    return {
      secret,
      otpauthUri: otpauthUri({ secret, accountName: user.email, issuer: config.issuer }),
      recoveryCodes,
    };
  });

  app.post('/auth/mfa/confirm', async (request) => {
    if (request.auth === undefined) throw unauthorized();
    const { code } = codeSchema.parse(request.body);
    const { user, session } = request.auth;

    const ok = await withoutCompany(`user:${user.userId}`, async (tx) => {
      const found = await tx.query<{ mfa_secret_encrypted: string | null }>(
        'SELECT mfa_secret_encrypted FROM users WHERE id = $1',
        [user.userId],
      );
      const encrypted = found.rows[0]?.mfa_secret_encrypted;
      if (encrypted == null) return false;
      if (!verifyTotp(decryptSecret(encrypted), code, Date.now())) return false;

      await tx.query(
        'UPDATE users SET mfa_enabled = true, mfa_confirmed_at = now() WHERE id = $1',
        [user.userId],
      );
      await tx.query('UPDATE sessions SET mfa_satisfied = true WHERE id = $1', [session.id]);
      return true;
    });

    if (!ok) throw invalidCredentials();
    return { mfaEnabled: true };
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.auth !== undefined) {
      const { session, user } = request.auth;
      await withoutCompany(`user:${user.userId}`, (tx) =>
        tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [session.id]),
      );
    }
    reply.clearCookie(config.session.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const auth = requireAuth(request);
    const companies = await withoutCompany(`user:${auth.user.userId}`, async (tx) => {
      const result = await tx.query<{ id: string; legal_name: string; cuit: string; role: string }>(
        `SELECT DISTINCT c.id, c.legal_name, c.cuit, r.code AS role
           FROM user_company_roles ucr
           JOIN companies c ON c.id = ucr.company_id
           JOIN roles r ON r.id = ucr.role_id
          WHERE ucr.user_id = $1
            AND ucr.valid_from <= CURRENT_DATE
            AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)
          ORDER BY c.legal_name`,
        [auth.user.userId],
      );
      return result.rows;
    });

    return {
      user: {
        id: auth.user.userId,
        email: auth.user.email,
        fullName: auth.user.fullName,
        mfaEnabled: auth.user.mfaEnabled,
      },
      companies,
    };
  });

  /** Alta de usuario del estudio. Sin sesión solo se permite si no hay ninguno. */
  app.post('/auth/register-first-admin', async (request) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(12),
        fullName: z.string().min(1).max(200),
      })
      .parse(request.body);

    const created = await withoutCompany('system:bootstrap', async (tx) => {
      const existing = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
      if (existing.rows[0]!.n !== '0') return undefined;
      const result = await tx.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [body.email, body.fullName, await hashPassword(body.password)],
      );
      return result.rows[0]!.id;
    });

    if (created === undefined) {
      throw badRequest('Ya existe al menos un usuario: usá el alta desde el estudio.');
    }
    return { id: created };
  });
}
