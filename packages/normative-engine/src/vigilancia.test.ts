/**
 * Tests de la vigilancia normativa.
 *
 * El primer `describe` es el que define la fase: **un candidato nunca es una
 * norma**. Los demás cubren la identificación, que es conservadora a propósito.
 */

import { describe, expect, it } from 'vitest';
import { parseCalendarDate } from '@aai/shared';
import {
  identificarNorma,
  loQueUnCandidatoNoHabilita,
  vigilar,
  type ItemDeVigilancia,
  type NormaArchivada,
} from './index.js';

function item(overrides: Partial<ItemDeVigilancia> & { titulo: string }): ItemDeVigilancia {
  return {
    fuente: 'CKAN_DATOS_GOB_AR',
    idExterno: 'x-1',
    url: 'https://servicios.infoleg.gob.ar/…',
    publicadoEl: parseCalendarDate('2026-08-20'),
    crudo: overrides.titulo,
    ...overrides,
  };
}

const ARCHIVADAS: readonly NormaArchivada[] = [
  { organismo: 'ARCA', tipo: 'RG', numero: '5616', anio: 2024 },
  { organismo: 'ARCA', tipo: 'RG', numero: '5707', anio: 2025 },
  { organismo: 'IGJ', tipo: 'RG', numero: '9', anio: 2026 },
];

describe('un candidato nunca es una norma', () => {
  it('una norma nueva produce un candidato con la acción que le toca a una persona', () => {
    const resultado = vigilar(
      [item({ titulo: 'ARCA. Resolución General N° 5912/2026. Procedimiento.' })],
      ARCHIVADAS,
    );

    const candidato = resultado.candidatos[0];
    expect(candidato?.estado).toBe('NUEVO');
    expect(candidato?.identificada).toEqual({
      organismo: 'ARCA',
      tipo: 'RG',
      numero: '5912',
      anio: 2026,
    });
    // Lo que sigue lo hace una persona, y el módulo no ofrece un atajo.
    expect(candidato?.accion).toMatch(/Descargar el documento oficial/);
    expect(candidato?.accion).toMatch(/sha256/);
    expect(candidato?.accion).toMatch(/El sistema NO lo carga solo/);
    expect(candidato?.accion).toMatch(/no se puede citar/);
  });

  it('el resumen dice que nada de esto se cargó ni se puede citar', () => {
    const resultado = vigilar(
      [item({ titulo: 'ARCA. Resolución General N° 5912/2026.' })],
      ARCHIVADAS,
    );

    expect(resultado.nuevos).toBe(1);
    expect(resultado.resumen).toMatch(/son candidatos hasta que una persona archive/);
  });

  it('lo que un candidato no habilita está enumerado, no implícito', () => {
    const limites = loQueUnCandidatoNoHabilita();

    expect(limites.join(' ')).toMatch(/no se puede citar/i);
    expect(limites.join(' ')).toMatch(/norm_version_id/);
    expect(limites.join(' ')).toMatch(/El título es lo que publicó la fuente, no el articulado/);
  });

  it('una norma ya archivada no vuelve a avisar', () => {
    const resultado = vigilar(
      [item({ titulo: 'ARCA. Resolución General N° 5707/2025. Portal IVA.' })],
      ARCHIVADAS,
    );

    expect(resultado.candidatos[0]?.estado).toBe('YA_ARCHIVADO');
    expect(resultado.candidatos[0]?.accion).toBe('');
    expect(resultado.nuevos).toBe(0);
  });

  it('un título que no se puede identificar no se adivina', () => {
    const resultado = vigilar([item({ titulo: 'Se aprueban modificaciones varias' })], ARCHIVADAS);
    const candidato = resultado.candidatos[0];

    expect(candidato?.estado).toBe('NO_IDENTIFICABLE');
    expect(candidato?.identificada).toBeNull();
    expect(candidato?.motivo).toMatch(/un identificador equivocado es peor que ninguno/i);
    // Igual queda la acción: alguien tiene que abrirlo y decidir.
    expect(candidato?.accion).toMatch(/Abrir/);
  });

  it('una fuente vacía no es "no hay novedades"', () => {
    const resultado = vigilar([], ARCHIVADAS);

    expect(resultado.resumen).toMatch(/No se relevó nada/);
    expect(resultado.resumen).toMatch(/no es lo mismo que no haber novedades/);
  });
});

describe('identificación conservadora', () => {
  it('reconoce las formas que los organismos usan de verdad', () => {
    expect(identificarNorma('ARCA. Resolución General N° 5912/2026')).toMatchObject({
      organismo: 'ARCA',
      numero: '5912',
      anio: 2026,
    });
    expect(identificarNorma('Resolución General AFIP N° 4597/2019')).toMatchObject({
      organismo: 'ARCA',
      numero: '4597',
    });
    expect(
      identificarNorma('INSPECCIÓN GENERAL DE JUSTICIA. Resolución General N° 12/2026'),
    ).toMatchObject({ organismo: 'IGJ', numero: '12', anio: 2026 });
    expect(identificarNorma('Resolución Técnica N° 54 — FACPCE, 2022')).toMatchObject({
      organismo: 'FACPCE',
      tipo: 'RT',
      numero: '54',
    });
  });

  it('devuelve null antes que arriesgar', () => {
    // Sin organismo no se sabe de quién es la resolución general: ARCA, IGJ y
    // media docena de organismos provinciales las numeran por separado.
    expect(identificarNorma('Resolución General 100/2026')).toBeNull();
    expect(identificarNorma('Decreto 841/84')).toBeNull();
    expect(identificarNorma('')).toBeNull();
    expect(identificarNorma('ARCA informa sobre vencimientos')).toBeNull();
  });

  it('el mismo número de dos organismos distintos no se confunde', () => {
    const arca = identificarNorma('ARCA. Resolución General N° 9/2026');
    const igj = identificarNorma('IGJ. Resolución General N° 9/2026');

    expect(arca?.organismo).toBe('ARCA');
    expect(igj?.organismo).toBe('IGJ');
    // Y la deduplicación los distingue: la RG 9/2026 de IGJ está archivada, la
    // de ARCA no.
    const resultado = vigilar(
      [
        item({ titulo: 'ARCA. Resolución General N° 9/2026' }),
        item({ titulo: 'IGJ. Resolución General N° 9/2026' }),
      ],
      ARCHIVADAS,
    );
    expect(resultado.candidatos.map((c) => c.estado)).toEqual(['NUEVO', 'YA_ARCHIVADO']);
  });

  it('conserva el crudo de la fuente para poder auditar la lectura', () => {
    const original = 'ARCA.  Resolución  General  N°  5912/2026.  ';
    const resultado = vigilar([item({ titulo: original })], ARCHIVADAS);

    expect(resultado.candidatos[0]?.item.crudo).toBe(original);
  });
});
