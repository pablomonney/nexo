/**
 * Los mensajes por defecto de zod, en castellano.
 *
 * Casi todos los esquemas de la API traen su mensaje escrito —«El dígito
 * verificador del CUIT no cierra»— y esos no los toca nadie: son mejores que
 * cualquier texto genérico y explican qué corregir, que es lo que se le pide a
 * un error acá.
 *
 * Lo que se cuela es el **caso que nadie escribió**. Un campo que falta sale
 * como `Required`, y así llega a la pantalla. La auditoría del 2026-09-09 lo vio
 * en la consola, al lado de un mensaje en castellano:
 *
 *     Datos inválidos
 *       roles: Required
 *
 * Es el mismo defecto que el volcado de JSON, más chico: el sistema hablándole
 * al usuario en su propio idioma técnico. Se arregla en un solo lugar porque el
 * problema es de un solo lugar — el mapa por defecto, no los esquemas.
 *
 * **Solo se traducen los códigos, no los mensajes escritos a mano.** Cuando un
 * esquema declara su propio `message`, zod ni consulta este mapa. Y de los
 * códigos se traducen los que un usuario puede provocar; para los que no se
 * cubren se devuelve `undefined`, que le dice a zod «usá el tuyo» en vez de
 * inventar una traducción aproximada.
 */

import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

/** Cómo se nombra un tipo de dato en una frase. */
const TIPOS: Readonly<Record<string, string>> = {
  string: 'un texto',
  number: 'un número',
  boolean: 'un valor verdadero o falso',
  array: 'una lista',
  object: 'un objeto',
  date: 'una fecha',
  integer: 'un número entero',
};

const nombreDe = (t: string): string => TIPOS[t] ?? t;

export const mapaEnCastellano: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      // El caso que motivó todo esto: `Required`.
      return issue.received === 'undefined'
        ? { message: 'Falta este dato' }
        : { message: `Tiene que ser ${nombreDe(issue.expected)}` };

    case ZodIssueCode.invalid_enum_value:
      return {
        message: `No es un valor admitido. Los que valen son: ${issue.options.join(', ')}`,
      };

    case ZodIssueCode.invalid_string:
      if (issue.validation === 'uuid') return { message: 'No es un identificador válido' };
      if (issue.validation === 'email') return { message: 'No es una dirección de correo' };
      if (issue.validation === 'url') return { message: 'No es una dirección web' };
      if (issue.validation === 'regex') return { message: 'No tiene el formato esperado' };
      return { message: ctx.defaultError };

    case ZodIssueCode.too_small: {
      const { minimum, type, inclusive } = issue;
      if (type === 'string') {
        return minimum === 1
          ? { message: 'No puede quedar vacío' }
          : { message: `Tiene que tener al menos ${String(minimum)} caracteres` };
      }
      if (type === 'array') {
        return minimum === 1
          ? { message: 'Tiene que tener al menos un elemento' }
          : { message: `Tiene que tener al menos ${String(minimum)} elementos` };
      }
      return {
        message: inclusive
          ? `No puede ser menor que ${String(minimum)}`
          : `Tiene que ser mayor que ${String(minimum)}`,
      };
    }

    case ZodIssueCode.too_big: {
      const { maximum, type, inclusive } = issue;
      if (type === 'string') {
        return { message: `No puede tener más de ${String(maximum)} caracteres` };
      }
      if (type === 'array') {
        return { message: `No puede tener más de ${String(maximum)} elementos` };
      }
      return {
        message: inclusive
          ? `No puede ser mayor que ${String(maximum)}`
          : `Tiene que ser menor que ${String(maximum)}`,
      };
    }

    case ZodIssueCode.unrecognized_keys:
      return { message: `Sobran estos datos: ${issue.keys.join(', ')}` };

    case ZodIssueCode.invalid_date:
      return { message: 'No es una fecha válida' };

    case ZodIssueCode.not_multiple_of:
      return { message: `Tiene que ser múltiplo de ${String(issue.multipleOf)}` };

    default:
      // Lo que no está previsto lo contesta zod. Inventarle una traducción
      // aproximada a un código que no se pensó sería reemplazar un mensaje raro
      // en inglés por uno raro en castellano.
      return { message: ctx.defaultError };
  }
};

/** Se llama una vez, al construir el servidor. */
export function ponerZodEnCastellano(): void {
  z.setErrorMap(mapaEnCastellano);
}
