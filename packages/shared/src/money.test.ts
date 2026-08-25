import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  compare,
  convert,
  formatAr,
  money,
  moneyFromDecimalString,
  multiplyByRate,
  rate,
  subtract,
  sum,
  toDecimalString,
  zero,
} from './money.js';

describe('construcción y formato', () => {
  it('parsea decimales con punto y con coma', () => {
    expect(moneyFromDecimalString('1234.56', 'ARS').amount).toBe(123_456n);
    expect(moneyFromDecimalString('1234,56', 'ARS').amount).toBe(123_456n);
    expect(moneyFromDecimalString('-0.05', 'ARS').amount).toBe(-5n);
    expect(moneyFromDecimalString('7', 'ARS').amount).toBe(700n);
  });

  it('rechaza más decimales de los que admite la moneda en vez de truncar', () => {
    expect(() => moneyFromDecimalString('1.005', 'ARS')).toThrow(/decimales/);
  });

  it('respeta monedas sin decimales', () => {
    expect(moneyFromDecimalString('1500', 'CLP').amount).toBe(1500n);
    expect(() => moneyFromDecimalString('1500.5', 'CLP')).toThrow();
  });

  it('formatea en es-AR con negativos entre paréntesis', () => {
    expect(formatAr(moneyFromDecimalString('1234567.89', 'ARS'))).toBe('1.234.567,89');
    expect(formatAr(moneyFromDecimalString('-42.5', 'ARS'))).toBe('(42,50)');
    expect(formatAr(zero('ARS'))).toBe('0,00');
  });

  it('ida y vuelta a string decimal', () => {
    for (const value of ['0.00', '0.01', '-0.01', '999999999999.99']) {
      const parsed = moneyFromDecimalString(value, 'ARS');
      expect(toDecimalString(parsed)).toBe(value);
    }
  });
});

describe('aritmética', () => {
  it('no permite operar entre monedas distintas', () => {
    expect(() => add(money(100n, 'ARS'), money(100n, 'USD'))).toThrow(/monedas distintas/);
  });

  it('el clásico 0,1 + 0,2 da exactamente 0,3', () => {
    const result = add(moneyFromDecimalString('0.10', 'ARS'), moneyFromDecimalString('0.20', 'ARS'));
    expect(toDecimalString(result)).toBe('0.30');
  });

  it('suma y resta preservan el total', () => {
    const a = moneyFromDecimalString('1000.00', 'ARS');
    const b = moneyFromDecimalString('333.33', 'ARS');
    expect(toDecimalString(subtract(add(a, b), b))).toBe('1000.00');
  });

  it('sum de una lista vacía es cero de la moneda pedida', () => {
    expect(sum([], 'ARS').amount).toBe(0n);
  });

  it('compare ordena correctamente', () => {
    expect(compare(money(1n, 'ARS'), money(2n, 'ARS'))).toBe(-1);
    expect(compare(money(2n, 'ARS'), money(2n, 'ARS'))).toBe(0);
    expect(compare(money(3n, 'ARS'), money(2n, 'ARS'))).toBe(1);
  });
});

describe('tasas y redondeo', () => {
  it('IVA 21% sobre 1.000,00', () => {
    const neto = moneyFromDecimalString('1000.00', 'ARS');
    const iva = multiplyByRate(neto, rate('21', { percent: true }), 'HALF_UP');
    expect(toDecimalString(iva)).toBe('210.00');
  });

  it('IVA 10,5% sobre 1.234,56 según el modo de redondeo', () => {
    const neto = moneyFromDecimalString('1234.56', 'ARS');
    const factor = rate('10.5', { percent: true });
    // 1234,56 * 0,105 = 129,6288
    expect(toDecimalString(multiplyByRate(neto, factor, 'HALF_UP'))).toBe('129.63');
    expect(toDecimalString(multiplyByRate(neto, factor, 'DOWN'))).toBe('129.62');
    expect(toDecimalString(multiplyByRate(neto, factor, 'UP'))).toBe('129.63');
  });

  it('HALF_EVEN desempata al par y HALF_UP se aleja del cero', () => {
    const half = rate('0.5');
    expect(toDecimalString(multiplyByRate(money(5n, 'ARS'), half, 'HALF_EVEN'))).toBe('0.02');
    expect(toDecimalString(multiplyByRate(money(5n, 'ARS'), half, 'HALF_UP'))).toBe('0.03');
    expect(toDecimalString(multiplyByRate(money(15n, 'ARS'), half, 'HALF_EVEN'))).toBe('0.08');
  });

  it('el redondeo de negativos es simétrico respecto del cero', () => {
    const factor = rate('0.5');
    expect(multiplyByRate(money(-5n, 'ARS'), factor, 'HALF_UP').amount).toBe(-3n);
    expect(multiplyByRate(money(-5n, 'ARS'), factor, 'DOWN').amount).toBe(-2n);
  });
});

describe('allocate — P-7: el redondeo nunca crea ni destruye centavos', () => {
  it('reparte 0,10 en tres partes iguales sin perder un centavo', () => {
    const parts = allocate(moneyFromDecimalString('0.10', 'ARS'), [1n, 1n, 1n]);
    expect(parts.map(toDecimalString)).toEqual(['0.04', '0.03', '0.03']);
    expect(sum(parts, 'ARS').amount).toBe(10n);
  });

  it('reparte proporcionalmente por pesos', () => {
    const parts = allocate(moneyFromDecimalString('100.00', 'ARS'), [70n, 30n]);
    expect(parts.map(toDecimalString)).toEqual(['70.00', '30.00']);
  });

  it('funciona con importes negativos', () => {
    const parts = allocate(moneyFromDecimalString('-0.10', 'ARS'), [1n, 1n, 1n]);
    expect(sum(parts, 'ARS').amount).toBe(-10n);
  });

  it('propiedad: para cualquier importe y pesos, la suma del reparto es el original', () => {
    const amounts = [0n, 1n, 7n, 99n, 100n, 12_345n, 999_999_999n, -1n, -12_345n];
    const weightSets: bigint[][] = [
      [1n],
      [1n, 1n],
      [1n, 1n, 1n],
      [1n, 2n, 3n],
      [7n, 11n, 13n, 17n],
      [0n, 1n, 0n, 5n],
      [1n, 1n, 1n, 1n, 1n, 1n, 1n],
    ];
    for (const amount of amounts) {
      for (const weights of weightSets) {
        const original = money(amount, 'ARS');
        const parts = allocate(original, weights);
        expect(parts).toHaveLength(weights.length);
        expect(sum(parts, 'ARS').amount).toBe(amount);
      }
    }
  });

  it('rechaza pesos inválidos en lugar de repartir cualquier cosa', () => {
    expect(() => allocate(money(100n, 'ARS'), [])).toThrow();
    expect(() => allocate(money(100n, 'ARS'), [0n, 0n])).toThrow();
    expect(() => allocate(money(100n, 'ARS'), [-1n, 2n])).toThrow();
  });
});

describe('rango', () => {
  it('soporta importes muy por encima de Number.MAX_SAFE_INTEGER', () => {
    const huge = moneyFromDecimalString('999999999999999999999.99', 'ARS');
    const doubled = add(huge, huge);
    expect(toDecimalString(doubled)).toBe('1999999999999999999999.98');
  });
});

describe('conversión de moneda', () => {
  const dolar = { numerator: 1000n, denominator: 1n };

  it('convierte con una cotización exacta', () => {
    // USD 100,00 a 1000 → ARS 100.000,00
    expect(convert(money(10_000n, 'USD'), 'ARS', dolar, 'HALF_UP')).toEqual({
      amount: 10_000_000n,
      currency: 'ARS',
    });
  });

  it('ajusta la escala cuando las monedas tienen distintos decimales', () => {
    // CLP no tiene centavos. Sin ajustar la escala el resultado saldría cien
    // veces más grande, y nada en el sistema lo notaría.
    const aPesosChilenos = { numerator: 1n, denominator: 1n };
    expect(convert(money(12_345n, 'ARS'), 'CLP', aPesosChilenos, 'HALF_UP').amount).toBe(123n);
    expect(convert(money(123n, 'CLP'), 'ARS', aPesosChilenos, 'HALF_UP').amount).toBe(12_300n);
  });

  it('el modo de redondeo cambia el resultado, y por eso se pide', () => {
    const media = { numerator: 100_050n, denominator: 100n }; // 1000,50
    expect(convert(money(1n, 'USD'), 'ARS', media, 'HALF_UP').amount).toBe(1001n);
    expect(convert(money(1n, 'USD'), 'ARS', media, 'DOWN').amount).toBe(1000n);
    expect(convert(money(1n, 'USD'), 'ARS', media, 'HALF_EVEN').amount).toBe(1000n);
  });

  it('rechaza un denominador no positivo en lugar de dividir por cero', () => {
    expect(() => convert(money(1n, 'USD'), 'ARS', { numerator: 1n, denominator: 0n }, 'HALF_UP')).toThrow();
  });

  it('no pierde precisión con importes grandes', () => {
    const grande = moneyFromDecimalString('99999999999999999.99', 'USD');
    const convertido = convert(grande, 'ARS', dolar, 'HALF_UP');
    expect(convertido.amount).toBe(grande.amount * 1000n);
  });
});
