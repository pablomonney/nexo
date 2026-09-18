/**
 * El organismo de contralor en el alta de empresa, de punta a punta.
 *
 * ## El defecto que motiva este archivo
 *
 * Medido en producción el 2026-09-18, con un cliente completando el primer
 * formulario del producto: escribir `igj` en minúsculas en «Organismo» devolvía
 * `{"error":"INTERNAL_ERROR","message":"Error interno"}`.
 *
 * La causa no estaba en el organismo sino en la juntura: `POST
 * /onboarding/empresa` validaba el campo como **texto libre** de hasta cuarenta
 * caracteres, y `companies.regulator` lo restringe a **cinco valores en
 * mayúsculas** desde la migración 0002. El `INSERT` moría con un `23514` que
 * nadie traducía.
 *
 * ## Qué se prueba acá y qué no
 *
 * `organismo.test.ts` —al lado del módulo— ya prueba la normalización y el
 * conjunto. Acá se prueba lo que solo se ve **contra la base**: que el valor
 * normalizado es el que queda guardado, que el rechazo llega como 400 con la
 * lista adentro, y —lo que más importa— que **ninguna violación de restricción
 * de este formulario vuelve a salir como 500**.
 *
 * Por eso los dos últimos casos mandan valores que la ruta NO conoce: son la
 * red, no la validación, y son los que demuestran que la red existe.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const CLAVE = 'una-contrasena-suficientemente-larga';

interface Respuesta {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  json: <T>() => T;
}

suite('El organismo de contralor en el alta de empresa', () => {
  let app: FastifyInstance;
  let raw: Client;
  let plan: string;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    const planes = await app.inject({ method: 'GET', url: '/planes' });
    const catalogo = planes.json<{ planes: { code: string }[] }>();
    const primero = catalogo.planes[0];
    if (primero === undefined) throw new Error('no hay planes disponibles en la base de pruebas');
    plan = primero.code;
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  /** La cookie de sesión, tal como la manda el servidor. */
  const galleta = (respuesta: Respuesta): string => {
    const bruto = respuesta.headers['set-cookie'];
    const lista = Array.isArray(bruto) ? bruto : [bruto];
    const sesion = lista.find((c): c is string => typeof c === 'string' && c.includes('='));
    if (sesion === undefined) throw new Error('el servidor no mandó cookie de sesión');
    return sesion.split(';')[0]!;
  };

  /**
   * Una cuenta nueva, confirmada, sin estudio.
   *
   * Cada caso necesita la suya: quien ya administra un estudio recibe
   * `YA_TIENE_ESTUDIO`, que es otra respuesta y taparía la que se quiere medir.
   * El código sale de la bandeja de salida porque es la única fuente —la
   * aplicación no puede leer esa tabla— y es el mismo camino que recorre una
   * persona.
   */
  const sesionNueva = async (etiqueta: string): Promise<string> => {
    const sufijo = await sufijoUnico(raw);
    const correo = `organismo-${etiqueta}-${sufijo}@estudio.test`;

    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: correo, password: CLAVE, fullName: 'Quien da de alta' },
    });

    const bandeja = await raw.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM email_outbox
        WHERE destinatario = $1 AND tipo = 'VERIFICACION_DE_ALTA'
        ORDER BY creado_el DESC LIMIT 1`,
      [correo],
    );
    const token = /\n\n([A-Za-z0-9_-]{20,})\n/u.exec(bandeja.rows[0]?.cuerpo ?? '')?.[1];
    if (token === undefined) throw new Error('el alta no dejó código en la bandeja');

    await app.inject({ method: 'POST', url: '/auth/verificar-correo', payload: { token } });

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: correo, password: CLAVE },
    });
    return galleta(login as unknown as Respuesta);
  };

  /** Un alta completa y válida, con el organismo —o lo que se le pase— encima. */
  const crear = async (
    etiqueta: string,
    encima: Record<string, unknown>,
  ): Promise<{ respuesta: Respuesta; cuit: string }> => {
    const cookie = await sesionNueva(etiqueta);
    const cuit = withCheckDigit(`30${await sufijoUnico(raw)}`);

    const respuesta = (await app.inject({
      method: 'POST',
      url: '/onboarding/empresa',
      headers: { cookie },
      payload: {
        estudio: `Estudio ${etiqueta}`,
        razonSocial: `Empresa ${etiqueta}`,
        cuit,
        tipoEntidad: 'SA',
        jurisdiccion: 'AR-C',
        cierreEjercicio: '12-31',
        plan,
        ...encima,
      },
    })) as unknown as Respuesta;

    return { respuesta, cuit };
  };

  /** Lo que quedó guardado, que es lo único que decide si la normalización sirvió. */
  const regulatorDe = async (cuit: string): Promise<string | null> => {
    const r = await raw.query<{ regulator: string | null }>(
      'SELECT regulator FROM companies WHERE cuit = $1',
      [cuit],
    );
    return r.rows[0]?.regulator ?? null;
  };

  const cuantasEmpresas = async (cuit: string): Promise<number> => {
    const r = await raw.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM companies WHERE cuit = $1',
      [cuit],
    );
    return Number(r.rows[0]!.n);
  };

  it('acepta IGJ y lo guarda tal cual', async () => {
    const { respuesta, cuit } = await crear('igj-mayus', { organismo: 'IGJ' });
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    expect(await regulatorDe(cuit)).toBe('IGJ');
  });

  it('acepta igj en minúsculas y lo guarda en mayúsculas', async () => {
    // El caso exacto que devolvía 500 en producción.
    const { respuesta, cuit } = await crear('igj-minus', { organismo: 'igj' });
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    expect(await regulatorDe(cuit)).toBe('IGJ');
  });

  it('acepta un organismo con espacios de más alrededor', async () => {
    const { respuesta, cuit } = await crear('igj-espacios', { organismo: '  Igj  ' });
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    expect(await regulatorDe(cuit)).toBe('IGJ');
  });

  it('acepta otro organismo del conjunto', async () => {
    const { respuesta, cuit } = await crear('cnv', { organismo: 'cnv' });
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    expect(await regulatorDe(cuit)).toBe('CNV');
  });

  it('sin organismo la empresa se crea igual, y queda en NULL', async () => {
    const { respuesta, cuit } = await crear('sin-organismo', {});
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    expect(await regulatorDe(cuit)).toBeNull();
  });

  it('con el organismo vacío también, y queda en NULL', async () => {
    // La consola manda el desplegable en su opción «(ninguno)», que es ''.
    const { respuesta, cuit } = await crear('organismo-vacio', { organismo: '' });
    expect(respuesta.statusCode, respuesta.body).toBe(201);
    expect(await regulatorDe(cuit)).toBeNull();
  });

  it('«I G J» se rechaza con 400 y la lista, en vez de adivinar', async () => {
    const { respuesta, cuit } = await crear('igj-separado', { organismo: 'I G J' });
    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.body).toContain('IGJ, CNV, BCRA, INAES, PROVINCIAL');
    expect(respuesta.body).not.toContain('INTERNAL_ERROR');
    // Y no quedó nada a medio crear.
    expect(await cuantasEmpresas(cuit)).toBe(0);
  });

  it('un organismo que no existe se rechaza con 400 y la lista', async () => {
    const { respuesta, cuit } = await crear('inventado', { organismo: 'MINISTERIO' });
    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.body).toContain('IGJ, CNV, BCRA, INAES, PROVINCIAL');
    expect(respuesta.body).not.toContain('INTERNAL_ERROR');
    expect(await cuantasEmpresas(cuit)).toBe(0);
  });

  it('una jurisdicción que la base rechaza sale como 400, no como 500', async () => {
    // La red. `jurisdiccion` se valida como texto de 2 a 10 y la columna pide
    // `^AR(-[A-Z])?$`: es la misma forma del defecto del organismo, en otra
    // columna. Que conteste 400 con el nombre de la restricción es lo que
    // impide que vuelva a aparecer un «Error interno» en esta pantalla.
    const { respuesta, cuit } = await crear('jurisdiccion', { jurisdiccion: 'XX' });
    expect(respuesta.statusCode, respuesta.body).toBe(400);
    expect(respuesta.body).not.toContain('INTERNAL_ERROR');
    expect(respuesta.body).toContain('companies_jurisdiction_check');
    expect(await cuantasEmpresas(cuit)).toBe(0);
  });

  it('un tipo de entidad que la base no conoce sale como 400, no como 500', async () => {
    // `OTRO` está en el enum de esta ruta y NO está en el CHECK de la columna,
    // que admite doce valores y ninguno se llama así. Es un segundo desajuste
    // real, vivo en el mismo formulario: la red lo convierte en un 400.
    const { respuesta, cuit } = await crear('tipo-otro', { tipoEntidad: 'OTRO' });
    expect(respuesta.statusCode, respuesta.body).toBe(400);
    expect(respuesta.body).not.toContain('INTERNAL_ERROR');
    expect(await cuantasEmpresas(cuit)).toBe(0);
  });
});
