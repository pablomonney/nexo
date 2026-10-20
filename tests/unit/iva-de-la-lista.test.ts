/**
 * El IVA que se suma a un precio de lista NETO («+ IVA»).
 *
 * Antes de esto el cargo salía por el neto tal cual: la lista decía «+ IVA» y se cobraba un 21 % menos de lo que la página prometía.
 * Todo en centavos enteros: nunca punto flotante.
 */

import { describe, expect, it } from 'vitest';
import { ALICUOTA_GENERAL_DEL_IVA, centavosATexto, sumarIva } from '../../apps/api/src/billing/iva.js';

describe('sumarIva', () => {
  it('la alícuota es la general: 21 %', () => {
    expect(ALICUOTA_GENERAL_DEL_IVA).toBe(21n);
  });

  it('suma el 21 % exacto cuando divide justo', () => {
    expect(sumarIva(10_000n)).toEqual({ netoCentavos: 10_000n, ivaCentavos: 2_100n, totalCentavos: 12_100n });
  });

  it('redondea el IVA al centavo más cercano, la mitad hacia arriba', () => {
    // 12345,67 × 21 % = 2592,5907 → 2592,59
    expect(sumarIva(1_234_567n).ivaCentavos).toBe(259_259n);
    // 0,50 × 21 % = 0,105 → 0,11 (la mitad hacia arriba); 0,24 × 21 % = 0,0504 → 0,05
    expect(sumarIva(50n).ivaCentavos).toBe(11n);
    expect(sumarIva(24n).ivaCentavos).toBe(5n);
  });

  it('el total es neto + IVA, sin perder un centavo', () => {
    for (const neto of [1n, 99n, 4_950_413n, 9_909_091n, 20_652_893n, 37_181_818n, 12_388_430n, 7_429_752n, 5_000_000n]) {
      const r = sumarIva(neto);
      expect(r.totalCentavos).toBe(neto + r.ivaCentavos);
    }
  });

  it('los cinco precios publicados (netos y redondos) dan el final con IVA que se cobra', () => {
    // Netos = el múltiplo de $ 5.000 más cercano a (final de septiembre ÷ 1,21); el final con IVA queda a menos de un 2 % del anterior.
    const lista: Array<[string, bigint, bigint]> = [
      ['CONTABLE', 5_000_000n, 6_050_000n],
      ['ESTUDIO', 7_500_000n, 9_075_000n],
      ['GESTION', 10_000_000n, 12_100_000n],
      ['EMPRESA_B1', 20_500_000n, 24_805_000n],
      ['COMPLETO', 37_000_000n, 44_770_000n],
    ];
    for (const [plan, neto, final] of lista) expect(sumarIva(neto).totalCentavos, plan).toBe(final);

    const anteriores: Record<string, bigint> = {
      CONTABLE: 5_990_000n, ESTUDIO: 8_990_000n, GESTION: 11_990_000n, EMPRESA_B1: 24_990_000n, COMPLETO: 44_990_000n,
    };
    for (const [plan, neto, final] of lista) {
      const antes = anteriores[plan]!;
      const diferencia = final > antes ? final - antes : antes - final;
      expect(diferencia * 100n < antes * 2n, `${plan} cambia más de un 2 %`).toBe(true);
      void neto;
    }
  });

  it('cero queda en cero y un importe negativo no existe', () => {
    expect(sumarIva(0n).totalCentavos).toBe(0n);
    expect(() => sumarIva(-1n)).toThrow(RangeError);
  });
});

describe('centavosATexto', () => {
  it('escribe el importe con dos decimales, sin pasar por flotante', () => {
    expect(centavosATexto(1_493_826n)).toBe('14938.26');
    expect(centavosATexto(5n)).toBe('0.05');
    expect(centavosATexto(100n)).toBe('1.00');
    expect(centavosATexto(0n)).toBe('0.00');
  });
});
