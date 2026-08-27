/**
 * La traducción de una declaración al hecho, y sobre todo cuándo NO hay hecho.
 *
 * El test que más importa es el primero: que la ausencia de declaración no
 * produzca `false`. Todo lo demás del diseño se apoya en esa distinción.
 */

import { describe, expect, it } from 'vitest';
import { evaluar, ErrorDeRegla } from '@aai/normative-engine';
import {
  HECHO_VINCULACION,
  hechosDeAfectacion,
  proveerVinculacion,
  type Afectacion,
  type DeclaracionDeAfectacion,
} from './afectacion.js';

function declaracion(afectacion: Afectacion, extra: Partial<DeclaracionDeAfectacion> = {}): DeclaracionDeAfectacion {
  return {
    companyId: '01a03589-0000-7000-8000-000000000001',
    taxTransactionId: '01a03589-0000-7000-8000-0000000000aa',
    afectacion,
    proporcionGravada: afectacion === 'MIXTA' ? 6000 : null,
    declaradaPor: 'user:contadora',
    declaradaAt: '2026-08-27T12:00:00.000Z',
    evidencia: [{ tipo: 'CUENTA', id: '01a03589-0000-7000-8000-0000000000bb' }],
    ...extra,
  };
}

/** El AST de AR-IVA-CF-VINCULACION-001, tal cual está en la base. */
const AST_DE_LA_REGLA = { op: 'eq', field: HECHO_VINCULACION, value: false };

describe('ausencia ≠ false', () => {
  it('sin declaración, el hecho está AUSENTE', () => {
    expect(proveerVinculacion(null)).toEqual({ estado: 'AUSENTE', motivo: 'SIN_DECLARACION' });
  });

  it('sin declaración, la clave NO aparece en los hechos', () => {
    // No basta con que el estado diga AUSENTE: lo que la regla ve son los hechos,
    // y ahí la clave tiene que faltar. Un `{ vinculada...: false }` sería la
    // misma catástrofe con otra forma.
    const hechos = hechosDeAfectacion(proveerVinculacion(null));
    expect(Object.hasOwn(hechos, HECHO_VINCULACION)).toBe(false);
    expect(hechos).toEqual({});
  });

  it('y entonces la regla LANZA en vez de resolverse como no computable', () => {
    // Este es el comportamiento que se está comprando con todo lo demás.
    const hechos = hechosDeAfectacion(proveerVinculacion(null));
    expect(() => evaluar(AST_DE_LA_REGLA, hechos)).toThrow(ErrorDeRegla);
    expect(() => evaluar(AST_DE_LA_REGLA, hechos)).toThrow(/no está en el contexto/);
  });

  it('NO_DETERMINADA se comporta exactamente como la ausencia', () => {
    const provision = proveerVinculacion(declaracion('NO_DETERMINADA', { evidencia: [] }));
    expect(provision).toEqual({ estado: 'AUSENTE', motivo: 'NO_DETERMINADA' });
    expect(hechosDeAfectacion(provision)).toEqual({});
    expect(() => evaluar(AST_DE_LA_REGLA, hechosDeAfectacion(provision))).toThrow(ErrorDeRegla);
  });
});

describe('declaraciones que sí proveen el hecho', () => {
  it('GRAVADAS provee TRUE', () => {
    const provision = proveerVinculacion(declaracion('GRAVADAS'));
    expect(provision.estado).toBe('PROVISTO');
    expect(hechosDeAfectacion(provision)).toEqual({ [HECHO_VINCULACION]: true });
  });

  it('con GRAVADAS la regla del art. 12 NO se cumple', () => {
    // La regla dispara con `value: false`. Que la condición del artículo esté
    // satisfecha no significa que el crédito sea computable: significa que esta
    // regla —que solo sabe negar— no tiene nada que decir.
    const hechos = hechosDeAfectacion(proveerVinculacion(declaracion('GRAVADAS')));
    expect(evaluar(AST_DE_LA_REGLA, hechos)).toBe(false);
  });

  it('EXENTAS provee FALSE', () => {
    const provision = proveerVinculacion(declaracion('EXENTAS'));
    expect(hechosDeAfectacion(provision)).toEqual({ [HECHO_VINCULACION]: false });
  });

  it('NO_GRAVADAS provee FALSE', () => {
    const provision = proveerVinculacion(declaracion('NO_GRAVADAS'));
    expect(hechosDeAfectacion(provision)).toEqual({ [HECHO_VINCULACION]: false });
  });

  it('con EXENTAS la regla SÍ se cumple, y ahí el NO_COMPUTABLE queda fundado', () => {
    const hechos = hechosDeAfectacion(proveerVinculacion(declaracion('EXENTAS')));
    expect(evaluar(AST_DE_LA_REGLA, hechos)).toBe(true);
  });

  it('la declaración viaja con la provisión, para poder citarla', () => {
    const provision = proveerVinculacion(declaracion('EXENTAS'));
    if (provision.estado !== 'PROVISTO') throw new Error('debería estar provisto');
    expect(provision.declaracion.declaradaPor).toBe('user:contadora');
    expect(provision.declaracion.evidencia).toHaveLength(1);
  });
});

describe('MIXTA', () => {
  it('no provee hecho: requiere revisión', () => {
    const provision = proveerVinculacion(declaracion('MIXTA'));
    expect(provision.estado).toBe('REQUIERE_REVISION');
    if (provision.estado !== 'REQUIERE_REVISION') return;
    expect(provision.motivo).toBe('MIXTA_SIN_PRORRATEO');
    expect(provision.explicacion).toMatch(/art\. 13/);
  });

  it('la regla no se resuelve, ni a favor ni en contra', () => {
    // Devolver `true` daría por computable la parte exenta; devolver `false`
    // negaría un crédito que existe. Las dos respuestas son falsas.
    const hechos = hechosDeAfectacion(proveerVinculacion(declaracion('MIXTA')));
    expect(hechos).toEqual({});
    expect(() => evaluar(AST_DE_LA_REGLA, hechos)).toThrow(ErrorDeRegla);
  });

  it('conserva la proporción declarada, para cuando exista el art. 13', () => {
    const provision = proveerVinculacion(declaracion('MIXTA', { proporcionGravada: 3333 }));
    if (provision.estado !== 'REQUIERE_REVISION') throw new Error('debería requerir revisión');
    expect(provision.declaracion.proporcionGravada).toBe(3333);
  });
});

describe('el mapa completo', () => {
  it('cada afectación tiene un destino declarado y ninguno es "por defecto"', () => {
    const esperado: Record<Afectacion, string> = {
      GRAVADAS: 'PROVISTO',
      EXENTAS: 'PROVISTO',
      NO_GRAVADAS: 'PROVISTO',
      MIXTA: 'REQUIERE_REVISION',
      NO_DETERMINADA: 'AUSENTE',
    };
    for (const [afectacion, estado] of Object.entries(esperado)) {
      const d = declaracion(afectacion as Afectacion, afectacion === 'NO_DETERMINADA' ? { evidencia: [] } : {});
      expect(proveerVinculacion(d).estado).toBe(estado);
    }
  });
});
