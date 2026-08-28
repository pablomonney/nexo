/**
 * Cierre y apertura de ejercicio — la aritmética, sin base de datos.
 *
 * Tres funciones puras que reciben saldos y devuelven líneas de asiento. No
 * conocen PostgreSQL, no leen la hora y no deciden si el ejercicio *puede*
 * cerrarse: eso lo decide `evaluarChecklist` en `periods.ts` y lo verifica la
 * ruta. Acá solo vive **qué asiento corresponde** una vez que se decidió cerrar.
 *
 * ## Por qué dos asientos y no uno
 *
 * Cerrar un ejercicio son dos actos distintos:
 *
 *   1. **Refundición.** Las cuentas de resultado se cancelan contra la cuenta de
 *      Resultado del ejercicio. Después de esto, ningún ingreso ni gasto tiene
 *      saldo, y el resultado del período está en una sola cuenta patrimonial.
 *   2. **Cierre.** Lo que queda —lo patrimonial— se cancela también, y el
 *      ejercicio termina con todas las cuentas en cero.
 *
 * Juntarlos en un asiento obligaría a que la cuenta de resultado aparezca dos
 * veces, acreditada por la refundición y debitada por el cierre, con un viaje de
 * ida y vuelta que no explica nada. Separados, cada uno se lee solo.
 *
 * ## Por qué el cierre cancela también lo patrimonial
 *
 * Porque si no, la apertura del ejercicio siguiente **contaría dos veces**. Los
 * saldos de arrastre salen de sumar todos los movimientos anteriores a la fecha
 * (`saldosAnterioresA` en la ruta de libros); si el ejercicio N terminara con
 * Caja en 1710 y el asiento de apertura de N+1 volviera a debitar 1710, el saldo
 * inicial de N+1 sería 3420.
 *
 * El par cierre/apertura es lo que hace que esa suma acumulada siga siendo
 * cierta a través del corte: el cierre lleva todo a cero, la apertura vuelve a
 * poner lo patrimonial, y lo de resultado —que no vuelve— es exactamente lo que
 * no debe arrastrarse.
 *
 * ## Qué cuenta recibe el resultado
 *
 * Ninguna que este archivo elija. `planificarCierre` la recibe como dato; quien
 * la resuelve es la ruta, leyendo `accounts.closing_role`, y si la empresa no
 * designó ninguna el cierre se rechaza con `E_RESULT_ACCOUNT_MISSING`. Deducirla
 * —la primera PN, la que se llame «Resultado»— sería inventar contabilidad
 * ajena.
 */

import type { AccountingError, Currency, Money } from '@aai/shared';
import { accountingError, add, isZero, money, negate, subtract, zero } from '@aai/shared';

export type TipoDeCuenta = 'ACTIVO' | 'PASIVO' | 'PN' | 'INGRESO' | 'COSTO' | 'GASTO' | 'ORDEN';

/**
 * Las que se refunden. Sale del `type` de `accounts`, que es el modelo técnico
 * que ya existe: no se agrega ninguna clasificación nueva ni se afirma que esta
 * partición tenga origen normativo.
 */
const TIPOS_DE_RESULTADO: readonly TipoDeCuenta[] = ['INGRESO', 'COSTO', 'GASTO'];

/**
 * Las que se arrastran. `ORDEN` va acá: las cuentas de orden no son resultado, y
 * se compensan entre sí, así que atraviesan el cierre y la apertura sin alterar
 * ningún total.
 */
const TIPOS_PATRIMONIALES: readonly TipoDeCuenta[] = ['ACTIVO', 'PASIVO', 'PN', 'ORDEN'];

export function esDeResultado(tipo: TipoDeCuenta): boolean {
  return TIPOS_DE_RESULTADO.includes(tipo);
}

export interface SaldoDeCuenta {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: TipoDeCuenta;
  /** Positivo = deudor, negativo = acreedor. Misma convención que el Mayor. */
  readonly saldo: Money;
}

export interface LineaDeCierre {
  readonly accountId: string;
  readonly accountCode: string;
  readonly debit: Money;
  readonly credit: Money;
  readonly description: string;
}

export interface PlanDeCierre {
  /** Resultado del ejercicio. Positivo = ganancia, negativo = pérdida. */
  readonly resultado: Money;
  readonly ingresos: Money;
  readonly gastos: Money;
  /** Vacío si el ejercicio no tuvo movimientos de resultado. */
  readonly refundicion: readonly LineaDeCierre[];
  /**
   * Saldos patrimoniales **después** de la refundición, sin los que quedaron en
   * cero. Es lo que se archiva en el cierre y de lo que después nace la
   * apertura.
   */
  readonly saldosFinales: readonly SaldoDeCuenta[];
  /** Vacío si no quedó nada patrimonial que cancelar. */
  readonly cierre: readonly LineaDeCierre[];
}

export type ResultadoDelPlan<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly AccountingError[] };

/**
 * Arma los dos asientos del cierre a partir de los saldos del ejercicio.
 *
 * `saldos` son los acumulados hasta la fecha de cierre inclusive, de todas las
 * cuentas de la empresa. Se espera que sumen cero: si no, el Mayor está roto y
 * cerrar sobre él fijaría el error para siempre.
 */
export function planificarCierre(
  saldos: readonly SaldoDeCuenta[],
  cuentaResultado: { readonly accountId: string; readonly code: string },
  moneda: Currency,
): ResultadoDelPlan<PlanDeCierre> {
  const errors: AccountingError[] = [];

  const total = saldos.reduce((acc, s) => add(acc, s.saldo), zero(moneda));
  if (!isZero(total)) {
    // No se corrige: se informa. Un cierre que ajusta para cuadrar deja de ser
    // un cierre y pasa a ser una invención.
    errors.push(
      accountingError(
        'E_UNBALANCED',
        `Los saldos del ejercicio no suman cero (diferencia de ${total.amount} en unidades menores). ` +
          'El Mayor está descuadrado: cerrar sobre él fijaría el error.',
        { details: { diferenciaEnMenor: total.amount.toString() } },
      ),
    );
  }

  const deResultado = saldos.filter((s) => esDeResultado(s.type));
  const patrimoniales = saldos.filter((s) => TIPOS_PATRIMONIALES.includes(s.type));

  if (deResultado.length + patrimoniales.length !== saldos.length) {
    errors.push(
      accountingError(
        'E_ACCOUNT_NOT_POSTABLE',
        'Hay cuentas cuyo tipo no cae ni en resultado ni en patrimonial. El cierre no las sabe tratar.',
      ),
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // Ingresos y gastos, expuestos por separado porque el cierre tiene que poder
  // responder cómo llegó al resultado, no solo cuál fue.
  const ingresos = negate(
    deResultado.filter((s) => s.type === 'INGRESO').reduce((acc, s) => add(acc, s.saldo), zero(moneda)),
  );
  const gastos = deResultado
    .filter((s) => s.type !== 'INGRESO')
    .reduce((acc, s) => add(acc, s.saldo), zero(moneda));

  // Ingresos − gastos, pero derivado de los saldos y no de las dos variables de
  // arriba: si una cuenta de ingresos quedara deudora, la resta directa la
  // trataría bien y el par ingresos/gastos solo la describe.
  const resultado = negate(deResultado.reduce((acc, s) => add(acc, s.saldo), zero(moneda)));

  const refundicion = cancelar(deResultado, 'Refundición de resultados');
  if (refundicion.length > 0 && !isZero(resultado)) {
    // La contrapartida: la ganancia se acredita en la cuenta de resultado, la
    // pérdida se debita.
    refundicion.push(linea(cuentaResultado.accountId, cuentaResultado.code, negate(resultado), 'Resultado del ejercicio'));
  }

  // La cuenta de resultado puede no venir en `saldos`: si nunca se movió, no
  // tiene saldo que informar. Aun así es donde acaba de caer el resultado del
  // ejercicio, así que se la agrega. Sin esto, el primer cierre de una empresa
  // —cuenta de resultado recién creada, saldo cero— perdía el resultado entero y
  // el asiento de cierre no cuadraba.
  const conResultado: SaldoDeCuenta[] = patrimoniales.some(
    (s) => s.accountId === cuentaResultado.accountId,
  )
    ? patrimoniales.map((s) =>
        s.accountId === cuentaResultado.accountId
          ? { ...s, saldo: subtract(s.saldo, resultado) }
          : s,
      )
    : [
        ...patrimoniales,
        {
          accountId: cuentaResultado.accountId,
          code: cuentaResultado.code,
          name: 'Resultado del ejercicio',
          type: 'PN' as const,
          saldo: negate(resultado),
        },
      ];

  const saldosFinales = conResultado.filter((s) => !isZero(s.saldo));

  return {
    ok: true,
    value: {
      resultado,
      ingresos,
      gastos,
      refundicion,
      saldosFinales,
      cierre: cancelar(saldosFinales, 'Cierre del ejercicio'),
    },
  };
}

/**
 * El asiento de apertura: los saldos finales del cierre anterior, del mismo lado
 * en que estaban.
 *
 * Recibe los saldos **archivados por el cierre**, no unos recalculados. Es la
 * diferencia entre poder demostrar `CIERRE N → SALDOS FINALES → APERTURA N+1` y
 * tener dos números que casualmente coinciden.
 */
export function planificarApertura(
  saldosFinales: readonly SaldoDeCuenta[],
  moneda: Currency,
): ResultadoDelPlan<readonly LineaDeCierre[]> {
  const errors: AccountingError[] = [];

  const arrastradasDeResultado = saldosFinales.filter((s) => esDeResultado(s.type));
  if (arrastradasDeResultado.length > 0) {
    // El error que este archivo existe para hacer imposible. Arrastrar un
    // ingreso al ejercicio siguiente lo cuenta dos veces en el resultado: una en
    // el ejercicio en que ocurrió y otra en el que empieza.
    errors.push(
      accountingError(
        'E_ACCOUNT_NOT_POSTABLE',
        `La apertura no traslada cuentas de resultado: ${arrastradasDeResultado
          .map((s) => s.code)
          .join(', ')}. Su saldo se refunde al cerrar y no cruza al ejercicio siguiente.`,
        { details: { cuentas: arrastradasDeResultado.map((s) => s.code) } },
      ),
    );
  }

  const total = saldosFinales.reduce((acc, s) => add(acc, s.saldo), zero(moneda));
  if (!isZero(total)) {
    errors.push(
      accountingError(
        'E_UNBALANCED',
        `Los saldos de apertura no suman cero (diferencia de ${total.amount} en unidades menores).`,
        { details: { diferenciaEnMenor: total.amount.toString() } },
      ),
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  // Mismo lado que el saldo: lo deudor se debita, lo acreedor se acredita. Es la
  // imagen espejo del cierre, que los pone del lado contrario.
  const lineas = saldosFinales
    .filter((s) => !isZero(s.saldo))
    .map((s) => linea(s.accountId, s.code, s.saldo, 'Apertura del ejercicio'));

  return { ok: true, value: lineas };
}

/** Lleva cada saldo a cero poniéndolo del lado contrario. */
function cancelar(saldos: readonly SaldoDeCuenta[], descripcion: string): LineaDeCierre[] {
  return saldos
    .filter((s) => !isZero(s.saldo))
    .map((s) => linea(s.accountId, s.code, negate(s.saldo), `${descripcion} — ${s.code}`));
}

/**
 * Una línea a partir de un importe con signo: positivo al Debe, negativo al
 * Haber.
 *
 * Un solo lugar donde se decide el lado. Repartir esa decisión entre el cierre y
 * la apertura fue el primer camino y duraba hasta el primer signo invertido.
 */
function linea(
  accountId: string,
  accountCode: string,
  importe: Money,
  description: string,
): LineaDeCierre {
  const cero = zero(importe.currency);
  return importe.amount >= 0n
    ? { accountId, accountCode, debit: importe, credit: cero, description }
    : { accountId, accountCode, debit: cero, credit: money(-importe.amount, importe.currency), description };
}
