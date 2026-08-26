/**
 * CUIT / CUIL — validación del dígito verificador (módulo 11).
 *
 * Validar la estructura NO valida que el contribuyente exista ni que esté activo: eso
 * requiere el padrón de ARCA. Son dos comprobaciones distintas y el sistema no las
 * confunde, igual que no confunde validación fiscal con validación contable (§11).
 */

const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** Prefijos de tipo de persona admitidos por el régimen de CUIT/CUIL. */
const VALID_PREFIXES = new Set(['20', '23', '24', '25', '26', '27', '30', '33', '34']);

export type Cuit = string & { readonly __brand: 'Cuit' };

export function normalizeCuit(input: string): string {
  return input.replace(/[^\d]/g, '');
}

export function isValidCuit(input: string): boolean {
  const digits = normalizeCuit(input);
  if (digits.length !== 11) return false;
  if (!VALID_PREFIXES.has(digits.slice(0, 2))) return false;

  let total = 0;
  for (let index = 0; index < WEIGHTS.length; index += 1) {
    total += Number(digits[index]) * WEIGHTS[index]!;
  }

  const remainder = total % 11;
  let expected: number;
  if (remainder === 0) expected = 0;
  else if (remainder === 1) expected = 9; // convención de ARCA para resto 1
  else expected = 11 - remainder;

  return Number(digits[10]) === expected;
}

/**
 * El dígito verificador que le corresponde a los diez primeros dígitos.
 *
 * Es la misma cuenta que hace `isValidCuit`, expuesta para **construir** un CUIT
 * en vez de comprobarlo. Existe por dos razones concretas:
 *
 * - Cinco archivos de test tenían su propia copia del módulo 11 para armar CUIT
 *   de fixture. Cinco copias de un algoritmo son cinco oportunidades de que una
 *   se desvíe y los tests pasen contra una regla que el sistema no aplica.
 * - Anonimizar un comprobante real exige reemplazar el CUIT por otro **válido**:
 *   uno inválido lo rechaza el parser por un motivo que no es el que se quiere
 *   medir.
 *
 * No valida el prefijo: quien construye elige el tipo de sujeto, y `isValidCuit`
 * es quien después dice si el resultado sirve.
 */
export function cuitCheckDigit(firstTen: string): number {
  const digits = normalizeCuit(firstTen);
  if (digits.length !== 10) {
    throw new RangeError(`Se esperaban 10 dígitos y llegaron ${digits.length}: ${JSON.stringify(firstTen)}`);
  }

  let total = 0;
  for (let index = 0; index < WEIGHTS.length; index += 1) {
    total += Number(digits[index]) * WEIGHTS[index]!;
  }

  const remainder = total % 11;
  if (remainder === 0) return 0;
  if (remainder === 1) return 9; // convención de ARCA para resto 1
  return 11 - remainder;
}

/** Los diez dígitos más el verificador que les corresponde. `30` + 8 dígitos → CUIT. */
export function withCheckDigit(firstTen: string): string {
  const digits = normalizeCuit(firstTen);
  return `${digits}${cuitCheckDigit(digits)}`;
}

/** Devuelve el CUIT normalizado o lanza. Usar en bordes de entrada, no en el dominio. */
export function parseCuit(input: string): Cuit {
  const digits = normalizeCuit(input);
  if (!isValidCuit(digits)) {
    throw new RangeError(`CUIT inválido: ${JSON.stringify(input)}`);
  }
  return digits as Cuit;
}

/** 30-12345678-9 */
export function formatCuit(input: Cuit | string): string {
  const digits = normalizeCuit(input);
  if (digits.length !== 11) return input;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}
