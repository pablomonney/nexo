/** Monedas soportadas y su cantidad de decimales (ISO 4217). */

export const CURRENCIES = {
  ARS: 2,
  USD: 2,
  EUR: 2,
  BRL: 2,
  CLP: 0,
  GBP: 2,
  CHF: 2,
  JPY: 0,
  UYU: 2,
} as const;

export type Currency = keyof typeof CURRENCIES;

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCIES, value);
}

export function minorUnitsOf(currency: Currency): number {
  return CURRENCIES[currency];
}

/**
 * Cotización aplicada a una operación en moneda extranjera.
 *
 * `source` y `date` no son opcionales a propósito: la RG ARCA 5616/2024 exige consignar
 * el tipo de cambio y de qué fuente sale. Un `fxRate` suelto, sin origen ni fecha, no es
 * auditable — y el motor contable lo rechaza (E_MISSING_FX).
 */
export interface FxQuote {
  readonly from: Currency;
  readonly to: Currency;
  /** Numerador y denominador enteros: la cotización tampoco es un float. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** Fuente citable, p. ej. "BNA vendedor divisa". */
  readonly source: string;
  /** Fecha de la cotización, en formato YYYY-MM-DD. */
  readonly date: string;
}
