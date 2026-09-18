import { describe, expect, it } from 'vitest';
import {
  CATALOGO_DE_JURISDICCIONES,
  esJurisdiccion,
  FORMA_DE_JURISDICCION,
  JURISDICCIONES,
  MENSAJE_DE_JURISDICCION,
  normalizarJurisdiccion,
} from './jurisdiccion.js';

describe('La jurisdicción', () => {
  it('ofrece las tres que el sistema usa hoy', () => {
    expect([...JURISDICCIONES]).toEqual(['AR', 'AR-C', 'AR-B']);
  });

  it('normaliza minúsculas y espacios', () => {
    // El caso realista: alguien escribe `ar-c` y la columna lo rechaza.
    expect(normalizarJurisdiccion('ar-c')).toBe('AR-C');
    expect(normalizarJurisdiccion('  ar-b  ')).toBe('AR-B');
    expect(normalizarJurisdiccion('ar')).toBe('AR');
    expect(esJurisdiccion(normalizarJurisdiccion('ar-c'))).toBe(true);
  });

  it('las tres cumplen la forma que exige la base', () => {
    // Si alguna no la cumpliera, el desplegable ofrecería un valor que termina
    // en un 23514: es la comprobación que une el catálogo con la columna.
    for (const codigo of JURISDICCIONES) {
      expect(FORMA_DE_JURISDICCION.test(codigo)).toBe(true);
    }
  });

  it('separa «mal escrita» de «todavía no disponible»', () => {
    // `XX` no tiene la forma. `AR-Z` sí la tiene —la base la aceptaría— y aun
    // así no se ofrece: es una decisión de producto, no una restricción de la
    // base, y por eso son dos comprobaciones distintas.
    expect(FORMA_DE_JURISDICCION.test('XX')).toBe(false);
    expect(FORMA_DE_JURISDICCION.test('AR-Z')).toBe(true);
    expect(esJurisdiccion('AR-Z')).toBe(false);
  });

  it('rechaza las formas que la columna no admite', () => {
    for (const valor of ['AR-CABA', 'ARG', 'AR-', 'BUENOS AIRES', '']) {
      expect(FORMA_DE_JURISDICCION.test(valor)).toBe(false);
    }
  });

  it('todas tienen nombre, y el mensaje de error los trae', () => {
    for (const { codigo, etiqueta } of CATALOGO_DE_JURISDICCIONES) {
      expect(etiqueta.length).toBeGreaterThan(3);
      expect(MENSAJE_DE_JURISDICCION).toContain(codigo);
      expect(MENSAJE_DE_JURISDICCION).toContain(etiqueta);
    }
  });
});
