import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDate,
  compareDates,
  endOfMonth,
  isCalendarDate,
  isWithin,
  parseCalendarDate,
  startOfMonth,
} from './calendar-date.js';

describe('CalendarDate', () => {
  it('valida el formato y la existencia real de la fecha', () => {
    expect(isCalendarDate('2025-01-01')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true); // bisiesto
    expect(isCalendarDate('2025-02-29')).toBe(false); // no bisiesto
    expect(isCalendarDate('2025-13-01')).toBe(false);
    expect(isCalendarDate('2025-04-31')).toBe(false);
    expect(isCalendarDate('01/01/2025')).toBe(false);
  });

  it('no corre la fecha por zona horaria', () => {
    // El bug clásico: `new Date('2025-01-01')` interpretado en UTC-3 da 31/12/2024.
    const fecha = parseCalendarDate('2025-01-01');
    expect(fecha).toBe('2025-01-01');
    expect(String(fecha)).toBe('2025-01-01');
  });

  it('ordena cronológicamente por comparación de strings', () => {
    expect(compareDates(parseCalendarDate('2024-12-31'), parseCalendarDate('2025-01-01'))).toBe(-1);
    expect(compareDates(parseCalendarDate('2025-01-01'), parseCalendarDate('2025-01-01'))).toBe(0);
  });

  it('isWithin soporta intervalos abiertos hacia el futuro', () => {
    const desde = parseCalendarDate('2024-07-01');
    expect(isWithin(parseCalendarDate('2024-06-30'), desde, null)).toBe(false);
    expect(isWithin(parseCalendarDate('2024-07-01'), desde, null)).toBe(true);
    expect(isWithin(parseCalendarDate('2030-01-01'), desde, null)).toBe(true);
    expect(isWithin(parseCalendarDate('2030-01-01'), desde, parseCalendarDate('2025-06-30'))).toBe(false);
  });

  it('inicio y fin de mes', () => {
    expect(startOfMonth(parseCalendarDate('2025-03-17'))).toBe('2025-03-01');
    expect(endOfMonth(parseCalendarDate('2024-02-10'))).toBe('2024-02-29');
    expect(endOfMonth(parseCalendarDate('2025-02-10'))).toBe('2025-02-28');
  });

  it('addDays cruza fin de mes y fin de año', () => {
    expect(addDays(parseCalendarDate('2024-12-31'), 1)).toBe('2025-01-01');
    expect(addDays(parseCalendarDate('2025-01-01'), -1)).toBe('2024-12-31');
    expect(addDays(parseCalendarDate('2024-02-28'), 1)).toBe('2024-02-29');
  });

  it('calendarDate construye con padding', () => {
    expect(calendarDate(2025, 1, 5)).toBe('2025-01-05');
  });
});
