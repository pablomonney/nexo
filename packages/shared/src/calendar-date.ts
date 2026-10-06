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

export function addDays(value: CalendarDate, days: number): CalendarDate {
  const utc = Date.UTC(yearOf(value), monthOf(value) - 1, dayOf(value));
  const shifted = new Date(utc + days * 86_400_000);
  return calendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Suma meses recortando al último día del mes destino.
 *
 * El 31 de enero más un mes es el 28 de febrero, no el 3 de marzo. La
 * aritmética nativa de `Date` hace lo segundo —desborda al mes siguiente— y eso
 * en una suscripción mensual significa que quien contrata un 31 se saltea
 * febrero y termina facturado dos veces en marzo.
 *
 * El recorte es asimétrico y no se recupera: quien empieza el 31 de enero pasa
 * a cobrarse el 28, y de ahí en adelante los 28. Es la convención habitual y la
 * única que no exige guardar aparte el «día original de contratación»; si algún
 * día hiciera falta preservarlo, el lugar es la suscripción, no esta función.
 */
export function addMonths(value: CalendarDate, months: number): CalendarDate {
  const total = (yearOf(value) - 1) * 12 + (monthOf(value) - 1) + months;
  // Meses en un calendario, no centavos: la división es exacta sobre enteros
  // chicos y el resultado es un número de año. no-float-check: allow
  const year = Math.floor(total / 12) + 1;
  const month = (total % 12) + 1;
  return calendarDate(year, month, Math.min(dayOf(value), daysInMonth(year, month)));
}

/** Días de diferencia entre dos fechas: `hasta - desde`. Negativo si va al revés. */
export function daysBetween(desde: CalendarDate, hasta: CalendarDate): number {
  const a = Date.UTC(yearOf(desde), monthOf(desde) - 1, dayOf(desde));
  const b = Date.UTC(yearOf(hasta), monthOf(hasta) - 1, dayOf(hasta));
  return Math.round((b - a) / 86_400_000);
}

/**
 * La zona horaria en la que se cuentan los días del negocio.
 *
 * Argentina es UTC−3 fijo (sin horario de verano desde 2009). Es la zona que la
 * aplicación fija en cada conexión a PostgreSQL —`initPool`— y la que usa
 * `hoyEnZonaDeNegocio`. La base de producción corre en UTC y **no** se cambia:
 * el hash de la cadena de auditoría incluye `occurred_at::text`, y ese texto
 * depende de la zona de la sesión (ver `docs/PLAN_ZONA_HORARIA.md`).
 */
export const ZONA_DE_NEGOCIO = 'America/Argentina/Buenos_Aires';

const PARTES_DE_HOY = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA_DE_NEGOCIO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * El día de calendario de `ahora` en la zona del negocio.
 *
 * Para código que no tiene una base a mano. Con una transacción abierta se le
 * pregunta `CURRENT_DATE` a la base: la sesión ya está en esta misma zona y es
 * la base la que después compara.
 */
export function hoyEnZonaDeNegocio(ahora: Date = new Date()): CalendarDate {
  const partes = Object.fromEntries(
    PARTES_DE_HOY.formatToParts(ahora).map((p) => [p.type, p.value]),
  );
  return calendarDate(Number(partes['year']), Number(partes['month']), Number(partes['day']));
}
