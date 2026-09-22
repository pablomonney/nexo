/**
 * La red de `POST /journal-entries`: una carrera no sale como 500.
 *
 * ## Por qué esto se prueba acá y no contra la base
 *
 * Porque el caso secuencial ya lo cubre `journal-entries-api.test.ts` — dos
 * POST uno detrás del otro sobre el mismo comprobante, el segundo 422 con
 * `E_DUPLICATE_SOURCE`, resuelto por `armarContexto`/`prepararPosteo` antes de
 * llegar a ningún INSERT. Lo que este archivo protege es la rama que ese test
 * no puede alcanzar: la constraint de base disparando por una carrera real
 * (dos pedidos casi simultáneos, ninguno ve todavía el commit del otro), y que
 * esa constraint específica —y solo ella— se traduzca a un 409 legible.
 *
 * Forzar esa carrera de verdad contra Postgres sería un test intermitente por
 * diseño. Lo que sí se puede fijar de forma determinística es la regla que
 * decide la traducción: el nombre de la constraint, no el código 23505 solo
 * —que además dispara con la restricción de numeración del asiento y con
 * cualquier otra violación de unicidad futura, ninguna de las cuales es "este
 * comprobante ya tiene un asiento".
 */

import { describe, expect, it } from 'vitest';
import { esConflictoDeFuenteDuplicada } from '@aai/api/routes/journal-entries';

describe('esConflictoDeFuenteDuplicada', () => {
  it('reconoce la violación de journal_entries_unique_source', () => {
    expect(
      esConflictoDeFuenteDuplicada({ code: '23505', constraint: 'journal_entries_unique_source' }),
    ).toBe(true);
  });

  it('no confunde otra violación de unicidad con un comprobante duplicado', () => {
    // La misma tabla tiene una segunda UNIQUE (company_id, journal_code,
    // fiscal_year_id, entry_number) — no es este caso, y convertirla en 409
    // ocultaría un problema de numeración detrás de un mensaje que no aplica.
    expect(
      esConflictoDeFuenteDuplicada({
        code: '23505',
        constraint: 'journal_entries_company_id_journal_code_fiscal_year_id_entry__key',
      }),
    ).toBe(false);
  });

  it('no confunde un 23505 sin nombre de constraint', () => {
    expect(esConflictoDeFuenteDuplicada({ code: '23505' })).toBe(false);
  });

  it('no confunde un error de otra clase que sea 23505 por accidente en otro código', () => {
    expect(
      esConflictoDeFuenteDuplicada({ code: '23503', constraint: 'journal_entries_unique_source' }),
    ).toBe(false);
  });

  it('no se cae con un error que no trae forma de error de Postgres', () => {
    expect(esConflictoDeFuenteDuplicada(new Error('boom'))).toBe(false);
    expect(esConflictoDeFuenteDuplicada('boom')).toBe(false);
    expect(esConflictoDeFuenteDuplicada(null)).toBe(false);
    expect(esConflictoDeFuenteDuplicada(undefined)).toBe(false);
  });
});
