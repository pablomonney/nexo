import { describe, expect, it } from 'vitest';
import { moneyFromDecimalString } from '@aai/shared';
import { desambiguarPorControl, parseImporteAr } from './parsers/importe.js';
import { parseFechaAr } from './parsers/fecha.js';
import {
  LIMITES,
  parseCodigoAutorizacion,
  parseLetraComprobante,
  parsePuntoVentaYNumero,
} from './parsers/comprobante.js';
import { acotarConfianza, TECHO_CONFIANZA } from './types.js';

/** Ayuda a leer los tests: importe en unidades menores. */
function centavos(resultado: ReturnType<typeof parseImporteAr>): bigint {
  if (!resultado.ok) throw new Error(`Se esperaba un importe: ${resultado.error.mensaje}`);
  return resultado.value.money.amount;
}

describe('parseImporteAr', () => {
  it('resuelve el formato argentino', () => {
    expect(centavos(parseImporteAr('1.234,56'))).toBe(123456n);
  });

  it('resuelve el formato anglosajón, porque el último separador es el decimal', () => {
    expect(centavos(parseImporteAr('1,234.56'))).toBe(123456n);
  });

  it('trata varios separadores iguales como miles', () => {
    expect(centavos(parseImporteAr('12.345.678'))).toBe(1234567800n);
  });

  it('acepta signo de moneda y espacios de cualquier tipo', () => {
    expect(centavos(parseImporteAr('$ 1.234,56'))).toBe(123456n);
    // Espacio duro entre los miles, como lo escribe más de un PDF.
    expect(centavos(parseImporteAr('1 234,56'))).toBe(123456n);
    expect(centavos(parseImporteAr('US$ 99,90', 'USD'))).toBe(9990n);
  });

  it('interpreta los paréntesis contables como negativo', () => {
    expect(centavos(parseImporteAr('(1.234,56)'))).toBe(-123456n);
    expect(centavos(parseImporteAr('1.234,56-'))).toBe(-123456n);
    // Menos tipográfico, que no es el guion ASCII.
    expect(centavos(parseImporteAr('−1.234,56'))).toBe(-123456n);
  });

  it('no confunde dos decimales con un grupo de miles', () => {
    expect(centavos(parseImporteAr('1.23'))).toBe(123n);
    expect(centavos(parseImporteAr('123,4'))).toBe(12340n);
  });

  // El test central de este módulo.
  it('SE ABSTIENE cuando un separador con tres dígitos es genuinamente ambiguo', () => {
    const resultado = parseImporteAr('1.234');
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.codigo).toBe('AMBIGUO');
    expect(resultado.error.candidatos).toEqual(['1234', '1.234']);
  });

  it('se abstiene también con la coma, que es el caso argentino', () => {
    const resultado = parseImporteAr('1,234');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.codigo).toBe('AMBIGUO');
  });

  it('rechaza más decimales de los que admite la moneda en lugar de redondear', () => {
    const resultado = parseImporteAr('1.2345');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.codigo).toBe('DECIMALES_EXCEDIDOS');
  });

  it('rechaza agrupaciones imposibles', () => {
    for (const entrada of ['1.234.5', '1..2', '1.2.3']) {
      const resultado = parseImporteAr(entrada);
      expect(resultado.ok, entrada).toBe(false);
    }
  });

  it('distingue vacío, sin dígitos y formato inválido', () => {
    const casos = [
      ['   ', 'VACIO'],
      ['s/d', 'SIN_DIGITOS'],
      ['12ab', 'FORMATO_INVALIDO'],
    ] as const;
    for (const [entrada, codigo] of casos) {
      const resultado = parseImporteAr(entrada);
      expect(resultado.ok, entrada).toBe(false);
      if (!resultado.ok) expect(resultado.error.codigo, entrada).toBe(codigo);
    }
  });

  it('resuelve la ambigüedad si la aritmética del comprobante la cierra', () => {
    const resultado = desambiguarPorControl('1.234', moneyFromDecimalString('1234', 'ARS'));
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.money.amount).toBe(123400n);
    // No llega a 1: lo que la resuelve es un control externo, no el campo.
    expect(resultado.value.confianza).toBeLessThan(1);
    expect(resultado.value.nota).toMatch(/control aritmético/i);
  });

  it('sigue absteniéndose si el control tampoco cierra con ningún candidato', () => {
    const resultado = desambiguarPorControl('1.234', moneyFromDecimalString('9999', 'ARS'));
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.codigo).toBe('AMBIGUO');
  });
});

describe('parseFechaAr', () => {
  const valor = (entrada: string, anioReferencia?: number): string => {
    const resultado = parseFechaAr(
      entrada,
      anioReferencia !== undefined ? { anioReferencia } : {},
    );
    if (!resultado.ok) throw new Error(`Se esperaba una fecha: ${resultado.error.mensaje}`);
    return resultado.value.fecha;
  };

  it('lee el formato argentino, el ISO y el compacto de ARCA', () => {
    expect(valor('05/03/2026')).toBe('2026-03-05');
    expect(valor('5-3-2026')).toBe('2026-03-05');
    expect(valor('2026-03-05')).toBe('2026-03-05');
    expect(valor('20260305')).toBe('2026-03-05');
  });

  it('lee fechas con el mes escrito', () => {
    expect(valor('5 de marzo de 2026')).toBe('2026-03-05');
    expect(valor('05-mar-2026')).toBe('2026-03-05');
    expect(valor('5 setiembre 2026')).toBe('2026-09-05');
  });

  it('interpreta el año de dos dígitos y deja constancia del supuesto', () => {
    const resultado = parseFechaAr('05/03/26', { anioReferencia: 2026 });
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.fecha).toBe('2026-03-05');
    expect(resultado.value.nota).toMatch(/dos dígitos/);
    // La interpretación vale menos que un año de cuatro dígitos.
    expect(resultado.value.confianza).toBeLessThanOrEqual(0.85);
  });

  it('manda un año de dos dígitos muy adelantado al siglo anterior', () => {
    expect(valor('05/03/98', 2026)).toBe('1998-03-05');
  });

  // El test que evita mover un comprobante de mes.
  it('SE ABSTIENE ante una fecha en formato mm/dd en lugar de darla vuelta', () => {
    const resultado = parseFechaAr('12/25/2026');
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.mensaje).toMatch(/no es un mes/);
    expect(resultado.error.mensaje).toMatch(/no lo asume/);
  });

  it('rechaza fechas que no existen en el calendario', () => {
    expect(parseFechaAr('31/02/2026').ok).toBe(false);
    expect(parseFechaAr('30/02/2024').ok).toBe(false);
    expect(valor('29/02/2024')).toBe('2024-02-29');
  });

  it('rechaza años fuera del rango razonable para un comprobante', () => {
    const resultado = parseFechaAr('05/03/1912');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.mensaje).toMatch(/rango razonable/);
  });
});

describe('identificación del comprobante', () => {
  it('separa punto de venta y número', () => {
    const resultado = parsePuntoVentaYNumero('0001-00001234');
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value).toMatchObject({ puntoVenta: 1, numero: 1234 });
  });

  it('lee la forma con etiquetas', () => {
    const resultado = parsePuntoVentaYNumero('Pto. Vta: 00012  Nro: 00000045');
    expect(resultado.ok).toBe(true);
    if (resultado.ok) expect(resultado.value).toMatchObject({ puntoVenta: 12, numero: 45 });
  });

  it('no parte un bloque corrido de dígitos por su cuenta', () => {
    const resultado = parsePuntoVentaYNumero('000100001234');
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.error.codigo).toBe('AMBIGUO');
  });

  it('aplica los rangos que publica el manual del WSCDC', () => {
    expect(parsePuntoVentaYNumero('00000-00001234').ok).toBe(false);
    expect(parsePuntoVentaYNumero('99999-00001234').ok).toBe(false);
    expect(parsePuntoVentaYNumero('99998-99999999').ok).toBe(true);
  });

  it('valida la longitud del código de autorización', () => {
    const ok = parseCodigoAutorizacion('75123456789012');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toHaveLength(LIMITES.longitudCodigoAutorizacion);

    // Un dígito perdido por el OCR: se detecta acá y no en la constatación.
    const corto = parseCodigoAutorizacion('7512345678901');
    expect(corto.ok).toBe(false);
    if (!corto.ok) expect(corto.error.mensaje).toMatch(/13 dígitos/);
  });

  it('conserva el código de autorización como texto', () => {
    const resultado = parseCodigoAutorizacion('00123456789012');
    expect(resultado.ok).toBe(true);
    // Como número habría perdido los ceros de la izquierda.
    if (resultado.ok) expect(resultado.value).toBe('00123456789012');
  });

  it('extrae la letra impresa', () => {
    for (const [entrada, esperado] of [
      ['A', 'A'],
      ['FACTURA B', 'B'],
      ['COD. 011 C', 'C'],
    ] as const) {
      const resultado = parseLetraComprobante(entrada);
      expect(resultado.ok, entrada).toBe(true);
      if (resultado.ok) expect(resultado.value).toBe(esperado);
    }
  });
});

describe('techo de confianza por método', () => {
  it('impide que una lectura de imagen alcance el nivel de un dato estructurado', () => {
    // Un motor que reporta 0.99 sobre un escaneo no vale lo mismo que un XML.
    expect(acotarConfianza('OCR', 0.99)).toBeLessThan(1);
    expect(acotarConfianza('REGEX', 1)).toBe(TECHO_CONFIANZA.REGEX);
    expect(acotarConfianza('LLM', 1)).toBe(TECHO_CONFIANZA.LLM);
    expect(acotarConfianza('XML', 1)).toBe(1);
    expect(acotarConfianza('MANUAL', 1)).toBe(1);
  });

  it('acota también por abajo', () => {
    expect(acotarConfianza('OCR', -3)).toBe(0);
  });
});
