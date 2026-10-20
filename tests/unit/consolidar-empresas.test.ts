/**
 * El total consolidado de varias empresas lo calcula el sistema, con enteros, y sólo cuando es un total de verdad.
 */

import { centavosATextoEs, centavosDe, consolidar } from '@aai/api/asistente/consolidar';
import { describe, expect, it } from 'vitest';

describe('importes en el formato del sistema', () => {
  it('ida y vuelta sin perder un centavo', () => {
    for (const v of ['0,00', '1,05', '1.234.567,89', '999,99', '1.000,00', '-2.500,10']) {
      expect(centavosATextoEs(centavosDe(v)!), v).toBe(v);
    }
  });

  it('lo que no es un importe no se interpreta', () => {
    for (const v of ['', 'abc', '12 de 20', '1,234,567.89', '1.2.3', '$ 100,00']) expect(centavosDe(v), v).toBeNull();
  });

  it('sin decimales o con uno, completa a centavos', () => {
    expect(centavosDe('1.500')).toBe(150_000n);
    expect(centavosDe('7,5')).toBe(750n);
  });
});

describe('consolidar', () => {
  it('suma en enteros: ninguna coma flotante (0,10 + 0,20 es 0,30)', () => {
    const r = consolidar([
      { valor: '0,10', unidad: '$' },
      { valor: '0,20', unidad: '$' },
    ]);
    expect(r.consolidado).toEqual({ valor: '0,30', unidad: '$', empresasSumadas: 2 });
  });

  it('suma grandes importes exactos', () => {
    const r = consolidar([
      { valor: '1.234.567,89', unidad: '$ neto' },
      { valor: '8.765.432,11', unidad: '$ neto' },
      { valor: '0,00', unidad: '$ neto' },
    ]);
    expect(r.consolidado?.valor).toBe('10.000.000,00');
    expect(r.consolidado?.empresasSumadas).toBe(3);
  });

  it('con una sola empresa no hay nada que consolidar', () => {
    const r = consolidar([{ valor: '10,00', unidad: '$' }]);
    expect(r.consolidado).toBeNull();
    expect(r.motivoSinTotal).toMatch(/una sola empresa/u);
  });

  it('unidades distintas no se suman', () => {
    const r = consolidar([
      { valor: '10,00', unidad: '$' },
      { valor: '3', unidad: 'proyectos' },
    ]);
    expect(r.consolidado).toBeNull();
    expect(r.motivoSinTotal).toMatch(/unidades distintas/u);
  });

  it('si alguna empresa no pudo afirmar su valor, no hay total: dejarla afuera daría un número que parece total y no lo es', () => {
    const r = consolidar([
      { valor: '10,00', unidad: '$' },
      { valor: null, unidad: '$' },
    ]);
    expect(r.consolidado).toBeNull();
    expect(r.motivoSinTotal).toMatch(/no pudo afirmar/u);
  });

  it('un porcentaje no se suma', () => {
    const r = consolidar([
      { valor: '12,5', unidad: '%' },
      { valor: '20,0', unidad: '%' },
    ]);
    expect(r.consolidado).toBeNull();
    expect(r.motivoSinTotal).toMatch(/porcentaje/u);
  });

  it('un valor que no es un importe no se suma', () => {
    const r = consolidar([
      { valor: '4 de 5', unidad: 'ítems' },
      { valor: '2 de 3', unidad: 'ítems' },
    ]);
    expect(r.consolidado).toBeNull();
  });
});
