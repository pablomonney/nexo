import { describe, expect, it } from 'vitest';
import { formatCuit, isValidCuit, normalizeCuit, parseCuit } from './cuit.js';

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
});
