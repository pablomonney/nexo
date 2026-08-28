/**
 * La aritmética del cierre y de la apertura, en el motor puro.
 *
 * Lo que estos tests fijan, por encima de cada caso: **el par cierre/apertura
 * conserva lo patrimonial y no conserva lo de resultado**. Es la única propiedad
 * del cierre que, si se rompe, no produce un error visible — produce un balance
 * que cuadra y un resultado contado dos veces.
 */

import { describe, expect, it } from 'vitest';
import { money, toDecimalString, type Money } from '@aai/shared';
import { planificarApertura, planificarCierre, type SaldoDeCuenta } from './cierre-de-ejercicio.js';

const pesos = (centavos: bigint): Money => money(centavos, 'ARS');

const RESULTADO = { accountId: 'acc-res', code: '3.4.01' };

function saldo(
  accountId: string,
  code: string,
  type: SaldoDeCuenta['type'],
  centavos: bigint,
): SaldoDeCuenta {
  return { accountId, code, name: code, type, saldo: pesos(centavos) };
}

/** Debe y Haber de un conjunto de líneas, para comprobar que cierran. */
function totales(lineas: readonly { debit: Money; credit: Money }[]): {
  debe: bigint;
  haber: bigint;
} {
  return {
    debe: lineas.reduce((acc, l) => acc + l.debit.amount, 0n),
    haber: lineas.reduce((acc, l) => acc + l.credit.amount, 0n),
  };
}

/** Ejercicio con ganancia: Caja 1710 D, Ventas 1710 H (saldo acreedor). */
const CON_GANANCIA: readonly SaldoDeCuenta[] = [
  saldo('acc-caja', '1.1.01', 'ACTIVO', 171_000n),
  saldo('acc-ventas', '4.1.01', 'INGRESO', -171_000n),
];

describe('determinación del resultado', () => {
  it('ingresos menos gastos, con ganancia', () => {
    const plan = planificarCierre(
      [
        saldo('acc-caja', '1.1.01', 'ACTIVO', 100_000n),
        saldo('acc-ventas', '4.1.01', 'INGRESO', -180_000n),
        saldo('acc-gasto', '5.1.01', 'GASTO', 80_000n),
      ],
      RESULTADO,
      'ARS',
    );
    if (!plan.ok) throw new Error(plan.errors.map((e) => e.message).join('; '));

    expect(toDecimalString(plan.value.ingresos)).toBe('1800.00');
    expect(toDecimalString(plan.value.gastos)).toBe('800.00');
    expect(toDecimalString(plan.value.resultado)).toBe('1000.00');
  });

  it('resultado negativo cuando los gastos superan a los ingresos', () => {
    const plan = planificarCierre(
      [
        saldo('acc-prov', '2.1.01', 'PASIVO', -50_000n),
        saldo('acc-ventas', '4.1.01', 'INGRESO', -30_000n),
        saldo('acc-gasto', '5.1.01', 'GASTO', 80_000n),
      ],
      RESULTADO,
      'ARS',
    );
    if (!plan.ok) throw new Error('debería planificar');

    expect(toDecimalString(plan.value.resultado)).toBe('-500.00');
    // La pérdida se DEBITA en la cuenta de resultado.
    const contrapartida = plan.value.refundicion.find((l) => l.accountId === RESULTADO.accountId);
    expect(toDecimalString(contrapartida!.debit)).toBe('500.00');
  });

  it('resultado cero: hay refundición y no hay contrapartida', () => {
    // Ingresos y gastos iguales. Las dos cuentas se cancelan entre sí y la
    // cuenta de resultado no participa: agregarle una línea de cero la haría
    // rebotar contra `jel_one_side`.
    const plan = planificarCierre(
      [
        saldo('acc-ventas', '4.1.01', 'INGRESO', -40_000n),
        saldo('acc-gasto', '5.1.01', 'GASTO', 40_000n),
      ],
      RESULTADO,
      'ARS',
    );
    if (!plan.ok) throw new Error('debería planificar');

    expect(plan.value.resultado.amount).toBe(0n);
    expect(plan.value.refundicion).toHaveLength(2);
    expect(plan.value.refundicion.some((l) => l.accountId === RESULTADO.accountId)).toBe(false);
    const t = totales(plan.value.refundicion);
    expect(t.debe).toBe(t.haber);
  });

  it('un ejercicio sin movimientos de resultado no genera refundición', () => {
    const plan = planificarCierre(
      [
        saldo('acc-caja', '1.1.01', 'ACTIVO', 100_000n),
        saldo('acc-cap', '3.1.01', 'PN', -100_000n),
      ],
      RESULTADO,
      'ARS',
    );
    if (!plan.ok) throw new Error('debería planificar');

    expect(plan.value.refundicion).toEqual([]);
    expect(plan.value.resultado.amount).toBe(0n);
    // Pero sí hay cierre: lo patrimonial se cancela igual.
    expect(plan.value.cierre).toHaveLength(2);
  });
});

describe('el asiento de refundición', () => {
  it('cancela las cuentas de resultado y cuadra', () => {
    const plan = planificarCierre(CON_GANANCIA, RESULTADO, 'ARS');
    if (!plan.ok) throw new Error('debería planificar');

    // Ventas tenía saldo acreedor: se debita para llevarlo a cero.
    const ventas = plan.value.refundicion.find((l) => l.accountCode === '4.1.01');
    expect(toDecimalString(ventas!.debit)).toBe('1710.00');

    // Y la ganancia se acredita en la cuenta de resultado.
    const res = plan.value.refundicion.find((l) => l.accountId === RESULTADO.accountId);
    expect(toDecimalString(res!.credit)).toBe('1710.00');

    const t = totales(plan.value.refundicion);
    expect(t.debe).toBe(t.haber);
  });

  it('NO toca ninguna cuenta patrimonial', () => {
    // Es la mitad del invariante: la refundición mueve resultado, no patrimonio.
    const plan = planificarCierre(
      [
        saldo('acc-caja', '1.1.01', 'ACTIVO', 171_000n),
        saldo('acc-cap', '3.1.01', 'PN', -50_000n),
        saldo('acc-ventas', '4.1.01', 'INGRESO', -121_000n),
      ],
      RESULTADO,
      'ARS',
    );
    if (!plan.ok) throw new Error('debería planificar');

    const tocadas = plan.value.refundicion.map((l) => l.accountCode);
    expect(tocadas).not.toContain('1.1.01');
    expect(tocadas).not.toContain('3.1.01');
    expect(tocadas.sort()).toEqual(['3.4.01', '4.1.01']);
  });
});

describe('el asiento de cierre', () => {
  it('lleva a cero lo patrimonial, con el resultado ya refundido adentro', () => {
    const plan = planificarCierre(CON_GANANCIA, RESULTADO, 'ARS');
    if (!plan.ok) throw new Error('debería planificar');

    // Caja era deudora: se acredita. La cuenta de resultado quedó acreedora tras
    // la refundición: se debita.
    const caja = plan.value.cierre.find((l) => l.accountCode === '1.1.01');
    expect(toDecimalString(caja!.credit)).toBe('1710.00');
    const res = plan.value.cierre.find((l) => l.accountCode === '3.4.01');
    expect(toDecimalString(res!.debit)).toBe('1710.00');

    const t = totales(plan.value.cierre);
    expect(t.debe).toBe(t.haber);
  });

  it('la cuenta de resultado entra aunque nunca se haya movido', () => {
    // Primer cierre de una empresa: la cuenta de resultado se creó y no tiene
    // saldo. Si no se la agregara, el resultado del ejercicio se perdería y el
    // asiento de cierre no cuadraría.
    const plan = planificarCierre(CON_GANANCIA, RESULTADO, 'ARS');
    if (!plan.ok) throw new Error('debería planificar');

    const enSaldos = plan.value.saldosFinales.find((s) => s.accountId === RESULTADO.accountId);
    expect(toDecimalString(enSaldos!.saldo)).toBe('-1710.00');
  });

  it('los saldos finales no incluyen ninguna cuenta de resultado', () => {
    const plan = planificarCierre(CON_GANANCIA, RESULTADO, 'ARS');
    if (!plan.ok) throw new Error('debería planificar');
    expect(plan.value.saldosFinales.map((s) => s.type)).not.toContain('INGRESO');
    expect(plan.value.saldosFinales.map((s) => s.type)).not.toContain('GASTO');
  });

  it('las cuentas de orden atraviesan el cierre como patrimoniales', () => {
    const plan = planificarCierre(
      [
        saldo('acc-orden-d', '7.1.01', 'ORDEN', 25_000n),
        saldo('acc-orden-h', '7.2.01', 'ORDEN', -25_000n),
      ],
      RESULTADO,
      'ARS',
    );
    if (!plan.ok) throw new Error('debería planificar');
    expect(plan.value.refundicion).toEqual([]);
    expect(plan.value.saldosFinales).toHaveLength(2);
  });
});

describe('lo que el cierre se niega a hacer', () => {
  it('no cierra sobre un Mayor descuadrado: lo informa', () => {
    const plan = planificarCierre(
      [
        saldo('acc-caja', '1.1.01', 'ACTIVO', 100_000n),
        saldo('acc-ventas', '4.1.01', 'INGRESO', -99_000n),
      ],
      RESULTADO,
      'ARS',
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.errors[0]?.code).toBe('E_UNBALANCED');
    expect(plan.errors[0]?.details?.['diferenciaEnMenor']).toBe('1000');
  });
});

describe('la apertura', () => {
  it('reproduce los saldos finales del mismo lado y cuadra', () => {
    const cierre = planificarCierre(CON_GANANCIA, RESULTADO, 'ARS');
    if (!cierre.ok) throw new Error('debería planificar');

    const apertura = planificarApertura(cierre.value.saldosFinales, 'ARS');
    if (!apertura.ok) throw new Error(apertura.errors.map((e) => e.message).join('; '));

    // Caja era deudora al cierre: en la apertura vuelve al Debe.
    const caja = apertura.value.find((l) => l.accountCode === '1.1.01');
    expect(toDecimalString(caja!.debit)).toBe('1710.00');
    const res = apertura.value.find((l) => l.accountCode === '3.4.01');
    expect(toDecimalString(res!.credit)).toBe('1710.00');

    const t = totales(apertura.value);
    expect(t.debe).toBe(t.haber);
  });

  it('la apertura es exactamente el reverso del cierre', () => {
    // La propiedad que hace que el arrastre sea neutro: si el cierre pone un
    // importe de un lado y la apertura del otro, la suma acumulada a través del
    // corte no cambia.
    const cierre = planificarCierre(CON_GANANCIA, RESULTADO, 'ARS');
    if (!cierre.ok) throw new Error('debería planificar');
    const apertura = planificarApertura(cierre.value.saldosFinales, 'ARS');
    if (!apertura.ok) throw new Error('debería planificar');

    for (const linea of cierre.value.cierre) {
      const espejo = apertura.value.find((l) => l.accountId === linea.accountId);
      expect(espejo!.debit.amount).toBe(linea.credit.amount);
      expect(espejo!.credit.amount).toBe(linea.debit.amount);
    }
  });

  it('se niega a trasladar una cuenta de resultado', () => {
    // No debería llegar nunca por el camino productivo —el cierre las filtra—,
    // y por eso mismo el control vale: si alguien arma los saldos a mano, esto
    // es lo que impide contar el mismo ingreso en dos ejercicios.
    const apertura = planificarApertura(
      [
        saldo('acc-caja', '1.1.01', 'ACTIVO', 171_000n),
        saldo('acc-ventas', '4.1.01', 'INGRESO', -171_000n),
      ],
      'ARS',
    );
    expect(apertura.ok).toBe(false);
    if (apertura.ok) return;
    expect(apertura.errors[0]?.code).toBe('E_ACCOUNT_NOT_POSTABLE');
    expect(apertura.errors[0]?.message).toMatch(/4\.1\.01/);
  });

  it('se niega si los saldos de apertura no cuadran', () => {
    const apertura = planificarApertura(
      [
        saldo('acc-caja', '1.1.01', 'ACTIVO', 171_000n),
        saldo('acc-cap', '3.1.01', 'PN', -170_000n),
      ],
      'ARS',
    );
    expect(apertura.ok).toBe(false);
    if (apertura.ok) return;
    expect(apertura.errors[0]?.code).toBe('E_UNBALANCED');
  });

  it('un ejercicio que cerró en cero no genera líneas de apertura', () => {
    const apertura = planificarApertura([], 'ARS');
    if (!apertura.ok) throw new Error('debería planificar');
    expect(apertura.value).toEqual([]);
  });
});
