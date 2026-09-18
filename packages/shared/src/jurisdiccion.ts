/**
 * La jurisdicción de una empresa: código ISO 3166-2:AR y nombre.
 *
 * ## Dos barreras, y la de afuera es la más chica
 *
 * `companies.jurisdiction` exige la **forma** `^AR(-[A-Z])?$` desde la 0002:
 * `AR` para lo nacional, o `AR-` más una letra. Eso es una forma, no una lista:
 * la base acepta `AR-I` y `AR-O`, que ISO no asignó.
 *
 * El alta ofrece **tres códigos**, que son los únicos que el sistema usa hoy —
 * los que aparecen en las migraciones, en las adopciones jurisdiccionales y en
 * las reglas del motor normativo—. No son «las jurisdicciones de Argentina»:
 * son las que NEXO puede resolver. Publicar veinticuatro sería ofrecer
 * veintiuna sobre las que el motor normativo todavía no tiene nada que decir.
 *
 * Por eso se valida contra las dos: primero la forma —la barrera que comparte
 * con la base, la que impide un `23514`— y después el conjunto, que es la
 * decisión de producto y puede crecer sin tocar la base. Cuando se amplíe, se
 * amplía acá; el `CHECK` ya lo admite.
 *
 * ## `ar-c` es `AR-C` escrito con apuro
 *
 * Se recorta y se pasa a mayúsculas antes de validar, por el mismo motivo que
 * el organismo de contralor: rechazar a alguien porque escribió en minúsculas
 * no protege ningún dato.
 */

/** La forma que exige la columna. Segunda barrera, y la que evita el 23514. */
export const FORMA_DE_JURISDICCION = /^AR(-[A-Z])?$/u;

export const JURISDICCIONES = ['AR', 'AR-C', 'AR-B'] as const;

export type Jurisdiccion = (typeof JURISDICCIONES)[number];

export const ETIQUETA_DE_JURISDICCION: Readonly<Record<Jurisdiccion, string>> = {
  AR: 'Nacional',
  'AR-C': 'Ciudad Autónoma de Buenos Aires',
  'AR-B': 'Buenos Aires',
};

/** Recorta y pasa a mayúsculas: `  ar-c ` es `AR-C`. */
export function normalizarJurisdiccion(valor: string): string {
  return valor.trim().toUpperCase();
}

export function esJurisdiccion(valor: string): valor is Jurisdiccion {
  return (JURISDICCIONES as readonly string[]).includes(valor);
}

/** El catálogo para armar un desplegable: código y nombre, en orden. */
export const CATALOGO_DE_JURISDICCIONES: readonly {
  readonly codigo: Jurisdiccion;
  readonly etiqueta: string;
}[] = JURISDICCIONES.map((codigo) => ({ codigo, etiqueta: ETIQUETA_DE_JURISDICCION[codigo] }));

/** Lo que se le dice a quien mandó otra cosa: los tres, con su nombre. */
export const MENSAJE_DE_JURISDICCION =
  'La jurisdicción tiene que ser una de: ' +
  CATALOGO_DE_JURISDICCIONES.map((j) => `${j.codigo} (${j.etiqueta})`).join(', ') +
  '.';
