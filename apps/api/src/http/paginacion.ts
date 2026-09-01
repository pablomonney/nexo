/**
 * Contrato único de paginación por *keyset*.
 *
 * ## Por qué no `OFFSET`
 *
 * Sobre una lista ordenada por fecha descendente, `OFFSET` **salta y repite**
 * filas cuando entran inserciones concurrentes: si llegan tres documentos
 * mientras alguien mira la página 1, la página 2 arranca tres filas más atrás y
 * tres se pierden sin que nadie se entere. En un sistema donde no ver un
 * comprobante tiene consecuencias, eso no es un detalle de rendimiento.
 *
 * ## La clave
 *
 * El orden es `(campo_de_negocio DESC, id DESC)` y el corte se hace con
 * comparación de tuplas:
 *
 * ```sql
 * WHERE ($1::timestamptz IS NULL OR (received_at, id) < ($1::timestamptz, $2::uuid))
 * ORDER BY received_at DESC, id DESC
 * LIMIT $3 + 1
 * ```
 *
 * El `id` como desempate no es decorativo. Todos los identificadores del sistema
 * son **UUIDv7** —48 bits de timestamp más aleatoriedad— y eso da las dos
 * propiedades que hacen falta:
 *
 * - **totalidad**: `received_at` puede empatar, `(received_at, id)` no, porque
 *   `id` es único. Sin empates no hay filas repetidas ni salteadas;
 * - **correlación temporal**: el desempate ordena aproximadamente por inserción,
 *   así que la página siguiente es la continuación natural y no un salto.
 *
 * Lo que **no** hay que suponer es que UUIDv7 ordene estrictamente por inserción
 * dentro del mismo milisegundo: la cola es aleatoria. No hace falta. Lo que el
 * cursor necesita es un orden total y estable, y comparar dos uuid lo es.
 *
 * ## El cursor no lleva la empresa
 *
 * Codifica la fecha y el id, y nada más. Si llevara `company_id` existirían dos
 * canales para decir a qué empresa pertenece un pedido —la cabecera y el
 * cursor— y algún día no coincidirían. La empresa sale de `X-Company-Id`, la
 * valida `requireCompany` contra `user_company_roles` y la filtra RLS. Siempre.
 *
 * Por eso tampoco se firma: un cursor manipulado solo puede pedir otra posición
 * **dentro de la misma empresa**, porque la cláusula de empresa la pone el
 * servidor. Lo que sí se hace es validarlo antes de usarlo, para que una cadena
 * cualquiera dé 400 y no un error de casteo de PostgreSQL.
 */

import { badRequest } from './errors.js';

/** Página de resultados con su cursor de continuación. */
export interface Pagina<T> {
  readonly items: readonly T[];
  /** `null` cuando no hay más. Nunca una cadena vacía: eso sería ambiguo. */
  readonly cursor: string | null;
  readonly limite: number;
}

export interface ClaveDeOrden {
  /** Fecha o timestamp del campo de negocio por el que se ordena. */
  readonly fecha: Date | string;
  readonly id: string;
}

/** Lo que el cursor transporta, ya validado. */
export interface CorteDeCursor {
  readonly fecha: string;
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `2026-08-29` o `2026-08-29T12:34:56.789Z`.
 *
 * Se valida acá y no se delega en el casteo de PostgreSQL: un `::timestamptz`
 * sobre basura devuelve SQLSTATE 22007, que el manejador de errores traduciría a
 * un 500. Un cursor mal formado es un pedido mal formado.
 */
const FECHA = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?)?$/;

const SEPARADOR = '|';

function aTexto(fecha: Date | string): string {
  return fecha instanceof Date ? fecha.toISOString() : fecha;
}

/** Codifica el corte como base64url. Opaco para el cliente, a propósito. */
export function codificarCursor(clave: ClaveDeOrden): string {
  return Buffer.from(`${aTexto(clave.fecha)}${SEPARADOR}${clave.id}`, 'utf8').toString('base64url');
}

/**
 * Decodifica y valida. Lanza 400 ante cualquier cosa que no sea exactamente
 * `<fecha>|<uuid>`: no se le pasa a la base nada que no se haya mirado.
 */
export function decodificarCursor(crudo: string): CorteDeCursor {
  // `Buffer.from(x, 'base64url')` no lanza ante basura: devuelve los bytes que
  // pueda. El `catch` queda por defensa —una entrada gigante puede fallar por
  // memoria— pero quien rechaza de verdad es la validación de abajo.
  let plano: string;
  try {
    plano = Buffer.from(crudo, 'base64url').toString('utf8');
  } catch {
    throw badRequest('El cursor no es válido');
  }

  const partes = plano.split(SEPARADOR);
  if (partes.length !== 2) throw badRequest('El cursor no es válido');

  const [fecha, id] = partes as [string, string];
  if (!FECHA.test(fecha) || !UUID.test(id)) throw badRequest('El cursor no es válido');

  return { fecha, id };
}

/** `undefined` si no vino cursor; el corte validado si vino. */
export function corteDe(cursor: string | undefined): CorteDeCursor | undefined {
  return cursor === undefined || cursor === '' ? undefined : decodificarCursor(cursor);
}

/**
 * Los dos parámetros que van a la consulta, en el orden en que se escriben.
 *
 * Se devuelven como `null` cuando no hay cursor para que la condición
 * `$n IS NULL OR …` sirva igual en la primera página y en las siguientes: una
 * sola consulta, sin ramas.
 */
export function parametrosDeCorte(corte: CorteDeCursor | undefined): [string | null, string | null] {
  return corte === undefined ? [null, null] : [corte.fecha, corte.id];
}

/**
 * Arma la página a partir de `limite + 1` filas pedidas.
 *
 * Se pide una de más para saber si hay página siguiente sin contar el total. No
 * se devuelve `total`: contarlo exige un segundo barrido en cada página y, sobre
 * una lista que crece mientras se la mira, es un número que envejece antes de
 * llegar al cliente.
 */
export function armarPagina<T>(
  filas: readonly T[],
  limite: number,
  clave: (fila: T) => ClaveDeOrden,
): Pagina<T> {
  const hayMas = filas.length > limite;
  const items = hayMas ? filas.slice(0, limite) : filas;
  const ultimo = items[items.length - 1];

  return {
    items,
    cursor: hayMas && ultimo !== undefined ? codificarCursor(clave(ultimo)) : null,
    limite,
  };
}
