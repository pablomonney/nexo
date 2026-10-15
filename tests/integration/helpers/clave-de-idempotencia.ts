/**
 * El encabezado `Idempotency-Key` para las suites que ejercitan caja y stock.
 *
 * Las operaciones que crean un movimiento lo exigen (docs/DISENO_IDEMPOTENCIA.md). Las suites viejas llaman a esos
 * endpoints decenas de veces para armar su escenario, y a ellas no les interesa la idempotencia: les interesa el
 * movimiento. Este helper agrega una clave NUEVA por petición, así cada llamada sigue siendo una operación distinta,
 * que es lo que esas suites daban por supuesto.
 *
 * Las pruebas que sí hablan de idempotencia (`idempotencia.test.ts`, `transiciones-concurrentes.test.ts`) mandan la
 * clave a mano, porque ahí lo que se prueba es justamente cuándo se repite y cuándo no.
 */

import { randomUUID } from 'node:crypto';

/** Las rutas que crean un movimiento y por lo tanto exigen clave. */
const EXIGEN_CLAVE: readonly RegExp[] = [
  /^\/cash-sessions$/u,
  /^\/cash-sessions\/[^/]+\/movimientos$/u,
  /^\/stock-movements\/(salida|ajuste|transferencia)$/u,
  /^\/tax-transactions\/[^/]+\/salida$/u,
];

/** `{ 'idempotency-key': <uuid nuevo> }` si la petición lo exige; `{}` si no. */
export function cabeceraDeClave(method: string, url: string): Record<string, string> {
  if (method !== 'POST') return {};
  const ruta = url.split('?')[0]!;
  return EXIGEN_CLAVE.some((r) => r.test(ruta)) ? { 'idempotency-key': randomUUID() } : {};
}
