/**
 * De tokens a plata.
 *
 * `ai_predictions.cost_micros` existe desde la 0007 y hasta ahora no lo escribía
 * nadie, porque no había de dónde sacar el precio. Este archivo es la cuenta, y
 * lo único que hace es multiplicar — pero hay tres decisiones adentro.
 *
 * **1. Sin precio, `null`.** No cero. Un costo cero se suma en un informe y no
 * se distingue de una llamada gratis; un `null` obliga a decir «de estas N
 * llamadas, M no tienen precio declarado», que es la verdad.
 *
 * **2. Sin uso, `null`.** Si el proveedor no informó tokens, no hay con qué
 * multiplicar. Estimar por el largo del prompt daría un número plausible y
 * equivocado.
 *
 * **3. Enteros.** Los precios se declaran en micros por cada mil tokens y la
 * cuenta se hace en enteros. Un precio en punto flotante multiplicado por
 * millones de tokens acumula error, y este número termina en un informe de
 * costos que alguien va a comparar contra una factura.
 *
 * El redondeo es **hacia arriba**, por la misma razón que se elige un redondeo
 * en cualquier lado: hay que elegir uno y decirlo. Subestimar sistemáticamente
 * el costo propio es el error más caro de los dos.
 */

import type { UsoDelModelo } from './contracts.js';

export interface PrecioDelModelo {
  /** Micros de la moneda del proveedor por cada mil tokens de entrada. */
  readonly inputMicrosPorMil: number;
  readonly outputMicrosPorMil: number;
}

/**
 * El costo en micros, o `null` cuando no se puede afirmar.
 *
 * Determinística y sin estado: los mismos tokens con el mismo precio dan
 * siempre lo mismo, que es la condición para poder rehacer la cuenta.
 */
export function calcularCostoEnMicros(
  uso: UsoDelModelo | null | undefined,
  precio: PrecioDelModelo | null,
): number | null {
  if (uso === null || uso === undefined) return null;
  if (precio === null) return null;

  // `ceil` por parte y no sobre el total: cada tramo se factura por separado, y
  // sumar dos redondeos es lo que hace una factura.
  const entrada = Math.ceil((uso.tokensDeEntrada * precio.inputMicrosPorMil) / 1000);
  const salida = Math.ceil((uso.tokensDeSalida * precio.outputMicrosPorMil) / 1000);
  return entrada + salida;
}
