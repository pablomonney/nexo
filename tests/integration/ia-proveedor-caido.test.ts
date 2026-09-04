/**
 * El proveedor se cae, y el ERP sigue contestando.
 *
 * Es la propiedad central de esta capa y la más fácil de romper sin querer: la
 * llamada al modelo está en el medio de una ruta que ya calculó la respuesta,
 * y una excepción que suba desde ahí convierte un 200 correcto en un 500.
 *
 * El día que eso pase, la IA deja de ser una capacidad adicional y pasa a ser
 * un punto único de fallo del ERP. Este archivo lo impide.
 *
 * ## Cómo se rompe el proveedor sin salir a Internet
 *
 * `AI_PROVIDER=http` apuntando a `127.0.0.1:1`, que es un puerto reservado donde
 * no escucha nadie: la conexión se rechaza al instante. No hay red, no hay
 * credencial de nadie, no hay servidor que levantar — y el camino que se
 * ejercita es el real, de punta a punta: configuración → fábrica →
 * `HttpLLMProvider` → `fetch` → `ErrorDeProveedor` → la ruta.
 *
 * Se importa todo dinámicamente después de tocar el entorno, porque `config` lo
 * lee al importarse y el resto de las suites tienen que seguir corriendo sin
 * proveedor.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

suite('Un proveedor caído no se lleva puesta la respuesta', () => {
  let app: FastifyInstance;
  let db: Client;
  let cerrarPool: () => Promise<void>;
  let token = '';
  let empresa = '';

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'http';
    process.env.AI_API_KEY = 'clave-de-prueba-que-no-llega-a-ningun-lado';
    process.env.AI_MODEL_ID = 'modelo-inexistente';
    // Puerto 1: reservado, nadie escucha. La conexión se rechaza al instante.
    process.env.AI_BASE_URL = 'http://127.0.0.1:1/v1/completions';
    process.env.AI_TIMEOUT_MS = '300';
    // Sin reintentos: acá se prueba la tolerancia al fallo, no el backoff.
    process.env.AI_MAX_RETRIES = '0';
    vi.resetModules();

    const dbMod = await import('@aai/db');
    dbMod.initPool(process.env.DATABASE_URL!);
    cerrarPool = dbMod.closePool;

    const { buildServer } = await import('@aai/api/server');
    const { withCheckDigit, totp } = await import('@aai/shared');

    app = await buildServer();
    await app.ready();
    db = await connect();
    const stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [`fundador-caido-${stamp}@estudio.test`, 'Fundador', clave],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio caido ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa caido ${stamp}`,
        withCheckDigit(`27${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-caido-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const correo = `contadora-caido-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email: correo, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { userId, role: 'CONTADOR' },
    });

    const inicial = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: correo, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
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
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await cerrarPool?.();
    process.env.AI_PROVIDER = 'none';
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL_ID;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_TIMEOUT_MS;
    delete process.env.AI_MAX_RETRIES;
    vi.resetModules();
  });

  it('el arranque informa el proveedor como configurado, no como conectado', async () => {
    const { modoDeIa } = await import('@aai/api/arranque');
    const { config } = await import('@aai/api/config');

    const modo = modoDeIa(config.ai);
    expect(modo.real).toBe(true);
    // Y aun así no dice «conectado»: la credencial cargada no prueba nada.
    expect(modo.detalle).toContain('no prueba una conexión');
    // Ni imprime la clave.
    expect(JSON.stringify(modo)).not.toContain('clave-de-prueba');
  });

  it('la pregunta contesta 200 con su cifra, aunque el proveedor no exista', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/intelligence/preguntar',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      payload: { pregunta: '¿cuánto vendí este mes?' },
    });

    // Lo que se defiende: **200**, no 500.
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<{
      entendida: boolean;
      respuesta: { titulo: string; origen: string[]; metodologia: string };
      narracion: { disponible: boolean; motivo: string; codigo: string; explicacion: string };
    }>();

    // La respuesta determinística está entera: cifra, origen y metodología.
    expect(v.entendida).toBe(true);
    expect(v.respuesta.origen.length).toBeGreaterThan(0);
    expect(v.respuesta.metodologia.length).toBeGreaterThan(20);

    // Y la narración dice qué pasó, con el código y no con el mensaje crudo.
    expect(v.narracion.disponible).toBe(false);
    expect(v.narracion.motivo).toBe('PROVEEDOR_FALLO');
    expect(['RED', 'TIMEOUT']).toContain(v.narracion.codigo);
    expect(v.narracion.explicacion).toContain('siguen siendo correctas');
  });

  it('el fallo no filtra la credencial en ninguna parte de la respuesta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/intelligence/preguntar',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      payload: { pregunta: '¿cuánto vendí este mes?' },
    });

    expect(r.body).not.toContain('clave-de-prueba');
    // Ni la URL del proveedor, que en algunos casos lleva la clave en la query.
    expect(r.body).not.toContain('127.0.0.1:1');
  });

  it('el resto del ERP no se entera de que hay un proveedor caído', async () => {
    // La analítica, los libros y la bandeja no pasan por la IA. Si un fallo del
    // proveedor los afectara, la IA habría dejado de ser una capa opcional.
    for (const url of ['/analytics/resumen', '/work-queue', '/journal-entries?limite=5']) {
      const r = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      });
      expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
    }
  });
});
