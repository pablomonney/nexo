/**
 * El mapa de errores de zod, caso por caso.
 *
 * `tests/integration/errores-en-castellano.test.ts` comprueba lo que importa de
 * verdad —que por la API no salga un texto en inglés— pero solo puede llegar a
 * los códigos que los esquemas reales provocan, que son tres o cuatro.
 *
 * Este archivo ejercita el resto. Es una función pura sobre un objeto de zod, y
 * probarla directamente es lo correcto: montar un endpoint por cada código de
 * error sería inventar una API para poder testear una traducción.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ponerZodEnCastellano } from '@aai/api/http/zod-en-castellano';

/**
 * El primer mensaje que produce un esquema para un valor.
 *
 * Se usa el mapa **global**, que es como lo pone el servidor, y no el que se
 * pasa a `safeParse`. No es un detalle: en zod el mapa contextual tiene más
 * prioridad que el del esquema, y el global menos. Probar con el contextual
 * daría verde en el caso que más importa —`required_error`— midiendo lo
 * contrario de lo que pasa en producción.
 */
function mensajeDe(esquema: z.ZodTypeAny, valor: unknown): string {
  const r = esquema.safeParse(valor);
  expect(r.success, `se esperaba que ${JSON.stringify(valor)} fuera inválido`).toBe(false);
  return r.success ? '' : r.error.issues[0]!.message;
}

describe('los errores de zod, en castellano', () => {
  beforeAll(() => {
    ponerZodEnCastellano();
  });

  it('un campo que falta no dice Required', () => {
    expect(mensajeDe(z.object({ a: z.string() }), {})).toBe('Falta este dato');
  });

  it('un tipo equivocado dice qué se esperaba', () => {
    expect(mensajeDe(z.string(), 42)).toBe('Tiene que ser un texto');
    expect(mensajeDe(z.number(), 'x')).toBe('Tiene que ser un número');
    expect(mensajeDe(z.boolean(), 'x')).toBe('Tiene que ser un valor verdadero o falso');
    expect(mensajeDe(z.array(z.string()), 'x')).toBe('Tiene que ser una lista');
    expect(mensajeDe(z.object({}), 'x')).toBe('Tiene que ser un objeto');
    expect(mensajeDe(z.date(), 'x')).toBe('Tiene que ser una fecha');
  });

  it('un tipo sin nombre en castellano se muestra como viene', () => {
    // La lista de nombres es corta a propósito; lo que no está no se inventa.
    expect(mensajeDe(z.bigint(), 'x')).toBe('Tiene que ser bigint');
  });

  it('un valor fuera del catálogo enumera los que valen', () => {
    const m = mensajeDe(z.enum(['ALTA', 'BAJA']), 'OTRA');
    expect(m).toContain('No es un valor admitido');
    expect(m).toContain('ALTA, BAJA');
  });

  it('los formatos de texto se nombran como los conoce el usuario', () => {
    expect(mensajeDe(z.string().uuid(), 'x')).toBe('No es un identificador válido');
    expect(mensajeDe(z.string().email(), 'x')).toBe('No es una dirección de correo');
    expect(mensajeDe(z.string().url(), 'x')).toBe('No es una dirección web');
    expect(mensajeDe(z.string().regex(/^\d+$/), 'x')).toBe('No tiene el formato esperado');
  });

  it('un formato sin traducción propia cae en el texto de zod', () => {
    // `undefined` sería peor que el mensaje en inglés: dejaría el renglón vacío.
    expect(mensajeDe(z.string().datetime(), 'x')).not.toBe('');
  });

  it('lo demasiado corto se dice según qué es', () => {
    expect(mensajeDe(z.string().min(1), '')).toBe('No puede quedar vacío');
    expect(mensajeDe(z.string().min(3), 'ab')).toBe('Tiene que tener al menos 3 caracteres');
    expect(mensajeDe(z.array(z.string()).min(1), [])).toBe('Tiene que tener al menos un elemento');
    expect(mensajeDe(z.array(z.string()).min(2), ['a'])).toBe(
      'Tiene que tener al menos 2 elementos',
    );
    expect(mensajeDe(z.number().min(10), 5)).toBe('No puede ser menor que 10');
    expect(mensajeDe(z.number().gt(10), 10)).toBe('Tiene que ser mayor que 10');
  });

  it('lo demasiado largo también', () => {
    expect(mensajeDe(z.string().max(2), 'abc')).toBe('No puede tener más de 2 caracteres');
    expect(mensajeDe(z.array(z.string()).max(1), ['a', 'b'])).toBe(
      'No puede tener más de 1 elementos',
    );
    expect(mensajeDe(z.number().max(10), 11)).toBe('No puede ser mayor que 10');
    expect(mensajeDe(z.number().lt(10), 10)).toBe('Tiene que ser menor que 10');
  });

  it('las claves que sobran se enumeran', () => {
    const m = mensajeDe(z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 });
    expect(m).toContain('Sobran estos datos');
    expect(m).toContain('b');
  });

  it('una fecha imposible se dice como fecha', () => {
    expect(mensajeDe(z.date(), new Date('no es una fecha'))).toBe('No es una fecha válida');
  });

  it('un múltiplo que no cierra dice de qué', () => {
    expect(mensajeDe(z.number().multipleOf(5), 7)).toBe('Tiene que ser múltiplo de 5');
  });

  it('el mensaje escrito a mano gana siempre', () => {
    // Es la propiedad que hace que este mapa sea seguro de agregar: zod ni
    // consulta el mapa cuando el esquema declara su propio texto. Si esto
    // fallara, la traducción se habría llevado puestos los mensajes buenos.
    expect(mensajeDe(z.string().min(3, 'El CUIT tiene 11 dígitos'), 'ab')).toBe(
      'El CUIT tiene 11 dígitos',
    );
    expect(mensajeDe(z.string({ required_error: 'Falta el CUIT' }), undefined)).toBe(
      'Falta el CUIT',
    );
  });
});
