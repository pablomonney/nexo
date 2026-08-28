/**
 * Tests del Libro Diario y del Libro Mayor.
 *
 * El criterio de salida de la fase es una frase: *el Mayor reconstruido desde el
 * Diario coincide exactamente; el balance cierra en sus tres igualdades; cada
 * movimiento navega hasta el documento original*. Los tres primeros `describe`
 * de este archivo son esa frase, verificada.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, zero, type CalendarDate, type Money } from '@aai/shared';
import {
  asientosDelDiario,
  balanceDesdeMayor,
  construirLibroDiario,
  construirLibroMayor,
  exportarDiarioCsv,
  exportarMayorCsv,
  hashDeLibro,
  pieDeLibro,
  resumenCoincideConDetalle,
  resumirPorMes,
  saldosDeCierre,
  saldosPorNaturaleza,
  verificarProyeccion,
  type AsientoDelLibro,
  type CuentaParaElMayor,
  type LineaDelLibro,
  type MovimientoMaterializado,
  type SubdiarioDeclarado,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fecha = (iso: string): CalendarDate => parseCalendarDate(iso);
const pesos = (centavos: bigint): Money => money(centavos, 'ARS');

const EJERCICIO = 'fy-2026';
const PERIODO = 'per-2026-03';
const EMPRESA = 'co-1';

const CATALOGO: readonly CuentaParaElMayor[] = [
  { id: 'acc-caja', code: '1.1.01', name: 'Caja', nature: 'DEUDORA' },
  { id: 'acc-iva', code: '1.1.05', name: 'IVA Crédito Fiscal', nature: 'DEUDORA' },
  { id: 'acc-gasto', code: '5.1.01', name: 'Gastos de administración', nature: 'DEUDORA' },
  { id: 'acc-prov', code: '2.1.01', name: 'Proveedores', nature: 'ACREEDORA' },
  { id: 'acc-ventas', code: '4.1.01', name: 'Ventas', nature: 'ACREEDORA' },
];

function linea(overrides: Partial<LineaDelLibro> & { id: string; accountId: string }): LineaDelLibro {
  const ficha = CATALOGO.find((cuenta) => cuenta.id === overrides.accountId);
  return {
    lineNo: 1,
    accountCode: ficha?.code ?? '',
    accountName: ficha?.name ?? '',
    debit: zero('ARS'),
    credit: zero('ARS'),
    monedaOriginal: null,
    importeOriginal: null,
    fxRate: null,
    fxSource: null,
    fxDate: null,
    costCenterCode: null,
    partyId: null,
    description: null,
    taxTransactionId: null,
    ...overrides,
  };
}

function asiento(
  overrides: Partial<AsientoDelLibro> & { id: string; entryNumber: number; entryDate: CalendarDate },
): AsientoDelLibro {
  return {
    journalCode: 'COMPRAS',
    description: `Asiento ${overrides.entryNumber}`,
    kind: 'NORMAL',
    status: 'APROBADO',
    fiscalYearId: EJERCICIO,
    periodId: PERIODO,
    reversesEntryId: null,
    sourceType: 'INVOICE',
    sourceId: `doc-${overrides.id}`,
    documentId: `doc-${overrides.id}`,
    manualJustification: null,
    decisionId: null,
    aiPredictionId: null,
    createdBy: 'u-carga',
    approvedBy: 'u-contador',
    lines: [],
    ...overrides,
  };
}

/** Una compra: gasto + IVA contra proveedores. Cierra en partida doble. */
function compra(numero: number, dia: string, neto: bigint, iva: bigint): AsientoDelLibro {
  const id = `je-${numero}`;
  return asiento({
    id,
    entryNumber: numero,
    entryDate: fecha(dia),
    lines: [
      linea({ id: `${id}-1`, lineNo: 1, accountId: 'acc-gasto', debit: pesos(neto) }),
      linea({ id: `${id}-2`, lineNo: 2, accountId: 'acc-iva', debit: pesos(iva) }),
      linea({
        id: `${id}-3`,
        lineNo: 3,
        accountId: 'acc-prov',
        credit: pesos(neto + iva),
        partyId: 'party-1',
      }),
    ],
  });
}

const OPCIONES_DIARIO = {
  companyId: EMPRESA,
  fiscalYearId: EJERCICIO,
  moneda: 'ARS' as const,
  desde: fecha('2026-03-01'),
  hasta: fecha('2026-03-31'),
};

const OPCIONES_MAYOR = {
  companyId: EMPRESA,
  moneda: 'ARS' as const,
  desde: fecha('2026-03-01'),
  hasta: fecha('2026-03-31'),
  cuentas: CATALOGO,
};

const MARZO: readonly AsientoDelLibro[] = [
  compra(1, '2026-03-02', 100_000n, 21_000n),
  compra(2, '2026-03-10', 50_000n, 10_500n),
  compra(3, '2026-03-21', 33_333n, 7_000n),
];

// ---------------------------------------------------------------------------
// El criterio de la fase, en tres pruebas
// ---------------------------------------------------------------------------

describe('el Mayor reconstruido desde el Diario coincide exactamente', () => {
  it('reproduce cada movimiento materializado, sin sobrantes ni faltantes', () => {
    const diario = construirLibroDiario(MARZO, OPCIONES_DIARIO);
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);

    // Lo que la base tendría en ledger_movements: una fila por línea.
    const materializado: MovimientoMaterializado[] = MARZO.flatMap((entrada) =>
      entrada.lines.map((l) => ({
        entryLineId: l.id,
        accountId: l.accountId,
        fecha: entrada.entryDate,
        debe: l.debit,
        haber: l.credit,
      })),
    );

    const verificacion = verificarProyeccion(mayor, materializado);

    expect(diario.asientos).toBe(3);
    expect(verificacion.movimientos).toBe(9);
    expect(verificacion.discrepancias).toEqual([]);
    expect(verificacion.coincide).toBe(true);
  });

  it('un movimiento del Mayor sin línea en el Diario es la discrepancia grave', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const materializado: MovimientoMaterializado[] = [
      ...MARZO.flatMap((entrada) =>
        entrada.lines.map((l) => ({
          entryLineId: l.id,
          accountId: l.accountId,
          fecha: entrada.entryDate,
          debe: l.debit,
          haber: l.credit,
        })),
      ),
      {
        entryLineId: 'linea-fantasma',
        accountId: 'acc-caja',
        fecha: fecha('2026-03-15'),
        debe: pesos(999_999n),
        haber: zero('ARS'),
      },
    ];

    const verificacion = verificarProyeccion(mayor, materializado);

    expect(verificacion.coincide).toBe(false);
    expect(verificacion.discrepancias).toHaveLength(1);
    expect(verificacion.discrepancias[0]?.tipo).toBe('SOBRA_EN_MAYOR');
    expect(verificacion.discrepancias[0]?.detalle).toMatch(/saldo sin origen/i);
  });

  it('detecta el importe cambiado, la cuenta cambiada y la línea que no llegó', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const todos = MARZO.flatMap((entrada) =>
      entrada.lines.map((l) => ({
        entryLineId: l.id,
        accountId: l.accountId,
        fecha: entrada.entryDate,
        debe: l.debit,
        haber: l.credit,
      })),
    );

    const primero = todos[0];
    const segundo = todos[1];
    expect(primero).toBeDefined();
    expect(segundo).toBeDefined();
    if (primero === undefined || segundo === undefined) return;

    const alterado: MovimientoMaterializado[] = [
      { ...primero, debe: pesos(primero.debe.amount + 1n) },
      { ...segundo, accountId: 'acc-caja' },
      ...todos.slice(2, -1),
    ];

    const verificacion = verificarProyeccion(mayor, alterado);
    const tipos = verificacion.discrepancias.map((d) => d.tipo);

    expect(tipos).toContain('IMPORTE_DISTINTO');
    expect(tipos).toContain('CUENTA_DISTINTA');
    expect(tipos).toContain('FALTA_EN_MAYOR');
  });
});

describe('el balance cierra en sus tres igualdades', () => {
  it('sale del Mayor y las tres verificaciones dan bien', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const balance = balanceDesdeMayor(mayor);

    expect(balance.cuadra).toBe(true);
    expect(balance.verificaciones.map((v) => v.cumple)).toEqual([true, true, true]);
    expect(balance.totalDebitos.amount).toBe(balance.totalCreditos.amount);
    expect(balance.totalSaldosDeudores.amount).toBe(balance.totalSaldosAcreedores.amount);
  });

  it('el Mayor y el balance dan los mismos totales: son la misma fuente', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const balance = balanceDesdeMayor(mayor);
    const porNaturaleza = saldosPorNaturaleza(mayor);

    expect(balance.totalDebitos.amount).toBe(mayor.totalDebe.amount);
    expect(balance.totalCreditos.amount).toBe(mayor.totalHaber.amount);
    expect(balance.totalSaldosDeudores.amount).toBe(porNaturaleza.deudores.amount);
    expect(balance.totalSaldosAcreedores.amount).toBe(porNaturaleza.acreedores.amount);
  });

  it('arrastra los saldos de cierre al período siguiente sin perder las cuentas en cero', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const arrastre = saldosDeCierre(mayor);

    const abril = construirLibroMayor([], { ...OPCIONES_MAYOR, saldosIniciales: arrastre });

    // Sin movimientos, abril tiene las mismas cuentas y los mismos saldos.
    expect(abril.cuentas).toHaveLength(mayor.cuentas.length);
    expect(balanceDesdeMayor(abril).cuadra).toBe(true);
    for (const cuenta of abril.cuentas) {
      const previa = mayor.cuentas.find((c) => c.accountId === cuenta.accountId);
      expect(cuenta.saldoInicial.amount).toBe(previa?.saldoFinal.amount);
      expect(cuenta.saldoFinal.amount).toBe(previa?.saldoFinal.amount);
    }
  });
});

describe('cada movimiento navega hasta el documento original', () => {
  it('todo movimiento de una compra llega a su documento y a su línea de asiento', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const movimientos = mayor.cuentas.flatMap((cuenta) => cuenta.movimientos);

    expect(movimientos).toHaveLength(9);
    for (const movimiento of movimientos) {
      expect(movimiento.documentId).toMatch(/^doc-je-\d$/);
      expect(movimiento.entryLineId).toMatch(/^je-\d-\d$/);
      expect(movimiento.entryId).toMatch(/^je-\d$/);
      expect(movimiento.entryNumber).toBeGreaterThan(0);
    }
  });

  it('un asiento de cierre no tiene documento, y eso se ve en el movimiento', () => {
    const cierre = asiento({
      id: 'je-cierre',
      entryNumber: 1,
      entryDate: fecha('2026-03-31'),
      journalCode: 'CIERRE',
      kind: 'CIERRE',
      sourceType: 'CLOSING',
      sourceId: null,
      documentId: null,
      manualJustification: 'Refundición de cuentas de resultado del ejercicio 2026',
      lines: [
        linea({ id: 'je-cierre-1', lineNo: 1, accountId: 'acc-ventas', debit: pesos(1_000n) }),
        linea({ id: 'je-cierre-2', lineNo: 2, accountId: 'acc-gasto', credit: pesos(1_000n) }),
      ],
    });

    const mayor = construirLibroMayor([cierre], OPCIONES_MAYOR);
    const movimiento = mayor.cuentas
      .flatMap((cuenta) => cuenta.movimientos)
      .find((m) => m.entryLineId === 'je-cierre-1');

    expect(movimiento?.documentId).toBeNull();
    expect(movimiento?.sourceType).toBe('CLOSING');
    // Y el Diario no lo marca como falta de respaldo: tiene justificación firmada.
    const diario = construirLibroDiario([cierre], OPCIONES_DIARIO);
    expect(control(diario, 'RESPALDO_DOCUMENTAL').cumple).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Qué entra al libro y qué no
// ---------------------------------------------------------------------------

describe('qué entra al Diario', () => {
  it('un borrador y una propuesta quedan afuera, con su motivo', () => {
    const borrador = asiento({
      id: 'je-borrador',
      entryNumber: 9,
      entryDate: fecha('2026-03-05'),
      status: 'BORRADOR',
      approvedBy: null,
      lines: [
        linea({ id: 'b-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'b-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });
    const propuesta = asiento({ ...borrador, id: 'je-propuesta', status: 'PROPUESTO' });

    const diario = construirLibroDiario([...MARZO, borrador, propuesta], OPCIONES_DIARIO);

    expect(diario.asientos).toBe(3);
    expect(diario.excluidos).toHaveLength(2);
    expect(diario.excluidos.every((e) => /todavía no es una registración/.test(e.motivo))).toBe(true);
  });

  it('asientosDelDiario devuelve exactamente lo que quedó adentro', () => {
    // El Mayor se arma sobre esta lista. Mientras había que aplanar los folios a
    // mano, `routes/books.ts` le pasaba la lista cruda de la base y el Mayor
    // terminaba con BORRADOR y PROPUESTO que el Diario había excluido.
    const propuesta = asiento({
      id: 'je-propuesta',
      entryNumber: 9,
      entryDate: fecha('2026-03-05'),
      status: 'PROPUESTO',
      approvedBy: null,
      lines: [
        linea({ id: 'p-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'p-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });

    const diario = construirLibroDiario([...MARZO, propuesta], OPCIONES_DIARIO);
    const dentro = asientosDelDiario(diario);

    expect(dentro).toHaveLength(diario.asientos);
    expect(dentro.map((a) => a.id)).not.toContain('je-propuesta');

    // Y el Mayor armado sobre ella no ve la propuesta tampoco.
    const mayor = construirLibroMayor(dentro, OPCIONES_MAYOR);
    const movimientos = mayor.cuentas.flatMap((c) => c.movimientos);
    expect(movimientos.map((m) => m.entryId)).not.toContain('je-propuesta');
  });

  it('un asiento anulado sí entra: el art. 324 inc. c pide que quede a la vista', () => {
    const original = compra(1, '2026-03-02', 100_000n, 21_000n);
    const anulado: AsientoDelLibro = { ...original, status: 'ANULADO' };
    const contraasiento = asiento({
      id: 'je-rev',
      entryNumber: 2,
      entryDate: fecha('2026-03-09'),
      kind: 'REVERSION',
      reversesEntryId: original.id,
      sourceType: 'MANUAL',
      sourceId: null,
      documentId: null,
      manualJustification: 'Error en la cuenta de gasto advertido el 09/03',
      lines: [
        linea({ id: 'rev-1', lineNo: 1, accountId: 'acc-gasto', credit: pesos(100_000n) }),
        linea({ id: 'rev-2', lineNo: 2, accountId: 'acc-iva', credit: pesos(21_000n) }),
        linea({
          id: 'rev-3',
          lineNo: 3,
          accountId: 'acc-prov',
          debit: pesos(121_000n),
          partyId: 'party-1',
        }),
      ],
    });

    const diario = construirLibroDiario([anulado, contraasiento], OPCIONES_DIARIO);
    const mayor = construirLibroMayor([anulado, contraasiento], OPCIONES_MAYOR);

    expect(diario.asientos).toBe(2);
    expect(control(diario, 'CORRECCIONES_SALVADAS').cumple).toBe(true);
    // Los dos se compensan: el Mayor queda en cero, pero con cuatro movimientos.
    for (const cuenta of mayor.cuentas) {
      expect(cuenta.saldoFinal.amount).toBe(0n);
    }
    expect(mayor.cuentas.flatMap((c) => c.movimientos)).toHaveLength(6);
  });

  it('deja afuera lo de otro ejercicio y lo de fuera del rango, diciéndolo', () => {
    const otroAnio = asiento({ ...compra(7, '2026-03-04', 1n, 0n), fiscalYearId: 'fy-2025' });
    const fueraDeRango = compra(8, '2026-04-02', 1n, 0n);

    const diario = construirLibroDiario([...MARZO, otroAnio, fueraDeRango], OPCIONES_DIARIO);

    expect(diario.asientos).toBe(3);
    expect(diario.excluidos.map((e) => e.motivo).sort()).toEqual([
      'Fuera del rango pedido',
      'Pertenece a otro ejercicio',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Controles de forma — CCyC arts. 321, 324 y 325
// ---------------------------------------------------------------------------

describe('controles de forma del CCyC', () => {
  it('un hueco en la numeración se señala con el número que falta', () => {
    const conHueco = [compra(1, '2026-03-02', 10n, 0n), compra(3, '2026-03-04', 10n, 0n)];
    const diario = construirLibroDiario(conHueco, OPCIONES_DIARIO);
    const numeracion = control(diario, 'NUMERACION_CORRELATIVA');

    expect(numeracion.cumple).toBe(false);
    expect(numeracion.incumplen).toEqual(['COMPRAS#2']);
    expect(numeracion.fundamento).toMatch(/art\. 324 inc\. b/);
    // El libro se emite igual: un Diario con un hueco existe y hay que verlo.
    expect(diario.asientos).toBe(2);
    expect(diario.cumpleFormalidades).toBe(false);
  });

  it('la numeración de dos libros auxiliares distintos no se mezcla', () => {
    const compras = compra(1, '2026-03-02', 10n, 0n);
    const ventas = asiento({
      ...compra(1, '2026-03-03', 20n, 0n),
      id: 'je-v1',
      journalCode: 'VENTAS',
    });

    const diario = construirLibroDiario([compras, ventas], OPCIONES_DIARIO);

    expect(control(diario, 'NUMERACION_CORRELATIVA').cumple).toBe(true);
    expect(control(diario, 'SIN_DUPLICADOS').cumple).toBe(true);
  });

  it('un número posterior con fecha anterior rompe el orden del art. 324 inc. a', () => {
    const desordenado = [
      compra(1, '2026-03-10', 10n, 0n),
      compra(2, '2026-03-02', 10n, 0n),
    ];
    const diario = construirLibroDiario(desordenado, OPCIONES_DIARIO);
    const orden = control(diario, 'ORDEN_CRONOLOGICO');

    expect(orden.cumple).toBe(false);
    expect(orden.incumplen).toEqual(['je-2']);
  });

  it('un contraasiento con fecha anterior al asiento que corrige es antedatado', () => {
    const original = { ...compra(1, '2026-03-20', 100n, 0n), status: 'ANULADO' as const };
    const contraasiento = asiento({
      id: 'je-rev',
      entryNumber: 2,
      entryDate: fecha('2026-03-05'),
      kind: 'REVERSION',
      reversesEntryId: 'je-1',
      manualJustification: 'reversión',
      lines: [
        linea({ id: 'r-1', lineNo: 1, accountId: 'acc-prov', debit: pesos(100n), partyId: 'p' }),
        linea({ id: 'r-2', lineNo: 2, accountId: 'acc-gasto', credit: pesos(100n) }),
      ],
    });

    const control324c = control(
      construirLibroDiario([original, contraasiento], OPCIONES_DIARIO),
      'CORRECCIONES_SALVADAS',
    );

    expect(control324c.cumple).toBe(false);
    expect(control324c.incumplen).toEqual(['je-rev']);
    expect(control324c.detalle).toMatch(/fecha anterior/);
  });

  it('un anulado sin contraasiento a la vista se señala', () => {
    const huerfano = { ...compra(1, '2026-03-20', 100n, 0n), status: 'ANULADO' as const };
    const resultado = control(
      construirLibroDiario([huerfano], OPCIONES_DIARIO),
      'CORRECCIONES_SALVADAS',
    );

    expect(resultado.cumple).toBe(false);
    expect(resultado.incumplen).toEqual(['je-1']);
  });

  it('una conversión sin cotización con fuente no cumple el art. 325', () => {
    const enDolares = asiento({
      id: 'je-usd',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      lines: [
        linea({
          id: 'usd-1',
          lineNo: 1,
          accountId: 'acc-gasto',
          debit: pesos(1_000_000n),
          monedaOriginal: 'USD',
          importeOriginal: money(100_000n, 'USD'),
          fxRate: '1000.00',
          fxSource: null,
          fxDate: fecha('2026-03-06'),
        }),
        linea({
          id: 'usd-2',
          lineNo: 2,
          accountId: 'acc-prov',
          credit: pesos(1_000_000n),
          partyId: 'p',
        }),
      ],
    });

    const moneda = control(construirLibroDiario([enDolares], OPCIONES_DIARIO), 'MONEDA_DE_REGISTRO');

    expect(moneda.cumple).toBe(false);
    expect(moneda.incumplen).toEqual(['je-usd:1']);
    expect(moneda.fundamento).toMatch(/moneda nacional/);
  });

  it('la conversión con cotización, fuente y fecha sí cumple', () => {
    const enDolares = asiento({
      id: 'je-usd',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      lines: [
        linea({
          id: 'usd-1',
          lineNo: 1,
          accountId: 'acc-gasto',
          debit: pesos(1_000_000n),
          monedaOriginal: 'USD',
          importeOriginal: money(100_000n, 'USD'),
          fxRate: '1000.00',
          fxSource: 'BCRA Com. A 3500 — 06/03/2026',
          fxDate: fecha('2026-03-06'),
        }),
        linea({
          id: 'usd-2',
          lineNo: 2,
          accountId: 'acc-prov',
          credit: pesos(1_000_000n),
          partyId: 'p',
        }),
      ],
    });

    expect(
      control(construirLibroDiario([enDolares], OPCIONES_DIARIO), 'MONEDA_DE_REGISTRO').cumple,
    ).toBe(true);
  });

  it('un asiento sin comprobante ni justificación no tiene respaldo (art. 321)', () => {
    const sinRespaldo = asiento({
      id: 'je-huerfano',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      sourceType: 'MANUAL',
      sourceId: null,
      documentId: null,
      manualJustification: '   ',
      lines: [
        linea({ id: 'h-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'h-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });

    const respaldo = control(
      construirLibroDiario([sinRespaldo], OPCIONES_DIARIO),
      'RESPALDO_DOCUMENTAL',
    );

    expect(respaldo.cumple).toBe(false);
    expect(respaldo.incumplen).toEqual(['je-huerfano']);
  });

  it('una decisión contable respalda un asiento sin comprobante ni justificación', () => {
    // Es la tercera vía de `E_NO_TRACEABILITY`. Si el motor deja pasar el
    // asiento y el libro lo denuncia como sin respaldo, uno de los dos miente.
    const conDecision = asiento({
      id: 'je-por-decision',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      kind: 'AJUSTE',
      sourceType: 'CLOSING',
      sourceId: null,
      documentId: null,
      manualJustification: null,
      decisionId: 'dec-1',
      lines: [
        linea({ id: 'd-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'd-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });

    const respaldo = control(
      construirLibroDiario([conDecision], OPCIONES_DIARIO),
      'RESPALDO_DOCUMENTAL',
    );

    expect(respaldo.incumplen).toEqual([]);
    expect(respaldo.cumple).toBe(true);
  });

  it('un id de decisión vacío no respalda nada', () => {
    // El control falla cerrado: exige un id de verdad, no «distinto de null».
    const conDecisionVacia = asiento({
      id: 'je-decision-vacia',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      sourceType: 'MANUAL',
      sourceId: null,
      documentId: null,
      manualJustification: null,
      decisionId: '   ',
      lines: [
        linea({ id: 'v-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'v-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });

    const respaldo = control(
      construirLibroDiario([conDecisionVacia], OPCIONES_DIARIO),
      'RESPALDO_DOCUMENTAL',
    );

    expect(respaldo.cumple).toBe(false);
    expect(respaldo.incumplen).toEqual(['je-decision-vacia']);
  });

  it('un asiento descuadrado se detecta aunque la base debería haberlo impedido', () => {
    const roto = asiento({
      id: 'je-roto',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      lines: [
        linea({ id: 'x-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(100n) }),
        linea({ id: 'x-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(99n), partyId: 'p' }),
      ],
    });

    const partida = control(construirLibroDiario([roto], OPCIONES_DIARIO), 'PARTIDA_DOBLE');

    expect(partida.cumple).toBe(false);
    expect(partida.detalle).toMatch(/no debería poder pasar/i);
  });

  it('un libro vacío no inventa incumplimientos', () => {
    const diario = construirLibroDiario([], OPCIONES_DIARIO);

    expect(diario.asientos).toBe(0);
    expect(diario.folios).toEqual([]);
    expect(diario.totalDebe.amount).toBe(0n);
    expect(diario.cumpleFormalidades).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Foliatura y transporte
// ---------------------------------------------------------------------------

describe('foliatura y transporte', () => {
  it('el transporte de cada folio es el acumulado del anterior', () => {
    const diario = construirLibroDiario(MARZO, { ...OPCIONES_DIARIO, asientosPorFolio: 2 });

    expect(diario.folios).toHaveLength(2);
    const primero = diario.folios[0];
    const segundo = diario.folios[1];

    expect(primero?.numero).toBe(1);
    expect(primero?.transporteDebe.amount).toBe(0n);
    expect(segundo?.transporteDebe.amount).toBe(primero?.acumuladoDebe.amount);
    expect(segundo?.transporteHaber.amount).toBe(primero?.acumuladoHaber.amount);
    expect(diario.totalDebe.amount).toBe(segundo?.acumuladoDebe.amount);
    expect(diario.totalDebe.amount).toBe(diario.totalHaber.amount);
  });

  it('el total no depende del tamaño del folio', () => {
    const chico = construirLibroDiario(MARZO, { ...OPCIONES_DIARIO, asientosPorFolio: 1 });
    const grande = construirLibroDiario(MARZO, { ...OPCIONES_DIARIO, asientosPorFolio: 100 });

    expect(chico.folios).toHaveLength(3);
    expect(grande.folios).toHaveLength(1);
    expect(chico.totalDebe.amount).toBe(grande.totalDebe.amount);
  });

  it('un folio de cero asientos no es un folio', () => {
    expect(() => construirLibroDiario(MARZO, { ...OPCIONES_DIARIO, asientosPorFolio: 0 })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Diario resumido — CCyC art. 327
// ---------------------------------------------------------------------------

describe('Diario resumido (art. 327)', () => {
  const subdiarioCompras: SubdiarioDeclarado = {
    journalCode: 'COMPRAS',
    nombre: 'Subdiario de Compras',
    desde: fecha('2026-03-01'),
    hasta: fecha('2026-03-31'),
    referencia: 'IVA-COMPRAS-2026-03 sha256:abc',
  };

  it('sin subdiario declarado no hay resumen', () => {
    const resultado = resumirPorMes(MARZO, [], 'ARS');

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error).toHaveLength(1);
    expect(resultado.error[0]?.motivo).toBe('SUBDIARIO_NO_DECLARADO');
    expect(resultado.error[0]?.fundamento).toMatch(/art\. 327/);
  });

  it('con subdiario declarado condensa el mes y conserva el hilo al detalle', () => {
    const resultado = resumirPorMes(MARZO, [subdiarioCompras], 'ARS');

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value).toHaveLength(1);

    const resumen = resultado.value[0];
    expect(resumen).toBeDefined();
    if (resumen === undefined) return;

    expect(resumen.mes).toBe(3);
    expect(resumen.fecha).toBe('2026-03-21');
    expect(resumen.lineas).toHaveLength(3);
    expect(resumen.totalDebe.amount).toBe(resumen.totalHaber.amount);
    expect(resumen.asientosResumidos).toEqual(['je-1', 'je-2', 'je-3']);
    expect(resumen.descripcion).toContain('Subdiario de Compras');
    expect(resumenCoincideConDetalle(resumen, MARZO)).toBe(true);

    // El resumen suma exactamente lo mismo que el Diario detallado.
    const detallado = construirLibroDiario(MARZO, OPCIONES_DIARIO);
    expect(resumen.totalDebe.amount).toBe(detallado.totalDebe.amount);
  });

  it('un subdiario que no cubre todo el mes no respalda el resumen', () => {
    const corto: SubdiarioDeclarado = { ...subdiarioCompras, hasta: fecha('2026-03-15') };
    const resultado = resumirPorMes(MARZO, [corto], 'ARS');

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error[0]?.motivo).toBe('SUBDIARIO_NO_CUBRE_EL_PERIODO');
    expect(resultado.error[0]?.detalle).toMatch(/tramo descubierto/i);
  });

  it('dos meses dan dos resúmenes: el período no puede pasar del mes', () => {
    const abril = compra(4, '2026-04-03', 10n, 2n);
    const largo: SubdiarioDeclarado = { ...subdiarioCompras, hasta: fecha('2026-04-30') };
    const resultado = resumirPorMes([...MARZO, abril], [largo], 'ARS');

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value).toHaveLength(2);
    expect(resultado.value.map((r) => r.mes)).toEqual([3, 4]);
  });

  it('acumula todos los rechazos, no solo el primero', () => {
    const ventas = asiento({
      ...compra(1, '2026-03-03', 20n, 0n),
      id: 'je-v1',
      journalCode: 'VENTAS',
    });
    const resultado = resumirPorMes([...MARZO, ventas], [], 'ARS');

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.map((r) => r.journalCode).sort()).toEqual(['COMPRAS', 'VENTAS']);
  });
});

// ---------------------------------------------------------------------------
// Exportación
// ---------------------------------------------------------------------------

describe('exportación canónica', () => {
  it('el mismo libro exportado dos veces da el mismo hash', () => {
    const uno = exportarDiarioCsv(construirLibroDiario(MARZO, OPCIONES_DIARIO));
    const dos = exportarDiarioCsv(construirLibroDiario([...MARZO].reverse(), OPCIONES_DIARIO));

    // El orden de entrada no importa: el libro se ordena solo.
    expect(uno).toBe(dos);
    expect(hashDeLibro(uno)).toBe(hashDeLibro(dos));
    expect(hashDeLibro(uno)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cambiar un centavo cambia el hash', () => {
    const original = exportarDiarioCsv(construirLibroDiario(MARZO, OPCIONES_DIARIO));
    const tocado = exportarDiarioCsv(
      construirLibroDiario(
        [compra(1, '2026-03-02', 100_001n, 21_000n), ...MARZO.slice(1)],
        OPCIONES_DIARIO,
      ),
    );

    expect(hashDeLibro(original)).not.toBe(hashDeLibro(tocado));
  });

  it('escribe los importes con punto y sin separador de miles', () => {
    const csv = exportarDiarioCsv(construirLibroDiario(MARZO, OPCIONES_DIARIO));
    const filas = csv.split('\n');

    // El BOM se compara por punto de código: escrito como carácter sería
    // invisible en el archivo de test, y un test que nadie puede leer no prueba.
    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(filas[0]?.slice(1).startsWith('folio;libro;numero')).toBe(true);
    expect(filas[1]).toContain(';1000.00;');
    expect(csv).not.toContain('1.000,00');
    expect(csv.endsWith('\n')).toBe(true);
    expect(csv).not.toContain('\r');
  });

  it('escapa el punto y coma y las comillas de las descripciones', () => {
    const conflictivo = asiento({
      id: 'je-x',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      description: 'Factura A 0001-00045231; "Proveedor S.A."',
      lines: [
        linea({ id: 'x-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'x-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });

    const csv = exportarDiarioCsv(construirLibroDiario([conflictivo], OPCIONES_DIARIO));

    expect(csv).toContain('"Factura A 0001-00045231; ""Proveedor S.A."""');
    // Y la fila sigue teniendo la misma cantidad de columnas que la cabecera.
    const cabecera = csv.split('\n')[0]?.split(';').length;
    expect(contarColumnas(csv.split('\n')[1] ?? '')).toBe(cabecera);
  });

  it('el Mayor exportado lleva el saldo acumulado y el hilo al documento', () => {
    const csv = exportarMayorCsv(construirLibroMayor(MARZO, OPCIONES_MAYOR));

    expect(csv).toContain('cuenta_codigo;cuenta_nombre;naturaleza');
    expect(csv).toContain('doc-je-1');
    expect(csv).toContain('linea_id');
  });

  it('los dos libros escriben la decisión que funda el asiento', () => {
    // El libro emitido es el que tiene eficacia probatoria. Un asiento fundado
    // en una decisión y sin comprobante aparecería ahí sin ningún origen: es el
    // único artefacto donde la tercera vía no podía leerse.
    const conDecision = asiento({
      id: 'je-dec',
      entryNumber: 1,
      entryDate: fecha('2026-03-06'),
      sourceType: 'CLOSING',
      sourceId: null,
      documentId: null,
      decisionId: 'dec-7f3',
      lines: [
        linea({ id: 'c-1', lineNo: 1, accountId: 'acc-gasto', debit: pesos(10n) }),
        linea({ id: 'c-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(10n), partyId: 'p' }),
      ],
    });

    const diario = construirLibroDiario([conDecision], OPCIONES_DIARIO);
    const csvDiario = exportarDiarioCsv(diario);
    expect(csvDiario).toContain('decision_id');
    expect(csvDiario).toContain('dec-7f3');

    const mayor = construirLibroMayor(asientosDelDiario(diario), OPCIONES_MAYOR);
    expect(mayor.cuentas.flatMap((c) => c.movimientos).every((m) => m.decisionId === 'dec-7f3')).toBe(
      true,
    );
    expect(exportarMayorCsv(mayor)).toContain('dec-7f3');
  });

  it('el pie dice qué controles fallaron, y no afirma tener la autorización del art. 329', () => {
    const conHueco = construirLibroDiario(
      [compra(1, '2026-03-02', 10n, 0n), compra(3, '2026-03-04', 10n, 0n)],
      OPCIONES_DIARIO,
    );
    const csv = exportarDiarioCsv(conHueco);
    const pie = pieDeLibro(conHueco, csv, null);

    expect(pie).toContain('NUMERACION_CORRELATIVA');
    expect(pie).toContain('El libro se emite igual');
    expect(pie).toMatch(/no cargada en el sistema/);
    expect(pie).toMatch(/no puede afirmar si existe/);
    expect(pie).toContain(hashDeLibro(csv));
  });

  it('con la autorización cargada, el pie la transcribe', () => {
    const diario = construirLibroDiario(MARZO, OPCIONES_DIARIO);
    const pie = pieDeLibro(diario, exportarDiarioCsv(diario), 'IGJ Res. 1234/2025');

    expect(pie).toContain('IGJ Res. 1234/2025');
    expect(pie).toContain('sin observaciones');
  });
});

describe('los campos vacíos salen vacíos, no como "null"', () => {
  const manual = asiento({
    id: 'je-manual',
    entryNumber: 1,
    entryDate: fecha('2026-03-08'),
    journalCode: 'GENERAL',
    sourceType: 'MANUAL',
    sourceId: null,
    documentId: null,
    manualJustification: 'Ajuste por diferencia de arqueo del 08/03',
    approvedBy: 'u-contador',
    lines: [
      linea({ id: 'm-1', lineNo: 1, accountId: 'acc-caja', debit: pesos(500n) }),
      linea({ id: 'm-2', lineNo: 2, accountId: 'acc-ventas', credit: pesos(500n) }),
    ],
  });

  it('el CSV del Diario no escribe la palabra null en ninguna columna', () => {
    const csv = exportarDiarioCsv(construirLibroDiario([manual], OPCIONES_DIARIO));

    // El bug clásico del CSV: `String(null)` da "null" y queda escrito en el
    // libro. Una celda vacía dice "no hay dato"; la palabra null dice otra cosa.
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
    // Y las columnas siguen siendo las mismas: los vacíos ocupan su lugar.
    const filas = csv.split('\n');
    expect(contarColumnas(filas[1] ?? '')).toBe(contarColumnas(filas[0] ?? ''));
  });

  it('el CSV del Mayor tampoco, con el documento ausente', () => {
    const csv = exportarMayorCsv(construirLibroMayor([manual], OPCIONES_MAYOR));

    expect(csv).not.toContain('null');
    expect(csv).toContain(';MANUAL;');
  });

  it('una línea con moneda original escribe el importe original y su cotización', () => {
    const enDolares = asiento({
      id: 'je-usd',
      entryNumber: 2,
      entryDate: fecha('2026-03-09'),
      lines: [
        linea({
          id: 'u-1',
          lineNo: 1,
          accountId: 'acc-gasto',
          debit: pesos(1_000_000n),
          monedaOriginal: 'USD',
          importeOriginal: money(100_000n, 'USD'),
          fxRate: '1000.00',
          fxSource: 'BCRA A3500',
          fxDate: fecha('2026-03-09'),
          costCenterCode: 'ADM',
          partyId: 'party-9',
          description: 'Licencia anual',
        }),
        linea({ id: 'u-2', lineNo: 2, accountId: 'acc-prov', credit: pesos(1_000_000n) }),
      ],
    });

    const csv = exportarDiarioCsv(construirLibroDiario([enDolares], OPCIONES_DIARIO));

    expect(csv).toContain(';USD;1000.00;1000.00;BCRA A3500;2026-03-09;ADM;party-9;Licencia anual;');
  });
});

describe('el Mayor con el catálogo incompleto o sin movimientos', () => {
  it('incluye las cuentas del plan que no se movieron, si se lo piden', () => {
    const conTodas = construirLibroMayor(MARZO, {
      ...OPCIONES_MAYOR,
      incluirCuentasSinMovimientos: true,
    });
    const soloMovidas = construirLibroMayor(MARZO, OPCIONES_MAYOR);

    expect(conTodas.cuentas).toHaveLength(CATALOGO.length);
    expect(soloMovidas.cuentas).toHaveLength(3);
    // Sumar cuentas en cero no cambia ningún total.
    expect(conTodas.totalDebe.amount).toBe(soloMovidas.totalDebe.amount);
    expect(balanceDesdeMayor(conTodas).cuadra).toBe(true);
  });

  it('sin ficha en el catálogo toma el código de la línea y no adivina la naturaleza', () => {
    const desconocida = asiento({
      id: 'je-x',
      entryNumber: 1,
      entryDate: fecha('2026-03-11'),
      lines: [
        {
          ...linea({ id: 'x-1', lineNo: 1, accountId: 'acc-fantasma', credit: pesos(400n) }),
          accountCode: '9.9.99',
          accountName: 'Cuenta que no está en el catálogo',
        },
        linea({ id: 'x-2', lineNo: 2, accountId: 'acc-caja', debit: pesos(400n) }),
      ],
    });

    const mayor = construirLibroMayor([desconocida], OPCIONES_MAYOR);
    const cuenta = mayor.cuentas.find((c) => c.accountId === 'acc-fantasma');

    expect(cuenta?.accountCode).toBe('9.9.99');
    expect(cuenta?.accountName).toBe('Cuenta que no está en el catálogo');
    // Quedó con saldo acreedor y aun así se declara DEUDORA: la naturaleza es
    // un dato de la ficha, no una deducción del signo. La ficha faltante es el
    // problema, y deducirla lo taparía.
    expect(cuenta?.saldoFinal.amount).toBe(-400n);
    expect(cuenta?.nature).toBe('DEUDORA');
  });

  it('un Mayor vacío no rompe el balance ni los totales por naturaleza', () => {
    const vacio = construirLibroMayor([], OPCIONES_MAYOR);

    expect(vacio.cuentas).toEqual([]);
    expect(vacio.totalDebe.amount).toBe(0n);
    expect(saldosDeCierre(vacio)).toEqual([]);
    expect(saldosPorNaturaleza(vacio).deudores.amount).toBe(0n);
    expect(balanceDesdeMayor(vacio).cuadra).toBe(true);
  });

  it('una diferencia de moneda entre el Diario y el Mayor es un importe distinto', () => {
    const mayor = construirLibroMayor(MARZO, OPCIONES_MAYOR);
    const primeraLinea = MARZO[0]?.lines[0];
    expect(primeraLinea).toBeDefined();
    if (primeraLinea === undefined) return;

    const enOtraMoneda: MovimientoMaterializado[] = [
      {
        entryLineId: primeraLinea.id,
        accountId: primeraLinea.accountId,
        fecha: fecha('2026-03-02'),
        // Mismo número, otra moneda. Sin comparar la moneda, esto pasaría.
        debe: money(primeraLinea.debit.amount, 'USD'),
        haber: money(0n, 'USD'),
      },
    ];

    const verificacion = verificarProyeccion(mayor, enOtraMoneda);
    const tipos = verificacion.discrepancias.map((d) => d.tipo);

    expect(tipos).toContain('IMPORTE_DISTINTO');
  });
});

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function control(
  diario: ReturnType<typeof construirLibroDiario>,
  codigo: string,
): { cumple: boolean; incumplen: readonly string[]; detalle: string; fundamento: string } {
  const encontrado = diario.controles.find((c) => c.codigo === codigo);
  if (encontrado === undefined) throw new Error(`No existe el control ${codigo}`);
  return encontrado;
}

/** Cuenta columnas respetando el entrecomillado del CSV. */
function contarColumnas(fila: string): number {
  let columnas = 1;
  let dentroDeComillas = false;
  for (let i = 0; i < fila.length; i += 1) {
    const caracter = fila[i];
    if (caracter === '"') dentroDeComillas = !dentroDeComillas;
    else if (caracter === ';' && !dentroDeComillas) columnas += 1;
  }
  return columnas;
}
