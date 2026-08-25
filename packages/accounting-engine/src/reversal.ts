/**
 * Contraasiento (§15, §38).
 *
 * Un asiento aprobado con error **no se edita ni se borra**: se contrapone. Los
 * dos quedan visibles, y esa es la diferencia entre un libro y una base de datos
 * con historial. El Libro Diario impreso tiene que poder reproducirse idéntico
 * años después; si las correcciones fueran reescrituras, no podría.
 *
 * La reversión intercambia Debe y Haber línea por línea. No "resta": eso dejaría
 * importes negativos, que un libro no admite —el signo lo da la columna—.
 */

import type { CalendarDate } from '@aai/shared';
import type { JournalEntryDraft, JournalEntryLineDraft } from './contracts.js';

export interface AsientoAAnular {
  readonly id: string;
  readonly companyId: string;
  readonly journalCode: JournalEntryDraft['journalCode'];
  readonly entryDate: CalendarDate;
  readonly description: string;
  readonly currency: JournalEntryDraft['currency'];
  readonly status: 'BORRADOR' | 'PROPUESTO' | 'APROBADO' | 'ANULADO';
  readonly lines: readonly JournalEntryLineDraft[];
  readonly source: JournalEntryDraft['source'];
}

export interface OpcionesReversion {
  /**
   * Fecha del contraasiento. Puede diferir de la del original: si el período del
   * original está cerrado, la corrección va a un período abierto.
   */
  readonly fecha: CalendarDate;
  readonly motivo: string;
  readonly actor: JournalEntryDraft['actor'];
}

export type ResultadoReversion =
  | { readonly ok: true; readonly draft: JournalEntryDraft }
  | { readonly ok: false; readonly motivo: string };

export function construirContraasiento(
  original: AsientoAAnular,
  opciones: OpcionesReversion,
): ResultadoReversion {
  if (original.status !== 'APROBADO') {
    // Un borrador o una propuesta todavía no son contabilidad: se editan. Un
    // contraasiento sobre algo que nunca se aprobó ensucia el libro con dos
    // asientos donde no debería haber ninguno.
    return {
      ok: false,
      motivo: `El asiento está en ${original.status}: se edita directamente, no se contrapone`,
    };
  }
  if (opciones.motivo.trim().length < 3) {
    return { ok: false, motivo: 'La anulación exige un motivo' };
  }

  const lines: JournalEntryLineDraft[] = original.lines.map((linea) => ({
    ...linea,
    // Intercambio, no resta: el signo lo da la columna.
    debit: linea.credit,
    credit: linea.debit,
    description: `Reversión: ${linea.description ?? ''}`.trim(),
  }));

  return {
    ok: true,
    draft: {
      companyId: original.companyId,
      journalCode: original.journalCode,
      entryDate: opciones.fecha,
      description: `Contraasiento de "${original.description}" — ${opciones.motivo}`,
      kind: 'REVERSION',
      currency: original.currency,
      lines,
      // El contraasiento NO hereda el `source.id` del original: si lo heredara,
      // el índice único de comprobante lo tomaría por un asiento duplicado del
      // mismo comprobante, que es justamente lo que no es.
      source: { type: original.source.type, id: null },
      // La traza del contraasiento es el asiento que anula más el motivo firmado.
      ruleApplications: [],
      manualJustification: `Anula el asiento ${original.id}. Motivo: ${opciones.motivo}`,
      actor: opciones.actor,
    },
  };
}
