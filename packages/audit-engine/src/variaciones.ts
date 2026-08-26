/**
 * Análisis de variaciones entre períodos.
 *
 * La pregunta que responde: *¿qué cambió, cuánto, y vale la pena mirarlo?*
 *
 * ## El problema del porcentaje
 *
 * Un análisis de variaciones ordenado por porcentaje pone arriba de todo una
 * cuenta que pasó de $ 100 a $ 400 —un 300%— y abajo una que pasó de
 * $ 40.000.000 a $ 44.000.000 —un 10%—. La segunda mueve cuatro millones y la
 * primera trescientos pesos.
 *
 * Y al revés: ordenar por importe absoluto esconde exactamente el hallazgo que
 * la auditoría busca, que es la cuenta chica que se multiplicó por cinco.
 *
 * Por eso acá una variación es **significativa** si supera *cualquiera* de los
 * dos umbrales, y el resultado trae los dos números sin elegir por el lector.
 * Ordenar por uno de ellos es una decisión de presentación, no del análisis.
 *
 * ## Y el problema del cero
 *
 * Una cuenta que pasó de $ 0 a $ 50.000 tiene una variación porcentual infinita.
 * Casi todos los sistemas muestran ahí un `∞`, un `N/A` o un `999%`, y las tres
 * son formas de no decir lo único que importa: **la cuenta apareció**. Es una
 * categoría propia (`APARECE`), no un porcentaje muy grande.
 */

import type { Money } from '@aai/shared';
import { money } from '@aai/shared';

export type TipoVariacion =
  | 'AUMENTA'
  | 'DISMINUYE'
  | 'APARECE'
  | 'DESAPARECE'
  | 'SIN_CAMBIO'
  | 'CAMBIA_DE_SIGNO';

export interface SaldoComparable {
  readonly accountId: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly actual: Money;
  readonly anterior: Money;
}

export interface Variacion {
  readonly accountId: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly actual: Money;
  readonly anterior: Money;
  readonly absoluta: Money;
  /**
   * Puntos porcentuales enteros. `null` cuando el anterior era cero: ahí no hay
   * porcentaje, hay una aparición.
   *
   * Entero y no decimal porque es un indicador para ordenar y mirar, no una
   * medición. Un 340,7% y un 341% mandan a mirar la misma cuenta.
   */
  readonly porcentaje: number | null;
  readonly tipo: TipoVariacion;
  readonly significativa: boolean;
  readonly motivo: string;
}

export interface UmbralesDeVariacion {
  /** Variación porcentual a partir de la cual se marca. Entero. */
  readonly porcentaje: number;
  /** Variación absoluta en unidades menores a partir de la cual se marca. */
  readonly absoluto: bigint;
}

/**
 * Umbrales por defecto, deliberadamente conservadores.
 *
 * 25% y un millón de unidades menores —diez mil pesos— marcan de más, no de
 * menos. Un análisis que marca poco se vuelve decorativo en dos ejercicios; uno
 * que marca de más se ajusta mirando la lista una vez.
 */
export const UMBRALES_POR_DEFECTO: UmbralesDeVariacion = {
  porcentaje: 25,
  absoluto: 1_000_000n,
};

export function analizarVariaciones(
  saldos: readonly SaldoComparable[],
  umbrales: UmbralesDeVariacion = UMBRALES_POR_DEFECTO,
): Variacion[] {
  return saldos.map((saldo) => {
    const actual = saldo.actual.amount;
    const anterior = saldo.anterior.amount;
    const absoluta = actual - anterior;
    const moneda = saldo.actual.currency;

    const tipo = clasificar(actual, anterior);
    const porcentaje = anterior === 0n ? null : porcentajeEntero(absoluta, anterior);

    const superaAbsoluto = abs(absoluta) >= umbrales.absoluto;
    const superaPorcentaje = porcentaje !== null && Math.abs(porcentaje) >= umbrales.porcentaje;

    // Una aparición o una desaparición son significativas por sí mismas, sin
    // importar el monto: una cuenta que no existía y ahora tiene saldo es un
    // hecho, no una variación.
    const porNaturaleza = tipo === 'APARECE' || tipo === 'DESAPARECE' || tipo === 'CAMBIA_DE_SIGNO';

    return {
      accountId: saldo.accountId,
      codigo: saldo.codigo,
      nombre: saldo.nombre,
      actual: saldo.actual,
      anterior: saldo.anterior,
      absoluta: money(absoluta, moneda),
      porcentaje,
      tipo,
      significativa: porNaturaleza || superaAbsoluto || superaPorcentaje,
      motivo: explicar(tipo, porcentaje, absoluta, superaAbsoluto, superaPorcentaje, umbrales),
    };
  });
}

function clasificar(actual: bigint, anterior: bigint): TipoVariacion {
  if (actual === anterior) return 'SIN_CAMBIO';
  if (anterior === 0n) return 'APARECE';
  if (actual === 0n) return 'DESAPARECE';
  // Un activo que pasa a acreedor, o un pasivo que pasa a deudor, casi siempre es
  // un error de imputación. Es un hallazgo distinto de "subió mucho".
  if ((actual > 0n) !== (anterior > 0n)) return 'CAMBIA_DE_SIGNO';
  return abs(actual) > abs(anterior) ? 'AUMENTA' : 'DISMINUYE';
}

/**
 * Porcentaje en enteros, redondeado al más cercano.
 *
 * `(diferencia × 100 × 2 + |base|) / (|base| × 2)` con el signo repuesto, que es
 * el mismo redondeo entero que usa el motor de IVA. Sin punto flotante: un
 * porcentaje calculado con `Number` sobre saldos de miles de millones se corre, y
 * un análisis que ordena por un número corrido ordena mal.
 */
function porcentajeEntero(diferencia: bigint, base: bigint): number {
  const baseAbs = abs(base);
  const negativo = diferencia < 0n;
  const numerador = abs(diferencia) * 100n * 2n + baseAbs;
  const resultado = numerador / (baseAbs * 2n);
  return Number(negativo ? -resultado : resultado);
}

function abs(valor: bigint): bigint {
  return valor < 0n ? -valor : valor;
}

function explicar(
  tipo: TipoVariacion,
  porcentaje: number | null,
  absoluta: bigint,
  superaAbsoluto: boolean,
  superaPorcentaje: boolean,
  umbrales: UmbralesDeVariacion,
): string {
  switch (tipo) {
    case 'SIN_CAMBIO':
      return 'El saldo no cambió.';
    case 'APARECE':
      return `La cuenta no tenía saldo y ahora tiene ${absoluta}. No es un porcentaje muy grande: es una aparición, y se mira igual sin importar el monto.`;
    case 'DESAPARECE':
      return `La cuenta tenía saldo y quedó en cero. Puede ser una cancelación normal o una reclasificación que se hizo a medias.`;
    case 'CAMBIA_DE_SIGNO':
      return 'El saldo cambió de deudor a acreedor o al revés. Casi siempre es un error de imputación, no una variación.';
    default: {
      const razones: string[] = [];
      if (superaPorcentaje && porcentaje !== null) {
        razones.push(`varía ${porcentaje}% (umbral ${umbrales.porcentaje}%)`);
      }
      if (superaAbsoluto) {
        razones.push(`mueve ${absoluta} en unidades menores (umbral ${umbrales.absoluto})`);
      }
      return razones.length === 0
        ? `Variación de ${absoluta}, por debajo de los dos umbrales.`
        : `Significativa porque ${razones.join(' y ')}.`;
    }
  }
}

/**
 * Las variaciones significativas, sin ordenar.
 *
 * **No se ordena a propósito.** Ordenar por porcentaje esconde la cuenta grande
 * que se movió poco; ordenar por absoluto esconde la cuenta chica que se
 * multiplicó. Los dos criterios son legítimos y la elección es de quien presenta,
 * así que el análisis devuelve los dos números y no decide.
 */
export function significativas(variaciones: readonly Variacion[]): Variacion[] {
  return variaciones.filter((variacion) => variacion.significativa);
}

export interface ResumenDeVariaciones {
  readonly analizadas: number;
  readonly significativas: number;
  readonly aparecen: number;
  readonly desaparecen: number;
  readonly cambianDeSigno: number;
  readonly comentario: string;
}

export function resumirVariaciones(variaciones: readonly Variacion[]): ResumenDeVariaciones {
  const contar = (tipo: TipoVariacion): number =>
    variaciones.filter((variacion) => variacion.tipo === tipo).length;

  const marcadas = variaciones.filter((variacion) => variacion.significativa).length;
  const cambiosDeSigno = contar('CAMBIA_DE_SIGNO');

  const comentario =
    cambiosDeSigno > 0
      ? `${cambiosDeSigno} cuenta(s) cambiaron de signo. Empezá por ahí: casi siempre es un error de imputación, no una variación del ejercicio.`
      : marcadas === 0
        ? 'Ninguna variación supera los umbrales. Con un ejercicio completo eso es raro: revisá que los saldos comparativos sean los correctos.'
        : `${marcadas} variación(es) para revisar.`;

  return {
    analizadas: variaciones.length,
    significativas: marcadas,
    aparecen: contar('APARECE'),
    desaparecen: contar('DESAPARECE'),
    cambianDeSigno: cambiosDeSigno,
    comentario,
  };
}
