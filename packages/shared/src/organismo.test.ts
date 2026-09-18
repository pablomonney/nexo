import { describe, expect, it } from 'vitest';
import {
  esOrganismoDeContralor,
  MENSAJE_DE_ORGANISMO,
  normalizarOrganismo,
  ORGANISMOS_DE_CONTRALOR,
} from './organismo.js';

describe('El organismo de contralor', () => {
  it('acepta los cinco que admite la base', () => {
    expect([...ORGANISMOS_DE_CONTRALOR]).toEqual(['IGJ', 'CNV', 'BCRA', 'INAES', 'PROVINCIAL']);
    for (const organismo of ORGANISMOS_DE_CONTRALOR) {
      expect(esOrganismoDeContralor(organismo)).toBe(true);
    }
  });

  it('normaliza lo que es descuido de tipeo', () => {
    // Minúsculas, mayúsculas de más y espacios en los extremos son la misma
    // palabra escrita con apuro. Rechazarlas sería pedantería, y es lo que hacía
    // que `igj` terminara en un 500.
    expect(normalizarOrganismo('igj')).toBe('IGJ');
    expect(normalizarOrganismo('  igj  ')).toBe('IGJ');
    expect(normalizarOrganismo('Igj')).toBe('IGJ');
    expect(normalizarOrganismo('\tcnv\n')).toBe('CNV');
  });

  it('NO adivina qué quiso escribir quien puso espacios en el medio', () => {
    // `I G J` no se convierte en `IGJ`: colapsar espacios internos es adivinar,
    // y una corrección silenciosa sobre un dato registral es peor que un
    // rechazo que dice cuáles son los cinco valores.
    expect(normalizarOrganismo('I G J')).toBe('I G J');
    expect(esOrganismoDeContralor(normalizarOrganismo('I G J'))).toBe(false);
  });

  it('rechaza lo que no pertenece al conjunto', () => {
    for (const valor of ['MINISTERIO', 'AFIP', 'ARCA', 'NINGUNO', 'SA', 'IGJ ']) {
      expect(esOrganismoDeContralor(valor)).toBe(false);
    }
  });

  it('el vacío no es un organismo: la ausencia se guarda como NULL', () => {
    // `NINGUNO` es un valor en otra tabla —la de estados contables, que es NOT
    // NULL y necesita nombrar la ausencia—. En `companies.regulator` la
    // ausencia es NULL, y por eso acá no hay un sexto valor.
    expect(esOrganismoDeContralor('')).toBe(false);
    expect(esOrganismoDeContralor('NINGUNO')).toBe(false);
  });

  it('el mensaje de error nombra los cinco valores y la salida', () => {
    // Un «valor inválido» sin la lista obliga a adivinar, y lo que hay que
    // saber son cinco palabras.
    for (const organismo of ORGANISMOS_DE_CONTRALOR) {
      expect(MENSAJE_DE_ORGANISMO).toContain(organismo);
    }
    expect(MENSAJE_DE_ORGANISMO).toContain('dejá el campo vacío');
  });
});
