/**
 * El tipo de entidad de una empresa: los doce que admite la base, con su nombre.
 *
 * ## Por qué existe este archivo
 *
 * La lista vivía en tres lugares y **ninguno de los tres era el mismo**:
 * `companies.entity_type` (0002) admite doce valores; `studio.ts` los repetía a
 * mano; y `onboarding.ts` —la única pantalla desde la que se crea una empresa—
 * tenía siete, dos de ellos inventados: `ASOCIACION` en vez de `ASOC_CIVIL`, y
 * un `OTRO` que la base no admite. Elegir cualquiera de esos dos devolvía
 * `INTERNAL_ERROR` en el primer formulario del producto.
 *
 * No es la primera vez que se detecta esa lista inventada: el comentario de
 * `TipoEnte`, en `@aai/financial-statements`, ya la describe con esas palabras
 * —«seis valores inventados desde la intuición»— y la corrigió **en su
 * paquete**. `onboarding.ts` era la última copia sobreviviente. Por eso la lista
 * ahora vive acá, y los demás la importan en vez de repetirla.
 *
 * ## Código canónico adentro, nombre humano afuera
 *
 * El `value` que viaja por la API y se guarda en la base es el código —`SA_299`,
 * `ASOC_CIVIL`—, y lo que lee una persona es la etiqueta. Separarlos es lo que
 * permite escribir «Sociedad del art. 299 LGS» en la pantalla sin que eso se
 * convierta en un valor nuevo el día que alguien mejore la redacción.
 *
 * ## El orden no es alfabético y no es casual
 *
 * Es el de frecuencia esperada en un estudio contable argentino: lo que se da
 * de alta todos los días arriba, y las figuras infrecuentes abajo. Un
 * desplegable ordenado por el `CHECK` de la migración obligaría a buscar `SRL`
 * en el medio de la lista.
 */

/** Los doce de `companies.entity_type`, ni uno más. */
export const TIPOS_DE_ENTIDAD = [
  'SA',
  'SRL',
  'SAS',
  'UNIPERSONAL',
  'SA_299',
  'SOCIEDAD_SIMPLE',
  'ASOC_CIVIL',
  'FUNDACION',
  'MUTUAL',
  'COOPERATIVA',
  'SUCURSAL_EXTRANJERA',
  'FIDEICOMISO',
] as const;

export type TipoDeEntidad = (typeof TIPOS_DE_ENTIDAD)[number];

/**
 * Cómo se llama cada uno en una pantalla.
 *
 * Es un mapa cerrado sobre el tipo: agregar un código sin su nombre no compila.
 */
export const ETIQUETA_DE_ENTIDAD: Readonly<Record<TipoDeEntidad, string>> = {
  SA: 'Sociedad Anónima',
  SRL: 'Sociedad de Responsabilidad Limitada',
  SAS: 'Sociedad por Acciones Simplificada',
  UNIPERSONAL: 'Unipersonal',
  SA_299: 'Sociedad Anónima del art. 299 LGS',
  SOCIEDAD_SIMPLE: 'Sociedad simple (Secc. IV LGS)',
  ASOC_CIVIL: 'Asociación Civil',
  FUNDACION: 'Fundación',
  MUTUAL: 'Mutual',
  COOPERATIVA: 'Cooperativa',
  SUCURSAL_EXTRANJERA: 'Sucursal de sociedad extranjera',
  FIDEICOMISO: 'Fideicomiso',
};

/*
 * Acá había un `esTipoDeEntidad`, escrito por simetría con el organismo y la
 * jurisdicción. Lo sacó el control S-16: esos dos se usan en los `refine` de la
 * ruta, y este no tenía a quién —el tipo de entidad se valida con
 * `z.enum(TIPOS_DE_ENTIDAD)`, que no necesita un predicado—. Una función
 * exportada que solo usan sus tests es código muerto con coartada.
 */

/** El catálogo para armar un desplegable: código y nombre, en orden. */
export const CATALOGO_DE_ENTIDADES: readonly { readonly codigo: TipoDeEntidad; readonly etiqueta: string }[] =
  TIPOS_DE_ENTIDAD.map((codigo) => ({ codigo, etiqueta: ETIQUETA_DE_ENTIDAD[codigo] }));
