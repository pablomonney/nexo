/**
 * Balance de sumas y saldos — la prueba de vida del sistema (§8).
 *
 * Tres igualdades que se verifican en cada corrida:
 *
 * ```
 * Σ débitos del período  =  Σ créditos del período
 * Σ saldos deudores      =  Σ saldos acreedores
 * saldo inicial + débitos − créditos = saldo final   (por cuenta)
 * ```
 *
 * Si alguna falla, el sistema entra en modo degradado y **no emite estados
 * contables**. Es la línea más importante de este archivo: un balance que no
 * cuadra no es un reporte con una advertencia, es un libro roto, y emitir
 * estados sobre él sería firmar algo que no se sostiene.
 *
 * El saldo se expresa con signo según la **naturaleza** de la cuenta: deudor
 * positivo en cuentas deudoras, acreedor positivo en acreedoras. Presentarlos
 * todos con el mismo signo obliga al lector a recordar de qué tipo es cada
 * cuenta, que es exactamente el trabajo que un balance debería ahorrarle.
 */

import type { Currency, Money } from '@aai/shared';
import { add, money, subtract, zero } from '@aai/shared';

export interface MovimientoDeMayor {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly nature: 'DEUDORA' | 'ACREEDORA';
  readonly debit: Money;
  readonly credit: Money;
}

export interface SaldoInicial {
  readonly accountId: string;
  /** Positivo si es deudor, negativo si es acreedor. */
  readonly monto: Money;
}

export interface LineaBalance {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly nature: 'DEUDORA' | 'ACREEDORA';
  readonly saldoInicial: Money;
  readonly debitos: Money;
  readonly creditos: Money;
  /** Saldo inicial + débitos − créditos. Positivo = deudor. */
  readonly saldoFinal: Money;
}

export interface BalanceDeSumasYSaldos {
  readonly moneda: Currency;
  readonly lineas: readonly LineaBalance[];
  readonly totalDebitos: Money;
  readonly totalCreditos: Money;
  readonly totalSaldosDeudores: Money;
  readonly totalSaldosAcreedores: Money;
  readonly verificaciones: readonly Verificacion[];
  /** `false` inhabilita la emisión de estados contables. */
  readonly cuadra: boolean;
}

export interface Verificacion {
  readonly codigo: 'SUMAS_IGUALES' | 'SALDOS_IGUALES' | 'SALDO_POR_CUENTA';
  readonly cumple: boolean;
  readonly detalle: string;
}

export function balanceDeSumasYSaldos(
  movimientos: readonly MovimientoDeMayor[],
  saldosIniciales: readonly SaldoInicial[],
  moneda: Currency,
): BalanceDeSumasYSaldos {
  const acumulado = new Map<string, LineaMutable>();

  for (const movimiento of movimientos) {
    let linea = acumulado.get(movimiento.accountId);
    if (linea === undefined) {
      linea = {
        accountId: movimiento.accountId,
        accountCode: movimiento.accountCode,
        accountName: movimiento.accountName,
        nature: movimiento.nature,
        saldoInicial: zero(moneda),
        debitos: zero(moneda),
        creditos: zero(moneda),
      };
      acumulado.set(movimiento.accountId, linea);
    }
    linea.debitos = add(linea.debitos, movimiento.debit);
    linea.creditos = add(linea.creditos, movimiento.credit);
  }

  for (const inicial of saldosIniciales) {
    const linea = acumulado.get(inicial.accountId);
    if (linea !== undefined) {
      linea.saldoInicial = inicial.monto;
      continue;
    }
    // Una cuenta con saldo inicial y sin movimientos en el período sigue
    // estando en el balance: omitirla haría que los totales no cierren.
    acumulado.set(inicial.accountId, {
      accountId: inicial.accountId,
      accountCode: '',
      accountName: '',
      nature: inicial.monto.amount >= 0n ? 'DEUDORA' : 'ACREEDORA',
      saldoInicial: inicial.monto,
      debitos: zero(moneda),
      creditos: zero(moneda),
    });
  }

  const lineas: LineaBalance[] = [...acumulado.values()]
    .map((linea) => ({
      ...linea,
      saldoFinal: subtract(add(linea.saldoInicial, linea.debitos), linea.creditos),
    }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  const totalDebitos = lineas.reduce((acc, linea) => add(acc, linea.debitos), zero(moneda));
  const totalCreditos = lineas.reduce((acc, linea) => add(acc, linea.creditos), zero(moneda));

  let deudores = 0n;
  let acreedores = 0n;
  for (const linea of lineas) {
    if (linea.saldoFinal.amount > 0n) deudores += linea.saldoFinal.amount;
    else acreedores += -linea.saldoFinal.amount;
  }

  const sumasIguales = totalDebitos.amount === totalCreditos.amount;
  const saldosIguales = deudores === acreedores;

  // Tercera igualdad. Es tautológica dada la fórmula de `saldoFinal`, y por eso
  // mismo vale la pena verificarla: si alguna vez deja de serlo, es que alguien
  // cambió cómo se calcula el saldo y no se dio cuenta.
  const porCuenta = lineas.every(
    (linea) =>
      linea.saldoFinal.amount ===
      linea.saldoInicial.amount + linea.debitos.amount - linea.creditos.amount,
  );

  const verificaciones: Verificacion[] = [
    {
      codigo: 'SUMAS_IGUALES',
      cumple: sumasIguales,
      detalle: sumasIguales
        ? 'Σ débitos = Σ créditos'
        : `Σ débitos ${totalDebitos.amount} ≠ Σ créditos ${totalCreditos.amount}`,
    },
    {
      codigo: 'SALDOS_IGUALES',
      cumple: saldosIguales,
      detalle: saldosIguales
        ? 'Σ saldos deudores = Σ saldos acreedores'
        : `Deudores ${deudores} ≠ acreedores ${acreedores}`,
    },
    {
      codigo: 'SALDO_POR_CUENTA',
      cumple: porCuenta,
      detalle: porCuenta
        ? 'Saldo inicial + débitos − créditos = saldo final, en todas las cuentas'
        : 'Hay cuentas cuyo saldo final no se deriva de sus movimientos',
    },
  ];

  return {
    moneda,
    lineas,
    totalDebitos,
    totalCreditos,
    totalSaldosDeudores: money(deudores, moneda),
    totalSaldosAcreedores: money(acreedores, moneda),
    verificaciones,
    cuadra: verificaciones.every((verificacion) => verificacion.cumple),
  };
}

interface LineaMutable {
  accountId: string;
  accountCode: string;
  accountName: string;
  nature: 'DEUDORA' | 'ACREEDORA';
  saldoInicial: Money;
  debitos: Money;
  creditos: Money;
}

/**
 * Diferencia entre columnas, en unidades menores.
 *
 * Se devuelve como texto porque viaja al checklist de cierre y de ahí a un
 * `jsonb`. Un `bigint` no sobrevive a `JSON.stringify`, y convertirlo a `number`
 * en el camino sería reintroducir el flotante por la puerta de atrás.
 */
export function diferenciaEnMenor(balance: BalanceDeSumasYSaldos): string {
  return (balance.totalDebitos.amount - balance.totalCreditos.amount).toString();
}
