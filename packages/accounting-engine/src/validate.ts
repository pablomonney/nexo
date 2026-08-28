/**
 * Las once validaciones del §2 de ACCOUNTING_ENGINE.md, en orden.
 *
 * Dos criterios que gobiernan este archivo:
 *
 * **Se acumulan todos los errores que se puedan determinar.** El destinatario es
 * un contador que necesita saber qué corregir, no descubrir un problema por vez.
 * Lo único que corta es una validación de la que dependen las siguientes: si una
 * cuenta no existe, no tiene sentido opinar sobre su centro de costo.
 *
 * **Ante una suma que no cierra, se rechaza; no se ajusta.** Un motor que mete
 * la diferencia en una cuenta de ajuste produce libros que siempre cuadran y
 * asientos que nadie revisó.
 *
 * La validación #3 —Debe = Haber— se verifica también por `CONSTRAINT TRIGGER`
 * diferido en PostgreSQL. La redundancia es deliberada: el invariante más
 * importante del sistema no puede depender de que la aplicación no tenga bugs.
 */

import type { AccountingError, CalendarDate, Money } from '@aai/shared';
import { accountingError, add, convert, formatAr, isZero, money, zero } from '@aai/shared';
import type { JournalEntryDraft, JournalEntryLineDraft } from './contracts.js';
import type { AccountSnapshot, LedgerContext } from './ledger-context.js';
import { accountByCode, fiscalYearById, periodFor, sourceKey } from './ledger-context.js';

export interface LineaResuelta {
  /** `line_no` en la base: 1-based y estable. */
  readonly lineNo: number;
  readonly draft: JournalEntryLineDraft;
  readonly account: AccountSnapshot;
  /** Importes llevados a la moneda de la contabilidad. */
  readonly debit: Money;
  readonly credit: Money;
}

export interface AsientoValidado {
  readonly draft: JournalEntryDraft;
  readonly periodId: string;
  readonly fiscalYearId: string;
  readonly lines: readonly LineaResuelta[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
}

export type ResultadoValidacion =
  | { readonly ok: true; readonly value: AsientoValidado }
  | { readonly ok: false; readonly errors: readonly AccountingError[] };

export function validar(draft: JournalEntryDraft, context: LedgerContext): ResultadoValidacion {
  const errors: AccountingError[] = [];

  // --- 1. Al menos dos líneas ---------------------------------------------
  if (draft.lines.length < 2) {
    errors.push(
      accountingError(
        'E_MIN_LINES',
        `El asiento tiene ${draft.lines.length} línea(s); la partida doble requiere al menos 2`,
      ),
    );
    // Sin líneas no hay nada más que evaluar sobre ellas.
    return { ok: false, errors };
  }

  // --- 2. Cada línea es débito o crédito, con importe positivo -------------
  // --- 4. Las cuentas existen, están activas y son imputables --------------
  const resueltas: LineaResuelta[] = [];
  draft.lines.forEach((linea, indice) => {
    const lineNo = indice + 1;
    const at = `línea ${lineNo}`;

    const problemaDeLado = validarLado(linea, at);
    if (problemaDeLado !== null) {
      // La línea no se resuelve. Seguir con ella arrastraría importes en una
      // moneda que la línea no declara, y la suma final rompería en vez de
      // devolver un error accionable.
      errors.push(problemaDeLado);
      return;
    }

    const account = accountByCode(context, linea.accountCode);
    if (account === undefined) {
      errors.push(
        accountingError('E_ACCOUNT_NOT_POSTABLE', `La cuenta ${linea.accountCode} no existe en el plan`, { at }),
      );
      return;
    }
    if (account.status !== 'ACTIVE') {
      errors.push(
        accountingError('E_ACCOUNT_NOT_POSTABLE', `La cuenta ${account.code} está archivada`, { at }),
      );
      return;
    }
    if (!account.isPostable) {
      errors.push(
        accountingError(
          'E_ACCOUNT_NOT_POSTABLE',
          `${account.code} ${account.name} es una cuenta de agrupación: no admite imputación directa`,
          { at },
        ),
      );
      return;
    }

    // --- 7. Dimensiones obligatorias -------------------------------------
    if (account.requiresCostCenter && vacio(linea.costCenterCode)) {
      errors.push(
        accountingError('E_MISSING_DIMENSION', `${account.code} exige centro de costo`, { at }),
      );
    } else if (
      linea.costCenterCode !== undefined &&
      !context.costCenterCodes.includes(linea.costCenterCode)
    ) {
      errors.push(
        accountingError(
          'E_MISSING_DIMENSION',
          `El centro de costo ${linea.costCenterCode} no existe en esta empresa`,
          { at },
        ),
      );
    }
    if (account.requiresThirdParty && vacio(linea.partyId)) {
      errors.push(
        accountingError('E_MISSING_DIMENSION', `${account.code} exige identificar al tercero`, { at }),
      );
    }

    // --- 9. Toda línea con efecto fiscal tiene su operación fiscal --------
    if (account.taxRole !== null && vacio(linea.taxTransactionId)) {
      errors.push(
        accountingError(
          'E_TAX_LINK_MISSING',
          `${account.code} tiene rol fiscal ${account.taxRole} y la línea no referencia una operación fiscal`,
          { at },
        ),
      );
    }

    // --- 8. Moneda extranjera con cotización completa ---------------------
    const convertida = convertir(linea, context, draft.entryDate, at);
    if ('error' in convertida) {
      errors.push(convertida.error);
      return;
    }

    resueltas.push({
      lineNo,
      draft: linea,
      account,
      debit: convertida.debit,
      credit: convertida.credit,
    });
  });

  // --- 3. Σ débitos = Σ créditos, en la moneda de la contabilidad ----------
  const totalDebit = resueltas.reduce(
    (acumulado, linea) => add(acumulado, linea.debit),
    zero(context.accountingCurrency),
  );
  const totalCredit = resueltas.reduce(
    (acumulado, linea) => add(acumulado, linea.credit),
    zero(context.accountingCurrency),
  );

  // Solo tiene sentido si todas las líneas se pudieron resolver: una suma a la
  // que le faltan líneas nunca va a cerrar, y el error sería una consecuencia
  // del anterior, no un problema nuevo.
  if (resueltas.length === draft.lines.length && totalDebit.amount !== totalCredit.amount) {
    errors.push(
      accountingError(
        'E_UNBALANCED',
        `Debe ${formatAr(totalDebit)} ≠ Haber ${formatAr(totalCredit)} ` +
          `(diferencia ${formatAr(money(totalDebit.amount - totalCredit.amount, totalDebit.currency))}). ` +
          'El motor no ajusta la diferencia: la corrección es una decisión contable.',
      ),
    );
  }

  if (resueltas.length === draft.lines.length && isZero(totalDebit) && isZero(totalCredit)) {
    errors.push(
      accountingError('E_UNBALANCED', 'El asiento suma cero en ambas columnas: no registra nada'),
    );
  }

  // --- 5 y 6. Período abierto y fecha dentro del ejercicio -----------------
  const period = periodFor(context, draft.entryDate);
  let periodId = '';
  let fiscalYearId = '';

  if (period === undefined) {
    errors.push(
      accountingError(
        'E_DATE_OUT_OF_PERIOD',
        `La fecha ${draft.entryDate} no cae en ningún período de esta empresa`,
      ),
    );
  } else {
    periodId = period.id;
    fiscalYearId = period.fiscalYearId;

    if (period.status === 'CERRADO') {
      errors.push(
        accountingError(
          'E_PERIOD_CLOSED',
          `El período ${period.number} está cerrado. Corregir exige un ajuste en período abierto o la reapertura formal.`,
        ),
      );
    } else if (period.status === 'BLOQUEADO' && context.actorCanPostToBlocked !== true) {
      errors.push(
        accountingError(
          'E_PERIOD_CLOSED',
          `El período ${period.number} está bloqueado: solo admite asientos de cierre`,
        ),
      );
    }

    const year = fiscalYearById(context, period.fiscalYearId);
    if (year === undefined) {
      errors.push(
        accountingError('E_DATE_OUT_OF_PERIOD', 'El período no pertenece a ningún ejercicio conocido'),
      );
    } else if (draft.entryDate < year.startDate || draft.entryDate > year.endDate) {
      // El período y el ejercicio deberían ser coherentes, pero si no lo son
      // manda el ejercicio: es el que define el libro y la numeración.
      errors.push(
        accountingError(
          'E_DATE_OUT_OF_PERIOD',
          `La fecha ${draft.entryDate} está fuera del ejercicio ${year.code} (${year.startDate} a ${year.endDate})`,
        ),
      );
    } else if (year.status === 'CERRADO') {
      errors.push(
        accountingError('E_PERIOD_CLOSED', `El ejercicio ${year.code} está cerrado`),
      );
    }
  }

  // --- 10. Trazabilidad: regla aplicada, justificación firmada o decisión ---
  //
  // Tres vías, y la tercera se agregó cuando el circuito
  // `comprobante → decisión → asiento` empezó a producir asientos cuya razón
  // vive en `accounting_decisions`. Antes había que repetir la justificación en
  // el asiento **solo para conformar a este control**, y una explicación
  // duplicada es una que se desincroniza.
  //
  // El motor no valida el UUID: compara lo que el llamador pidió contra lo que
  // el contexto pudo resolver. Un `decisionId` pedido que no aparece resuelto no
  // es un asiento sin trazabilidad —es un asiento que cita algo que no está—, y
  // esa diferencia manda a revisar cosas distintas.
  const decisionPedida = draft.decisionId;
  const decisionResuelta = context.decision ?? null;

  if (decisionPedida !== undefined && decisionResuelta?.id !== decisionPedida) {
    errors.push(
      accountingError(
        'E_DECISION_NOT_FOUND',
        `El asiento cita la decisión ${decisionPedida}, que no se pudo resolver para esta ` +
          'operación. Puede no existir, ser de otra empresa, ser de ambiente PRUEBA, o ' +
          'corresponder a otro comprobante.',
      ),
    );
  }

  const tieneDecision = decisionPedida !== undefined && decisionResuelta?.id === decisionPedida;

  if (draft.ruleApplications.length === 0 && vacio(draft.manualJustification) && !tieneDecision) {
    errors.push(
      accountingError(
        'E_NO_TRACEABILITY',
        'El asiento no cita ninguna regla aplicada, ni trae justificación manual, ni se apoya ' +
          'en una decisión contable. Un asiento sin origen demostrable no se postea, ni ' +
          'siquiera a mano (§24).',
      ),
    );
  }

  // --- 11. El comprobante no tiene ya un asiento vigente -------------------
  const clave = sourceKey(draft.source.type, draft.source.id);
  if (clave !== null && context.postedSources.includes(clave)) {
    errors.push(
      accountingError(
        'E_DUPLICATE_SOURCE',
        `El comprobante ${clave} ya tiene un asiento vigente. Para corregirlo, contraasiento.`,
      ),
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { draft, periodId, fiscalYearId, lines: resueltas, totalDebit, totalCredit },
  };
}

// ---------------------------------------------------------------------------

function validarLado(linea: JournalEntryLineDraft, at: string): AccountingError | null {
  const debe = linea.debit.amount;
  const haber = linea.credit.amount;

  if (debe < 0n || haber < 0n) {
    return accountingError(
      'E_LINE_SIDE',
      'Los importes de una línea no pueden ser negativos: el signo lo da la columna',
      { at },
    );
  }
  if (debe > 0n && haber > 0n) {
    return accountingError('E_LINE_SIDE', 'Una línea es débito o crédito, no las dos cosas', { at });
  }
  if (debe === 0n && haber === 0n) {
    return accountingError('E_LINE_SIDE', 'Una línea sin importe no registra nada', { at });
  }
  if (linea.debit.currency !== linea.currency || linea.credit.currency !== linea.currency) {
    return accountingError(
      'E_LINE_SIDE',
      `La línea declara moneda ${linea.currency} y sus importes están en ` +
        `${linea.debit.currency}/${linea.credit.currency}`,
      { at },
    );
  }
  return null;
}

type Convertida = { debit: Money; credit: Money } | { error: AccountingError };

/**
 * Lleva la línea a la moneda de la contabilidad.
 *
 * La cotización se guarda con fuente y fecha porque la RG ARCA 5616/2024 exige
 * consignar el tipo de cambio: un `rate` suelto no es auditable. Y una
 * cotización posterior a la fecha del asiento tampoco sirve — es la de un día
 * que, cuando la operación ocurrió, todavía no existía.
 */
function convertir(
  linea: JournalEntryLineDraft,
  context: LedgerContext,
  entryDate: CalendarDate,
  at: string,
): Convertida {
  if (linea.currency === context.accountingCurrency) {
    return { debit: linea.debit, credit: linea.credit };
  }

  const fx = linea.fx;
  if (fx === undefined) {
    return {
      error: accountingError(
        'E_MISSING_FX',
        `La línea está en ${linea.currency} y no trae cotización a ${context.accountingCurrency}`,
        { at },
      ),
    };
  }
  if (vacio(fx.source)) {
    return {
      error: accountingError(
        'E_MISSING_FX',
        'La cotización no declara fuente. Sin fuente no es auditable (RG 5616/2024)',
        { at },
      ),
    };
  }
  if (fx.rate.numerator <= 0n || fx.rate.denominator <= 0n) {
    return {
      error: accountingError('E_MISSING_FX', 'La cotización tiene que ser positiva', { at }),
    };
  }
  if (fx.date > entryDate) {
    return {
      error: accountingError(
        'E_MISSING_FX',
        `La cotización es del ${fx.date} y el asiento del ${entryDate}: ` +
          'no se puede valuar una operación con una cotización posterior',
        { at },
      ),
    };
  }

  return {
    debit: convert(linea.debit, context.accountingCurrency, fx.rate, context.fxRoundingMode),
    credit: convert(linea.credit, context.accountingCurrency, fx.rate, context.fxRoundingMode),
  };
}

function vacio(valor: string | undefined): boolean {
  return valor === undefined || valor.trim().length === 0;
}

