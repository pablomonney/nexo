/**
 * accounting-engine — motor contable determinístico.
 *
 * Este archivo solo DEFINE. `index.ts` solo reexporta: un barril que además
 * define crea un ciclo en cuanto un módulo importa sus tipos de él.
 *
 * Este paquete no usa IA, no llama a la red y no lee archivos. Recibe un borrador
 * de asiento ya resuelto y decide si puede existir. Esa superficie chica es lo que
 * permite testearlo de forma exhaustiva.
 */

import type { CalendarDate, Currency, Money, Result } from '@aai/shared';
import type { AccountingError } from '@aai/shared';

export type JournalCode =
  | 'GENERAL'
  | 'COMPRAS'
  | 'VENTAS'
  | 'BANCOS'
  | 'CAJA'
  | 'SUELDOS'
  | 'AJUSTES'
  | 'CIERRE'
  | 'APERTURA';

export type EntryKind = 'NORMAL' | 'AJUSTE' | 'APERTURA' | 'CIERRE' | 'REVERSION';

export interface FxDetail {
  readonly rate: { readonly numerator: bigint; readonly denominator: bigint };
  readonly source: string;
  readonly date: CalendarDate;
}

export interface JournalEntryLineDraft {
  readonly accountCode: string;
  readonly debit: Money;
  readonly credit: Money;
  readonly currency: Currency;
  readonly fx?: FxDetail;
  readonly costCenterCode?: string;
  readonly partyId?: string;
  readonly description?: string;
  /**
   * Vínculo con la operación fiscal que origina esta línea.
   *
   * Obligatorio cuando la cuenta tiene rol fiscal (E_TAX_LINK_MISSING): un IVA
   * crédito fiscal sin la operación detrás no se puede llevar al Libro de IVA
   * ni defender en una fiscalización.
   */
  readonly taxTransactionId?: string;
}

export interface RuleApplicationRef {
  readonly ruleKey: string;
  readonly ruleVersion: number;
  readonly normVersionId: string;
}

export interface JournalEntryDraft {
  readonly companyId: string;
  readonly journalCode: JournalCode;
  readonly entryDate: CalendarDate;
  readonly description: string;
  readonly kind: EntryKind;
  readonly currency: Currency;
  readonly lines: readonly JournalEntryLineDraft[];
  readonly source: {
    readonly type: 'INVOICE' | 'RECEIPT' | 'BANK' | 'MANUAL' | 'CLOSING';
    readonly id: string | null;
  };
  /**
   * Trazabilidad normativa. Si está vacío, hace falta `manualJustification`
   * firmada: un asiento sin origen demostrable no se postea (E_NO_TRACEABILITY).
   */
  readonly ruleApplications: readonly RuleApplicationRef[];
  readonly manualJustification?: string;
  readonly actor: { readonly userId: string; readonly onBehalfOfAi?: string };
}

export interface PostedJournalEntry {
  readonly id: string;
  readonly entryNumber: number;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
}

export type PostResult = Result<PostedJournalEntry, AccountingError[]>;
