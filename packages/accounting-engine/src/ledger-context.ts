/**
 * El estado del libro que el motor necesita para decidir.
 *
 * Todo llega resuelto: cuentas, períodos, ejercicios, qué comprobantes ya se
 * postearon. El motor no consulta nada. Esa restricción es lo que permite
 * probarlo de forma exhaustiva —cada caso es un objeto literal— y lo que hace
 * que su comportamiento no dependa del estado de una conexión.
 *
 * La contrapartida es que quien arma este contexto tiene que traer lo
 * suficiente. Si trae de menos, el motor rechaza; nunca completa lo que falta.
 */

import type { CalendarDate, Currency, RoundingMode } from '@aai/shared';

export interface AccountSnapshot {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: 'ACTIVO' | 'PASIVO' | 'PN' | 'INGRESO' | 'COSTO' | 'GASTO' | 'ORDEN';
  readonly nature: 'DEUDORA' | 'ACREEDORA';
  readonly isPostable: boolean;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly currency: Currency;
  /** `IVA_CF`, `IVA_DF`, `PERCEPCION`, … cuando la cuenta tiene efecto fiscal. */
  readonly taxRole: string | null;
  readonly requiresCostCenter: boolean;
  readonly requiresThirdParty: boolean;
}

export type PeriodStatus = 'ABIERTO' | 'BLOQUEADO' | 'CERRADO';

export interface PeriodSnapshot {
  readonly id: string;
  readonly fiscalYearId: string;
  readonly number: number;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
  readonly status: PeriodStatus;
}

export interface FiscalYearSnapshot {
  readonly id: string;
  readonly code: string;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
  readonly status: 'ABIERTO' | 'EN_CIERRE' | 'CERRADO';
}

/**
 * Una decisión contable que el contexto pudo resolver para este asiento.
 *
 * Lleva lo mínimo para que el motor decida y para que el error sea legible. No
 * trae los hechos ni la evidencia: el motor no los evalúa, y arrastrarlos lo
 * invitaría a hacerlo.
 */
export interface DecisionSnapshot {
  readonly id: string;
  readonly origen: 'DETERMINISTICA' | 'PROPUESTA_IA' | 'MANUAL';
  readonly resultado: string;
  /** Cuántas reglas la fundan. Cero es legítimo: una decisión manual no cita ninguna. */
  readonly reglasAplicadas: number;
}

export interface LedgerContext {
  readonly companyId: string;
  /** Moneda en la que se lleva la contabilidad. El balance se verifica en ella. */
  readonly accountingCurrency: Currency;
  readonly accounts: readonly AccountSnapshot[];
  readonly periods: readonly PeriodSnapshot[];
  readonly fiscalYears: readonly FiscalYearSnapshot[];
  /** Centros de costo existentes y activos, por código. */
  readonly costCenterCodes: readonly string[];
  /** `${type}:${id}` de los comprobantes que ya tienen un asiento vigente. */
  readonly postedSources: readonly string[];
  /**
   * Modo de redondeo para la conversión de moneda extranjera.
   *
   * No tiene valor por defecto a propósito (ADR-005): el criterio depende de la
   * norma aplicable a la operación, y quien postea tiene que poder citar de
   * dónde sale. Un default acá lo volvería invisible.
   */
  readonly fxRoundingMode: RoundingMode;
  /**
   * La decisión que funda el asiento, **ya resuelta y verificada**.
   *
   * Se entrega resuelta o no se entrega. El motor es puro y no puede comprobar
   * que un UUID exista, sea de esta empresa, no sea de ambiente PRUEBA y
   * corresponda al comprobante del asiento — todo eso lo hace quien arma el
   * contexto, que sí tiene la base.
   *
   * Es la misma inversión que el permiso de emisión y el candado del sandbox:
   * en vez de pasarle al dominio un dato para que desconfíe, se le pasa la
   * prueba o nada. Un `null` acá no significa "no la pude verificar": significa
   * que no hay decisión válida, y el motor actúa en consecuencia.
   */
  readonly decision?: DecisionSnapshot | null;
  /**
   * Rol de cierre: habilita postear en un período `BLOQUEADO`.
   *
   * Bloqueado no es cerrado. Bloqueado significa "solo los ajustes de cierre";
   * cerrado significa que no entra nada.
   */
  readonly actorCanPostToBlocked?: boolean;
}

export function accountByCode(
  context: LedgerContext,
  code: string,
): AccountSnapshot | undefined {
  return context.accounts.find((account) => account.code === code);
}

/** Período que contiene la fecha. Los períodos de una empresa no se solapan. */
export function periodFor(
  context: LedgerContext,
  date: CalendarDate,
): PeriodSnapshot | undefined {
  return context.periods.find(
    (period) => period.startDate <= date && date <= period.endDate,
  );
}

export function fiscalYearById(
  context: LedgerContext,
  id: string,
): FiscalYearSnapshot | undefined {
  return context.fiscalYears.find((year) => year.id === id);
}

export function sourceKey(type: string, id: string | null): string | null {
  return id === null ? null : `${type}:${id}`;
}
