/**
 * El acta de conciliación — la igualdad que tiene que cerrar.
 *
 * ```
 * saldo según extracto  +  partidas conciliatorias  =  saldo según libro
 * ```
 *
 * Es a la conciliación lo que las tres igualdades del balance de sumas y saldos
 * son al Diario: la prueba de vida. Si no cierra, la conciliación **no está
 * hecha**, por más que los cuarenta matches propuestos estén todos bien. Lo que
 * falta es siempre una partida que nadie identificó, y esa partida es el
 * hallazgo.
 *
 * El motor no la busca ni la inventa: dice cuánto falta y de qué lado.
 *
 * ## Lo que este archivo deliberadamente no hace
 *
 * No clasifica las partidas conciliatorias por concepto. No dice "esto es una
 * comisión bancaria", ni "esto es el impuesto de la Ley 25.413", ni "esto es un
 * cheque no debitado". Puede parecer lo obvio —la descripción del banco muchas
 * veces lo dice— pero:
 *
 * - la Ley 25.413 no está archivada, así que el sistema no puede afirmar ni la
 *   alícuota ni el hecho imponible;
 * - una descripción bancaria no es una fuente: "COM. MANT. CTA" es una cadena
 *   que el banco eligió, no una calificación jurídica;
 * - y una partida mal clasificada que después se imputa contablemente produce un
 *   asiento equivocado con la firma de alguien que confió en la etiqueta.
 *
 * Lo que sí hace es decir **de qué lado quedó cada partida y dónde mirar**. La
 * calificación la pone el contador.
 */

import type { CalendarDate, Currency, Money } from '@aai/shared';
import { add, money, subtract, zero } from '@aai/shared';
import type {
  ActaDeConciliacion,
  Cobertura,
  DiferenciaConciliacion,
  LineaConciliable,
  MovimientoBancario,
} from './contracts.js';
import { proponerMatches, type OpcionesMatching, type ResultadoMatching } from './matching.js';

export interface DatosDeConciliacion {
  readonly bankAccountId: string;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly moneda: Currency;
  /** Saldo que el extracto declara al cierre del período. */
  readonly saldoSegunExtracto: Money;
  /** Saldo de la cuenta contable al cierre, del Mayor. */
  readonly saldoSegunLibro: Money;
  readonly movimientos: readonly MovimientoBancario[];
  readonly lineas: readonly LineaConciliable[];
}

export function conciliar(
  datos: DatosDeConciliacion,
  opciones: OpcionesMatching = {},
): ActaDeConciliacion {
  const matching = proponerMatches(datos.movimientos, datos.lineas, opciones);
  const diferencias = armarDiferencias(datos, matching);

  // El ajuste parte del extracto y llega al libro. Cada partida se suma o se
  // resta según de qué lado falta:
  //
  //   en el libro y no en el banco, ENTRADA  → el libro tiene más plata  → +
  //     (depósito en tránsito: el libro ya lo registró, el banco no lo acreditó)
  //   en el libro y no en el banco, SALIDA   → el libro tiene menos      → −
  //     (cheque emitido y no debitado)
  //   en el banco y no en el libro, SALIDA   → el libro todavía tiene esa plata → +
  //     (comisión que el banco ya cobró y nadie registró)
  //   en el banco y no en el libro, ENTRADA  → el libro todavía no la tiene     → −
  //     (una acreditación que el libro no registró)
  //
  // Los cuatro casos están escritos porque los dos del medio se confunden todo
  // el tiempo, y equivocarse en uno hace que el acta cierre por casualidad
  // cuando el importe de las dos puntas coincide.
  let ajuste = zero(datos.moneda);
  for (const diferencia of diferencias) {
    const entrada = diferencia.sentido === 'ENTRADA';
    if (diferencia.tipo === 'EN_LIBRO_NO_EN_BANCO') {
      ajuste = entrada ? add(ajuste, diferencia.importe) : subtract(ajuste, diferencia.importe);
    } else if (diferencia.tipo === 'EN_BANCO_NO_EN_LIBRO') {
      ajuste = entrada ? subtract(ajuste, diferencia.importe) : add(ajuste, diferencia.importe);
    }
  }

  const saldoConciliado = add(datos.saldoSegunExtracto, ajuste);
  const cierra = saldoConciliado.amount === datos.saldoSegunLibro.amount;
  const faltante = subtract(datos.saldoSegunLibro, saldoConciliado);

  return {
    bankAccountId: datos.bankAccountId,
    desde: datos.desde,
    hasta: datos.hasta,
    saldoSegunExtracto: datos.saldoSegunExtracto,
    saldoSegunLibro: datos.saldoSegunLibro,
    conciliados: matching.propuestas,
    ambiguos: matching.ambiguos,
    diferencias,
    ajusteNeto: ajuste,
    saldoConciliado,
    cierra,
    explicacion: explicar(datos, ajuste, saldoConciliado, cierra, faltante, matching),
    cobertura: medirCobertura(datos.movimientos, matching),
  };
}

function armarDiferencias(
  datos: DatosDeConciliacion,
  matching: ResultadoMatching,
): DiferenciaConciliacion[] {
  const diferencias: DiferenciaConciliacion[] = [];
  const porMovimiento = new Map(datos.movimientos.map((movimiento) => [movimiento.id, movimiento]));
  const porLinea = new Map(datos.lineas.map((linea) => [linea.entryLineId, linea]));

  for (const id of matching.movimientosSinCandidato) {
    const movimiento = porMovimiento.get(id);
    if (movimiento === undefined) continue;
    diferencias.push({
      tipo: 'EN_BANCO_NO_EN_LIBRO',
      movimientoId: movimiento.id,
      entryLineId: null,
      importe: movimiento.importe,
      sentido: movimiento.sentido,
      fecha: movimiento.fecha,
      descripcion: movimiento.descripcion,
      dondeMirar:
        movimiento.sentido === 'SALIDA'
          ? 'Salida de fondos que el banco ya hizo y el libro no registra. Suele ser una comisión, un impuesto sobre la cuenta o un cheque emitido en un período anterior. El concepto lo determina el contador: la descripción del banco no es una fuente.'
          : 'Entrada de fondos que el banco ya acreditó y el libro no registra. Suele ser una acreditación de un tercero, un interés o una devolución. Identificar el origen antes de imputar.',
    });
  }

  for (const id of matching.lineasSinCandidato) {
    const linea = porLinea.get(id);
    if (linea === undefined) continue;
    diferencias.push({
      tipo: 'EN_LIBRO_NO_EN_BANCO',
      movimientoId: null,
      entryLineId: linea.entryLineId,
      importe: linea.importe,
      sentido: linea.sentido,
      fecha: linea.fecha,
      descripcion: linea.descripcion,
      dondeMirar:
        linea.sentido === 'SALIDA'
          ? 'El libro registra una salida de fondos que el banco todavía no debitó. Típicamente un cheque emitido y no presentado.'
          : 'El libro registra un ingreso que el banco todavía no acreditó. Típicamente un depósito en tránsito o un cheque al cobro.',
    });
  }

  return diferencias;
}

/**
 * Cobertura: cuántos movimientos del extracto tienen propuesta.
 *
 * Es el indicador del criterio de la fase (≥ 80% de matching automático
 * propuesto). Se calcula sobre **movimientos del banco**, no sobre matches: una
 * agrupación que junta cuatro movimientos cubre cuatro, no uno.
 *
 * Los ambiguos **no cuentan como cubiertos**. El motor los encontró, sí, pero no
 * propuso nada: contarlos inflaría el indicador justo con los casos que más
 * trabajo humano requieren.
 *
 * El porcentaje es entero y se trunca hacia abajo. 79,9% se informa como 79, no
 * como 80: un indicador que redondea hacia arriba justo en el umbral del
 * criterio deja de servir para verificar el criterio.
 */
function medirCobertura(
  movimientos: readonly MovimientoBancario[],
  matching: ResultadoMatching,
): Cobertura {
  const cubiertos = new Set<string>();
  for (const propuesta of matching.propuestas) {
    for (const id of propuesta.movimientoIds) cubiertos.add(id);
  }

  const total = movimientos.length;
  return {
    movimientos: total,
    propuestos: cubiertos.size,
    ambiguos: matching.ambiguos.length,
    sinCandidato: matching.movimientosSinCandidato.length,
    porcentaje: total === 0 ? 0 : Math.floor((cubiertos.size * 100) / total),
  };
}

function explicar(
  datos: DatosDeConciliacion,
  ajuste: Money,
  saldoConciliado: Money,
  cierra: boolean,
  faltante: Money,
  matching: ResultadoMatching,
): string {
  const lineas = [
    `Saldo según extracto:      ${datos.saldoSegunExtracto.amount}`,
    `Partidas conciliatorias:   ${ajuste.amount}`,
    `Saldo conciliado:          ${saldoConciliado.amount}`,
    `Saldo según libro:         ${datos.saldoSegunLibro.amount}`,
    '(importes en unidades menores)',
  ];

  lineas.push(
    cierra
      ? 'La conciliación CIERRA: el saldo del extracto más las partidas conciliatorias da exactamente el saldo contable.'
      : `La conciliación NO CIERRA. Faltan ${faltante.amount} en unidades menores. Hay al menos una partida que nadie identificó, y ese es el hallazgo: no es un error de redondeo ni algo que se ajuste. El motor no la busca ni la inventa.`,
  );

  if (matching.busquedaIncompleta) {
    lineas.push(
      'La búsqueda de agrupaciones se cortó por el tope de combinaciones. Puede haber agrupaciones válidas que no se evaluaron: subí el tope o acotá el período antes de dar por cerrada la lista de diferencias.',
    );
  }

  if (matching.ambiguos.length > 0) {
    lineas.push(
      `${matching.ambiguos.length} movimiento(s) tienen más de un candidato con el mismo puntaje. El motor no desempata; resolvelos antes de confirmar.`,
    );
  }

  return lineas.join('\n');
}

/**
 * Verificación de una conciliación ya confirmada.
 *
 * Existe por la misma razón que `verificarProyeccion` en el Mayor: una
 * conciliación guardada es un dato derivado, y un dato derivado que nadie vuelve
 * a verificar se desincroniza en silencio. Se recalcula desde los movimientos y
 * las líneas, y se compara contra lo guardado.
 */
export function verificarActa(
  acta: ActaDeConciliacion,
  saldoGuardado: Money,
): { coincide: boolean; detalle: string } {
  if (acta.saldoConciliado.amount === saldoGuardado.amount) {
    return { coincide: true, detalle: 'El acta recalculada coincide con la guardada.' };
  }
  return {
    coincide: false,
    detalle: `La conciliación guardada dice ${saldoGuardado.amount} y recalculada da ${acta.saldoConciliado.amount} (unidades menores). Algo cambió después de confirmarla: un asiento nuevo en el período, un movimiento reimportado, o una línea anulada.`,
  };
}

/** Total de partidas conciliatorias por tipo, para el resumen del acta. */
export function totalesPorTipo(
  acta: ActaDeConciliacion,
  moneda: Currency,
): { enBancoNoEnLibro: Money; enLibroNoEnBanco: Money } {
  let banco = 0n;
  let libro = 0n;
  for (const diferencia of acta.diferencias) {
    if (diferencia.tipo === 'EN_BANCO_NO_EN_LIBRO') banco += diferencia.importe.amount;
    if (diferencia.tipo === 'EN_LIBRO_NO_EN_BANCO') libro += diferencia.importe.amount;
  }
  return { enBancoNoEnLibro: money(banco, moneda), enLibroNoEnBanco: money(libro, moneda) };
}
