import { withoutCompany, type Tx } from '@aai/db';
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
import {
  badRequest,
  forbidden,
  invalidCredentials,
  tooManyRequests,
  unauthorized,
} from '../http/errors.js';
import { SinProveedorDeCorreo, encolar, type ResultadoDeEnvio } from '../correo/puerto.js';

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const codeSchema = z.object({ code: z.string().min(6).max(14) });

/**
 * El secreto TOTP guardado, o `null` si no se puede abrir.
 *
 * `decryptSecret` tira cuando el ciphertext no abre con la clave que hay:
 * después de rotar `MFA_ENCRYPTION_KEY`, con la fila corrupta, o —fuera de
 * producción— en cada reinicio, porque ahí la clave es efímera a propósito.
 *
 * Eso salía como **500 sin manejar**, y lo peor no era el código de estado: la
 * excepción cortaba el flujo antes del `UPDATE mfa_recovery_codes` de abajo,
 * así que el código de recuperación —que existe exactamente para cuando no se
 * puede generar un TOTP— quedaba inalcanzable justo en el caso que vino a
 * cubrir. Alguien con su clave rotada no tenía ninguna forma de entrar.
 *
 * Se devuelve `null` y se sigue. Al que llama se le contesta lo mismo que a un
 * código equivocado —no hay oráculo que distinga «clave mal» de «código mal»—,
 * pero en el log queda la causa real, que es una emergencia de operación y no
 * un intento fallido más. Es el mismo criterio que ya tenía `verifyPassword`
 * para un hash corrupto, aplicado donde faltaba.
 */
function secretoTotpDe(cifrado: string, log: { warn: (o: object, m: string) => void }): string | null {
  try {
    return decryptSecret(cifrado);
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'no se pudo descifrar el secreto TOTP: la clave de cifrado no corresponde al dato ' +
        'guardado. Fuera de producción es esperable tras reiniciar (clave efímera); en ' +
        'producción significa que MFA_ENCRYPTION_KEY cambió y hay que restaurarla',
    );
    return null;
  }
}

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

      // La contraseña es correcta y la cuenta está esperando que confirme el
      // correo. Se lo dice, y no se cuenta como intento fallido: no lo es.
      //
      // Decirlo revela que la cuenta existe, y está bien: para llegar acá hubo
      // que acertar la contraseña. La alternativa —el mismo error genérico—
      // dejaría a alguien probando su contraseña correcta una y otra vez hasta
      // bloquearse la cuenta, sin ninguna forma de enterarse de qué falta.
      if (passwordOk && user.status === 'PENDIENTE') {
        return { kind: 'pendiente' as const };
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
    if (outcome.kind === 'pendiente') {
      throw forbidden(
        // Sin la ruta de la API: el mensaje lo lee alguien que está mirando la
        // pantalla de ingreso, y ahí el botón se llama «No me llegó».
        'La cuenta existe y todavía no confirmaste tu correo. Buscá el mensaje de ' +
          'verificación, y si no aparece pedí uno nuevo con «No me llegó».',
      );
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

      const secreto = secretoTotpDe(encrypted, request.log);
      if (secreto !== null && verifyTotp(secreto, code, Date.now())) {
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
      const secreto = secretoTotpDe(encrypted, request.log);
      if (secreto === null) return false;
      if (!verifyTotp(secreto, code, Date.now())) return false;

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

  /**
   * Alta autoservicio.
   *
   * ## Contesta lo mismo exista o no la dirección
   *
   * Si contestara «ese correo ya está registrado», cualquiera podría averiguar
   * quién usa NEXO probando direcciones — que es exactamente lo que el login ya
   * evita desde S-10. Acá vale lo mismo y es más fácil de olvidar, porque la
   * respuesta «ya existe» parece un servicio al usuario.
   *
   * A cambio, quien ya tiene cuenta y se registra de nuevo recibe un mensaje que
   * dice «revisá tu correo» y no encuentra nada nuevo. Es el precio, y es más
   * barato que una lista de clientes.
   *
   * ## El usuario nace PENDIENTE
   *
   * No entra hasta confirmar. Sin eso, alguien podría registrarse con el correo
   * de otro y quedarse esperando a que esa persona intente entrar.
   *
   * ## Y el correo probablemente no salga
   *
   * No hay proveedor contratado: el mensaje queda en la bandeja de salida con
   * `SIN_PROVEEDOR`. La respuesta **lo dice**, en vez de afirmar que se mandó
   * algo que no se mandó.
   */
  app.post('/auth/signup', async (request) => {
    const body = z
      .object({
        email: z.string().email().max(320),
        // Mismo mínimo que el resto del sistema. La política de contraseñas es
        // de longitud y no de "complejidad" cosmética (SECURITY.md §2).
        password: z.string().min(12).max(1024),
        fullName: z.string().min(1).max(200),
      })
      .parse(request.body);

    const salida = await withoutCompany('system:alta', async (tx) => {
      const existente = await tx.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [body.email],
      );
      // Ya existe: no se toca nada y se contesta igual que si no existiera.
      if (existente.rows[0] !== undefined) return { enviado: null };

      const creado = await tx.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, status, created_by)
         VALUES ($1, $2, $3, 'PENDIENTE', 'autoservicio') RETURNING id`,
        [body.email, body.fullName, await hashPassword(body.password)],
      );

      const envio = await emitirVerificacion(
        tx,
        creado.rows[0]!.id,
        body.email,
        request.ip,
      );
      return { enviado: envio.estado };
    });

    return {
      // Nunca el id ni el token: el que se registra no necesita ninguno de los
      // dos, y devolverlos convertiría esta ruta en una forma de verificar
      // cuentas sin pasar por el correo.
      estado: 'REGISTRADO',
      mensaje:
        'Si la dirección no estaba registrada, te mandamos un mensaje para confirmarla.',
      correo:
        salida.enviado === 'ENVIADO'
          ? 'El mensaje de verificación salió.'
          : 'ATENCIÓN: no hay proveedor de correo configurado en esta instalación, así que ' +
            'el mensaje quedó en la bandeja de salida y no llegó a ningún lado. Hasta que se ' +
            'contrate uno, el alta la completa el operador.',
    };
  });

  /**
   * Confirma la dirección y activa la cuenta.
   *
   * El token se compara **por su hash**: lo que hay en la base no sirve para
   * verificar nada, así que una filtración de la tabla no es una filtración de
   * cuentas. Es lo mismo que se hace con la sesión desde S-11.
   */
  app.post('/auth/verificar-correo', async (request) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.body);

    const resultado = await withoutCompany('system:alta', async (tx) => {
      const fila = await tx.query<{ id: string; user_id: string; expira_el: Date }>(
        `SELECT id, user_id, expira_el FROM email_verifications
          WHERE token_hash = $1 AND proposito = 'ALTA' AND consumido_el IS NULL`,
        [hashToken(token)],
      );
      const v = fila.rows[0];
      if (v === undefined) return 'INVALIDO' as const;
      if (v.expira_el <= new Date()) return 'VENCIDO' as const;

      // Se consume antes de activar. Si el orden fuera al revés y algo fallara
      // en el medio, el token quedaría vivo sobre una cuenta ya activa.
      await tx.query('UPDATE email_verifications SET consumido_el = now() WHERE id = $1', [v.id]);
      await tx.query(
        `UPDATE users SET status = 'ACTIVE', updated_at = now()
          WHERE id = $1 AND status = 'PENDIENTE'`,
        [v.user_id],
      );
      return 'ACTIVADA' as const;
    });

    if (resultado === 'INVALIDO') {
      // Un solo mensaje para «no existe» y «ya se usó»: distinguirlos diría si
      // un token fue válido alguna vez.
      throw badRequest('El enlace no sirve: puede haberse usado ya o no ser el que mandamos.');
    }
    if (resultado === 'VENCIDO') {
      throw badRequest(
        'El código venció. Pedí uno nuevo con «No me llegó» — el anterior ' +
          'queda invalidado, para no tener dos vías abiertas hacia la misma cuenta.',
      );
    }

    return { estado: 'ACTIVADA', mensaje: 'Listo: ya podés entrar.' };
  });

  /**
   * Manda un token nuevo, e invalida el anterior.
   *
   * Que el anterior muera no es un detalle: dos tokens vivos duplican la
   * superficie por la que se puede tomar una cuenta, y el segundo se pide
   * justamente cuando el primero pudo haber ido a parar a otro lado.
   */
  app.post('/auth/reenviar-verificacion', async (request) => {
    const { email } = z.object({ email: z.string().email().max(320) }).parse(request.body);

    await withoutCompany('system:alta', async (tx) => {
      const fila = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM users WHERE lower(email) = lower($1)',
        [email],
      );
      const u = fila.rows[0];
      // Solo tiene sentido para una cuenta pendiente. Si no existe, o ya está
      // activa, no se hace nada — y se contesta lo mismo.
      if (u === undefined || u.status !== 'PENDIENTE') return;

      await tx.query(
        `UPDATE email_verifications SET consumido_el = now()
          WHERE user_id = $1 AND proposito = 'ALTA' AND consumido_el IS NULL`,
        [u.id],
      );
      await emitirVerificacion(tx, u.id, email, request.ip);
    });

    return {
      estado: 'PEDIDO',
      mensaje: 'Si esa dirección tenía un alta sin confirmar, te mandamos un mensaje nuevo.',
    };
  });
}

/**
 * Cuánto vive un enlace de verificación.
 *
 * Un día. Es un parámetro de seguridad y no una decisión comercial, así que
 * tiene valor por defecto: más corto echa a quien abre el correo al día
 * siguiente, más largo deja abierta una vía de entrada a una cuenta durante una
 * semana en la bandeja de alguien.
 */
const HORAS_DE_VIDA_DEL_ENLACE = 24;

/**
 * Crea el token, lo guarda hasheado y encola el mensaje.
 *
 * Devuelve qué pasó con el envío para que quien llama pueda decirlo. **El token
 * no se devuelve**: sale por el cuerpo del mensaje y por ningún otro lado.
 */
async function emitirVerificacion(
  tx: Tx,
  userId: string,
  email: string,
  ip: string,
): Promise<ResultadoDeEnvio> {
  const token = generateSessionToken();

  await tx.query(
    `INSERT INTO email_verifications
       (user_id, token_hash, proposito, expira_el, creado_desde)
     VALUES ($1, $2, 'ALTA', now() + ($3 || ' hours')::interval, $4)`,
    [userId, hashToken(token), String(HORAS_DE_VIDA_DEL_ENLACE), config.recordIpInAudit ? ip : null],
  );

  return encolar(tx, new SinProveedorDeCorreo(), {
    destinatario: email,
    asunto: 'Confirmá tu dirección para entrar a NEXO',
    // Escrito para la persona que lo recibe, no para quien programó el
    // endpoint. Decía «mandá este código a /auth/verificar-correo»: una ruta de
    // la API, como instrucción, a alguien que se acaba de registrar y no sabe
    // qué es una ruta. Lo encontró la auditoría del 2026-09-09 leyendo la
    // bandeja de salida.
    cuerpo:
      'Hola,\n\n' +
      'Te estás dando de alta en NEXO. Para terminar, copiá este código y pegalo ' +
      'en la pantalla de ingreso, donde dice «Ya tengo el código de confirmación»:\n\n' +
      `${token}\n\n` +
      `El código vence en ${HORAS_DE_VIDA_DEL_ENLACE} horas. Si no fuiste vos quien se ` +
      'registró, ignorá este mensaje: la cuenta no se activa sola.',
    tipo: 'VERIFICACION_DE_ALTA',
  });
}
