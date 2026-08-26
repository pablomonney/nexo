/**
 * Tests del motor de auditoría.
 *
 * Dos ideas se prueban acá y son las que definen la fase: **un análisis de
 * variaciones no elige entre porcentaje e importe**, y **una anomalía dice qué se
 * observó, nunca qué significa**.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, type CalendarDate, type Money } from '@aai/shared';
import {
  UMBRALES_POR_DEFECTO,
  analizarVariaciones,
  asientosTardios,
  auditar,
  importesAtipicos,
  importesRedondos,
  justoBajoUmbral,
  madDe,
  medianaDe,
  resumirVariaciones,
  significativas,
  type AsientoParaAuditar,
  type SaldoComparable,
} from './index.js';

const fecha = (iso: string): CalendarDate => parseCalendarDate(iso);
const pesos = (centavos: bigint): Money => money(centavos, 'ARS');

function saldo(
  codigo: string,
  actual: bigint,
  anterior: bigint,
): SaldoComparable {
  return {
    accountId: `acc-${codigo}`,
    codigo,
    nombre: `Cuenta ${codigo}`,
    actual: pesos(actual),
    anterior: pesos(anterior),
  };
}

// ---------------------------------------------------------------------------
// Variaciones
// ---------------------------------------------------------------------------

describe('el análisis no elige entre porcentaje e importe', () => {
  it('la cuenta chica que se multiplicó y la grande que se movió aparecen las dos', () => {
    const variaciones = analizarVariaciones([
      // 300% pero mueve 300 pesos.
      saldo('5.1.01', 40_000n, 10_000n),
      // 10% pero mueve cuatro millones.
      saldo('1.1.01', 4_400_000_000n, 4_000_000_000n),
    ]);

    expect(variaciones.every((v) => v.significativa)).toBe(true);
    expect(variaciones[0]?.porcentaje).toBe(300);
    expect(variaciones[0]?.absoluta.amount).toBe(30_000n);
    expect(variaciones[1]?.porcentaje).toBe(10);
    expect(variaciones[1]?.absoluta.amount).toBe(400_000_000n);
    // Los dos números viajan juntos: ordenar es decisión de quien presenta.
    expect(variaciones[0]?.motivo).toMatch(/varía 300%/);
    expect(variaciones[1]?.motivo).toMatch(/mueve 400000000/);
  });

  it('una variación por debajo de los dos umbrales no se marca', () => {
    const variaciones = analizarVariaciones([saldo('5.1.02', 105_000n, 100_000n)]);

    expect(variaciones[0]?.significativa).toBe(false);
    expect(variaciones[0]?.porcentaje).toBe(5);
    expect(variaciones[0]?.motivo).toMatch(/por debajo de los dos umbrales/);
  });

  it('el porcentaje se calcula en enteros, sin flotante', () => {
    // 1/3 = 33,33%. Con `Number` sobre saldos grandes esto se corre.
    const variaciones = analizarVariaciones([saldo('x', 400_000_000_000n, 300_000_000_000n)]);

    expect(variaciones[0]?.porcentaje).toBe(33);
    expect(Number.isInteger(variaciones[0]?.porcentaje)).toBe(true);
  });

  it('redondea al porcentaje más cercano, no trunca', () => {
    // 2/3 = 66,66% → 67.
    expect(analizarVariaciones([saldo('x', 500n, 300n)])[0]?.porcentaje).toBe(67);
  });
});

describe('el cero no es un porcentaje muy grande', () => {
  it('una cuenta que aparece se clasifica como aparición, no como ∞', () => {
    const variaciones = analizarVariaciones([saldo('2.1.09', 5_000_000n, 0n)]);

    expect(variaciones[0]?.tipo).toBe('APARECE');
    expect(variaciones[0]?.porcentaje).toBeNull();
    expect(variaciones[0]?.motivo).toMatch(/No es un porcentaje muy grande: es una aparición/);
  });

  it('una aparición es significativa por sí misma, sin importar el monto', () => {
    // Cien pesos: no supera ningún umbral. Igual se marca.
    const variaciones = analizarVariaciones([saldo('2.1.09', 10_000n, 0n)]);

    expect(variaciones[0]?.significativa).toBe(true);
  });

  it('una desaparición también', () => {
    const variaciones = analizarVariaciones([saldo('1.1.05', 0n, 300_000n)]);

    expect(variaciones[0]?.tipo).toBe('DESAPARECE');
    expect(variaciones[0]?.significativa).toBe(true);
    expect(variaciones[0]?.motivo).toMatch(/reclasificación que se hizo a medias/);
  });

  it('un cambio de signo es un hallazgo distinto de "subió mucho"', () => {
    const variaciones = analizarVariaciones([saldo('1.1.01', -50_000n, 200_000n)]);

    expect(variaciones[0]?.tipo).toBe('CAMBIA_DE_SIGNO');
    expect(variaciones[0]?.significativa).toBe(true);
    expect(variaciones[0]?.motivo).toMatch(/error de imputación/);
  });

  it('sin cambio no se marca', () => {
    const variaciones = analizarVariaciones([saldo('x', 100n, 100n)]);

    expect(variaciones[0]?.tipo).toBe('SIN_CAMBIO');
    expect(variaciones[0]?.significativa).toBe(false);
  });
});

describe('el resumen manda a mirar lo que corresponde primero', () => {
  it('los cambios de signo van antes que todo', () => {
    const resumen = resumirVariaciones(
      analizarVariaciones([saldo('a', -50n, 200n), saldo('b', 900_000_000n, 100_000n)]),
    );

    expect(resumen.cambianDeSigno).toBe(1);
    expect(resumen.comentario).toMatch(/Empezá por ahí/);
  });

  it('ninguna variación significativa en un ejercicio completo es sospechoso en sí', () => {
    const resumen = resumirVariaciones(analizarVariaciones([saldo('a', 101n, 100n)]));

    expect(resumen.significativas).toBe(0);
    expect(resumen.comentario).toMatch(/revisá que los saldos comparativos sean los correctos/);
  });

  it('significativas() filtra sin ordenar', () => {
    const variaciones = analizarVariaciones([
      saldo('grande', 4_400_000_000n, 4_000_000_000n),
      saldo('chica', 40_000n, 10_000n),
      saldo('quieta', 100n, 100n),
    ]);
    const marcadas = significativas(variaciones);

    expect(marcadas).toHaveLength(2);
    // El orden es el de entrada: no se decide por el lector.
    expect(marcadas.map((v) => v.codigo)).toEqual(['grande', 'chica']);
  });

  it('los umbrales se pueden ajustar', () => {
    const estrictos = analizarVariaciones([saldo('x', 110_000n, 100_000n)], {
      porcentaje: 5,
      absoluto: UMBRALES_POR_DEFECTO.absoluto,
    });

    expect(estrictos[0]?.significativa).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anomalías
// ---------------------------------------------------------------------------

function asiento(overrides: Partial<AsientoParaAuditar> & { entryId: string }): AsientoParaAuditar {
  return {
    fecha: fecha('2026-03-10'),
    cargadoEl: '2026-03-11T10:00:00.000Z',
    importe: pesos(100_000n),
    cuentaCodigo: '5.1.01',
    contraparteId: 'party-1',
    ...overrides,
  };
}

describe('una anomalía dice qué se observó, nunca qué significa', () => {
  it('ningún hallazgo usa la palabra fraude ni concluye', () => {
    const resultado = auditar({
      asientos: [
        asiento({ entryId: 'a', importe: pesos(5_000_000n) }),
        asiento({ entryId: 'b', fecha: fecha('2026-01-01'), cargadoEl: '2026-09-01T00:00:00.000Z' }),
      ],
      historicosPorContraparte: new Map(),
    });

    const texto = resultado.anomalias.map((a) => `${a.observado} ${a.queMirar}`).join(' ');
    expect(texto).not.toMatch(/fraude|sospechoso|irregular|maniobra/i);
    // Y cada uno separa el hecho de la pregunta.
    for (const anomalia of resultado.anomalias) {
      expect(anomalia.observado.length).toBeGreaterThan(0);
      expect(anomalia.queMirar.length).toBeGreaterThan(0);
    }
  });

  it('un importe atípico se compara contra la historia de ESA contraparte', () => {
    const historia = new Map([['party-1', [100_000n, 102_000n, 98_000n, 101_000n, 99_000n, 100_500n, 99_500n, 100_200n]]]);
    const hallazgos = importesAtipicos(
      [asiento({ entryId: 'a', importe: pesos(9_000_000n) })],
      historia,
    );

    expect(hallazgos[0]?.codigo).toBe('IMPORTE_ATIPICO');
    expect(hallazgos[0]?.observado).toMatch(/mediana/);
    expect(hallazgos[0]?.queMirar).toMatch(/puede ser una operación legítimamente distinta/i);
  });

  it('con menos de ocho operaciones previas no se opina', () => {
    // La novena operación de un proveedor nuevo siempre se vería atípica.
    const historia = new Map([['party-1', [100_000n, 200_000n, 300_000n]]]);
    const hallazgos = importesAtipicos(
      [asiento({ entryId: 'a', importe: pesos(9_000_000n) })],
      historia,
    );

    expect(hallazgos).toEqual([]);
  });

  it('un asiento sin contraparte no se compara contra nada', () => {
    const hallazgos = importesAtipicos([asiento({ entryId: 'a', contraparteId: null })], new Map());
    expect(hallazgos).toEqual([]);
  });

  it('la mediana no se mueve con un valor extremo; la media sí', () => {
    const conExtremo = [10n, 10n, 10n, 10n, 1_000_000n];

    expect(medianaDe(conExtremo)).toBe(10n);
    // La media de esos cinco es 200.008: el extremo se llevó el estadístico.
    // Por eso el detector usa mediana.
    expect(madDe(conExtremo, 10n)).toBe(0n);
  });

  it('la mediana de un conjunto par promedia los dos centrales', () => {
    expect(medianaDe([10n, 20n, 30n, 40n])).toBe(25n);
    expect(medianaDe([])).toBe(0n);
    expect(medianaDe([7n])).toBe(7n);
  });

  it('con MAD cero, cualquier diferencia cuenta', () => {
    const historia = new Map([['party-1', Array.from({ length: 8 }, () => 100_000n)]]);

    expect(importesAtipicos([asiento({ entryId: 'a', importe: pesos(100_001n) })], historia)).toHaveLength(1);
    expect(importesAtipicos([asiento({ entryId: 'b', importe: pesos(100_000n) })], historia)).toEqual([]);
  });
});

describe('detectores que no concluyen', () => {
  it('un importe redondo se observa, no se acusa', () => {
    const hallazgos = importesRedondos([asiento({ entryId: 'a', importe: pesos(5_000_000n) })]);

    expect(hallazgos[0]?.codigo).toBe('IMPORTE_REDONDO');
    expect(hallazgos[0]?.observado).toMatch(/exactamente redondo/);
    expect(hallazgos[0]?.queMirar).toMatch(/el impuesto la rompe/);
  });

  it('un importe con IVA no es redondo y no se marca', () => {
    expect(importesRedondos([asiento({ entryId: 'a', importe: pesos(121_000n) })])).toEqual([]);
  });

  it('sin umbrales configurados el detector no inventa ninguno', () => {
    // Los umbrales salen de normas que este repositorio no tiene archivadas.
    expect(justoBajoUmbral([asiento({ entryId: 'a' })], [])).toEqual([]);

    const resultado = auditar({ asientos: [asiento({ entryId: 'a' })], historicosPorContraparte: new Map() });
    expect(resultado.comentario).toMatch(/no hay umbrales configurados/);
    expect(resultado.comentario).toMatch(/el motor no inventa ninguno/);
  });

  it('con umbrales, marca lo que queda justo por debajo y dice que uno solo no dice nada', () => {
    const hallazgos = justoBajoUmbral(
      [asiento({ entryId: 'a', importe: pesos(9_800_00n) })],
      [{ nombre: 'Régimen de información', monto: 10_000_00n }],
    );

    expect(hallazgos[0]?.codigo).toBe('JUSTO_BAJO_UMBRAL');
    expect(hallazgos[0]?.queMirar).toMatch(/Un caso aislado no dice nada/);
  });

  it('un importe por encima del umbral no es un hallazgo', () => {
    expect(
      justoBajoUmbral(
        [asiento({ entryId: 'a', importe: pesos(20_000_00n) })],
        [{ nombre: 'x', monto: 10_000_00n }],
      ),
    ).toEqual([]);
  });

  it('un asiento cargado meses después de su fecha contable se señala', () => {
    const hallazgos = asientosTardios([
      asiento({ entryId: 'a', fecha: fecha('2026-03-01'), cargadoEl: '2026-09-01T00:00:00.000Z' }),
    ]);

    expect(hallazgos[0]?.codigo).toBe('ASIENTO_TARDIO');
    expect(hallazgos[0]?.observado).toMatch(/184 días después/);
    expect(hallazgos[0]?.queMirar).toMatch(/no estuvo a la vista cuando se revisó su período/);
  });

  it('la carga normal, unos días después, no se marca', () => {
    expect(
      asientosTardios([
        asiento({ entryId: 'a', fecha: fecha('2026-03-01'), cargadoEl: '2026-03-05T00:00:00.000Z' }),
      ]),
    ).toEqual([]);
  });

  it('los hallazgos no traen puntaje ni prioridad', () => {
    const resultado = auditar({
      asientos: [asiento({ entryId: 'a', importe: pesos(5_000_000n) })],
      historicosPorContraparte: new Map(),
    });

    // Priorizar exigiría ponerle un número al riesgo, y ese número el software
    // no lo puede fundar.
    for (const anomalia of resultado.anomalias) {
      expect(Object.keys(anomalia).sort()).toEqual(['codigo', 'entryId', 'observado', 'queMirar']);
    }
    expect(resultado.asientosRevisados).toBe(1);
    expect(resultado.asientosConHallazgo).toBe(1);
  });
});
