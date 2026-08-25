/**
 * Libro Mayor — una proyección del Diario, no una segunda contabilidad.
 *
 * Esa frase decide todo el archivo. El Mayor no tiene ningún dato propio: cada
 * movimiento sale de una línea de asiento y de nada más. Por eso se puede
 * reconstruir entero, y por eso `verificarProyeccion` puede ser tajante — no
 * compara dos fuentes, compara una fuente con su copia.
 *
 * Cuando discrepan, gana el Diario (ACCOUNTING_ENGINE.md §7). No es una
 * preferencia de diseño: el Diario es el libro con eficacia probatoria del CCyC
 * art. 330; el Mayor materializado es una tabla que existe por rendimiento.
 */

import type { CalendarDate, Currency, Money } from '@aai/shared';
import { add, compareDates, money, subtract, zero } from '@aai/shared';
import type { AsientoDelLibro, LineaDelLibro } from './libro-diario.js';

export interface MovimientoDelMayor {
  /** La línea de asiento que lo origina. Es la clave de toda la trazabilidad. */
  readonly entryLineId: string;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly fecha: CalendarDate;
  readonly journalCode: string;
  readonly entryNumber: number;
  readonly entryId: string;
  readonly detalle: string;
  readonly debe: Money;
  readonly haber: Money;
  /** Saldo después de este movimiento. Positivo = deudor. */
  readonly saldo: Money;
  /** La punta del hilo hacia el comprobante. `null` en cierres y ajustes. */
  readonly documentId: string | null;
  readonly sourceType: string;
  readonly sourceId: string | null;
  /** Si el asiento fue anulado, el movimiento sigue: lo compensa el contraasiento. */
  readonly anulado: boolean;
}

export interface CuentaDelMayor {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly nature: 'DEUDORA' | 'ACREEDORA';
  readonly saldoInicial: Money;
  readonly movimientos: readonly MovimientoDelMayor[];
  readonly totalDebe: Money;
  readonly totalHaber: Money;
  readonly saldoFinal: Money;
}

export interface LibroMayor {
  readonly companyId: string;
  readonly moneda: Currency;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly cuentas: readonly CuentaDelMayor[];
  readonly totalDebe: Money;
  readonly totalHaber: Money;
}

export interface CuentaParaElMayor {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nature: 'DEUDORA' | 'ACREEDORA';
}

export interface SaldoDeApertura {
  readonly accountId: string;
  /** Positivo si es deudor, negativo si es acreedor. */
  readonly monto: Money;
}

export interface OpcionesMayor {
  readonly companyId: string;
  readonly moneda: Currency;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly cuentas: readonly CuentaParaElMayor[];
  readonly saldosIniciales?: readonly SaldoDeApertura[];
  /**
   * Incluir cuentas sin movimientos en el rango.
   *
   * Por defecto no: un Mayor con trescientas cuentas en cero es ilegible. Pero
   * una cuenta con saldo inicial y sin movimientos **siempre** aparece, tenga o
   * no esta opción — omitirla haría que los totales del Mayor no coincidan con
   * los del balance.
   */
  readonly incluirCuentasSinMovimientos?: boolean;
}

/**
 * Reconstruye el Mayor desde los asientos del Diario.
 *
 * Entran los mismos asientos que entran al Diario —los registrables— porque un
 * Mayor armado sobre un universo distinto al del Diario no sería una proyección
 * de nada. Quien llama pasa la salida de `construirLibroDiario`, o la misma
 * lista que le dio.
 */
export function construirLibroMayor(
  asientos: readonly AsientoDelLibro[],
  opciones: OpcionesMayor,
): LibroMayor {
  const { moneda } = opciones;

  const ordenados = [...asientos].sort((a, b) => {
    const porFecha = compareDates(a.entryDate, b.entryDate);
    if (porFecha !== 0) return porFecha;
    if (a.journalCode !== b.journalCode) return a.journalCode < b.journalCode ? -1 : 1;
    return a.entryNumber - b.entryNumber;
  });

  const catalogo = new Map(opciones.cuentas.map((cuenta) => [cuenta.id, cuenta]));
  const iniciales = new Map(
    (opciones.saldosIniciales ?? []).map((saldo) => [saldo.accountId, saldo.monto]),
  );

  // Primera pasada: juntar los movimientos por cuenta, sin saldo todavía. El
  // saldo acumulado depende del orden completo, así que no se puede calcular
  // mientras se recorre por asiento.
  const crudos = new Map<string, { asiento: AsientoDelLibro; linea: LineaDelLibro }[]>();
  for (const asiento of ordenados) {
    for (const linea of asiento.lines) {
      const lista = crudos.get(linea.accountId);
      if (lista === undefined) crudos.set(linea.accountId, [{ asiento, linea }]);
      else lista.push({ asiento, linea });
    }
  }

  const cuentas: CuentaDelMayor[] = [];
  const idsConMovimiento = new Set(crudos.keys());
  const idsAIncluir = new Set<string>(idsConMovimiento);
  for (const [accountId] of iniciales) idsAIncluir.add(accountId);
  if (opciones.incluirCuentasSinMovimientos === true) {
    for (const cuenta of opciones.cuentas) idsAIncluir.add(cuenta.id);
  }

  for (const accountId of idsAIncluir) {
    const ficha = catalogo.get(accountId);
    const saldoInicial = iniciales.get(accountId) ?? zero(moneda);
    let saldo = saldoInicial;
    let totalDebe = zero(moneda);
    let totalHaber = zero(moneda);
    const movimientos: MovimientoDelMayor[] = [];

    for (const { asiento, linea } of crudos.get(accountId) ?? []) {
      saldo = subtract(add(saldo, linea.debit), linea.credit);
      totalDebe = add(totalDebe, linea.debit);
      totalHaber = add(totalHaber, linea.credit);
      movimientos.push({
        entryLineId: linea.id,
        accountId,
        accountCode: linea.accountCode,
        accountName: linea.accountName,
        fecha: asiento.entryDate,
        journalCode: asiento.journalCode,
        entryNumber: asiento.entryNumber,
        entryId: asiento.id,
        detalle: linea.description ?? asiento.description,
        debe: linea.debit,
        haber: linea.credit,
        saldo,
        documentId: asiento.documentId,
        sourceType: asiento.sourceType,
        sourceId: asiento.sourceId,
        anulado: asiento.status === 'ANULADO',
      });
    }

    cuentas.push({
      accountId,
      accountCode: ficha?.code ?? movimientos[0]?.accountCode ?? '',
      accountName: ficha?.name ?? movimientos[0]?.accountName ?? '',
      // Sin ficha no se inventa la naturaleza a partir del signo: una cuenta de
      // activo puede quedar transitoriamente acreedora sin dejar de ser deudora.
      // Se marca DEUDORA por convención y el catálogo faltante es el problema.
      nature: ficha?.nature ?? 'DEUDORA',
      saldoInicial,
      movimientos,
      totalDebe,
      totalHaber,
      saldoFinal: saldo,
    });
  }

  cuentas.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    companyId: opciones.companyId,
    moneda,
    desde: opciones.desde,
    hasta: opciones.hasta,
    cuentas,
    totalDebe: cuentas.reduce((acc, cuenta) => add(acc, cuenta.totalDebe), zero(moneda)),
    totalHaber: cuentas.reduce((acc, cuenta) => add(acc, cuenta.totalHaber), zero(moneda)),
  };
}

// ---------------------------------------------------------------------------
// Verificación de la proyección
// ---------------------------------------------------------------------------

/** Lo que la tabla `ledger_movements` tiene guardado, para comparar. */
export interface MovimientoMaterializado {
  readonly entryLineId: string;
  readonly accountId: string;
  readonly fecha: CalendarDate;
  readonly debe: Money;
  readonly haber: Money;
}

export type TipoDiscrepancia =
  | 'FALTA_EN_MAYOR'
  | 'SOBRA_EN_MAYOR'
  | 'IMPORTE_DISTINTO'
  | 'CUENTA_DISTINTA'
  | 'FECHA_DISTINTA';

export interface Discrepancia {
  readonly tipo: TipoDiscrepancia;
  readonly entryLineId: string;
  readonly detalle: string;
}

export interface ResultadoVerificacion {
  readonly movimientos: number;
  readonly discrepancias: readonly Discrepancia[];
  readonly coincide: boolean;
}

/**
 * Compara el Mayor reconstruido con el materializado.
 *
 * Se comparan **los cuatro datos que el movimiento copia del Diario**: cuenta,
 * fecha, debe y haber. No se compara el saldo acumulado a propósito: el saldo no
 * está en `ledger_movements`, es un cálculo de lectura. Compararlo sería
 * verificar la aritmética de este mismo archivo contra sí misma.
 *
 * `SOBRA_EN_MAYOR` es la discrepancia grave. Un movimiento que falta puede ser
 * una proyección que no corrió todavía; uno que sobra es un movimiento sin
 * asiento detrás, y eso es un saldo que nadie puede explicar.
 */
export function verificarProyeccion(
  reconstruido: LibroMayor,
  materializado: readonly MovimientoMaterializado[],
): ResultadoVerificacion {
  const esperados = new Map<string, MovimientoDelMayor>();
  for (const cuenta of reconstruido.cuentas) {
    for (const movimiento of cuenta.movimientos) {
      esperados.set(movimiento.entryLineId, movimiento);
    }
  }

  const discrepancias: Discrepancia[] = [];
  const vistos = new Set<string>();

  for (const real of materializado) {
    vistos.add(real.entryLineId);
    const esperado = esperados.get(real.entryLineId);
    if (esperado === undefined) {
      discrepancias.push({
        tipo: 'SOBRA_EN_MAYOR',
        entryLineId: real.entryLineId,
        detalle:
          'Hay un movimiento en el Mayor cuya línea de asiento no está en el Diario del rango. Es un saldo sin origen.',
      });
      continue;
    }
    if (esperado.accountId !== real.accountId) {
      discrepancias.push({
        tipo: 'CUENTA_DISTINTA',
        entryLineId: real.entryLineId,
        detalle: `El Diario imputa a ${esperado.accountId} y el Mayor a ${real.accountId}`,
      });
    }
    if (esperado.fecha !== real.fecha) {
      discrepancias.push({
        tipo: 'FECHA_DISTINTA',
        entryLineId: real.entryLineId,
        detalle: `El Diario dice ${esperado.fecha} y el Mayor ${real.fecha}`,
      });
    }
    if (
      esperado.debe.amount !== real.debe.amount ||
      esperado.haber.amount !== real.haber.amount ||
      esperado.debe.currency !== real.debe.currency ||
      esperado.haber.currency !== real.haber.currency
    ) {
      discrepancias.push({
        tipo: 'IMPORTE_DISTINTO',
        entryLineId: real.entryLineId,
        detalle: `El Diario dice ${esperado.debe.amount}/${esperado.haber.amount} y el Mayor ${real.debe.amount}/${real.haber.amount} (unidades menores)`,
      });
    }
  }

  for (const [entryLineId] of esperados) {
    if (!vistos.has(entryLineId)) {
      discrepancias.push({
        tipo: 'FALTA_EN_MAYOR',
        entryLineId,
        detalle:
          'La línea está en el Diario y no llegó al Mayor. El saldo de esa cuenta está incompleto.',
      });
    }
  }

  return {
    movimientos: esperados.size,
    discrepancias,
    coincide: discrepancias.length === 0,
  };
}

/**
 * Saldos de cierre del Mayor, listos para alimentar el balance del período
 * siguiente.
 *
 * Se devuelven todas las cuentas, incluidas las que quedaron en cero. Una cuenta
 * que cerró en cero y desaparece del arrastre vuelve a aparecer más adelante con
 * un saldo inicial implícito de cero, que es lo mismo — pero deja de poder
 * distinguirse de una cuenta que nunca existió.
 */
export function saldosDeCierre(mayor: LibroMayor): SaldoDeApertura[] {
  return mayor.cuentas.map((cuenta) => ({
    accountId: cuenta.accountId,
    monto: cuenta.saldoFinal,
  }));
}

/**
 * Suma de saldos deudores y acreedores del Mayor.
 *
 * Existe para el control cruzado contra el balance de sumas y saldos: si el
 * Mayor y el balance no dan lo mismo, uno de los dos se armó sobre otro
 * universo de asientos.
 */
export function saldosPorNaturaleza(mayor: LibroMayor): {
  deudores: Money;
  acreedores: Money;
} {
  let deudores = 0n;
  let acreedores = 0n;
  for (const cuenta of mayor.cuentas) {
    if (cuenta.saldoFinal.amount > 0n) deudores += cuenta.saldoFinal.amount;
    else acreedores += -cuenta.saldoFinal.amount;
  }
  return {
    deudores: money(deudores, mayor.moneda),
    acreedores: money(acreedores, mayor.moneda),
  };
}
