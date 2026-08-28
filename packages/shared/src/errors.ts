/**
 * Errores tipados del dominio.
 *
 * Los códigos de `AccountingErrorCode` son exactamente los de ACCOUNTING_ENGINE.md §2.
 * Si se agrega una validación al motor, se agrega acá y se documenta allá — no hay
 * errores anónimos con string suelto.
 */

export type AccountingErrorCode =
  | 'E_MIN_LINES'
  | 'E_LINE_SIDE'
  | 'E_UNBALANCED'
  | 'E_ACCOUNT_NOT_POSTABLE'
  | 'E_PERIOD_CLOSED'
  | 'E_DATE_OUT_OF_PERIOD'
  | 'E_MISSING_DIMENSION'
  | 'E_MISSING_FX'
  | 'E_TAX_LINK_MISSING'
  | 'E_NO_TRACEABILITY'
  /**
   * Se citó una decisión contable que el contexto no pudo resolver: no existe,
   * es de otra empresa, es de ambiente PRUEBA o corresponde a otro comprobante.
   *
   * Es distinto de E_NO_TRACEABILITY —'no citaste nada'— y merece su propio
   * código: 'citaste algo que no está' manda a revisar otra cosa.
   */
  | 'E_DECISION_NOT_FOUND'
  | 'E_DUPLICATE_SOURCE'
  /**
   * El ejercicio no está en el estado que la operación pedida requiere.
   *
   * Cubre las cuatro formas de la misma equivocación —cerrar uno ya cerrado,
   * cerrar uno que nunca pasó por pre-cierre, pre-cerrar uno en cierre, abrir
   * sobre un ejercicio que sigue abierto—, y el mensaje dice cuál de las cuatro
   * es. Separarlas en cuatro códigos no le daría a quien recibe el error ninguna
   * decisión distinta: en los cuatro casos mira el estado y actúa.
   */
  | 'E_FISCAL_YEAR_STATE'
  /**
   * El checklist de cierre tiene ítems bloqueantes sin cumplir.
   *
   * Los ítems viajan en `details`. El sistema NO los arregla: un cierre que
   * acomoda los datos para poder cerrar no es un cierre.
   */
  | 'E_CLOSURE_BLOCKED'
  /**
   * La empresa no designó qué cuenta recibe el resultado del ejercicio.
   *
   * Es su propio código porque no es un dato faltante más: elegir esa cuenta es
   * una decisión del profesional sobre su plan de cuentas, y el sistema no la
   * puede adivinar sin inventar contabilidad. Se marca con
   * `accounts.closing_role`.
   */
  | 'E_RESULT_ACCOUNT_MISSING'
  /**
   * Se pidió la apertura de un ejercicio cuyo anterior no está cerrado, o cuyo
   * cierre no dejó saldos archivados.
   *
   * La apertura no se calcula de nuevo: se deriva de los saldos que el cierre
   * archivó. Sin ese cierre no hay de dónde derivarla.
   */
  | 'E_OPENING_WITHOUT_CLOSURE';

export type NormativeErrorCode =
  /** No hay norma relevada para el caso. Nunca se infiere una. */
  | 'FUENTE_NO_ENCONTRADA'
  /** Más de una regla aplicable de igual prioridad sin derogación declarada. */
  | 'CONFLICTO_NORMATIVO'
  /** La norma existe pero no está en nivel V1: no puede fundar una regla activa. */
  | 'FUENTE_NO_VERIFICADA'
  /** La jurisdicción no tiene cargado el acto de adopción de la norma profesional. */
  | 'ADOPCION_NO_RELEVADA';

export interface DomainError<C extends string> {
  readonly code: C;
  readonly message: string;
  /** Dónde ocurrió: número de línea del asiento, id de cuenta, etc. */
  readonly at?: string;
  /** Datos para que la UI pueda explicar el error sin re-derivarlo. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export type AccountingError = DomainError<AccountingErrorCode>;
export type NormativeError = DomainError<NormativeErrorCode>;

export function accountingError(
  code: AccountingErrorCode,
  message: string,
  extra: { at?: string; details?: Readonly<Record<string, unknown>> } = {},
): AccountingError {
  return { code, message, ...extra };
}

export function normativeError(
  code: NormativeErrorCode,
  message: string,
  extra: { at?: string; details?: Readonly<Record<string, unknown>> } = {},
): NormativeError {
  return { code, message, ...extra };
}

/**
 * Mensajes que el sistema muestra al usuario cuando no sabe.
 * Están acá, en un solo lugar, porque el §30 y el §52 exigen que sean literales y
 * estables — no sinónimos suaves que cada pantalla redacte a su gusto.
 */
export const ABSTENTION_MESSAGES = {
  FUENTE_NO_ENCONTRADA: 'FUENTE NO ENCONTRADA',
  CONFLICTO_NORMATIVO: 'CONFLICTO NORMATIVO — REQUIERE REVISIÓN',
  NO_VERIFICABLE: 'NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE',
  SIN_INFORMACION: 'NO HAY INFORMACIÓN SUFICIENTE',
  BLOQUEADO: 'BLOQUEADO — requiere intervención profesional',
} as const;
