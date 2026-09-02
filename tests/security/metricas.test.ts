/**
 * S-13 — El recolector de métricas.
 *
 * ## Por qué está en `tests/security` y no en integración
 *
 * Porque lo que se prueba no es que cuente bien: es **quién puede leerlo y qué
 * dice**. Los contadores informan cuántos pedidos atiende el sistema, a qué
 * hora y con qué demora, y la etiqueta de cada uno llevaría identificadores si
 * la ruta se midiera por su url concreta.
 *
 * ## Cómo se prueba una variable que se lee al importar
 *
 * `config` se evalúa una sola vez por módulo cargado, así que cambiar
 * `METRICS_TOKEN` después de importar el servidor no cambia nada — y un test
 * que lo intentara pasaría midiendo la configuración de la prueba anterior.
 * Cada caso reinicia el registro de módulos y **vuelve a importar** el
 * servidor con la variable ya puesta.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que sin token declarado la ruta no exista.** 404, igual que cualquier
 *      inexistente: distinguirla diría si el recolector está configurado.
 *   2. **Que con token equivocado conteste lo mismo.**
 *   3. **Que las etiquetas sean plantillas de ruta**, nunca uuids.
 *   4. **Que no se cuele ninguna métrica de negocio.**
 */

import { closePool, initPool } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hasDatabase } from '../integration/helpers/db.js';

const TOKEN = 'un-token-de-recoleccion-suficientemente-largo';

/**
 * Hace falta base aunque no se consulte ninguna tabla.
 *
 * El primer intento de este archivo no la inicializaba y todas las pruebas con
 * cabecera `Authorization` daban 500: el gancho de contexto busca la sesión
 * antes de llegar a la ruta, y sin pool esa búsqueda revienta. Estuve a punto de
 * anotarlo como un defecto del producto —«cualquier token inválido produce un
 * 500»— hasta que lo medí con el pool arriba y contestó 200. El defecto era del
 * banco de pruebas.
 */
const suite = hasDatabase ? describe : describe.skip;

suite('S-13 — métricas', () => {
  const tokenPrevio = process.env.METRICS_TOKEN;
  let app: FastifyInstance | undefined;

  /** Un servidor nuevo, con el módulo de configuración releído. */
  async function servidorCon(token: string | undefined): Promise<FastifyInstance> {
    if (token === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = token;

    vi.resetModules();

    // Reiniciar el registro de módulos también trae un `@aai/db` nuevo, con su
    // pool sin inicializar. Sin esta línea, cualquier pedido con cabecera de
    // autorización revienta al buscar la sesión — y el 500 se lee como si la
    // ruta de métricas estuviera rota.
    const { initPool: initPoolAislado } = await import('@aai/db');
    initPoolAislado(process.env.DATABASE_URL!);

    const { buildServer } = await import('@aai/api/server');
    const instancia = await buildServer();
    await instancia.ready();
    return instancia;
  }

  beforeAll(() => {
    initPool(process.env.DATABASE_URL!);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await closePool();
    if (tokenPrevio === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = tokenPrevio;
  });

  it('sin token declarado, la ruta no existe', async () => {
    app = await servidorCon(undefined);

    const r = await app.inject({ method: 'GET', url: '/metrics' });
    // 404 y no 401: distinguirlos diría si el recolector está configurado.
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('nexo_http_requests_total');
  });

  it('con token equivocado contesta lo mismo que sin función', async () => {
    app = await servidorCon(TOKEN);

    const r = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer otro-token-distinto-y-mas-largo-todavia' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('nexo_http_requests_total');
  });

  it('con el token correcto expone contadores, y ninguna etiqueta lleva un uuid', async () => {
    app = await servidorCon(TOKEN);

    // Un pedido cualquiera para que haya algo que contar. Sin sesión da 403, y
    // eso también es un pedido atendido: la métrica cuenta atenciones, no
    // éxitos.
    await app.inject({ method: 'GET', url: '/parties' });
    await app.inject({ method: 'GET', url: '/health' });

    const r = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain('nexo_http_requests_total');
    expect(r.body).toContain('nexo_http_request_duration_ms_total');
    expect(r.body).toContain('nexo_process_uptime_seconds');
    // El pedido de arriba tiene que estar contado: un recolector que devuelve
    // el encabezado y ninguna serie es un recolector que no mide.
    expect(r.body).toContain('ruta="/parties"');

    // Ninguna etiqueta puede llevar un identificador: la métrica se toma por la
    // plantilla de la ruta, no por la url concreta.
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(uuid.test(r.body)).toBe(false);

    // Y nada de negocio: el recolector técnico no cuenta empresas ni importes.
    for (const prohibida of ['empresa', 'company_id', 'importe', 'facturado', 'cuit']) {
      expect(r.body.toLowerCase()).not.toContain(prohibida);
    }
  });

  it('la plantilla de la ruta reemplaza al identificador', async () => {
    app = await servidorCon(TOKEN);

    // Una ruta con parámetro. El pedido va a fallar por falta de sesión, y aun
    // así queda contado — que es justo el caso donde el uuid podría filtrarse.
    await app.inject({
      method: 'GET',
      url: '/parties/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });

    const r = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(r.body).toContain('/parties/:partyId');
    expect(r.body).not.toContain('3f2504e0');
  });
});
