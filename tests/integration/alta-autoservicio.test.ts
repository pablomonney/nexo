/**
 * El alta autoservicio, y lo que la hace segura.
 *
 * Es la única ruta del sistema que crea usuarios **sin que nadie los autorice**,
 * así que lo que se prueba acá no es que ande: es que no sea una puerta abierta.
 *
 *   1. **Que no se pueda averiguar quién usa NEXO.** Registrarse con una
 *      dirección que ya existe contesta lo mismo que con una nueva.
 *   2. **Que el usuario no entre hasta confirmar.** Sin eso, alguien se registra
 *      con el correo de otro y espera.
 *   3. **Que el token no se devuelva por ningún lado.** Ni en la respuesta, ni
 *      en el error, ni en una consulta de la aplicación: sale por el cuerpo del
 *      mensaje y nada más.
 *   4. **Que la aplicación no pueda leer la bandeja de salida.** Es la
 *      propiedad central: el cuerpo lleva el token, y poder leerlo sería poder
 *      activar la cuenta de cualquiera.
 *   5. **Que el token sirva una sola vez** y que pedir uno nuevo mate al
 *      anterior.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { encolar } from '@aai/api/correo/puerto';
import { ProveedorDeResend } from '@aai/api/correo/resend';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('Alta autoservicio', () => {
  let app: FastifyInstance;
  let db: Client;
  let fx: Fixture;
  let stamp: string;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    fx = await seed(db, 'alta');
    stamp = await sufijoUnico(db);
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  const registrar = (email: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: PASSWORD, fullName: 'Quien se registra', ...extra },
    });

  /**
   * El token, leído como lo leería el operador: desde la bandeja, con la
   * conexión del operador. No hay otra forma de obtenerlo, y eso es el punto.
   */
  const tokenDeLaBandeja = async (email: string): Promise<string> => {
    const r = await db.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM email_outbox
        WHERE destinatario = $1 AND tipo = 'VERIFICACION_DE_ALTA'
        ORDER BY creado_el DESC LIMIT 1`,
      [email],
    );
    const m = /\n\n([A-Za-z0-9_-]{20,})\n/u.exec(r.rows[0]!.cuerpo);
    if (m === null) throw new Error('El mensaje no trae token');
    return m[1]!;
  };

  it('registra y avisa que el correo no salió', async () => {
    const email = `nuevo-${stamp}@estudio.test`;
    const r = await registrar(email);
    expect(r.statusCode, r.body).toBe(200);

    const cuerpo = r.json<{ estado: string; mensaje: string; correo: string }>();
    expect(cuerpo.estado).toBe('REGISTRADO');
    // No se afirma que se mandó algo que no se mandó.
    expect(cuerpo.correo).toContain('no hay proveedor de correo');

    const u = await db.query<{ status: string }>(
      'SELECT status FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    expect(u.rows[0]!.status).toBe('PENDIENTE');
  });

  it('la respuesta no trae el token ni el id del usuario', async () => {
    // Devolver cualquiera de los dos convertiría esta ruta en una forma de
    // verificar cuentas sin pasar por el correo.
    const email = `sin-token-${stamp}@estudio.test`;
    const r = await registrar(email);
    const token = await tokenDeLaBandeja(email);

    expect(r.body).not.toContain(token);
    expect(r.json<Record<string, unknown>>()).not.toHaveProperty('id');
  });

  it('registrarse con una dirección que ya existe contesta lo mismo', async () => {
    // Si contestara «ese correo ya está registrado», cualquiera podría averiguar
    // quién usa NEXO probando direcciones.
    const email = `repetido-${stamp}@estudio.test`;
    const primera = await registrar(email);
    const segunda = await registrar(email, { fullName: 'Otro nombre' });

    expect(segunda.statusCode).toBe(primera.statusCode);
    expect(segunda.json<{ mensaje: string }>().mensaje).toBe(
      primera.json<{ mensaje: string }>().mensaje,
    );

    // Y no se pisó nada: sigue habiendo un solo usuario, con el nombre original.
    const u = await db.query<{ n: string; full_name: string }>(
      `SELECT count(*)::text AS n, min(full_name) AS full_name FROM users
        WHERE lower(email) = lower($1)`,
      [email],
    );
    expect(u.rows[0]!.n).toBe('1');
    expect(u.rows[0]!.full_name).toBe('Quien se registra');
  });

  it('sin confirmar no entra, y el sistema dice qué falta', async () => {
    const email = `pendiente-${stamp}@estudio.test`;
    await registrar(email);

    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    // 403 y no 401: la contraseña era correcta. Contestar «credenciales
    // inválidas» dejaría a alguien probando su contraseña correcta hasta
    // bloquearse la cuenta.
    expect(r.statusCode, r.body).toBe(403);
    expect(r.body).toContain('confirmaste tu correo');
  });

  it('con la contraseña equivocada contesta lo genérico de siempre', async () => {
    // La distinción anterior solo aparece cuando se acertó la contraseña. Si
    // apareciera igual, sería una forma de enumerar cuentas.
    const email = `pendiente-${stamp}@estudio.test`;
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'otra-contrasena-larga-cualquiera' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain('confirmaste');
  });

  it('con el token, la cuenta se activa y entra', async () => {
    const email = `activable-${stamp}@estudio.test`;
    await registrar(email);
    const token = await tokenDeLaBandeja(email);

    const v = await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token },
    });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json<{ estado: string }>().estado).toBe('ACTIVADA');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
  });

  it('el token sirve una sola vez', async () => {
    const email = `una-vez-${stamp}@estudio.test`;
    await registrar(email);
    const token = await tokenDeLaBandeja(email);

    expect(
      (await app.inject({ method: 'POST', url: '/auth/verificar-correo', payload: { token } }))
        .statusCode,
    ).toBe(200);

    const segunda = await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token },
    });
    expect(segunda.statusCode).toBe(400);
    // Un solo mensaje para «no existe» y «ya se usó»: distinguirlos diría si un
    // token fue válido alguna vez.
    expect(segunda.body).toContain('puede haberse usado ya o no ser el que mandamos');
  });

  it('un token inventado da el mismo error que uno gastado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token: 'TEST_TOKEN_INEXISTENTE_PERO_LARGO_SUFICIENTE' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('puede haberse usado ya o no ser el que mandamos');
  });

  it('pedir uno nuevo invalida el anterior', async () => {
    // Dos tokens vivos duplican la superficie por la que se puede tomar una
    // cuenta, y el segundo se pide justamente cuando el primero pudo haber ido
    // a parar a otro lado.
    const email = `reenvio-${stamp}@estudio.test`;
    await registrar(email);
    const viejo = await tokenDeLaBandeja(email);

    const reenvio = await app.inject({
      method: 'POST',
      url: '/auth/reenviar-verificacion',
      payload: { email },
    });
    expect(reenvio.statusCode, reenvio.body).toBe(200);

    const nuevo = await tokenDeLaBandeja(email);
    expect(nuevo).not.toBe(viejo);

    const conElViejo = await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token: viejo },
    });
    expect(conElViejo.statusCode).toBe(400);

    const conElNuevo = await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token: nuevo },
    });
    expect(conElNuevo.statusCode, conElNuevo.body).toBe(200);
  });

  it('reenviar a una dirección que no existe contesta lo mismo', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/reenviar-verificacion',
      payload: { email: `no-existe-${stamp}@estudio.test` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ estado: string }>().estado).toBe('PEDIDO');
  });

  it('el token se guarda hasheado: buscarlo en claro no da nada', async () => {
    // Igual que la sesión (S-11): una filtración de la tabla no es una
    // filtración de cuentas.
    const email = `hasheado-${stamp}@estudio.test`;
    await registrar(email);
    const token = await tokenDeLaBandeja(email);

    const r = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM email_verifications WHERE token_hash = $1',
      [token],
    );
    expect(r.rows[0]!.n).toBe('0');
  });

  it('la aplicación no puede leer la bandeja de salida', async () => {
    // Es la propiedad central de este archivo. El cuerpo lleva el token: una
    // ruta que pudiera leer la bandeja podría activar la cuenta de cualquiera.
    const fallo = await asCompany(db, fx.companyA, async () => {
      try {
        await db.query('SELECT cuerpo FROM email_outbox LIMIT 1');
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? '';
      }
    }).catch((error: { code?: string }) => error.code ?? '');

    // 42501 — insufficient_privilege.
    expect(fallo).toBe('42501');
  });

  it('la aplicación sí puede encolar: un revoke de más rompería el alta', async () => {
    // El control positivo. Sin él, este archivo daría verde con `REVOKE ALL`, y
    // el alta fallaría con un 500 en producción.
    const encolado = await asCompany(db, fx.companyA, async () => {
      await db.query(
        `INSERT INTO email_outbox (destinatario, asunto, cuerpo, tipo, estado, detalle)
         VALUES ($1, 'prueba', 'cuerpo de prueba', 'AVISO', 'SIN_PROVEEDOR', 'test')`,
        [`encolable-${stamp}@estudio.test`],
      );
      return true;
    });
    expect(encolado).toBe(true);
  });

  /**
   * Con un proveedor conectado, `email_outbox` tiene que seguir contestando las
   * mismas preguntas.
   *
   * Antes de B2.5.1 no había proveedor, así que la mitad de las columnas de la
   * tabla —`proveedor`, `referencia_externa`, `enviado_el`, `intentos`— nunca
   * se habían escrito con un valor de verdad. Estos casos las ejercitan con el
   * adaptador real y un `fetch` falso: sin ellos, el primer envío en producción
   * sería la primera vez que ese `INSERT` corre con `estado = 'ENVIADO'`, y el
   * `CHECK outbox_enviado_con_fecha` de la 0103 es exactamente la clase de cosa
   * que se descubre ahí.
   *
   * **Ninguna llamada sale a la red.** Se inyecta el `fetch`.
   */
  describe('la bandeja con un proveedor conectado', () => {
    const CLAVE_SINTETICA = 're_TEST_SECRET_ONLY_no_es_una_credencial';

    /** Encola con un Resend de mentira que contesta lo que se le pida. */
    const encolarConResend = async (
      email: string,
      respuesta: { status: number; cuerpo: string },
      maxRetries = 0,
    ) => {
      const proveedor = new ProveedorDeResend({
        apiKey: async () => CLAVE_SINTETICA,
        from: 'NEXO <hola@ejemplo.invalid>',
        timeoutMs: 1_000,
        maxRetries,
        esperar: async () => undefined,
        fetch: async () => ({
          ok: respuesta.status >= 200 && respuesta.status < 300,
          status: respuesta.status,
          text: async () => respuesta.cuerpo,
        }),
      });

      return asCompany(db, fx.companyA, () =>
        encolar({ query: (t: string, v?: readonly unknown[]) => db.query(t, v as unknown[]) }, proveedor, {
          destinatario: email,
          asunto: 'Confirmá tu dirección para entrar a NEXO',
          cuerpo: 'Hola,\n\nTOKEN_DE_PRUEBA_9f3c1a7e5b2d4008\n\nVence en 24 horas.',
          tipo: 'VERIFICACION_DE_ALTA',
        }),
      );
    };

    const filaDe = async (email: string) => {
      const r = await db.query<{
        estado: string;
        proveedor: string | null;
        referencia_externa: string | null;
        detalle: string | null;
        intentos: number;
        enviado_el: Date | null;
      }>(
        `SELECT estado, proveedor, referencia_externa, detalle, intentos, enviado_el
           FROM email_outbox WHERE destinatario = $1 ORDER BY creado_el DESC LIMIT 1`,
        [email],
      );
      return r.rows[0]!;
    };

    it('un envío aceptado queda con proveedor, referencia y fecha', async () => {
      const email = `resend-ok-${stamp}@prueba.local`;
      const r = await encolarConResend(email, {
        status: 200,
        cuerpo: JSON.stringify({ id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c' }),
      });
      expect(r.estado).toBe('ENVIADO');

      const fila = await filaDe(email);
      expect(fila.estado).toBe('ENVIADO');
      expect(fila.proveedor).toBe('resend');
      // Es lo que permite ir a buscar el mensaje al proveedor el día que
      // alguien diga que no le llegó.
      expect(fila.referencia_externa).toBe('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
      expect(fila.enviado_el).not.toBeNull();
      expect(fila.detalle).toBeNull();
      expect(fila.intentos).toBe(1);
    });

    it('un rechazo queda con el motivo y sin referencia', async () => {
      const email = `resend-mal-${stamp}@prueba.local`;
      const r = await encolarConResend(email, {
        status: 422,
        cuerpo: JSON.stringify({ message: 'The from address is not verified' }),
      });
      expect(r.estado).toBe('FALLIDO');

      const fila = await filaDe(email);
      expect(fila.estado).toBe('FALLIDO');
      // El CHECK `outbox_fallo_con_detalle` exige motivo: un fallo sin motivo
      // no se puede diagnosticar una semana después.
      expect(fila.detalle).toContain('MENSAJE_RECHAZADO');
      expect(fila.referencia_externa).toBeNull();
      expect(fila.enviado_el).toBeNull();
      // Y el proveedor queda igual: se sabe quién lo rechazó.
      expect(fila.proveedor).toBe('resend');
    });

    it('los reintentos quedan contados en la bandeja', async () => {
      // `intentos` decía 1 fijo. Con un adaptador que reintenta un 429, esa
      // columna mentía: quien la mirara no vería que el proveedor estuvo caído.
      const email = `resend-reintentos-${stamp}@prueba.local`;
      await encolarConResend(email, { status: 503, cuerpo: '{}' }, 2);
      const fila = await filaDe(email);
      expect(fila.intentos).toBe(3);
      expect(fila.detalle).toContain('PROVEEDOR_CAIDO');
    });

    it('el token no llega al detalle, aunque el cuerpo sí se guarde', async () => {
      // El cuerpo se guarda entero **a propósito**: es lo que el operador lee.
      // Lo que no puede pasar es que el token se copie también al `detalle`,
      // que es el campo que termina en un tablero o en un log.
      const email = `resend-token-${stamp}@prueba.local`;
      await encolarConResend(email, { status: 500, cuerpo: 'no es json' });
      const fila = await filaDe(email);
      expect(fila.detalle).not.toContain('TOKEN_DE_PRUEBA_9f3c1a7e5b2d4008');
    });
  });
});
