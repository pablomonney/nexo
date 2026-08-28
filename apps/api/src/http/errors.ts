/**
 * Errores HTTP con forma estable.
 *
 * Los mensajes de autenticación son deliberadamente vagos ("credenciales
 * inválidas" y no "ese usuario no existe"): distinguirlos convierte el login en
 * un oráculo para enumerar cuentas del estudio.
 */

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'No autenticado'): HttpError =>
  new HttpError(401, 'UNAUTHORIZED', message);

export const invalidCredentials = (): HttpError =>
  new HttpError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');

export const mfaRequired = (): HttpError =>
  new HttpError(401, 'MFA_REQUIRED', 'Falta completar el segundo factor');

export const forbidden = (message = 'No autorizado'): HttpError =>
  new HttpError(403, 'FORBIDDEN', message);

/**
 * Se usa también cuando el recurso existe pero pertenece a otra empresa.
 *
 * Devolver 403 en ese caso confirmaría su existencia, que ya es información
 * sobre la contabilidad de otro cliente del estudio. Para quien pregunta, no
 * existe.
 */
export const notFound = (message = 'No encontrado'): HttpError =>
  new HttpError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown): HttpError =>
  new HttpError(409, 'CONFLICT', message, details);

/**
 * 409 con un código del catálogo cerrado en vez del genérico `CONFLICT`.
 *
 * Existe porque hay conflictos que quien los recibe tiene que poder distinguir
 * sin leer el mensaje: cerrar un ejercicio ya cerrado y pedir una apertura sobre
 * uno que sigue abierto son los dos 409 y mandan a hacer cosas distintas.
 */
export const conflictoTipado = (code: string, message: string, details?: unknown): HttpError =>
  new HttpError(409, code, message, details);

/**
 * 422 — la petición se entiende y las reglas del dominio la rechazan.
 *
 * Distinto de 400: los datos son válidos y están completos. Lo que falla es una
 * regla contable, y el `code` dice cuál.
 */
export const unprocessable = (code: string, message: string, details?: unknown): HttpError =>
  new HttpError(422, code, message, details);

export const tooManyRequests = (message: string): HttpError =>
  new HttpError(429, 'TOO_MANY_REQUESTS', message);
