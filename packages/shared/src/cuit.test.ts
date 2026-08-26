import { describe, expect, it } from 'vitest';
import {
  cuitCheckDigit,
  formatCuit,
  isValidCuit,
  normalizeCuit,
  parseCuit,
  withCheckDigit,
} from './cuit.js';

describe('CUIT', () => {
  it('acepta CUIT válidos de organismos públicos verificables', () => {
    // CUIT de ARCA/AFIP, publicado en su propia documentación.
    expect(isValidCuit('33-69345023-9')).toBe(true);
    expect(isValidCuit('33693450239')).toBe(true);
  });

  it('rechaza un dígito verificador incorrecto', () => {
    expect(isValidCuit('33-69345023-0')).toBe(false);
  });

  it('rechaza longitudes distintas de 11', () => {
    expect(isValidCuit('3369345023')).toBe(false);
    expect(isValidCuit('336934502399')).toBe(false);
    expect(isValidCuit('')).toBe(false);
  });

  it('rechaza prefijos de tipo de persona inexistentes', () => {
    expect(isValidCuit('99693450239')).toBe(false);
  });

  it('normaliza separadores y espacios', () => {
    expect(normalizeCuit(' 33.69345023/9 ')).toBe('33693450239');
  });

  it('parseCuit lanza con entrada inválida', () => {
    expect(() => parseCuit('12345678901')).toThrow(/CUIT inválido/);
  });

  it('formatea con guiones', () => {
    expect(formatCuit('33693450239')).toBe('33-69345023-9');
  });

  it('construye el mismo dígito que valida', () => {
    // El invariante que hace que construir y validar no se puedan desviar: si
    // `cuitCheckDigit` dejara de coincidir con `isValidCuit`, los fixtures
    // pasarían contra una regla que el sistema no aplica.
    expect(cuitCheckDigit('3369345023')).toBe(9);
    expect(withCheckDigit('3369345023')).toBe('33693450239');
    expect(isValidCuit(withCheckDigit('3369345023'))).toBe(true);
  });

  it('todo prefijo válido con cualquier cuerpo produce un CUIT válido', () => {
    for (const prefijo of ['20', '23', '24', '27', '30', '33', '34']) {
      for (const cuerpo of ['00000000', '12345678', '99999999', '71234567']) {
        expect(isValidCuit(withCheckDigit(prefijo + cuerpo))).toBe(true);
      }
    }
  });

  it('cubre la convención de resto 1, que es la que se olvida', () => {
    // Resto 0 → 0 y resto 1 → 9 son los dos casos especiales del módulo 11. El
    // segundo es el que las implementaciones caseras suelen escribir como 10.
    const restos = new Set<number>();
    for (let n = 0; n < 400; n += 1) {
      const cuerpo = String(n).padStart(8, '0');
      restos.add(cuitCheckDigit(`30${cuerpo}`));
    }
    expect(restos.has(9)).toBe(true);
    expect(restos.has(0)).toBe(true);
    expect([...restos].every((d) => d >= 0 && d <= 9)).toBe(true);
  });

  it('exige exactamente diez dígitos', () => {
    expect(() => cuitCheckDigit('336934502')).toThrow(/10 dígitos/);
    expect(() => cuitCheckDigit('33693450239')).toThrow(/10 dígitos/);
  });
});
