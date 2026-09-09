/**
 * Un error de validación no llega en inglés.
 *
 * Casi todos los esquemas de la API traen su mensaje escrito —«El dígito
 * verificador del CUIT no cierra»— y son mejores que cualquier texto genérico.
 * Lo que se colaba era **el caso que nadie escribió**: un campo que falta salía
 * como `Required`, el texto por defecto de zod, y así llegaba a la pantalla.
 *
 * La auditoría del 2026-09-09 lo vio en la consola, al lado de un mensaje en
 * castellano:
 *
 *     Datos inválidos
 *       roles: Required
 *
 * Es el mismo defecto que el volcado de JSON, más chico: el sistema hablándole
 * al usuario en su propio idioma técnico.
 *
 * Este control no comprueba que los mensajes sean lindos —eso no es
 * comprobable—, sino lo que sí lo es: que **ninguno de los textos por defecto de
 * zod salga por la API**. Es una lista corta y cerrada, y alcanza, porque un
 * mensaje escrito a mano nunca va a ser uno de ellos.
 */

import { buildServer } from '@aai/api/server';
import { closePool, initPool } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/** Lo que zod dice cuando nadie escribió el mensaje. */
const EN_INGLES = [
  'Required',
  'Expected ',
  'Invalid input',
  'String must contain',
  'Array must contain',
  'Number must be',
  'Invalid uuid',
  'Invalid email',
  'Invalid enum value',
  'Unrecognized key',
];

interface Detalle {
  readonly path: string;
  readonly message: string;
}

suite('los errores de validación están en castellano', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  const validar = async (url: string, payload: unknown): Promise<readonly Detalle[]> => {
    const r = await app.inject({ method: 'POST', url, payload: payload as object });
    expect(r.statusCode, r.body).toBe(400);
    const cuerpo = r.json() as { error: string; details?: Detalle[] };
    expect(cuerpo.error).toBe('VALIDATION_ERROR');
    return cuerpo.details ?? [];
  };

  it('un campo que falta dice que falta, y lo dice en castellano', async () => {
    // `/auth/login` no exige sesión, así que la validación es lo primero que
    // corre y lo único que se está midiendo.
    const detalles = await validar('/auth/login', {});

    expect(detalles.length, 'el pedido vacío tendría que dar al menos un renglón').toBeGreaterThan(
      0,
    );
    for (const d of detalles) {
      expect(d.message, `«${d.path}: ${d.message}» está en inglés`).toBe('Falta este dato');
    }
  });

  it('ningún renglón de validación usa el texto por defecto de zod', async () => {
    const casos: readonly [string, unknown][] = [
      ['/auth/login', {}],
      ['/auth/login', { email: 'no-es-un-correo', password: 'x' }],
      ['/auth/login', { email: 123, password: false }],
      ['/auth/signup', { email: 'alguien@ejemplo.test', password: 'corta' }],
    ];

    const encontrados: string[] = [];
    for (const [url, payload] of casos) {
      for (const d of await validar(url, payload)) {
        for (const ingles of EN_INGLES) {
          if (d.message.startsWith(ingles)) encontrados.push(`${url} · ${d.path}: ${d.message}`);
        }
      }
    }

    expect(
      encontrados,
      'estos renglones salen con el texto por defecto de zod, en inglés, y llegan tal cual a ' +
        'la pantalla del usuario',
    ).toEqual([]);
  });

  it('el mensaje escrito a mano gana sobre el mapa', async () => {
    // El control positivo, y el que importa: traducir los defaults no puede
    // haberse llevado puestos los mensajes que alguien escribió pensando en
    // quien los va a leer.
    const detalles = await validar('/auth/signup', {
      email: 'alguien@ejemplo.test',
      password: 'una-contrasena-suficientemente-larga',
      fullName: '',
    });

    const propio = detalles.find((d) => d.path === 'fullName');
    expect(propio, 'el esquema de alta valida el nombre').toBeDefined();
    expect(propio?.message).not.toBe('Falta este dato');
  });
});
