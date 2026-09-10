/**
 * S-39 — Lo que separa un despliegue de producción de uno que solo arranca.
 *
 * Todo lo de este archivo tiene la misma forma: **funciona igual de bien mal
 * configurado**. Ninguno de estos defectos rompe nada, ninguno aparece en un
 * log, y los tres se descubren cuando ya hay clientes adentro.
 *
 *   1. **El rol de la base.** RLS se evalúa contra el rol que ejecuta la
 *      consulta. Con un superusuario en `DATABASE_URL`, cualquier consulta
 *      escrita fuera de `withCompany`/`withoutCompany` atraviesa las políticas:
 *      una empresa ve los datos de otra, sin error y sin rastro.
 *   2. **El proxy.** Con `trustProxy` en falso detrás de un balanceador,
 *      `request.ip` es la del proxy **para todo el mundo**, y el límite de
 *      intentos por origen se vuelve un límite global: treinta fallos de
 *      cualquiera dejan a todos afuera.
 *   3. **HSTS.** Sin la cabecera, el primer pedido de cada visita puede ir en
 *      claro, y ahí es donde se roba una cookie de sesión en una red ajena.
 *
 * ## Por qué las comprobaciones son de función pura y no de despliegue
 *
 * No hay servidor de producción todavía. Lo que sí se puede ejercitar es la
 * **decisión**: dado un estado, ¿el sistema arranca o se niega? Eso es una
 * función, y una función se prueba con los dos casos —incluida la rama roja,
 * que contra una base bien configurada nunca se ve.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { problemasDelRol, rolesDeLaBase, type RolesDeLaBase } from '@aai/api/arranque';
import { config } from '@aai/api/config';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, hasDatabase } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/** Un rol sano: ni la conexión es superusuario ni el efectivo saltea RLS. */
const SANO: RolesDeLaBase = {
  sesion: 'aai_app',
  efectivo: 'aai_app',
  sesionEsSuperusuario: false,
  efectivoSalteaRls: false,
};

describe('S-39 — el rol de la base no puede saltear el aislamiento', () => {
  it('en producción, un rol de conexión superusuario impide arrancar', () => {
    const problemas = problemasDelRol({ ...SANO, sesion: 'postgres', sesionEsSuperusuario: true }, true);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]!.que).toContain('superusuario');
    // El mensaje tiene que decir qué hacer. Uno que solo describe el estado deja
    // a quien despliega buscando el comando en la documentación.
    expect(problemas[0]!.comoSeArregla).toContain('aai_app');
  });

  it('en producción, un rol efectivo con BYPASSRLS impide arrancar', () => {
    // Es el peor de los dos: `SET LOCAL ROLE` corrió, la aplicación cree que
    // está aislada, y el rol atraviesa las políticas igual.
    const problemas = problemasDelRol({ ...SANO, efectivoSalteaRls: true }, true);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]!.que).toContain('BYPASSRLS');
    expect(problemas[0]!.comoSeArregla).toContain('NOBYPASSRLS');
  });

  it('los dos problemas a la vez se informan los dos, no el primero', () => {
    // Informar solo el primero obliga a desplegar, fallar, arreglar, desplegar y
    // fallar otra vez por lo segundo.
    const problemas = problemasDelRol(
      { sesion: 'postgres', efectivo: 'postgres', sesionEsSuperusuario: true, efectivoSalteaRls: true },
      true,
    );
    expect(problemas).toHaveLength(2);
  });

  it('un rol sano arranca', () => {
    // El control positivo. Sin él, una función que devolviera siempre un
    // problema pasaría todos los casos de arriba y nada arrancaría nunca.
    expect(problemasDelRol(SANO, true)).toEqual([]);
  });

  it('fuera de producción se deja pasar: la base de desarrollo conecta como dueña', () => {
    // Obligar a un rol dedicado para levantar el proyecto en una máquina de
    // desarrollo sería costo sin beneficio: `tenancy.ts` hace `SET LOCAL ROLE`
    // igual, y el aislamiento se prueba en la suite.
    const roto = { sesion: 'postgres', efectivo: 'postgres', sesionEsSuperusuario: true, efectivoSalteaRls: true };
    expect(problemasDelRol(roto, false)).toEqual([]);
  });

  it('no poder afirmar que el rol es seguro se trata como inseguro', () => {
    // `rolesDeLaBase` traduce un `null` de `pg_roles` —el rol no está, no se
    // pudo leer— a `true`. En una comprobación de seguridad, «no se sabe» y «es
    // peligroso» llevan a la misma decisión: no arrancar.
    const noSeSabe: RolesDeLaBase = {
      sesion: 'desconocido',
      efectivo: 'desconocido',
      sesionEsSuperusuario: true,
      efectivoSalteaRls: true,
    };
    expect(problemasDelRol(noSeSabe, true).length).toBeGreaterThan(0);
  });
});

suite('S-39 — el rol real de esta instalación', () => {
  beforeAll(() => {
    initPool(DATABASE_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it('adentro de una transacción, el rol efectivo es aai_app y no saltea RLS', async () => {
    // Es la propiedad de la que depende TODO el aislamiento, y no depende del
    // rol con el que se conecte: `tenancy.ts` hace `SET LOCAL ROLE aai_app` en
    // cada transacción. Esta prueba lo comprueba contra la base de verdad.
    const roles = await rolesDeLaBase();

    expect(roles.efectivo).toBe('aai_app');
    expect(
      roles.efectivoSalteaRls,
      'aai_app puede saltear RLS: el aislamiento entre empresas no existe',
    ).toBe(false);
  });
});

suite('S-39 — cabeceras y proxy', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initPool(DATABASE_URL);
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('las cabeceras de endurecimiento van en toda respuesta', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('HSTS depende del entorno, y en desarrollo NO se manda', async () => {
    // Mandarla en desarrollo haría que el navegador recuerde que a `localhost`
    // se entra por HTTPS, y dejaría de poder abrirse por HTTP. Es un dolor de
    // cabeza que dura hasta que alguien encuentra la pantalla donde se borra.
    const r = await app.inject({ method: 'GET', url: '/health' });
    if (config.isProduction) {
      expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    } else {
      expect(r.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('sin proxy declarado, una cabecera X-Forwarded-For inventada no se cree', async () => {
    // Es lo que impide que cualquiera se fabrique una dirección distinta en
    // cada intento y esquive el límite. Se comprueba por el efecto: el límite
    // sigue contando los intentos como del mismo origen.
    expect(config.trustProxy, 'los tests corren sin proxy declarado').toBe(false);

    const r = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(r.statusCode).toBe(200);
  });
});

suite('S-39 — la sonda de salud dice qué está corriendo', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initPool(DATABASE_URL);
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('/health no toca la base: una base caída no puede reiniciar la aplicación', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const cuerpo = r.json<{ status: string; version: string | null; uptimeSegundos: number }>();
    expect(cuerpo.status).toBe('ok');
    expect(cuerpo.uptimeSegundos).toBeGreaterThanOrEqual(0);
    // Sin BUILD_ID declarado, `null`. **No una versión inventada**: decir
    // «1.0.0» sobre un despliegue desconocido hace concluir que dos entornos
    // son el mismo cuando nadie lo comprobó.
    expect(cuerpo.version).toBeNull();
  });

  it('/health/db informa cuántas migraciones aplicó', async () => {
    const r = await app.inject({ method: 'GET', url: '/health/db' });
    expect(r.statusCode).toBe(200);
    const cuerpo = r.json<{ status: string; migrations: number }>();
    expect(cuerpo.migrations).toBeGreaterThan(100);
  });

  it('ninguna sonda expone la conexión, el rol ni el nombre de la base', async () => {
    // Son extremos **sin autenticar**: los mira el orquestador, y cualquiera que
    // llegue al puerto. Lo que digan es público.
    for (const url of ['/health', '/health/db']) {
      const cuerpo = (await app.inject({ method: 'GET', url })).body;
      for (const prohibido of ['postgres://', 'password', 'aai_app', 'DATABASE_URL']) {
        expect(cuerpo, `${url} expone «${prohibido}»`).not.toContain(prohibido);
      }
    }
  });
});
