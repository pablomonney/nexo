/**
 * Result — el motor contable devuelve errores, no los lanza.
 *
 * El destinatario de un rechazo es un contador que necesita saber QUÉ corregir, y suele
 * haber más de un problema a la vez. Una excepción entrega el primero y descarta el
 * resto; un Result los entrega todos.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

