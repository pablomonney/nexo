/**
 * Por dónde puede pasar una migración, y por dónde no.
 *
 * ## Por qué es una máquina y no un campo de texto
 *
 * Los pasos importan en orden. Importar sin haber validado, o validar sin haber
 * mapeado, produce una empresa a medio cargar que después hay que reconstruir a
 * mano. La transición vive acá y la base la vuelve a exigir con un CHECK: dos
 * candados, porque el de la aplicación se saltea llamando a otra ruta.
 *
 * ## Las tres formas de terminar
 *
 * `COMPLETADA` y `COMPLETADA_CON_ADVERTENCIAS` son distintas a propósito. La
 * segunda importó todo y algo quedó dicho —un duplicado que alguien resolvió,
 * un campo opcional ilegible— y esa diferencia es lo que alguien mira seis
 * meses después cuando un saldo no cierra.
 *
 * `REVERTIDA` no es un fracaso: es una migración que se deshizo entera. Se
 * distingue de `FALLIDA`, que es la que se cortó y **no** se pudo deshacer.
 */

/**
 * ## Por qué no hay un estado `ANALIZADA`
 *
 * La primera versión de esta tabla lo tenía, entre `CARGADA` y `MAPEADA`, por
 * analogía con los asistentes de importación que analizan el archivo en un paso
 * aparte. Acá el análisis —adivinar la entidad y proponer el mapeo— lo hace el
 * adaptador **durante** la carga, así que ningún camino del código llegaba a ese
 * estado y `CARGADA → MAPEADA`, que es la transición que sí ocurre, no estaba
 * permitida. La primera migración real no pudo declarar su mapeo.
 *
 * El CHECK de la 0111 todavía admite el valor. No molesta: un CHECK limita lo
 * que se puede escribir, no obliga a escribirlo.
 */
export const ESTADOS = [
  'CREADA',
  'CARGADA',
  'MAPEADA',
  'CANCELACION_PEDIDA',
  'CANCELADA',
  'VALIDADA',
  'LISTA',
  'IMPORTANDO',
  'COMPLETADA',
  'COMPLETADA_CON_ADVERTENCIAS',
  'FALLIDA',
  'REVERTIDA',
] as const;

export type Estado = (typeof ESTADOS)[number];

/**
 * A dónde se puede ir desde cada estado.
 *
 * Volver atrás está permitido hasta `LISTA` —cambiar el mapeo obliga a validar
 * de nuevo, y eso es sano— y prohibido después: una vez que se empezó a
 * escribir en la empresa, el único camino es terminar o revertir.
 */
const TRANSICIONES: Readonly<Record<Estado, readonly Estado[]>> = {
  CREADA: ['CARGADA', 'FALLIDA'],
  // No se vuelve a `CARGADA`: cargar otro archivo sobre una migración cargada
  // arrastraría las filas crudas, y esas no se destruyen. Se hace una nueva.
  CARGADA: ['MAPEADA', 'FALLIDA'],
  MAPEADA: ['VALIDADA', 'MAPEADA', 'FALLIDA'],
  // De VALIDADA solo se pasa a LISTA si no hay errores; eso lo decide el
  // llamador con el veredicto en la mano, no esta tabla.
  VALIDADA: ['LISTA', 'MAPEADA', 'FALLIDA'],
  LISTA: ['IMPORTANDO', 'MAPEADA', 'FALLIDA'],
  // `IMPORTANDO → IMPORTANDO` es lo que hace reanudable una importación por
  // tandas: quedaron tandas sin correr y volver a llamar sigue desde ahí.
  IMPORTANDO: [
    'IMPORTANDO',
    'CANCELACION_PEDIDA',
    'COMPLETADA',
    'COMPLETADA_CON_ADVERTENCIAS',
    'FALLIDA',
  ],
  // Se pide la cancelación y el importador la efectiviza al terminar la tanda
  // en curso. Que pueda volver a COMPLETADA no es una contradicción: si el
  // pedido llegó cuando ya no quedaba nada, la migración terminó bien.
  CANCELACION_PEDIDA: [
    'CANCELADA',
    'IMPORTANDO',
    'COMPLETADA',
    'COMPLETADA_CON_ADVERTENCIAS',
    'FALLIDA',
  ],
  // Lo que alcanzó a entrar sigue en la empresa: cancelar no es revertir.
  CANCELADA: ['REVERTIDA', 'IMPORTANDO'],
  // Una migración terminada se puede revertir; una fallida también, porque
  // pudo haber escrito algo antes de cortarse.
  COMPLETADA: ['REVERTIDA'],
  COMPLETADA_CON_ADVERTENCIAS: ['REVERTIDA'],
  FALLIDA: ['REVERTIDA'],
  REVERTIDA: [],
};

export function puedeTransicionar(desde: Estado, hasta: Estado): boolean {
  return (TRANSICIONES[desde] ?? []).includes(hasta);
}

/** Los estados desde los que todavía no se escribió nada en la empresa. */
export const ANTES_DE_TOCAR_DATOS: readonly Estado[] = [
  'CREADA', 'CARGADA', 'MAPEADA', 'VALIDADA', 'LISTA',
];

export const esTerminal = (e: Estado): boolean =>
  e === 'COMPLETADA' ||
  e === 'COMPLETADA_CON_ADVERTENCIAS' ||
  e === 'FALLIDA' ||
  e === 'REVERTIDA' ||
  // Cancelada es terminal aunque quede trabajo sin hacer: lo que entró, entró.
  e === 'CANCELADA';

/**
 * Con qué estado termina una importación.
 *
 * Se decide con las advertencias, no con los errores: una migración con errores
 * nunca llegó a importar, porque `LISTA` exige cero.
 */
export function comoTermina(advertencias: number): Estado {
  return advertencias > 0 ? 'COMPLETADA_CON_ADVERTENCIAS' : 'COMPLETADA';
}
