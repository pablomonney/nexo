/**
 * S-1 (nivel HTTP) — criterio de salida de la FASE 2.
 *
 * "Un estudio con 3 empresas, planes de cuentas distintos, y cero fugas de datos
 * entre ellas verificado por test automatizado **sobre todos los endpoints**."
 *
 * La parte que importa es "todos". El test no recorre una lista escrita a mano
 * —que se desactualiza en cuanto alguien agrega una ruta— sino el inventario de
 * rutas que el propio servidor construye al registrarlas. Si mañana aparece un
 * endpoint nuevo sin protección de tenancy, este test lo encuentra solo.
 */

import { closePool, initPool } from '@aai/db';
// La API valida el CUIT en el borde: un número inventado se rechaza con 400
// antes de llegar a la lógica que el test quiere ejercitar.
import { withCheckDigit } from '@aai/shared';
import { buildServer } from '@aai/api/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

interface Actor {
  token: string;
  userId: string;
  email: string;
}

/**
/**
 * Rutas que no son company-scoped por diseño: pertenecen al estudio o al propio
 * usuario. Se excluyen del barrido de aislamiento por empresa y se verifican
 * aparte — un endpoint que se agregue sin declararse acá entra al barrido, que
 * es lo que se quiere.
 */
const STUDIO_SCOPED = new Set(['GET /organizations', 'POST /organizations']);

/**
 * Rutas que sirven contenido sin ningún dato y por eso no se autentican.
 *
 * Hoy hay una sola: la consola operativa, que es un archivo estático. Excluirla
 * del barrido es una excepción declarada, no un olvido — y no se sostiene con
 * esta línea sino con `mvp-fronteras.test.ts`, que comprueba que el HTML no
 * lleve credenciales, ni identificadores de empresa, ni una consulta a la base,
 * y que su CSP no admita recursos externos.
 *
 * Autenticar la página de login sería circular. Lo que importa es que no
 * contenga nada, y eso se prueba aparte.
 */
const SIN_DATOS = new Set(['GET /consola']);

suite('S-1 HTTP — aislamiento sobre todos los endpoints', () => {
  let app: FastifyInstance;
  let raw: Client;

  let organizationId: string;
  let companyA: string;
  let companyB: string;
  let companyC: string;
  let owner: Actor;
  /** Solo tiene rol en la empresa A. Es quien intenta llegar a B y a C. */
  let usuarioA: Actor;

  const password = 'contrasena-de-prueba-larga';

  async function post(url: string, body: unknown, actor?: Actor, companyId?: string) {
    return app.inject({
      method: 'POST',
      url,
      payload: body as object,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
        ...(companyId ? { 'x-company-id': companyId } : {}),
      },
    });
  }

  async function login(email: string): Promise<Actor> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    });
    if (response.statusCode !== 200) {
      throw new Error(`login falló para ${email}: ${response.statusCode} ${response.body}`);
    }
    const body = response.json<{ token: string }>();
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    return { token: body.token, userId: me.json<{ user: { id: string } }>().user.id, email };
  }

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    const stamp = await sufijoUnico(raw);
    const ownerEmail = `owner-${stamp}@estudio.test`;
    const userEmail = `usuario-${stamp}@estudio.test`;

    // Alta directa en base: el bootstrap por HTTP solo funciona con la base vacía,
    // y estos tests corren contra una base que ya tiene datos de otras suites.
    // Se usan los mismos parámetros de Argon2id que la API (apps/api/src/auth/crypto.ts).
    const { hash: argonHash } = await import('@node-rs/argon2');
    const hash = await argonHash(password, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const ownerRow = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [ownerEmail, 'Dueño del estudio', hash],
    );
    const userRow = await raw.query<{ id: string }>(
      'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [userEmail, 'Usuario de empresa A', hash],
    );

    const org = await raw.query<{ create_organization: string }>(
      'SELECT create_organization($1, $2, $3)',
      [`Estudio ${stamp}`, `30${stamp.padStart(8, '0')}7`, ownerRow.rows[0]!.id],
    );
    organizationId = org.rows[0]!.create_organization;

    await raw.query(
      'INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, $3)',
      [organizationId, userRow.rows[0]!.id, 'MEMBER'],
    );

    const makeCompany = async (name: string, cuitSuffix: string): Promise<string> => {
      const result = await raw.query<{ create_company: string }>(
        'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          ownerRow.rows[0]!.id, organizationId, name,
          `30${stamp.padStart(8, '0')}${cuitSuffix}`,
          'SRL', 'AR-C', 'IGJ', '12-31',
        ],
      );
      return result.rows[0]!.create_company;
    };

    companyA = await makeCompany('Empresa A', '1');
    companyB = await makeCompany('Empresa B', '2');
    companyC = await makeCompany('Empresa C', '3');

    // El usuario solo tiene rol en A. Roles sin MFA obligatorio para poder
    // ejercitar los endpoints; la exigencia de MFA se testea aparte.
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      ownerRow.rows[0]!.id, companyA, userRow.rows[0]!.id, 'USUARIO_EMPRESA',
    ]);
    await raw.query('SELECT grant_company_role($1, $2, $3, $4)', [
      ownerRow.rows[0]!.id, companyA, ownerRow.rows[0]!.id, 'USUARIO_EMPRESA',
    ]);

    // Planes de cuentas distintos: cada empresa con su propio código y nombre.
    for (const [company, code, name] of [
      [companyA, '1.1.01', 'Caja A'],
      [companyB, '1.1.02', 'Banco B'],
      [companyC, '1.1.03', 'Valores C'],
    ] as const) {
      const chart = await raw.query<{ id: string }>(
        `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan') RETURNING id`,
        [company],
      );
      await raw.query(
        `INSERT INTO accounts (company_id, chart_id, code, name, type, nature)
         VALUES ($1, $2, $3, $4, 'ACTIVO', 'DEUDORA')`,
        [company, chart.rows[0]!.id, code, name],
      );
    }

    owner = await login(ownerEmail);
    usuarioA = await login(userEmail);
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  it('el inventario de rutas no está vacío', () => {
    expect(app.routeTable.length).toBeGreaterThan(10);
  });

  it('NINGÚN endpoint devuelve 2xx con una empresa en la que el usuario no tiene rol', async () => {
    const filled = (url: string): string =>
      url
        .replace(':organizationId', organizationId)
        .replace(':companyId', companyB)
        .replace(':accountId', '00000000-0000-7000-8000-000000000000')
        .replace(':periodId', '00000000-0000-7000-8000-000000000000');

    const leaks: string[] = [];

    for (const route of app.routeTable) {
      // Los endpoints de sesión, de salud y los del estudio no son company-scoped.
      if (route.url.startsWith('/auth/') || route.url.startsWith('/health')) continue;
      if (STUDIO_SCOPED.has(`${route.method} ${route.url}`)) continue;
      if (SIN_DATOS.has(`${route.method} ${route.url}`)) continue;

      const response = await app.inject({
        method: route.method as 'GET',
        url: filled(route.url),
        payload: route.method === 'GET' ? undefined : {},
        headers: {
          authorization: `Bearer ${usuarioA.token}`,
          'x-company-id': companyB,
        },
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        leaks.push(`${route.method} ${route.url} → ${response.statusCode} ${response.body.slice(0, 200)}`);
      }
    }

    expect(leaks, `Endpoints que respondieron 2xx para una empresa ajena:\n${leaks.join('\n')}`).toEqual([]);
  });

  it('el usuario de A ve su plan de cuentas', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/accounts',
      headers: { authorization: `Bearer ${usuarioA.token}`, 'x-company-id': companyA },
    });
    expect(response.statusCode).toBe(200);
    const codes = response.json<{ accounts: Array<{ code: string }> }>().accounts.map((a) => a.code);
    expect(codes).toContain('1.1.01');
    expect(codes).not.toContain('1.1.02');
    expect(codes).not.toContain('1.1.03');
  });

  it('el usuario de A no puede leer el plan de cuentas de B ni de C', async () => {
    for (const other of [companyB, companyC]) {
      const response = await app.inject({
        method: 'GET',
        url: '/accounts',
        headers: { authorization: `Bearer ${usuarioA.token}`, 'x-company-id': other },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('Banco B');
      expect(response.body).not.toContain('Valores C');
    }
  });

  it('la respuesta es idéntica para una empresa ajena y para una inexistente', async () => {
    const ajena = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: { authorization: `Bearer ${usuarioA.token}`, 'x-company-id': companyB },
    });
    const inexistente = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: {
        authorization: `Bearer ${usuarioA.token}`,
        'x-company-id': '00000000-0000-7000-8000-0000000000ff',
      },
    });
    // Si difirieran, el endpoint sería un oráculo para enumerar la cartera de clientes.
    expect(ajena.statusCode).toBe(inexistente.statusCode);
    expect(ajena.json()).toEqual(inexistente.json());
  });

  it('sin autenticación ningún endpoint de negocio responde 2xx', async () => {
    for (const route of app.routeTable) {
      if (route.url.startsWith('/health')) continue;
      if (route.url === '/auth/login' || route.url === '/auth/register-first-admin') continue;
      if (route.url === '/auth/logout') continue;
      if (SIN_DATOS.has(`${route.method} ${route.url}`)) continue;

      const response = await app.inject({
        method: route.method as 'GET',
        url: route.url
          .replace(':organizationId', organizationId)
          .replace(':companyId', companyA)
          .replace(':accountId', '00000000-0000-7000-8000-000000000000')
          .replace(':periodId', '00000000-0000-7000-8000-000000000000'),
        payload: route.method === 'GET' ? undefined : {},
        headers: { 'x-company-id': companyA },
      });
      expect(
        response.statusCode,
        `${route.method} ${route.url} respondió ${response.statusCode} sin autenticación`,
      ).toBeGreaterThanOrEqual(400);
    }
  });

  it('un token inventado no autentica', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: { authorization: 'Bearer no-soy-un-token-valido', 'x-company-id': companyA },
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /organizations solo muestra los estudios del propio usuario', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/organizations',
      headers: { authorization: `Bearer ${usuarioA.token}` },
    });
    expect(response.statusCode).toBe(200);
    const orgs = response.json<{ organizations: Array<{ id: string }> }>().organizations;
    expect(orgs.map((o) => o.id)).toEqual([organizationId]);
  });

  it('el owner del estudio puede crear una empresa; el miembro común no', async () => {
    const stamp = `${Date.now()}`.slice(-8);

    const asOwner = await post(
      `/organizations/${organizationId}/companies`,
      {
        legalName: `Empresa D ${stamp}`,
        cuit: withCheckDigit(`30${stamp}`),
        entityType: 'SRL',
        jurisdiction: 'AR-C',
        fiscalYearEnd: '12-31',
      },
      owner,
    );
    expect(asOwner.statusCode, asOwner.body).toBe(200);

    const asMember = await post(
      `/organizations/${organizationId}/companies`,
      {
        legalName: `Empresa E ${stamp}`,
        cuit: withCheckDigit(`33${stamp}`),
        entityType: 'SRL',
        jurisdiction: 'AR-C',
        fiscalYearEnd: '12-31',
      },
      usuarioA,
    );
    expect(asMember.statusCode).toBe(403);
  });

  it('el rol determina los permisos: USUARIO_EMPRESA no puede escribir el plan de cuentas', async () => {
    const response = await post(
      '/accounts',
      { code: '9.9.99', name: 'Cuenta prohibida', type: 'ACTIVO' },
      usuarioA,
      companyA,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json<{ message: string }>().message).toContain('account:write');
  });
});
