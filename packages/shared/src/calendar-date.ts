/**
 * CalendarDate — fecha civil sin hora ni zona horaria, en formato YYYY-MM-DD.
 *
 * Por qué existe en vez de usar `Date`: una fecha contable no tiene hora. Usar `Date`
 * arrastra zona horaria y produce el clásico bug de "el asiento del 1° de enero quedó
 * imputado al 31 de diciembre" al serializar desde un huso al oeste de UTC — que es
 * donde está Argentina. En un sistema donde el período contable gobierna la
 * mutabilidad, ese corrimiento de un día no es cosmético.
 *
 * Regla del repositorio (DATABASE.md §1): `timestamptz` para eventos del sistema,
 * `date` para fechas contables y fiscales. Nunca se confunden.
 */

export type CalendarDate = string & { readonly __brand: 'CalendarDate' };

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: string): value is CalendarDate {
  const match = PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  return true;
}

export function parseCalendarDate(value: string): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new RangeError(`Fecha inválida (se espera YYYY-MM-DD): ${JSON.stringify(value)}`);
  }
  return value;
}

export function calendarDate(year: number, month: number, day: number): CalendarDate {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return parseCalendarDate(value);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

export function yearOf(value: CalendarDate): number {
  return Number(value.slice(0, 4));
}

export function monthOf(value: CalendarDate): number {
  return Number(value.slice(5, 7));
}

export function dayOf(value: CalendarDate): number {
  return Number(value.slice(8, 10));
}

/** El formato YYYY-MM-DD ordena lexicográficamente igual que cronológicamente. */
export function compareDates(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Intervalo cerrado [from, to]. `to` nulo significa "sin fin". */
export function isWithin(
  value: CalendarDate,
  from: CalendarDate,
  to: CalendarDate | null,
): boolean {
  if (value < from) return false;
  if (to !== null && value > to) return false;
  return true;
}

export function startOfMonth(value: CalendarDate): CalendarDate {
  return calendarDate(yearOf(value), monthOf(value), 1);
}

export function endOfMonth(value: CalendarDate): CalendarDate {
  const year = yearOf(value);
  const month = monthOf(value);
  return calendarDate(year, month, daysInMonth(year, month));
}

export function addDays(value: CalendarDate, days: number): CalendarDate {
  const utc = Date.UTC(yearOf(value), monthOf(value) - 1, dayOf(value));
  const shifted = new Date(utc + days * 86_400_000);
  return calendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}
