/**
 * Períodos de facturación y prorrateo.
 *
 * Funciones puras sobre fechas e importes. No saben qué es una suscripción ni
 * cómo se guarda: reciben un tramo y devuelven otro. Es la condición para poder
 * probarlas de forma exhaustiva, y el lint de arquitectura la impone
 * (`dominio-sin-io`).
 *
 * ## Por qué el período es cerrado en los dos extremos
 *
 * `[desde, hasta]`, con `hasta` incluido. La alternativa —cerrado-abierto,
 * `[desde, hasta)`— es más limpia para componer y peor para lo que este sistema
 * hace con el dato: el período aparece impreso en un documento de cobro que
 * alguien lee, y «del 1 al 31 de enero» es lo que espera leer. Un `hasta` que
 * dijera «1 de febrero» obligaría a restarle un día en cada pantalla, y esa
 * resta se olvida en alguna.
 */

import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  type CalendarDate,
} from '@aai/shared';
import { allocate, type Money } from '@aai/shared';

/**
 * Cada cuánto se cobra.
 *
 * Dos valores, no más. Semanal y trimestral no están porque nadie los pidió y
 * agregarlos cuesta una línea acá y una en el `CHECK` de la base; inventarlos
 * ahora sería declarar una política comercial que no está decidida.
 */
export type Periodicidad = 'MENSUAL' | 'ANUAL';

/** Un tramo de tiempo cerrado en los dos extremos. */
export interface Periodo {
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
}

export function mesesDe(periodicidad: Periodicidad): number {
  return periodicidad === 'MENSUAL' ? 1 : 12;
}

/**
 * El período que empieza en `desde`.
 *
 * El 31 de enero mensual termina el 27 de febrero, porque el siguiente empieza
 * el 28: `addMonths` recorta al último día del mes destino y el período llega
 * hasta el día anterior. Sin ese recorte, quien contrata un 31 se saltea
 * febrero y aparece facturado dos veces en marzo.
 */
export function periodoDe(desde: CalendarDate, periodicidad: Periodicidad): Periodo {
  return { desde, hasta: addDays(addMonths(desde, mesesDe(periodicidad)), -1) };
}

/** El período que sigue a uno dado, sin huecos ni superposición. */
export function periodoSiguiente(periodo: Periodo, periodicidad: Periodicidad): Periodo {
  return periodoDe(addDays(periodo.hasta, 1), periodicidad);
}

/** Días que cubre un período, contando los dos extremos. */
export function diasDe(periodo: Periodo): number {
  return daysBetween(periodo.desde, periodo.hasta) + 1;
}

export function contiene(periodo: Periodo, fecha: CalendarDate): boolean {
  return compareDates(fecha, periodo.desde) >= 0 && compareDates(fecha, periodo.hasta) <= 0;
}

/**
 * La parte de `periodo` que se superpone con `tramo`, o `null` si no se tocan.
 *
 * Devolver `null` y no un período vacío es deliberado: un período de cero días
 * se sumaría como si existiera en cualquier reduce que lo reciba, y un importe
 * prorrateado sobre cero días es una división por cero disfrazada.
 */
export function interseccion(periodo: Periodo, tramo: Periodo): Periodo | null {
  const desde = compareDates(periodo.desde, tramo.desde) >= 0 ? periodo.desde : tramo.desde;
  const hasta = compareDates(periodo.hasta, tramo.hasta) <= 0 ? periodo.hasta : tramo.hasta;
  return compareDates(desde, hasta) <= 0 ? { desde, hasta } : null;
}

/**
 * Reparte el importe de un período entre los tramos en que se lo dividió.
 *
 * Se usa cuando una suscripción cambia de plan en el medio: el período se parte
 * en dos y cada parte se cobra a su precio. El reparto es **por días**, con el
 * método del mayor residuo de `allocate`, así que la suma de las partes es
 * exactamente el importe original: no se crean ni se pierden centavos.
 *
 * Se prorratea el importe del período completo y no se calcula cada parte por
 * separado precisamente por eso. Dos cálculos independientes redondeados al
 * centavo dan, en un mes de 31 días partido al medio, un centavo de más o de
 * menos que después nadie encuentra.
 *
 * Los tramos tienen que cubrir el período sin huecos ni superposiciones. Que no
 * lo hagan es un error de quien llama, no un caso a contemplar: prorratear
 * sobre una cobertura incompleta produciría un total que no es el del período y
 * se vería exactamente igual que uno correcto.
 */
export function prorratearPorDias(
  importeDelPeriodo: Money,
  periodo: Periodo,
  tramos: readonly Periodo[],
): readonly Money[] {
  if (tramos.length === 0) {
    throw new RangeError('prorratearPorDias necesita al menos un tramo');
  }

  const dias = tramos.map((tramo) => {
    const parte = interseccion(periodo, tramo);
    if (parte === null) {
      throw new RangeError(
        `El tramo ${tramo.desde}..${tramo.hasta} no cae dentro del período ` +
          `${periodo.desde}..${periodo.hasta}`,
      );
    }
    return BigInt(diasDe(parte));
  });

  const cubiertos = dias.reduce((acc, d) => acc + d, 0n);
  if (cubiertos !== BigInt(diasDe(periodo))) {
    throw new RangeError(
      `Los tramos cubren ${cubiertos} días y el período tiene ${diasDe(periodo)}: ` +
        'prorratear sobre una cobertura parcial daría un total que no es el del período',
    );
  }

  return allocate(importeDelPeriodo, dias);
}

/**
 * Lo que corresponde cobrar por usar el servicio solo una parte del período.
 *
 * Es el caso del alta a mitad de mes. Devuelve la parte de `tramo`, calculada
 * con el mismo reparto que arriba para que el alta a mitad de mes y el cambio
 * de plan a mitad de mes no puedan diferir en un centavo.
 */
export function proporcionDelPeriodo(
  importeDelPeriodo: Money,
  periodo: Periodo,
  tramo: Periodo,
): Money {
  const parte = interseccion(periodo, tramo);
  if (parte === null) {
    throw new RangeError(
      `El tramo ${tramo.desde}..${tramo.hasta} no toca el período ` +
        `${periodo.desde}..${periodo.hasta}`,
    );
  }
  if (compareDates(parte.desde, periodo.desde) === 0 && compareDates(parte.hasta, periodo.hasta) === 0) {
    return importeDelPeriodo;
  }

  const usados = BigInt(diasDe(parte));
  const restantes = BigInt(diasDe(periodo)) - usados;
  const [cobrable] = allocate(importeDelPeriodo, [usados, restantes]);
  return cobrable!;
}
