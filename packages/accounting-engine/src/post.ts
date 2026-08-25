/**
 * Posteo: validación más asignación de número.
 *
 * El motor **no** asigna el número. Devuelve un asiento listo para numerar y el
 * repositorio le pone el número dentro de la transacción, con la fila del
 * contador tomada para actualización (`next_entry_number` en la migración 0004).
 *
 * La separación no es purismo. Un libro rubricado exige una secuencia sin
 * huecos, y eso solo lo puede garantizar quien controla la transacción: si el
 * motor devolviera "el número es el 47" y después la transacción hiciera
 * rollback, el 47 quedaría libre o duplicado según cómo se implemente. Por eso
 * acá vive la **regla** de numeración y allá la **mecánica**.
 */

import type { AccountingError } from '@aai/shared';
import type { JournalEntryDraft } from './contracts.js';
import type { LedgerContext } from './ledger-context.js';
import { validar, type AsientoValidado } from './validate.js';

export interface AsientoParaNumerar extends AsientoValidado {
  /** Clave del contador correlativo: por empresa, libro y ejercicio. */
  readonly claveNumeracion: {
    readonly companyId: string;
    readonly journalCode: string;
    readonly fiscalYearId: string;
  };
}

export type ResultadoPosteo =
  | { readonly ok: true; readonly value: AsientoParaNumerar }
  | { readonly ok: false; readonly errors: readonly AccountingError[] };

/**
 * Decide si el asiento puede existir.
 *
 * Devuelve `Result`, no lanza: un asiento rechazado produce una lista de errores
 * tipados, porque el destinatario es alguien que necesita saber qué corregir.
 */
export function prepararPosteo(
  draft: JournalEntryDraft,
  context: LedgerContext,
): ResultadoPosteo {
  const validado = validar(draft, context);
  if (!validado.ok) return { ok: false, errors: validado.errors };

  return {
    ok: true,
    value: {
      ...validado.value,
      claveNumeracion: {
        companyId: context.companyId,
        journalCode: draft.journalCode,
        fiscalYearId: validado.value.fiscalYearId,
      },
    },
  };
}

/**
 * La regla de numeración, aislada para poder probarla.
 *
 * Correlativa y sin huecos por `(empresa, libro, ejercicio)`. Un asiento anulado
 * **conserva su número**: el hueco en la secuencia sería peor que el asiento
 * anulado, porque un libro con saltos no se puede defender ante nadie.
 */
export function siguienteNumero(ultimoNumero: number): number {
  if (!Number.isInteger(ultimoNumero) || ultimoNumero < 0) {
    throw new RangeError('El último número de asiento tiene que ser un entero no negativo');
  }
  return ultimoNumero + 1;
}

