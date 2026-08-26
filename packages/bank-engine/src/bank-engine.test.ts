/**
 * Tests de la conciliación bancaria.
 *
 * El criterio de la fase es doble: **≥ 80% de matching automático propuesto** y
 * **0 conciliaciones confirmadas sin intervención humana**. Lo primero se mide
 * acá; lo segundo lo impide la base y se prueba en la integración.
 *
 * Los primeros tres `describe` son las tres reglas duras del motor: el importe
 * exacto como precondición, el empate que no se resuelve, y el acta que cierra
 * o dice cuánto falta.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, type CalendarDate, type Money } from '@aai/shared';
import {
  conciliar,
  distanciaEnDias,
  huellaDeMovimiento,
  interpretarExtracto,
  interpretarFecha,
  interpretarImporte,
  normalizarReferencia,
  palabrasEnComun,
  proponerMatches,
  repetidosEnElLote,
  totalesDelLote,
  totalesPorTipo,
  verificarActa,
  verificarCadenaDeSaldos,
  type LineaConciliable,
  type MapeoDeExtracto,
  type MovimientoBancario,
  type SentidoBancario,
} from './index.js';

const fecha = (iso: string): CalendarDate => parseCalendarDate(iso);
const pesos = (centavos: bigint): Money => money(centavos, 'ARS');

function banco(
  overrides: Partial<MovimientoBancario> & { id: string; importe: Money },
): MovimientoBancario {
  return {
    fecha: fecha('2026-03-10'),
    fechaValor: null,
    descripcion: 'Movimiento',
    sentido: 'SALIDA',
    referencia: null,
    saldoPosterior: null,
    crudo: '',
    ...overrides,
  };
}

function libro(
  overrides: Partial<LineaConciliable> & { entryLineId: string; importe: Money },
): LineaConciliable {
  return {
    entryId: `je-${overrides.entryLineId}`,
    fecha: fecha('2026-03-10'),
    descripcion: 'Asiento',
    sentido: 'SALIDA',
    referencia: null,
    documentId: null,
    yaConciliada: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Regla 1: el importe exacto es precondición
// ---------------------------------------------------------------------------

describe('el importe exacto es precondición, no un componente del puntaje', () => {
  it('no propone nada cuando el importe difiere en un centavo', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: pesos(123_456_700n), referencia: '4521' })],
      [
        libro({
          entryLineId: 'l1',
          importe: pesos(123_456_750n),
          referencia: '4521',
          fecha: fecha('2026-03-10'),
        }),
      ],
    );

    // Fecha idéntica y referencia idéntica: cualquier motor que pese el importe
    // en vez de exigirlo lo daría por bueno, y dejaría 50 centavos flotando en
    // la cuenta del proveedor para siempre.
    expect(resultado.propuestas).toEqual([]);
    expect(resultado.movimientosSinCandidato).toEqual(['b1']);
    expect(resultado.lineasSinCandidato).toEqual(['l1']);
  });

  it('no concilia una salida contra una entrada del mismo monto', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: pesos(100_000n), sentido: 'SALIDA' })],
      [libro({ entryLineId: 'l1', importe: pesos(100_000n), sentido: 'ENTRADA' })],
    );

    expect(resultado.propuestas).toEqual([]);
  });

  it('no concilia entre monedas distintas aunque el número coincida', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: money(100_000n, 'USD') })],
      [libro({ entryLineId: 'l1', importe: pesos(100_000n) })],
    );

    expect(resultado.propuestas).toEqual([]);
  });

  it('con importe, fecha, referencia y descripción coincidentes da 100', () => {
    const resultado = proponerMatches(
      [
        banco({
          id: 'b1',
          importe: pesos(100_000n),
          referencia: '0000004521',
          descripcion: 'TRANSFERENCIA PROVEEDOR METALURGICA',
        }),
      ],
      [
        libro({
          entryLineId: 'l1',
          importe: pesos(100_000n),
          referencia: '4521',
          descripcion: 'Pago Metalurgica S.A.',
        }),
      ],
    );

    const propuesta = resultado.propuestas[0];
    expect(propuesta?.score).toBe(100);
    expect(propuesta?.tipo).toBe('EXACTO');
    expect(propuesta?.senales.map((s) => s.codigo)).toEqual([
      'IMPORTE_EXACTO',
      'MISMA_FECHA',
      'REFERENCIA_COINCIDE',
      'DESCRIPCION_COINCIDE',
    ]);
  });

  it('el puntaje baja con la distancia de fechas, y a fuera de ventana no aporta', () => {
    const cerca = proponerMatches(
      [banco({ id: 'b1', importe: pesos(100_000n), fecha: fecha('2026-03-12') })],
      [libro({ entryLineId: 'l1', importe: pesos(100_000n), fecha: fecha('2026-03-10') })],
    );
    const lejos = proponerMatches(
      [banco({ id: 'b1', importe: pesos(100_000n), fecha: fecha('2026-04-30') })],
      [libro({ entryLineId: 'l1', importe: pesos(100_000n), fecha: fecha('2026-03-10') })],
    );

    expect(cerca.propuestas[0]?.tipo).toBe('APROXIMADO');
    expect(cerca.propuestas[0]?.score).toBeGreaterThan(lejos.propuestas[0]?.score ?? 0);
    // Fuera de ventana el match igual se propone: el importe coincide y eso es
    // un hecho. Lo que no hace es puntuar como si la fecha acompañara.
    expect(lejos.propuestas[0]?.senales.some((s) => s.codigo === 'FECHA_LEJANA')).toBe(true);
  });

  it('una línea ya conciliada no vuelve a entrar', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: pesos(100_000n) })],
      [libro({ entryLineId: 'l1', importe: pesos(100_000n), yaConciliada: true })],
    );

    expect(resultado.propuestas).toEqual([]);
    expect(resultado.lineasSinCandidato).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regla 2: el empate no se resuelve
// ---------------------------------------------------------------------------

describe('el empate no se resuelve', () => {
  it('dos líneas idénticas contra un movimiento son una ambigüedad, no un match', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: pesos(50_000n), descripcion: 'DEBITO VARIOS' })],
      [
        libro({ entryLineId: 'l1', importe: pesos(50_000n), descripcion: 'Pago A' }),
        libro({ entryLineId: 'l2', importe: pesos(50_000n), descripcion: 'Pago B' }),
      ],
    );

    expect(resultado.propuestas).toEqual([]);
    expect(resultado.ambiguos).toHaveLength(1);
    expect(resultado.ambiguos[0]?.candidatos).toHaveLength(2);
    expect(resultado.ambiguos[0]?.motivo).toMatch(/no desempata/);
  });

  it('una referencia que coincide rompe el empate legítimamente', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: pesos(50_000n), referencia: '9911' })],
      [
        libro({ entryLineId: 'l1', importe: pesos(50_000n), referencia: '9911' }),
        libro({ entryLineId: 'l2', importe: pesos(50_000n), referencia: '9912' }),
      ],
    );

    expect(resultado.ambiguos).toEqual([]);
    expect(resultado.propuestas[0]?.entryLineIds).toEqual(['l1']);
  });

  it('un movimiento ambiguo no cuenta como cubierto en la cobertura', () => {
    const acta = conciliar({
      bankAccountId: 'ba-1',
      desde: fecha('2026-03-01'),
      hasta: fecha('2026-03-31'),
      moneda: 'ARS',
      saldoSegunExtracto: pesos(0n),
      saldoSegunLibro: pesos(0n),
      movimientos: [
        banco({ id: 'b1', importe: pesos(50_000n) }),
        banco({ id: 'b2', importe: pesos(70_000n) }),
      ],
      lineas: [
        libro({ entryLineId: 'l1', importe: pesos(50_000n) }),
        libro({ entryLineId: 'l2', importe: pesos(50_000n) }),
        libro({ entryLineId: 'l3', importe: pesos(70_000n) }),
      ],
    });

    // b1 quedó ambiguo, b2 se propuso: 1 de 2 = 50%, no 100%.
    expect(acta.cobertura.propuestos).toBe(1);
    expect(acta.cobertura.ambiguos).toBe(1);
    expect(acta.cobertura.porcentaje).toBe(50);
  });

  it('la cobertura trunca hacia abajo, no redondea', () => {
    const movimientos = Array.from({ length: 9 }, (_, i) =>
      banco({ id: `b${String(i)}`, importe: pesos(BigInt(1000 + i)) }),
    );
    // Ocho de nueve se pueden conciliar: 88,8% → 88.
    const lineas = movimientos
      .slice(0, 8)
      .map((movimiento, i) => libro({ entryLineId: `l${String(i)}`, importe: movimiento.importe }));

    const acta = conciliar({
      bankAccountId: 'ba-1',
      desde: fecha('2026-03-01'),
      hasta: fecha('2026-03-31'),
      moneda: 'ARS',
      saldoSegunExtracto: pesos(0n),
      saldoSegunLibro: pesos(0n),
      movimientos,
      lineas,
    });

    expect(acta.cobertura.propuestos).toBe(8);
    expect(acta.cobertura.porcentaje).toBe(88);
  });
});

// ---------------------------------------------------------------------------
// Regla 3: el acta cierra, o dice cuánto falta
// ---------------------------------------------------------------------------

describe('el acta de conciliación', () => {
  /**
   * El caso de manual: un cheque emitido y no debitado.
   *
   * Extracto: 100.000. Libro: 70.000, porque el libro ya registró el cheque de
   * 30.000 que el banco todavía no debitó. 100.000 − 30.000 = 70.000.
   */
  const chequeNoDebitado = {
    bankAccountId: 'ba-1',
    desde: fecha('2026-03-01'),
    hasta: fecha('2026-03-31'),
    moneda: 'ARS' as const,
    saldoSegunExtracto: pesos(10_000_000n),
    saldoSegunLibro: pesos(7_000_000n),
    movimientos: [] as MovimientoBancario[],
    lineas: [
      libro({
        entryLineId: 'cheque',
        importe: pesos(3_000_000n),
        sentido: 'SALIDA' as SentidoBancario,
        descripcion: 'Cheque 4521 a Metalurgica',
      }),
    ],
  };

  it('cierra con un cheque emitido y no debitado', () => {
    const acta = conciliar(chequeNoDebitado);

    expect(acta.diferencias).toHaveLength(1);
    expect(acta.diferencias[0]?.tipo).toBe('EN_LIBRO_NO_EN_BANCO');
    expect(acta.diferencias[0]?.dondeMirar).toMatch(/cheque emitido y no presentado/);
    expect(acta.ajusteNeto.amount).toBe(-3_000_000n);
    expect(acta.saldoConciliado.amount).toBe(7_000_000n);
    expect(acta.cierra).toBe(true);
    expect(acta.explicacion).toMatch(/La conciliación CIERRA/);
  });

  it('cierra con un depósito en tránsito', () => {
    const acta = conciliar({
      ...chequeNoDebitado,
      saldoSegunExtracto: pesos(10_000_000n),
      saldoSegunLibro: pesos(12_500_000n),
      lineas: [
        libro({
          entryLineId: 'deposito',
          importe: pesos(2_500_000n),
          sentido: 'ENTRADA',
          descripcion: 'Depósito cheques al cobro',
        }),
      ],
    });

    expect(acta.ajusteNeto.amount).toBe(2_500_000n);
    expect(acta.cierra).toBe(true);
    expect(acta.diferencias[0]?.dondeMirar).toMatch(/depósito en tránsito/);
  });

  it('cierra con una comisión que el banco debitó y el libro no registró', () => {
    const acta = conciliar({
      ...chequeNoDebitado,
      saldoSegunExtracto: pesos(9_950_000n),
      saldoSegunLibro: pesos(10_000_000n),
      movimientos: [
        banco({
          id: 'comision',
          importe: pesos(50_000n),
          sentido: 'SALIDA',
          descripcion: 'COM. MANT. CTA',
        }),
      ],
      lineas: [],
    });

    expect(acta.ajusteNeto.amount).toBe(50_000n);
    expect(acta.cierra).toBe(true);
    // Y NO dice que sea una comisión, aunque el extracto lo insinúe.
    expect(acta.diferencias[0]?.dondeMirar).toMatch(/El concepto lo determina el contador/);
    expect(acta.diferencias[0]?.dondeMirar).toMatch(/no es una fuente/);
  });

  it('cuando no cierra dice cuánto falta y que no lo va a buscar', () => {
    const acta = conciliar({
      ...chequeNoDebitado,
      saldoSegunLibro: pesos(6_900_000n),
    });

    expect(acta.cierra).toBe(false);
    expect(acta.explicacion).toMatch(/NO CIERRA/);
    expect(acta.explicacion).toMatch(/Faltan -100000/);
    expect(acta.explicacion).toMatch(/no la busca ni la inventa/);
  });

  it('una conciliación sin partidas ni movimientos cierra si los saldos coinciden', () => {
    const acta = conciliar({
      ...chequeNoDebitado,
      saldoSegunExtracto: pesos(10_000_000n),
      saldoSegunLibro: pesos(10_000_000n),
      lineas: [],
    });

    expect(acta.diferencias).toEqual([]);
    expect(acta.cierra).toBe(true);
    expect(acta.cobertura.porcentaje).toBe(0);
  });

  it('los totales por tipo separan los dos lados', () => {
    const acta = conciliar({
      ...chequeNoDebitado,
      movimientos: [banco({ id: 'com', importe: pesos(50_000n), sentido: 'SALIDA' })],
    });

    const totales = totalesPorTipo(acta, 'ARS');
    expect(totales.enLibroNoEnBanco.amount).toBe(3_000_000n);
    expect(totales.enBancoNoEnLibro.amount).toBe(50_000n);
  });

  it('un acta guardada que dejó de coincidir se detecta', () => {
    const acta = conciliar(chequeNoDebitado);

    expect(verificarActa(acta, pesos(7_000_000n)).coincide).toBe(true);
    const desincronizada = verificarActa(acta, pesos(6_000_000n));
    expect(desincronizada.coincide).toBe(false);
    expect(desincronizada.detalle).toMatch(/Algo cambió después de confirmarla/);
  });
});

// ---------------------------------------------------------------------------
// Agrupaciones
// ---------------------------------------------------------------------------

describe('agrupaciones', () => {
  it('junta tres depósitos del banco contra una sola cobranza del libro', () => {
    const resultado = proponerMatches(
      [
        banco({ id: 'b1', importe: pesos(10_000n), sentido: 'SALIDA' }),
        banco({ id: 'b2', importe: pesos(20_000n), sentido: 'SALIDA' }),
        banco({ id: 'b3', importe: pesos(30_000n), sentido: 'SALIDA' }),
      ],
      [libro({ entryLineId: 'l1', importe: pesos(60_000n), sentido: 'SALIDA' })],
    );

    const agrupado = resultado.propuestas.find((p) => p.tipo === 'AGRUPADO');
    expect(agrupado?.movimientoIds.sort()).toEqual(['b1', 'b2', 'b3']);
    expect(agrupado?.entryLineIds).toEqual(['l1']);
    // Una agrupación nunca puntúa como un match uno a uno.
    expect(agrupado?.score).toBeLessThan(100);
    expect(agrupado?.senales[0]?.detalle).toMatch(/pueden ser coincidencia/);
  });

  it('junta dos facturas del libro contra una transferencia del banco', () => {
    const resultado = proponerMatches(
      [banco({ id: 'b1', importe: pesos(75_000n), sentido: 'ENTRADA' })],
      [
        libro({ entryLineId: 'l1', importe: pesos(25_000n), sentido: 'ENTRADA' }),
        libro({ entryLineId: 'l2', importe: pesos(50_000n), sentido: 'ENTRADA' }),
      ],
    );

    const agrupado = resultado.propuestas.find((p) => p.tipo === 'AGRUPADO');
    expect(agrupado?.movimientoIds).toEqual(['b1']);
    expect(agrupado?.entryLineIds.sort()).toEqual(['l1', 'l2']);
  });

  it('el match uno a uno gana antes de que las agrupaciones se lleven la línea', () => {
    const resultado = proponerMatches(
      [
        banco({ id: 'exacto', importe: pesos(60_000n) }),
        banco({ id: 'p1', importe: pesos(10_000n) }),
        banco({ id: 'p2', importe: pesos(50_000n) }),
      ],
      [libro({ entryLineId: 'l1', importe: pesos(60_000n) })],
    );

    expect(resultado.propuestas).toHaveLength(1);
    expect(resultado.propuestas[0]?.movimientoIds).toEqual(['exacto']);
    expect(resultado.movimientosSinCandidato.sort()).toEqual(['p1', 'p2']);
  });

  it('avisa cuando la búsqueda se cortó por el tope, en vez de decir que no hay', () => {
    const movimientos = Array.from({ length: 40 }, (_, i) =>
      banco({ id: `b${String(i)}`, importe: pesos(BigInt(1000 + i)) }),
    );
    const resultado = proponerMatches(
      movimientos,
      [libro({ entryLineId: 'l1', importe: pesos(999_999_999n) })],
      { maxCombinaciones: 5 },
    );

    expect(resultado.busquedaIncompleta).toBe(true);
  });

  it('el acta transcribe ese aviso, porque cambia lo que significan las diferencias', () => {
    const acta = conciliar(
      {
        bankAccountId: 'ba-1',
        desde: fecha('2026-03-01'),
        hasta: fecha('2026-03-31'),
        moneda: 'ARS',
        saldoSegunExtracto: pesos(0n),
        saldoSegunLibro: pesos(0n),
        movimientos: Array.from({ length: 20 }, (_, i) =>
          banco({ id: `b${String(i)}`, importe: pesos(BigInt(1000 + i)) }),
        ),
        lineas: [libro({ entryLineId: 'l1', importe: pesos(999_999_999n) })],
      },
      { maxCombinaciones: 3 },
    );

    expect(acta.explicacion).toMatch(/se cortó por el tope/);
  });
});

// ---------------------------------------------------------------------------
// Importación
// ---------------------------------------------------------------------------

describe('importación de extractos', () => {
  const MAPEO: MapeoDeExtracto = {
    nombre: 'Banco de prueba',
    filasDeEncabezado: 1,
    columnaFecha: 0,
    columnaFechaValor: null,
    columnaDescripcion: 1,
    columnaReferencia: 2,
    columnaSaldo: 5,
    signo: { tipo: 'COLUMNAS_SEPARADAS', debitoDelBanco: 3, creditoDelBanco: 4 },
    formatoFecha: 'DD/MM/AAAA',
    formatoImporte: 'ES_AR',
    moneda: 'ARS',
  };

  const FILAS = [
    ['Fecha', 'Descripcion', 'Referencia', 'Debito', 'Credito', 'Saldo'],
    ['02/03/2026', 'TRANSFERENCIA RECIBIDA', '1001', '', '150.000,00', '150.000,00'],
    ['05/03/2026', 'COM. MANT. CTA', '', '2.500,50', '', '147.499,50'],
    ['10/03/2026', 'PAGO PROVEEDOR', '4521', '47.499,50', '', '100.000,00'],
  ];

  it('interpreta el extracto según el mapeo declarado', () => {
    const { movimientos, errores } = interpretarExtracto(FILAS, MAPEO);

    expect(errores).toEqual([]);
    expect(movimientos).toHaveLength(3);
    expect(movimientos[0]?.sentido).toBe('ENTRADA');
    expect(movimientos[0]?.importe.amount).toBe(15_000_000n);
    expect(movimientos[1]?.sentido).toBe('SALIDA');
    expect(movimientos[1]?.importe.amount).toBe(250_050n);
    expect(movimientos[2]?.referencia).toBe('4521');
    expect(movimientos[1]?.referencia).toBeNull();
  });

  it('la cadena de saldos cierra cuando el archivo está completo', () => {
    const { movimientos } = interpretarExtracto(FILAS, MAPEO);
    const verificacion = verificarCadenaDeSaldos(movimientos, pesos(0n), pesos(10_000_000n));

    expect(verificacion.verificable).toBe(true);
    expect(verificacion.errores).toEqual([]);
    expect(verificacion.saldoFinalCalculado.amount).toBe(10_000_000n);
  });

  it('una fila con el importe mal leído rompe la cadena en esa fila', () => {
    const corrompido = FILAS.map((fila, i) =>
      i === 2 ? ['05/03/2026', 'COM. MANT. CTA', '', '2.500,00', '', '147.499,50'] : fila,
    );
    const { movimientos } = interpretarExtracto(corrompido, MAPEO);
    const verificacion = verificarCadenaDeSaldos(movimientos, pesos(0n), null);

    // Cada fila por separado es válida. Lo que falla es la cadena.
    expect(verificacion.errores).toHaveLength(1);
    expect(verificacion.errores[0]?.codigo).toBe('CADENA_DE_SALDOS_ROTA');
    expect(verificacion.errores[0]?.fila).toBe(3);
    expect(verificacion.errores[0]?.mensaje).toMatch(/todo lo que sigue está corrido/);
  });

  it('sin columna de saldo dice que no se pudo verificar, no que está bien', () => {
    const sinSaldo: MapeoDeExtracto = { ...MAPEO, columnaSaldo: null };
    const { movimientos } = interpretarExtracto(FILAS, sinSaldo);
    const verificacion = verificarCadenaDeSaldos(movimientos, pesos(0n), null);

    expect(verificacion.verificable).toBe(false);
    expect(verificacion.errores).toEqual([]);
  });

  it('un saldo final que no coincide señala movimientos faltantes', () => {
    const { movimientos } = interpretarExtracto(FILAS, MAPEO);
    const verificacion = verificarCadenaDeSaldos(movimientos, pesos(0n), pesos(9_000_000n));

    expect(verificacion.errores[0]?.codigo).toBe('SALDO_FINAL_NO_COINCIDE');
    expect(verificacion.errores[0]?.mensaje).toMatch(/Faltan movimientos, o sobran/);
  });

  it('una fila corta no se saltea en silencio', () => {
    const { movimientos, errores } = interpretarExtracto(
      [...FILAS, ['15/03/2026', 'INCOMPLETA']],
      MAPEO,
    );

    expect(movimientos).toHaveLength(3);
    expect(errores[0]?.codigo).toBe('FILA_CORTA');
    expect(errores[0]?.crudo).toBe('15/03/2026 | INCOMPLETA');
    expect(errores[0]?.mensaje).toMatch(/el separador es otro/);
  });

  it('no prueba otros formatos de fecha cuando el declarado no encaja', () => {
    const { errores } = interpretarExtracto(
      [FILAS[0]!, ['2026-03-02', 'X', '', '', '100,00', '100,00']],
      MAPEO,
    );

    expect(errores[0]?.codigo).toBe('FECHA_INVALIDA');
    expect(errores[0]?.mensaje).toMatch(/no adivinar acá/);
  });

  it('importe en las dos columnas es un error, no una elección', () => {
    const { errores } = interpretarExtracto(
      [FILAS[0]!, ['02/03/2026', 'X', '', '100,00', '200,00', '0,00']],
      MAPEO,
    );

    expect(errores[0]?.codigo).toBe('AMBOS_LADOS');
    expect(errores[0]?.mensaje).toMatch(/columnas equivocadas/);
  });

  it('la columna única con signo respeta la óptica declarada', () => {
    const conSigno: MapeoDeExtracto = {
      ...MAPEO,
      columnaSaldo: null,
      signo: { tipo: 'COLUMNA_UNICA_CON_SIGNO', importe: 3, negativoEsSalida: true },
    };
    const { movimientos } = interpretarExtracto(
      [FILAS[0]!, ['02/03/2026', 'X', '', '-1.500,00', '', '']],
      conSigno,
    );

    expect(movimientos[0]?.sentido).toBe('SALIDA');
    // Se guarda en positivo: el sentido va aparte.
    expect(movimientos[0]?.importe.amount).toBe(150_000n);
  });

  it('invertir la óptica invierte el sentido, y nada más', () => {
    const invertido: MapeoDeExtracto = {
      ...MAPEO,
      columnaSaldo: null,
      signo: { tipo: 'COLUMNA_UNICA_CON_SIGNO', importe: 3, negativoEsSalida: false },
    };
    const { movimientos } = interpretarExtracto(
      [FILAS[0]!, ['02/03/2026', 'X', '', '-1.500,00', '', '']],
      invertido,
    );

    expect(movimientos[0]?.sentido).toBe('ENTRADA');
    expect(movimientos[0]?.importe.amount).toBe(150_000n);
  });

  it('detecta movimientos repetidos dentro del mismo lote', () => {
    const { movimientos } = interpretarExtracto(
      [
        FILAS[0]!,
        ['02/03/2026', 'PAGO', '1001', '100,00', '', ''],
        ['02/03/2026', 'PAGO', '1001', '100,00', '', ''],
      ],
      { ...MAPEO, columnaSaldo: null },
    );

    const repetidos = repetidosEnElLote(movimientos);
    expect(repetidos).toHaveLength(1);
    expect(repetidos[0]?.ids).toHaveLength(2);
    // La huella no incluye el número de fila: el mismo movimiento reimportado
    // desde un archivo con otro encabezado sigue siendo el mismo.
    expect(huellaDeMovimiento(movimientos[0]!)).toBe(huellaDeMovimiento(movimientos[1]!));
  });

  it('los totales del lote separan créditos de débitos', () => {
    const { movimientos } = interpretarExtracto(FILAS, MAPEO);
    const totales = totalesDelLote(movimientos, 'ARS');

    expect(totales.entradas.amount).toBe(15_000_000n);
    expect(totales.salidas.amount).toBe(250_050n + 4_749_950n);
  });
});

describe('la columna única, y los casos que suelen quedar sin probar', () => {
  const UNICA: MapeoDeExtracto = {
    nombre: 'Banco con columna única',
    filasDeEncabezado: 1,
    columnaFecha: 0,
    columnaFechaValor: 1,
    columnaDescripcion: 2,
    columnaReferencia: null,
    columnaSaldo: null,
    signo: { tipo: 'COLUMNA_UNICA_CON_SIGNO', importe: 3, negativoEsSalida: true },
    formatoFecha: 'AAAA-MM-DD',
    formatoImporte: 'PLANO',
    moneda: 'ARS',
  };

  const CABECERA = ['Fecha', 'Fecha valor', 'Detalle', 'Importe'];

  it('lee la fecha valor cuando el mapeo la declara', () => {
    const { movimientos } = interpretarExtracto(
      [CABECERA, ['2026-03-02', '2026-03-04', 'Acreditacion', '1500.00']],
      UNICA,
    );

    expect(movimientos[0]?.fecha).toBe('2026-03-02');
    expect(movimientos[0]?.fechaValor).toBe('2026-03-04');
    expect(movimientos[0]?.referencia).toBeNull();
    expect(movimientos[0]?.saldoPosterior).toBeNull();
  });

  it('una fecha valor vacía queda en null, no rompe la fila', () => {
    const { movimientos, errores } = interpretarExtracto(
      [CABECERA, ['2026-03-02', '', 'Acreditacion', '1500.00']],
      UNICA,
    );

    expect(errores).toEqual([]);
    expect(movimientos[0]?.fechaValor).toBeNull();
  });

  it('la columna de importe vacía es un error explícito', () => {
    const { errores } = interpretarExtracto([CABECERA, ['2026-03-02', '', 'X', '']], UNICA);

    expect(errores[0]?.codigo).toBe('SIN_IMPORTE');
    expect(errores[0]?.mensaje).toMatch(/está vacía/);
  });

  it('un importe de cero no se importa en silencio', () => {
    const { errores } = interpretarExtracto([CABECERA, ['2026-03-02', '', 'X', '0.00']], UNICA);

    expect(errores[0]?.codigo).toBe('SIN_IMPORTE');
    expect(errores[0]?.mensaje).toMatch(/no mueve el saldo/);
  });

  it('un importe ilegible en la columna única dice qué formato esperaba', () => {
    const { errores } = interpretarExtracto([CABECERA, ['2026-03-02', '', 'X', '1.234,56']], UNICA);

    expect(errores[0]?.codigo).toBe('IMPORTE_INVALIDO');
    expect(errores[0]?.mensaje).toMatch(/no prueba otros/);
  });

  it('una fila vacía al final del archivo no es un error', () => {
    const { movimientos, errores } = interpretarExtracto(
      [CABECERA, ['2026-03-02', '', 'X', '100.00'], ['', '', '', '']],
      UNICA,
    );

    expect(movimientos).toHaveLength(1);
    expect(errores).toEqual([]);
  });

  it('el signo más adelante del número no lo vuelve negativo', () => {
    expect(interpretarImporte('+1234.56', 'PLANO', 'ARS')?.amount).toBe(123_456n);
  });

  it('descarta los símbolos de otras monedas sin cambiar el número', () => {
    expect(interpretarImporte('USD 1234.56', 'PLANO', 'USD')?.amount).toBe(123_456n);
    expect(interpretarImporte('€1234.56', 'PLANO', 'ARS')?.amount).toBe(123_456n);
  });

  it('sin movimientos, la cadena de saldos devuelve el inicial', () => {
    const verificacion = verificarCadenaDeSaldos([], pesos(500n), null);

    expect(verificacion.saldoFinalCalculado.amount).toBe(500n);
    expect(verificacion.verificable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interpretación de valores
// ---------------------------------------------------------------------------

describe('interpretación de fechas e importes', () => {
  it('interpreta cada formato declarado y rechaza los demás', () => {
    expect(interpretarFecha('02/03/2026', 'DD/MM/AAAA')).toBe('2026-03-02');
    expect(interpretarFecha('2-3-2026', 'DD-MM-AAAA')).toBe('2026-03-02');
    expect(interpretarFecha('2026-03-02', 'AAAA-MM-DD')).toBe('2026-03-02');
    expect(interpretarFecha('02/03/26', 'DD/MM/AA')).toBe('2026-03-02');
    expect(interpretarFecha('02/03/2026', 'AAAA-MM-DD')).toBeNull();
    expect(interpretarFecha('31/02/2026', 'DD/MM/AAAA')).toBeNull();
  });

  it('interpreta importes en enteros, sin pasar por punto flotante', () => {
    expect(interpretarImporte('1.234,56', 'ES_AR', 'ARS')?.amount).toBe(123_456n);
    expect(interpretarImporte('1,234.56', 'EN_US', 'ARS')?.amount).toBe(123_456n);
    expect(interpretarImporte('1234.56', 'PLANO', 'ARS')?.amount).toBe(123_456n);
    // El caso que rompe a `parseFloat`: 0.1 + 0.2 no da 0.3, y 1234.565 no es
    // representable. Acá se concatena texto, así que no hay pérdida.
    expect(interpretarImporte('999.999.999,99', 'ES_AR', 'ARS')?.amount).toBe(99_999_999_999n);
  });

  it('los paréntesis son negativos: es la convención contable', () => {
    expect(interpretarImporte('(1.234,56)', 'ES_AR', 'ARS')?.amount).toBe(-123_456n);
    expect(interpretarImporte('-1.234,56', 'ES_AR', 'ARS')?.amount).toBe(-123_456n);
  });

  it('descarta el símbolo de moneda pero no inventa el formato', () => {
    expect(interpretarImporte('$ 1.234,56', 'ES_AR', 'ARS')?.amount).toBe(123_456n);
    expect(interpretarImporte('1.234,56', 'EN_US', 'ARS')).toBeNull();
    expect(interpretarImporte('mil doscientos', 'ES_AR', 'ARS')).toBeNull();
  });

  it('normaliza referencias como las imprimen los bancos', () => {
    expect(normalizarReferencia('0000012345')).toBe('12345');
    expect(normalizarReferencia('CHQ 12.345')).toBe('12345');
    expect(normalizarReferencia('12345')).toBe('12345');
    // Sin dígitos se compara el texto.
    expect(normalizarReferencia(' abc ')).toBe('ABC');
  });

  it('las palabras de relleno del extracto no hacen coincidir cualquier cosa', () => {
    expect(palabrasEnComun('PAGO TRANSFERENCIA', 'PAGO DEPOSITO')).toBe(0);
    expect(palabrasEnComun('PAGO METALURGICA SA', 'Metalúrgica del Sur')).toBe(1);
  });

  it('la distancia en días no depende de la zona horaria', () => {
    expect(distanciaEnDias(fecha('2026-03-01'), fecha('2026-03-10'))).toBe(9);
    // Cruza el cambio de mes y el de año sin ayuda.
    expect(distanciaEnDias(fecha('2026-02-28'), fecha('2026-03-01'))).toBe(1);
    expect(distanciaEnDias(fecha('2025-12-31'), fecha('2026-01-01'))).toBe(1);
    expect(distanciaEnDias(fecha('2026-03-10'), fecha('2026-03-10'))).toBe(0);
  });
});
