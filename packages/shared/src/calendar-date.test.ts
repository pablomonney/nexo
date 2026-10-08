import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDate,
  compareDates,
  isCalendarDate,
  parseCalendarDate,
  hoyEnZonaDeNegocio,
  ZONA_DE_NEGOCIO,
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

  it('addDays cruza fin de mes y fin de año', () => {
    expect(addDays(parseCalendarDate('2024-12-31'), 1)).toBe('2025-01-01');
    expect(addDays(parseCalendarDate('2025-01-01'), -1)).toBe('2024-12-31');
    expect(addDays(parseCalendarDate('2024-02-28'), 1)).toBe('2024-02-29');
  });

  it('calendarDate construye con padding', () => {
    expect(calendarDate(2025, 1, 5)).toBe('2025-01-05');
  });
});

describe('hoyEnZonaDeNegocio', () => {
  it('la zona del negocio es la argentina', () => {
    expect(ZONA_DE_NEGOCIO).toBe('America/Argentina/Buenos_Aires');
  });

  // Instantes fijos: la prueba no depende de la hora a la que corre. Argentina
  // es UTC−3, así que las 21:00 locales son las 00:00 UTC del día siguiente.
  it.each([
    ['2026-10-06T01:00:00Z', '2026-10-05'], // 22:00 ART: en UTC ya es mañana
    ['2026-10-06T02:59:59Z', '2026-10-05'], // 23:59:59 ART
    ['2026-10-06T03:00:00Z', '2026-10-06'], // 00:00:00 ART
    ['2026-12-31T23:30:00Z', '2026-12-31'],
    ['2027-01-01T02:59:59Z', '2026-12-31'], // en UTC ya es año nuevo
    ['2027-01-01T03:00:00Z', '2027-01-01'],
    ['2028-03-01T02:00:00Z', '2028-02-29'], // año bisiesto
    // La matriz de borde alrededor de las 21:00 ART, completa (21:00 ART = 00:00Z):
    ['2026-10-05T23:59:59Z', '2026-10-05'], // 20:59:59 ART
    ['2026-10-06T00:00:00Z', '2026-10-05'], // 21:00:00 ART: en UTC ya es mañana
    ['2026-10-06T00:00:01Z', '2026-10-05'], // 21:00:01 ART
    ['2026-10-06T02:59:59Z', '2026-10-05'], // 23:59:59 ART
    ['2026-10-06T03:00:00Z', '2026-10-06'], // 00:00:00 ART
    // Fin y principio de mes, de año, y febrero común y bisiesto.
    ['2026-01-31T23:59:59Z', '2026-01-31'],
    ['2026-02-01T02:59:59Z', '2026-01-31'],
    ['2026-02-01T03:00:00Z', '2026-02-01'],
    ['2027-03-01T02:59:59Z', '2027-02-28'], // febrero común
    ['2027-03-01T03:00:00Z', '2027-03-01'],
    ['2028-03-01T02:59:59Z', '2028-02-29'], // febrero bisiesto
    ['2028-03-01T03:00:00Z', '2028-03-01'],
    ['2026-12-31T00:00:00Z', '2026-12-30'], // 21:00 ART del 30/12
    ['2026-12-31T03:00:00Z', '2026-12-31'], // 00:00 ART del 31/12 (el instante del defecto del ejercicio)
    ['2027-01-01T00:00:00Z', '2026-12-31'], // 21:00 ART del 31/12: en UTC ya es 2027
  ])('%s → %s', (instante, esperado) => {
    expect(hoyEnZonaDeNegocio(new Date(instante))).toBe(esperado);
  });

  it('en todo el año 2028 (bisiesto) cambia de día exactamente a las 00:00 ART, ni antes ni después', () => {
    // Cada medianoche ART (03:00Z): un segundo antes es el día anterior, en punto es el nuevo.
    let anterior = '2028-01-01';
    for (let dia = 1; dia <= 366; dia += 1) {
      const medianoche = Date.UTC(2028, 0, dia, 3, 0, 0);
      const antes = hoyEnZonaDeNegocio(new Date(medianoche - 1000));
      const enPunto = hoyEnZonaDeNegocio(new Date(medianoche));
      expect(antes, `un segundo antes de la medianoche ART #${dia}`).toBe(dia === 1 ? '2027-12-31' : anterior);
      expect(enPunto > antes, `en punto #${dia}`).toBe(true);
      anterior = enPunto;
    }
    expect(anterior).toBe('2028-12-31');
  });
});
