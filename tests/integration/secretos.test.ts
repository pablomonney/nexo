/**
 * Las referencias de secretos, por HTTP y contra la base.
 *
 * Lo que este archivo defiende, en orden de gravedad si fallara:
 *
 *   1. **Que una empresa no lea el secreto de otra.** Es la falla más cara del
 *      módulo, y por eso se prueba contra las tres capas: el RLS, el contexto y
 *      la comprobación explícita.
 *   2. **Que el valor no se guarde.** No hay columna donde ponerlo, y el test lo
 *      comprueba mirando el esquema — no confiando en que nadie la agregue.
 *   3. **Que la API no lo devuelva.** Tampoco puede: no lo tiene.
 *   4. **Que rotar no corte.** La versión anterior sigue existiendo hasta que se
 *      la revoca.
 *
 * Los valores de prueba se llaman `TEST_SECRET_ONLY` a propósito: un secreto de
 * test que se pueda confundir con uno real es un secreto real esperando a que
 * alguien lo copie.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import { EnvSecretProvider, ErrorDeSecreto } from '@aai/secrets';
import { DbSecretProvider } from '@aai/api/secrets/proveedor';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

/** Una referencia, no un secreto. Aun así se nombra para que se note. */
const REFERENCIA = 'kms:TEST_SECRET_ONLY/arca/clave-privada';

suite('Referencias de secretos', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp = '';

  /** Dos empresas de dos estudios distintos: el aislamiento se prueba de verdad. */
  let empresaA = '';
  let empresaB = '';
  let tokenA = '';
  let tokenB = '';
  /** Un CONTADOR de A: puede usar integraciones y **no** administrarlas. */
  let tokenContadoraA = '';

  const pedir = async (
    metodo: 'GET' | 'POST',
    url: string,
    token: string,
    companyId: string,
    cuerpo?: unknown,
  ) =>
    app.inject({
      method: metodo,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
      ...(cuerpo === undefined ? {} : { payload: cuerpo }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    /** Un estudio con su empresa y un administrador con MFA resuelto. */
    const montar = async (
      etiqueta: string,
      sufijo: string,
      rol: string,
    ): Promise<{ empresa: string; token: string }> => {
      const correo = `admin-${etiqueta}-${sufijo}@estudio.test`;
      const fundadorId = (
        await db.query<{ id: string }>(
          'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
          [correo, etiqueta, clave],
        )
      ).rows[0]!.id;

      const org = (
        await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
          `Estudio ${etiqueta} ${sufijo}`,
          withCheckDigit(`30${sufijo}`),
          fundadorId,
        ])
      ).rows[0]!.create_organization;

      const empresa = (
        await db.query<{ create_company: string }>(
          'SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            fundadorId,
            org,
            `Empresa ${etiqueta} ${sufijo}`,
            withCheckDigit(`27${sufijo}`),
            'SA',
            'AR-C',
            'IGJ',
            '12-31',
          ],
        )
      ).rows[0]!.create_company;

      const tokenFundador = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: correo, password: PASSWORD },
        })
      ).json<{ token: string }>().token;

      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId: fundadorId, role: rol },
      });

      // ADMINISTRADOR y CONTADOR exigen segundo factor.
      const secret = (
        await app.inject({
          method: 'POST',
          url: '/auth/mfa/setup',
          headers: { authorization: `Bearer ${tokenFundador}` },
        })
      ).json<{ secret: string }>().secret;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/confirm',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${tokenFundador}` },
      });
      const token = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: correo, password: PASSWORD },
        })
      ).json<{ token: string }>().token;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${token}` },
      });

      return { empresa, token };
    };

    const a = await montar('a', stamp, 'ADMINISTRADOR');
    empresaA = a.empresa;
    tokenA = a.token;

    const stampB = await sufijoUnico(db);
    const b = await montar('b', stampB, 'ADMINISTRADOR');
    empresaB = b.empresa;
    tokenB = b.token;

    // Una contadora **de la empresa A**, no de otra.
    //
    // La primera versión de este test montaba una contadora en su propia
    // empresa y le pedía los secretos de A sin `x-company-id`: el 400 venía por
    // falta de empresa en contexto, no por permiso, y el test pasaba con el
    // permiso sacado. Un test que se cumple por el motivo equivocado es peor
    // que no tenerlo — lo detectó una mutación deliberada.
    const correoContadora = `contadora-a-${stamp}@estudio.test`;
    const contadoraId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [correoContadora, 'Contadora de A', clave],
      )
    ).rows[0]!.id;

    await db.query(
      `INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from)
       SELECT $1, $2, r.id, CURRENT_DATE FROM roles r WHERE r.code = 'CONTADOR'`,
      [contadoraId, empresaA],
    );

    const inicialC = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: correoContadora, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    const secretC = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicialC}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secretC, Date.now()) },
      headers: { authorization: `Bearer ${inicialC}` },
    });
    tokenContadoraA = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: correoContadora, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secretC, Date.now()) },
      headers: { authorization: `Bearer ${tokenContadoraA}` },
    });
  }, 240_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await closePool();
  });

  describe('la tabla no tiene dónde guardar un secreto', () => {
    it('ninguna columna admite material', async () => {
      // Se mira el **esquema**, no el código: una columna nueva llamada
      // `value` la agregaría alguien con buena intención, y este test la
      // encuentra antes de que nadie la escriba.
      const r = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'secret_refs'`,
      );
      const columnas = r.rows.map((f) => f.column_name);

      for (const prohibida of [
        'value',
        'valor',
        'secret',
        'secreto',
        'material',
        'plaintext',
        'encrypted',
        'api_key',
        'token',
        'password',
        'private_key',
      ]) {
        expect(columnas, `secret_refs no puede tener ${prohibida}`).not.toContain(prohibida);
      }

      // Y sí tiene la referencia, que no es sensible.
      expect(columnas).toContain('reference');
    });
  });

  describe('declarar y rotar', () => {
    it('declara la primera versión', async () => {
      const r = await pedir('POST', '/companies/current/secrets', tokenA, empresaA, {
        scope: 'arca',
        name: 'clave-privada',
        referencia: REFERENCIA,
        motivo: 'Alta del certificado de homologación de esta empresa.',
      });

      expect(r.statusCode, r.body).toBe(201);
      const v = r.json<{ version: number; backend: string; alcance: string }>();
      expect(v.version).toBe(1);
      expect(v.backend).toBe('kms');
      expect(v.alcance).toContain('la referencia, no el valor');
    });

    it('rotar es declarar la siguiente, y la anterior no se pierde', async () => {
      const r = await pedir('POST', '/companies/current/secrets', tokenA, empresaA, {
        scope: 'arca',
        name: 'clave-privada',
        referencia: `${REFERENCIA}-v2`,
        motivo: 'Rotación programada: el certificado anterior vence el mes que viene.',
      });

      expect(r.statusCode, r.body).toBe(201);
      expect(r.json<{ version: number }>().version).toBe(2);

      // La anterior sigue existiendo, supersedida. Esa ventana es lo que
      // permite comprobar la nueva antes de apagar la vieja.
      const lista = await pedir('GET', '/companies/current/secrets', tokenA, empresaA);
      const secretos = lista.json<{ secretos: { version: number; estado: string }[] }>().secretos;

      expect(secretos.find((s) => s.version === 1)!.estado).toBe('SUPERSEDIDO');
      expect(secretos.find((s) => s.version === 2)!.estado).toBe('ACTIVO');
    });

    it('la base no admite dos versiones activas a la vez', async () => {
      // Dos vigentes dejarían al resolvedor eligiendo, y la elección sería por
      // orden de inserción: es decir, por azar.
      const activas = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM secret_refs
          WHERE company_id = $1 AND scope = 'arca' AND name = 'clave-privada'
            AND status = 'ACTIVO'`,
        [empresaA],
      );
      expect(activas.rows[0]!.n).toBe('1');
    });

    it('rechaza una referencia sin backend', async () => {
      // Una referencia sin prefijo no dice quién tiene el secreto, y el
      // resolvedor tendría que adivinar.
      const r = await pedir('POST', '/companies/current/secrets', tokenA, empresaA, {
        scope: 'pagos',
        name: 'api-key',
        referencia: 'TEST_SECRET_ONLY-sin-prefijo',
        motivo: 'Debería rebotar por falta de backend.',
      });
      expect(r.statusCode, r.body).toBe(400);
    });
  });

  describe('resolver después de rotar', () => {
    /**
     * Un entorno falso: dos variables, la vieja y la nueva.
     *
     * Se inyecta en vez de tocar `process.env` para que el test no dependa del
     * proceso ni deje residuo. Es el mismo criterio del `fetch` inyectable del
     * adaptador HTTP.
     */
    const entorno = new EnvSecretProvider({
      TEST_SECRET_ONLY_VIEJA: 'TEST_SECRET_ONLY-la-vieja',
      TEST_SECRET_ONLY_NUEVA: 'TEST_SECRET_ONLY-la-nueva',
    });

    it('después de rotar se usa la nueva, no la vieja', async () => {
      // Es la propiedad que hace que rotar sirva. Si el resolvedor se quedara
      // con la primera versión, rotar sería declarar algo que nadie usa — y
      // nadie lo notaría hasta que revocaran la vieja.
      const proveedor = new DbSecretProvider('test:rotacion', entorno);
      const ref = { companyId: empresaA, scope: 'pagos', name: 'llave' };

      await proveedor.put(ref, 'env:TEST_SECRET_ONLY_VIEJA', {
        actorId: 'test:rotacion',
        motivo: 'Alta inicial de la credencial de la pasarela.',
      });
      expect((await proveedor.get(ref)).valor).toBe('TEST_SECRET_ONLY-la-vieja');

      await proveedor.put(ref, 'env:TEST_SECRET_ONLY_NUEVA', {
        actorId: 'test:rotacion',
        motivo: 'Rotación: la pasarela emitió una credencial nueva.',
      });

      const despues = await proveedor.get(ref);
      expect(despues.valor, 'después de rotar se usa la nueva').toBe('TEST_SECRET_ONLY-la-nueva');
      expect(despues.version).toBe(2);
    });

    it('la versión anterior sigue siendo resoluble hasta que se la revoque', async () => {
      // Esa ventana es la que permite comprobar la nueva antes de apagar la
      // vieja. Sin ella, rotar sería un salto sin red.
      const proveedor = new DbSecretProvider('test:rotacion', entorno);
      const vieja = await proveedor.get({
        companyId: empresaA,
        scope: 'pagos',
        name: 'llave',
        version: 1,
      });
      expect(vieja.valor).toBe('TEST_SECRET_ONLY-la-vieja');
    });

    it('revocada, deja de resolverse', async () => {
      const proveedor = new DbSecretProvider('test:rotacion', entorno);
      const ref = { companyId: empresaA, scope: 'pagos', name: 'llave', version: 1 };

      await proveedor.revocar(ref, {
        actorId: 'test:rotacion',
        motivo: 'La pasarela dio de baja la credencial anterior.',
      });

      const error = await proveedor.get(ref).catch((e: unknown) => e as ErrorDeSecreto);
      expect(error).toBeInstanceOf(ErrorDeSecreto);
      expect((error as ErrorDeSecreto).codigo).toBe('SECRET_NOT_FOUND');
    });

    it('una referencia a un gestor externo dice que no hay ninguno conectado', async () => {
      // Es el estado honesto de hoy: la arquitectura acepta la referencia y el
      // gestor no existe. Contestar `SECRET_NOT_FOUND` haría creer que falta
      // declararla.
      const proveedor = new DbSecretProvider('test:rotacion', entorno);
      const error = await proveedor
        .get({ companyId: empresaA, scope: 'arca', name: 'clave-privada' })
        .catch((e: unknown) => e as ErrorDeSecreto);

      expect((error as ErrorDeSecreto).codigo).toBe('SECRET_PROVIDER_UNAVAILABLE');
      expect((error as Error).message).toContain('no hay ninguno conectado');
    });
  });

  describe('la API nunca devuelve un secreto', () => {
    it('el listado trae metadata y nada más', async () => {
      const r = await pedir('GET', '/companies/current/secrets', tokenA, empresaA);
      expect(r.statusCode, r.body).toBe(200);

      // Ni la referencia completa: solo su prefijo. Un ARN dice de más sobre la
      // infraestructura y no aporta a ninguna decisión de pantalla.
      expect(r.body).not.toContain('TEST_SECRET_ONLY');
      expect(r.body).toContain('"backend":"kms"');

      const v = r.json<{ secretos: Record<string, unknown>[] }>();
      for (const s of v.secretos) {
        for (const prohibido of ['valor', 'value', 'secret', 'referencia', 'reference']) {
          expect(Object.keys(s), `el listado no puede traer ${prohibido}`).not.toContain(prohibido);
        }
      }
    });
  });

  describe('aislamiento entre empresas', () => {
    it('B no ve los secretos de A', async () => {
      const r = await pedir('GET', '/companies/current/secrets', tokenB, empresaB);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ secretos: unknown[] }>().secretos).toEqual([]);
    });

    it('A no puede pedir los secretos usando el id de empresa de B', async () => {
      // No tiene rol en B: el 403 lo pone el contexto, antes de que la consulta
      // llegue a la base.
      const r = await pedir('GET', '/companies/current/secrets', tokenA, empresaB);
      expect(r.statusCode).toBe(403);
    });

    it('el RLS no devuelve la fila de A con la empresa de B en contexto', async () => {
      // La capa de abajo, probada directamente contra la base: aunque el código
      // pidiera la fila de otra empresa, no la recibe.
      //
      // `asCompany` hace `SET LOCAL ROLE aai_app` además de fijar la empresa, y
      // eso no es un detalle: la conexión de los tests es **la dueña de la
      // tabla**, y sin cambiar de rol el `FORCE` no se ejercita. Un test que se
      // olvidara de eso vería las filas de todas las empresas y pasaría igual,
      // porque estaría comprobando que el `WHERE` funciona.
      const deB = await asCompany(db, empresaB, async () =>
        db.query<{ id: string }>('SELECT id FROM secret_refs WHERE company_id = $1', [empresaA]),
      );
      expect(deB.rowCount, 'el RLS tiene que tapar la fila de A').toBe(0);

      // Y con su propia empresa en contexto sí las ve: si no, este test estaría
      // pasando porque la consulta no devuelve nada nunca.
      const deA = await asCompany(db, empresaA, async () =>
        db.query<{ id: string }>('SELECT id FROM secret_refs WHERE company_id = $1', [empresaA]),
      );
      expect(deA.rowCount, 'con su empresa en contexto, A sí las ve').toBeGreaterThan(0);
    });
  });

  describe('la defensa en profundidad, ejercitada de verdad', () => {
    /**
     * Una capa que nunca se vio actuar no está probada — el mismo argumento que
     * hace S-8 con el lint de arquitectura, que introduce una violación real
     * para comprobar que el build se cae.
     *
     * Con todo en su lugar, el RLS nunca se ve trabajar: el `WHERE` de la
     * consulta ya filtra por empresa. Así que este test **afloja la política a
     * propósito** y comprueba que el aislamiento aguanta igual.
     *
     * Es también lo que demostró que una cuarta «capa» que había acá —comparar
     * la empresa de la fila contra la pedida— era inalcanzable: se quitó y
     * ningún test cambió, ni siquiera con el RLS abierto.
     */
    it('con el RLS aflojado, el aislamiento aguanta igual', async () => {
      const proveedor = new DbSecretProvider('test:profundidad', new EnvSecretProvider({}));

      // Primero, con todo en su lugar: A ve lo suyo. Si esto fallara, lo de
      // abajo pasaría por el motivo equivocado.
      const propio = await proveedor.existe({
        companyId: empresaA,
        scope: 'arca',
        name: 'clave-privada',
      });
      expect(propio, 'A ve su propia referencia').toBe(true);

      await db.query('ALTER POLICY secret_refs_por_empresa ON secret_refs USING (true)');
      try {
        // Con la política abierta, la consulta **sí** trae la fila de A aunque
        // el contexto sea B: la primera capa ya no protege.
        const filas = await asCompany(db, empresaB, async () =>
          db.query('SELECT id FROM secret_refs WHERE company_id = $1', [empresaA]),
        );
        expect(filas.rowCount, 'con el RLS abierto la fila se ve').toBeGreaterThan(0);

        // Y aun así el proveedor se niega: pide la de B, la base le devuelve la
        // de A, y la comprobación explícita lo corta.
        const error = await proveedor
          .get({ companyId: empresaB, scope: 'arca', name: 'clave-privada' })
          .catch((e: unknown) => e as ErrorDeSecreto);

        expect(error).toBeInstanceOf(ErrorDeSecreto);
        expect(
          ['SECRET_ACCESS_DENIED', 'SECRET_NOT_FOUND'],
          'o no la encuentra, o la rechaza por ser de otra empresa: nunca la entrega',
        ).toContain((error as ErrorDeSecreto).codigo);
      } finally {
        // La política vuelve a su lugar pase lo que pase. Un test que deja el
        // RLS abierto convierte a los que corren después en falsos verdes.
        await db.query(
          'ALTER POLICY secret_refs_por_empresa ON secret_refs USING (company_id = app_company_id())',
        );
      }
    });

    it('y la política quedó restaurada', async () => {
      // El seguro del seguro: si el test anterior fallara en medio, este avisa
      // en vez de dejar el resto de la suite corriendo sin aislamiento.
      const deB = await asCompany(db, empresaB, async () =>
        db.query('SELECT id FROM secret_refs WHERE company_id = $1', [empresaA]),
      );
      expect(deB.rowCount, 'el RLS tiene que estar puesto otra vez').toBe(0);
    });
  });

  describe('administrar no es usar', () => {
    it('un CONTADOR de la MISMA empresa no puede declarar una referencia', async () => {
      // Quien emite un comprobante usa el certificado de ARCA sin poder
      // tocarlo. `secret:manage` es solo de ADMINISTRADOR.
      //
      // La contadora es de la empresa A y manda su `x-company-id`: así el
      // rechazo tiene que venir del permiso y no de otra cosa. Es la diferencia
      // entre probar lo que dice el nombre del test y probar cualquier 4xx.
      const r = await pedir('POST', '/companies/current/secrets', tokenContadoraA, empresaA, {
        scope: 'pagos',
        name: 'api-key',
        referencia: 'kms:TEST_SECRET_ONLY/pagos',
        motivo: 'Una contadora no fija las credenciales de infraestructura.',
      });

      expect(r.statusCode, r.body).toBe(403);
      expect(r.json<{ message: string }>().message).toContain('secret:manage');
    });

    it('y tampoco puede listarlas', async () => {
      // Ver la lista de credenciales de una empresa ya es información: dice qué
      // integraciones tiene y con qué gestor.
      const r = await pedir('GET', '/companies/current/secrets', tokenContadoraA, empresaA);
      expect(r.statusCode, r.body).toBe(403);
    });
  });

  describe('revocar', () => {
    it('apaga la vigente y lo deja en la bitácora con su motivo', async () => {
      const r = await pedir('POST', '/companies/current/secrets/revoke', tokenA, empresaA, {
        scope: 'arca',
        name: 'clave-privada',
        motivo: 'Se dio de baja el certificado ante el organismo.',
      });
      expect(r.statusCode, r.body).toBe(200);

      const bitacora = await db.query<{ motivo: string }>(
        `SELECT motivo FROM audit_logs
          WHERE company_id = $1 AND action = 'REVOCAR_REFERENCIA_DE_SECRETO'
          ORDER BY occurred_at DESC LIMIT 1`,
        [empresaA],
      );
      expect(bitacora.rowCount).toBe(1);
      expect(bitacora.rows[0]!.motivo).toContain('de baja el certificado');
    });

    it('la bitácora no guarda la referencia completa ni ningún material', async () => {
      // Un ARN en la bitácora dice de más sobre la infraestructura, y no hace
      // falta para auditar el acto: alcanza con la identidad y el backend.
      const r = await db.query<{ new_value: unknown }>(
        `SELECT new_value FROM audit_logs
          WHERE company_id = $1 AND action LIKE '%REFERENCIA_DE_SECRETO'`,
        [empresaA],
      );
      expect(r.rowCount).toBeGreaterThan(0);
      for (const fila of r.rows) {
        expect(JSON.stringify(fila.new_value)).not.toContain('TEST_SECRET_ONLY');
      }
    });

    it('revocar no borra: la fila sigue estando', async () => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM secret_refs
          WHERE company_id = $1 AND scope = 'arca' AND name = 'clave-privada'`,
        [empresaA],
      );
      // Las dos versiones siguen ahí.
      expect(Number(r.rows[0]!.n)).toBe(2);
    });

    it('revocar algo que no existe dice que no existe', async () => {
      const r = await pedir('POST', '/companies/current/secrets/revoke', tokenA, empresaA, {
        scope: 'pagos',
        name: 'api-key',
        motivo: 'No hay nada declarado con ese nombre.',
      });
      expect(r.statusCode).toBe(404);
    });
  });
});
