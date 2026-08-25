/**
 * Money — importes monetarios como enteros en unidades menores (centavos).
 *
 * Regla del repositorio (ARCHITECTURE.md §7): está PROHIBIDO usar `number` de punto
 * flotante para dinero. `0.1 + 0.2 !== 0.3` es una curiosidad en una calculadora y un
 * asiento descuadrado en un libro Diario.
 *
 * Se usa `bigint` y no `number` entero porque los importes argentinos con inflación
 * acumulada superan cómodamente el rango cómodo de `Number.MAX_SAFE_INTEGER` cuando se
 * multiplican por tasas antes de redondear.
 */

import type { Currency } from './currency.js';
import { minorUnitsOf } from './currency.js';

/** Marca nominal: impide pasar un `{amount, currency}` cualquiera donde se espera Money. */
declare const MoneyBrand: unique symbol;

export interface Money {
  readonly [MoneyBrand]: 'Money';
  /** Importe en unidades menores (centavos para ARS/USD). Siempre entero. */
  readonly amount: bigint;
  readonly currency: Currency;
}

/**
 * Modo de redondeo.
 *
 * ADR-005: el modo NO es una constante del código. Se recibe como parámetro porque el
 * criterio aplicable depende de la norma y de la operación. Quien llama debe elegirlo
 * explícitamente y poder citar de dónde sale.
 */
export type RoundingMode =
  /** Redondeo aritmético clásico: 0,5 se aleja del cero. */
  | 'HALF_UP'
  /** Redondeo bancario: 0,5 va al par más cercano. Reduce el sesgo acumulado. */
  | 'HALF_EVEN'
  /** Truncamiento hacia cero. */
  | 'DOWN'
  /** Alejamiento del cero. */
  | 'UP';

/** Tasa exacta como fracción de enteros. Nunca un `number`. */
export interface Rate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function money(amount: bigint, currency: Currency): Money {
  return { amount, currency } as unknown as Money;
}

export function zero(currency: Currency): Money {
  return money(0n, currency);
}

/**
 * Construye un Money desde una representación decimal en texto ("1234.56", "-0,05").
 * Acepta coma o punto como separador decimal. Rechaza notación científica y cualquier
 * cosa con más decimales de los que admite la moneda: truncar en silencio es
 * exactamente el tipo de error que este módulo existe para impedir.
 */
export function moneyFromDecimalString(input: string, currency: Currency): Money {
  const normalized = input.trim().replace(',', '.');
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new RangeError(`Importe decimal inválido: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  const decimals = minorUnitsOf(currency);
  if (fraction.length > decimals) {
    throw new RangeError(
      `${JSON.stringify(input)} tiene ${fraction.length} decimales y ${currency} admite ${decimals}. ` +
        'Redondeá explícitamente con un RoundingMode antes de convertir.',
    );
  }
  const padded = fraction.padEnd(decimals, '0');
  const magnitude = BigInt(`${whole}${padded}`);
  return money(sign === '-' ? -magnitude : magnitude, currency);
}

export function toDecimalString(value: Money): string {
  const decimals = minorUnitsOf(value.currency);
  const negative = value.amount < 0n;
  const digits = (negative ? -value.amount : value.amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Formato es-AR: separador de miles ".", decimal ",", negativos entre paréntesis. */
export function formatAr(value: Money): string {
  const decimals = minorUnitsOf(value.currency);
  const negative = value.amount < 0n;
  const digits = (negative ? -value.amount : value.amount).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const body = decimals === 0 ? grouped : `${grouped},${fraction}`;
  return negative ? `(${body})` : body;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Operación entre monedas distintas: ${a.currency} y ${b.currency}. ` +
        'Convertí explícitamente con una cotización que tenga fuente y fecha.',
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function negate(value: Money): Money {
  return money(-value.amount, value.currency);
}

export function abs(value: Money): Money {
  return money(value.amount < 0n ? -value.amount : value.amount, value.currency);
}

export function sum(values: readonly Money[], currency: Currency): Money {
  return values.reduce<Money>((acc, item) => add(acc, item), zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function isZero(value: Money): boolean {
  return value.amount === 0n;
}

export function isNegative(value: Money): boolean {
  return value.amount < 0n;
}

export function isPositive(value: Money): boolean {
  return value.amount > 0n;
}

/**
 * Tasa desde texto decimal: rate('21') → 21/100 ; rate('0.105') → 105/1000.
 * `percent: true` interpreta el valor como porcentaje.
 */
export function rate(value: string, options: { percent?: boolean } = {}): Rate {
  const normalized = value.trim().replace(',', '.');
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new RangeError(`Tasa inválida: ${JSON.stringify(value)}`);
  }
  const [, sign, whole, fraction = ''] = match;
  const numerator = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);
  const denominator = 10n ** BigInt(fraction.length) * (options.percent === true ? 100n : 1n);
  return { numerator, denominator };
}

/** División entera con el modo de redondeo pedido. `denominator` debe ser positivo. */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) {
    throw new RangeError('El denominador debe ser positivo');
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;

  let rounded: bigint;
  if (remainder === 0n) {
    rounded = quotient;
  } else {
    switch (mode) {
      case 'DOWN':
        rounded = quotient;
        break;
      case 'UP':
        rounded = quotient + 1n;
        break;
      case 'HALF_UP':
        rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
        break;
      case 'HALF_EVEN': {
        const doubled = remainder * 2n;
        if (doubled > denominator) rounded = quotient + 1n;
        else if (doubled < denominator) rounded = quotient;
        else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
        break;
      }
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * Multiplica por una tasa exacta y redondea con el modo indicado.
 * Ejemplo: IVA 21% sobre $ 1.000,00 → multiplyByRate(neto, rate('21', {percent:true}), 'HALF_UP')
 */
export function multiplyByRate(value: Money, factor: Rate, mode: RoundingMode): Money {
  const scaled = value.amount * factor.numerator;
  return money(divideRounded(scaled, factor.denominator, mode), value.currency);
}

/**
 * Convierte a otra moneda con una cotización exacta.
 *
 * Vive acá y no en el motor contable por una razón concreta: la división
 * redondeada es la misma que usa `multiplyByRate`, y tener dos implementaciones
 * del redondeo es tener dos criterios que en algún momento divergen.
 *
 * Contempla que las monedas tengan distinta cantidad de decimales — ARS tiene
 * dos y CLP ninguno—: convertir sin ajustar la escala daría el resultado
 * multiplicado o dividido por cien.
 *
 * El `mode` se pide explícitamente (ADR-005): el criterio de redondeo aplicable
 * depende de la norma y de la operación, no del código.
 */
export function convert(value: Money, to: Currency, factor: Rate, mode: RoundingMode): Money {
  if (factor.denominator <= 0n) {
    throw new RangeError('El denominador de la cotización debe ser positivo');
  }
  const fromDecimals = BigInt(minorUnitsOf(value.currency));
  const toDecimals = BigInt(minorUnitsOf(to));
  const scaled = value.amount * factor.numerator * 10n ** toDecimals;
  const divisor = factor.denominator * 10n ** fromDecimals;
  return money(divideRounded(scaled, divisor, mode), to);
}

/** Multiplica por una cantidad entera. No hay redondeo posible, así que no lo pide. */
export function multiplyByInteger(value: Money, factor: bigint): Money {
  return money(value.amount * factor, value.currency);
}

/**
 * Reparte un importe según pesos enteros, sin crear ni destruir centavos.
 *
 * Propiedad garantizada (P-7 de TESTING_STRATEGY.md):
 *   sum(allocate(m, weights)) === m,  siempre, para cualquier m y cualquier weights.
 *
 * El resto se asigna por el método del mayor residuo, con desempate por orden de
 * aparición: el reparto es determinístico y reproducible, que es lo que exige un libro.
 */
export function allocate(value: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new RangeError('allocate requiere al menos un peso');
  }
  if (weights.some((weight) => weight < 0n)) {
    throw new RangeError('Los pesos no pueden ser negativos');
  }
  const total = weights.reduce((acc, weight) => acc + weight, 0n);
  if (total === 0n) {
    throw new RangeError('La suma de los pesos no puede ser cero');
  }

  const negative = value.amount < 0n;
  const magnitude = negative ? -value.amount : value.amount;

  const shares = weights.map((weight, index) => {
    const exact = magnitude * weight;
    return { index, base: exact / total, remainder: exact % total };
  });

  const assigned = shares.reduce((acc, share) => acc + share.base, 0n);
  let leftover = magnitude - assigned;

  // Mayor residuo primero; a igual residuo, menor índice primero.
  const ordered = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });

  const result = new Array<bigint>(weights.length).fill(0n);
  for (const share of shares) {
    result[share.index] = share.base;
  }
  for (const share of ordered) {
    if (leftover <= 0n) break;
    result[share.index] = (result[share.index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return result.map((amount) => money(negative ? -amount : amount, value.currency));
}

/** Serialización estable para persistencia y logs. */
export function toJSON(value: Money): { amount: string; currency: Currency } {
  return { amount: value.amount.toString(), currency: value.currency };
}

export function fromJSON(value: { amount: string; currency: Currency }): Money {
  return money(BigInt(value.amount), value.currency);
}
