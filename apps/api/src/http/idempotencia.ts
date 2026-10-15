/**
 * Idempotencia de las operaciones que crean un movimiento de caja o de stock.
 *
 * Diseño completo: `docs/DISENO_IDEMPOTENCIA.md`. En una línea: la clave que manda el cliente viaja dentro de la fila
 * del movimiento, y un índice único de la tabla decide. El `INSERT … ON CONFLICT DO NOTHING` es el árbitro; no hay
 * una tabla de claves aparte ni un estado «en curso» que pueda quedar colgado.
 *
 * ## Qué hace una repetición
 *
 *   · misma clave, mismos datos  → `200` con el MISMO cuerpo que la primera vez y `Idempotent-Replayed: true`.
 *     No escribe nada: ni otra fila, ni otra entrada de bitácora.
 *   · misma clave, otros datos   → `422 IDEMPOTENCIA_CONFLICTO`. No escribe nada.
 *   · sin clave, o con una que no tiene la forma → `400`. La clave es obligatoria: una opcional deja el riesgo en manos
 *     de cada cliente.
 *
 * ## Por qué la base y no el código
 *
 * Con dos peticiones idénticas en el mismo instante, la segunda espera en el índice único hasta que la primera
 * confirma (o se revierte), y recién entonces sigue. No hay una ventana entre «preguntar si existe» e «insertar» en la
 * que meterse: es una sola sentencia.
 */

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { badRequest, unprocessable } from './errors.js';

export const ENCABEZADO_DE_CLAVE = 'idempotency-key';

/** De 16 a 128 caracteres de `[A-Za-z0-9_-]`: lo que la base acepta (`*_clave_valida`). */
const FORMA_DE_LA_CLAVE = /^[A-Za-z0-9_-]{16,128}$/u;

/** Las tablas que llevan clave de idempotencia. Una lista cerrada: el nombre se interpola en SQL. */
export type TablaConClave = 'cash_movements' | 'stock_movements' | 'cash_sessions';

/** Lo mínimo de una transacción que este módulo necesita. */
interface Tx {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * La clave del encabezado `Idempotency-Key`, o `400` si falta o no tiene la forma.
 *
 * El mensaje dice qué hacer, porque quien lo lee es un integrador o la consola, y ninguno de los dos tiene que adivinar.
 */
export function claveDeIdempotencia(request: FastifyRequest): string {
  const bruta = request.headers[ENCABEZADO_DE_CLAVE];
  const valor = Array.isArray(bruta) ? bruta[0] : bruta;

  if (valor === undefined || valor === '') {
    throw badRequest(
      'Falta el encabezado Idempotency-Key. Esta operación crea un movimiento y puede reintentarse por un ' +
        'corte de red: mandá una clave única por operación (por ejemplo un UUID) y reutilizala en cada reintento ' +
        'de ESA misma operación. Si lo ves en la consola, recargá la página: tenías abierta una versión anterior.',
    );
  }
  if (!FORMA_DE_LA_CLAVE.test(valor)) {
    throw badRequest(
      'La Idempotency-Key no tiene la forma esperada: de 16 a 128 caracteres entre letras, números, guion y ' +
        'guion bajo (un UUID sirve).',
    );
  }
  return valor;
}

/** JSON con las claves ordenadas, para que el mismo contenido dé siempre el mismo texto. */
function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  const claves = Object.keys(valor as Record<string, unknown>)
    .filter((k) => (valor as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * La huella de una operación: el SHA-256 de su nombre y sus datos canonizados.
 *
 * Distingue un reintento (mismo contenido) de un error de uso (la misma clave con otro contenido). Entran los datos que
 * definen la operación —incluida la empresa y los identificadores de la URL—, no los de la sesión ni los encabezados.
 */
export function huellaDeLaOperacion(operacion: string, datos: unknown): string {
  return createHash('sha256').update(canonico({ operacion, datos })).digest('hex');
}

/**
 * Serializa las peticiones que llevan la misma clave, hasta que termine la transacción.
 *
 * Hace falta SOLO donde la tabla tiene otro índice único además del de la clave (la apertura de sesión de caja:
 * `cs_una_abierta_por_caja`). Con dos índices, `ON CONFLICT (clave) DO NOTHING` no alcanza: dos pedidos idénticos
 * simultáneos pueden cruzarse de modo que el segundo no vea todavía la entrada del primero en el índice de la clave
 * pero choque con ella en el otro índice, y reciba un 409 «ya hay una sesión abierta» en lugar de la repetición.
 * Medido el 2026-10-15: 2 de 320 pedidos idénticos simultáneos. Con este candado el segundo ESPERA a que el primero
 * confirme, y recién entonces inserta (y recibe `DO NOTHING`).
 *
 * En las tablas de movimientos, que solo tienen el índice de la clave, el propio índice serializa y no se usa.
 */
export async function serializarPorClave(tx: Tx, empresaId: string, clave: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`idempotencia:${empresaId}:${clave}`]);
}

export interface FilaConClave {
  readonly id: string;
  readonly parte: number;
  readonly huella: string;
}

/** Las filas de una operación, en el orden en que se crearon sus partes. */
export async function filasPorClave(
  tx: Tx,
  tabla: TablaConClave,
  empresaId: string,
  clave: string,
): Promise<FilaConClave[]> {
  const columnaParte = tabla === 'cash_sessions' ? '0' : 'idempotency_part';
  const r = await tx.query<{ id: string; parte: number; huella: string }>(
    `SELECT id, ${columnaParte}::int AS parte, request_hash AS huella
       FROM ${tabla}
      WHERE company_id = $1 AND idempotency_key = $2
      ORDER BY parte, id`,
    [empresaId, clave],
  );
  return r.rows;
}

/**
 * Si las filas que ya existen para la clave son de OTRA operación, `422`.
 *
 * Se llama solo cuando la inserción no escribió nada (la clave ya existía): ahí hay que decidir si es un reintento o
 * un error. La base no puede decidirlo sola porque no sabe qué datos «son la misma operación».
 */
export function exigirLaMismaOperacion(filas: readonly FilaConClave[], huella: string): void {
  if (filas.length === 0) {
    // La clave estaba y ya no está: la operación original se revirtió entre las dos lecturas. El cliente puede
    // reintentar con la misma clave y se ejecutará normalmente.
    throw unprocessable(
      'IDEMPOTENCIA_RESULTADO_INCIERTO',
      'No se pudo confirmar el resultado de la operación anterior con esta clave. Reintentala con la misma ' +
        'Idempotency-Key: si no llegó a registrarse, se registra ahora; si ya estaba, se devuelve lo que se hizo.',
    );
  }
  if (filas.some((f) => f.huella !== huella)) {
    throw unprocessable(
      'IDEMPOTENCIA_CONFLICTO',
      'Esa Idempotency-Key ya se usó para otra operación (otros datos). No se registró nada. Una clave identifica ' +
        'UNA operación: si querés hacer otra, usá una clave nueva.',
    );
  }
}

/** Marca la respuesta como una repetición: `200` con el mismo cuerpo y el encabezado que lo avisa. */
export function responderRepeticion(reply: FastifyReply): void {
  reply.code(200);
  reply.header('Idempotent-Replayed', 'true');
}
