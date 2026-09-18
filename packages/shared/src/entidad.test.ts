import { describe, expect, it } from 'vitest';
import { CATALOGO_DE_ENTIDADES, ETIQUETA_DE_ENTIDAD, TIPOS_DE_ENTIDAD } from './entidad.js';

/**
 * Los doce valores, escritos a mano, tal como los declara el `CHECK` de
 * `companies.entity_type` en la migración 0002.
 *
 * Es una copia deliberada: si el catálogo cambiara sin que alguien toque la
 * base, este test falla. Una lista que se compara contra sí misma no comprueba
 * nada.
 */
const LOS_DE_LA_BASE = [
  'SA',
  'SA_299',
  'SRL',
  'SAS',
  'SOCIEDAD_SIMPLE',
  'ASOC_CIVIL',
  'FUNDACION',
  'COOPERATIVA',
  'MUTUAL',
  'SUCURSAL_EXTRANJERA',
  'UNIPERSONAL',
  'FIDEICOMISO',
];

describe('El tipo de entidad', () => {
  it('es exactamente el conjunto que admite la base', () => {
    expect([...TIPOS_DE_ENTIDAD].sort()).toEqual([...LOS_DE_LA_BASE].sort());
  });

  it('no incluye los dos valores inventados que devolvían «Error interno»', () => {
    // `ASOCIACION` era `ASOC_CIVIL` mal escrito; `OTRO` no existe en ninguna
    // parte del sistema y la base lo rechaza.
    expect(TIPOS_DE_ENTIDAD).not.toContain('ASOCIACION');
    expect(TIPOS_DE_ENTIDAD).not.toContain('OTRO');
  });

  it('todos los códigos tienen un nombre para mostrar, y ninguno es el código', () => {
    for (const codigo of TIPOS_DE_ENTIDAD) {
      const etiqueta = ETIQUETA_DE_ENTIDAD[codigo];
      expect(etiqueta.length).toBeGreaterThan(3);
      // Una etiqueta igual al código sería un desplegable que no explica nada.
      expect(etiqueta).not.toBe(codigo);
    }
  });

  it('el catálogo conserva el orden y no pierde ni agrega valores', () => {
    expect(CATALOGO_DE_ENTIDADES.map((e) => e.codigo)).toEqual([...TIPOS_DE_ENTIDAD]);
  });

  it('distingue mayúsculas: el código es el código', () => {
    // A diferencia del organismo, acá no hay normalización: el valor no lo
    // tipea nadie, lo elige un desplegable, y `z.enum` compara exacto.
    expect(TIPOS_DE_ENTIDAD).not.toContain('sa');
    expect(TIPOS_DE_ENTIDAD).toContain('SA');
  });
});
