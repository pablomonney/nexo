/**
 * El organismo de contralor de una empresa.
 *
 * ## Por qué esto es un módulo y no un `z.enum` escrito en cada ruta
 *
 * `companies.regulator` lleva un `CHECK` desde la 0002 y admite **cinco
 * valores, en mayúsculas**. Esa lista estaba copiada a mano en `studio.ts` y
 * **faltaba** en `onboarding.ts`, que aceptaba texto libre de hasta cuarenta
 * caracteres. El resultado, medido en producción el 2026-09-18: escribir `igj`
 * en minúsculas en la pantalla de alta devolvía
 * `{"error":"INTERNAL_ERROR","message":"Error interno"}` —un 500— en el primer
 * formulario que completa un cliente. La base rechazaba la fila con un `23514`
 * y nadie lo traducía.
 *
 * Dos copias de una lista se desincronizan y nadie lo nota, porque las dos
 * siguen contestando. Acá vive una sola, y la usan la validación de las rutas y
 * el desplegable de la consola.
 *
 * ## «Sin organismo» es NULL, no un valor
 *
 * Muchas sociedades no tienen organismo de contralor, y eso **no** se escribe
 * como `NINGUNO`: la columna es nullable y `create_company` hace
 * `nullif(p_regulator, '')`. El conjunto de acá no incluye un sexto valor a
 * propósito — el de `financial-statements` sí lo tiene, pero ahí es otra
 * columna, que es `NOT NULL` y necesita nombrar la ausencia.
 *
 * ## Qué normaliza, y qué deliberadamente no
 *
 * Se recortan los espacios de los extremos y se pasa a mayúsculas: `  igj  ` es
 * `IGJ` escrito con descuido, no otro organismo, y rechazarlo sería pedantería.
 *
 * **Los espacios internos no se tocan**, así que `I G J` **no** es válido. No es
 * un olvido: colapsarlos sería adivinar qué quiso escribir alguien, y una
 * corrección silenciosa sobre un dato registral es peor que un rechazo que dice
 * cuáles son los cinco valores. La consola ofrece un desplegable justamente
 * para que nadie tenga que acertarle tipeando.
 */

/** Los cinco que admite `companies.regulator`. El orden es el de la migración. */
export const ORGANISMOS_DE_CONTRALOR = ['IGJ', 'CNV', 'BCRA', 'INAES', 'PROVINCIAL'] as const;

export type OrganismoDeContralor = (typeof ORGANISMOS_DE_CONTRALOR)[number];

/** Para los mensajes de error: la lista, tal como hay que escribirla. */
export const ORGANISMOS_EN_TEXTO = ORGANISMOS_DE_CONTRALOR.join(', ');

/** Recorta y pasa a mayúsculas. No colapsa espacios internos: ver arriba. */
export function normalizarOrganismo(valor: string): string {
  return valor.trim().toUpperCase();
}

export function esOrganismoDeContralor(valor: string): valor is OrganismoDeContralor {
  return (ORGANISMOS_DE_CONTRALOR as readonly string[]).includes(valor);
}

/**
 * Lo que se le dice a quien escribió cualquier otra cosa.
 *
 * Nombra los cinco valores y la salida —dejarlo vacío— porque un mensaje que
 * solo dice «inválido» obliga a adivinar, y acá lo que hay que saber es corto.
 */
export const MENSAJE_DE_ORGANISMO =
  `El organismo de contralor tiene que ser uno de: ${ORGANISMOS_EN_TEXTO}. ` +
  'Si la empresa no tiene organismo, dejá el campo vacío.';
