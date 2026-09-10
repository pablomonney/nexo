/**
 * Las reglas de la emisión fiscal, ejercitadas enteras.
 *
 * Vive **dentro del paquete** y no en `tests/`, y no es una preferencia de
 * ubicación: `tests/security/emision-fiscal-segura.test.ts` importa
 * `@aai/tax-engine`, que resuelve al compilado, así que ejercita `dist` y deja
 * `src` sin medir. Los dos archivos son necesarios y miran cosas distintas:
 *
 *     acá                      las reglas, todas sus ramas, sin base.
 *     tests/security (S-42)    que la BASE las garantice, con concurrencia real.
 *
 * Una regla que solo viviera acá la saltearía la primera consulta suelta; una
 * que solo viviera en la base no se podría ejercitar rama por rama.
 */

import { describe, expect, it } from 'vitest';
import {
  claveDeIntencion,
  esTerminal,
  estadoSegunDesenlace,
  puedePedirCae,
  puedeTransicionar,
  reconciliarPorUltimoAutorizado,
  reintentoSeguro,
  requiereReconciliacion,
  verificarEvidencia,
  type DesenlaceDeLlamada,
  type EstadoDeEmision,
} from './emision.js';

const TODOS: EstadoDeEmision[] = [
  'BORRADOR',
  'LISTA',
  'EMITIENDO',
  'AUTORIZADA',
  'RECHAZADA',
  'DESCONOCIDA',
  'RECONCILIANDO',
  'ANULADA',
];

describe('la máquina de estados de la emisión', () => {
  it('desde la duda solo se puede reconciliar', () => {
    // El candado de toda la fase, comprobado contra los ocho estados: la única
    // arista que sale de DESCONOCIDA es la que va a averiguar.
    const alcanzables = TODOS.filter((e) => puedeTransicionar('DESCONOCIDA', e));
    expect(alcanzables).toEqual(['RECONCILIANDO']);
  });

  it('la reconciliación termina en una certeza, o vuelve a la duda', () => {
    const alcanzables = TODOS.filter((e) => puedeTransicionar('RECONCILIANDO', e));
    expect(alcanzables.sort()).toEqual(['AUTORIZADA', 'DESCONOCIDA', 'RECHAZADA']);
  });

  it('emitir tiene exactamente tres desenlaces', () => {
    const alcanzables = TODOS.filter((e) => puedeTransicionar('EMITIENDO', e));
    expect(alcanzables.sort()).toEqual(['AUTORIZADA', 'DESCONOCIDA', 'RECHAZADA']);
  });

  it('el camino feliz existe', () => {
    // El control positivo: sin él, una máquina que prohibiera todo pasaría los
    // casos de arriba y no se podría emitir nunca.
    expect(puedeTransicionar('BORRADOR', 'LISTA')).toBe(true);
    expect(puedeTransicionar('LISTA', 'EMITIENDO')).toBe(true);
    expect(puedeTransicionar('EMITIENDO', 'AUTORIZADA')).toBe(true);
  });

  it('se puede abandonar antes de llamar, y no después', () => {
    expect(puedeTransicionar('BORRADOR', 'ANULADA')).toBe(true);
    expect(puedeTransicionar('LISTA', 'ANULADA')).toBe(true);
    // Una vez que la llamada salió, abandonar sería declarar que no pasó nada
    // sin saber si pasó.
    expect(puedeTransicionar('EMITIENDO', 'ANULADA')).toBe(false);
    expect(puedeTransicionar('DESCONOCIDA', 'ANULADA')).toBe(false);
  });

  it('los terminales son exactamente tres', () => {
    expect(TODOS.filter(esTerminal).sort()).toEqual(['ANULADA', 'AUTORIZADA', 'RECHAZADA']);
  });

  it('de un terminal no sale ninguna arista', () => {
    for (const terminal of ['AUTORIZADA', 'RECHAZADA', 'ANULADA'] as EstadoDeEmision[]) {
      expect(TODOS.filter((e) => puedeTransicionar(terminal, e))).toEqual([]);
    }
  });

  it('solo desde LISTA se pide un CAE', () => {
    expect(TODOS.filter(puedePedirCae)).toEqual(['LISTA']);
  });

  it('la duda y la averiguación exigen reconciliar; nada más lo exige', () => {
    expect(TODOS.filter(requiereReconciliacion).sort()).toEqual(['DESCONOCIDA', 'RECONCILIANDO']);
  });
});

describe('cómo se lee el desenlace de la llamada', () => {
  const TODOS_LOS_DESENLACES: DesenlaceDeLlamada[] = [
    'NO_SE_ENVIO',
    'AUTORIZO',
    'RECHAZO',
    'SIN_RESPUESTA',
  ];

  it('cada desenlace lleva a un estado, y son los cuatro esperados', () => {
    expect(TODOS_LOS_DESENLACES.map(estadoSegunDesenlace)).toEqual([
      'LISTA',
      'AUTORIZADA',
      'RECHAZADA',
      'DESCONOCIDA',
    ]);
  });

  it('lo único que se reintenta solo es lo que consta que no salió', () => {
    expect(TODOS_LOS_DESENLACES.filter(reintentoSeguro)).toEqual(['NO_SE_ENVIO']);
  });

  it('el estado al que lleva un desenlace reintentable permite pedir CAE', () => {
    // La coherencia entre las dos funciones: si `reintentoSeguro` dijera que sí
    // sobre un desenlace que deja el estado en DESCONOCIDA, el reintento
    // chocaría contra la máquina — o peor, la saltearía.
    for (const d of TODOS_LOS_DESENLACES) {
      if (reintentoSeguro(d)) expect(puedePedirCae(estadoSegunDesenlace(d))).toBe(true);
    }
  });
});

describe('la evidencia de que ARCA autorizó', () => {
  const buena = { cae: '75123456789012', caeVencimiento: '20261231', numeroAutorizado: 7 };

  it('con las tres cosas y el número correcto, alcanza', () => {
    expect(verificarEvidencia(buena, 7)).toEqual({ valida: true });
  });

  it('rechaza cada forma de no ser evidencia', () => {
    const casos = [
      [{ ...buena, cae: '   ' }, 'CAE_VACIO'],
      [{ ...buena, cae: 'aprobado' }, 'CAE_NO_NUMERICO'],
      // Un CAE de siete dígitos: parece uno y es corto.
      [{ ...buena, cae: '1234567' }, 'CAE_NO_NUMERICO'],
      [{ ...buena, caeVencimiento: '2026-12-31' }, 'VENCIMIENTO_INVALIDO'],
      [{ ...buena, caeVencimiento: '' }, 'VENCIMIENTO_INVALIDO'],
      [{ ...buena, numeroAutorizado: 0 }, 'NUMERO_INVALIDO'],
      [{ ...buena, numeroAutorizado: -1 }, 'NUMERO_INVALIDO'],
      [{ ...buena, numeroAutorizado: 7.5 }, 'NUMERO_INVALIDO'],
      // El menos evidente y el que más importa.
      [{ ...buena, numeroAutorizado: 8 }, 'NUMERO_DISTINTO_DEL_RESERVADO'],
    ] as const;

    for (const [evidencia, motivo] of casos) {
      expect(verificarEvidencia(evidencia, 7), JSON.stringify(evidencia)).toEqual({
        valida: false,
        motivo,
      });
    }
  });
});

describe('la reconciliación por el último autorizado', () => {
  it('concluye las tres cosas que puede concluir', () => {
    expect(reconciliarPorUltimoAutorizado(7, 7)).toBe('EXISTE_FALTA_RECUPERAR_CAE');
    expect(reconciliarPorUltimoAutorizado(12, 7)).toBe('EXISTE_FALTA_RECUPERAR_CAE');
    expect(reconciliarPorUltimoAutorizado(6, 7)).toBe('NO_SE_AUTORIZO');
    // Un hueco que este razonamiento no explica. Adivinar acá decidiría si se
    // vuelve a facturar una venta.
    expect(reconciliarPorUltimoAutorizado(3, 7)).toBe('INCONSISTENTE');
    expect(reconciliarPorUltimoAutorizado(0, 7)).toBe('INCONSISTENTE');
  });

  it('el primer comprobante de un punto de venta se resuelve igual', () => {
    // Con la numeración en cero, reservar el 1 y que ARCA siga en 0 significa
    // que no se autorizó — no que algo esté mal.
    expect(reconciliarPorUltimoAutorizado(0, 1)).toBe('NO_SE_AUTORIZO');
    expect(reconciliarPorUltimoAutorizado(1, 1)).toBe('EXISTE_FALTA_RECUPERAR_CAE');
  });
});

describe('la clave de la intención fiscal', () => {
  const base = {
    companyId: '11111111-1111-1111-1111-111111111111',
    ambiente: 'produccion' as const,
    origenTipo: 'COMMERCIAL_DOCUMENT',
    origenId: '22222222-2222-2222-2222-222222222222',
  };

  it('es determinística', () => {
    expect(claveDeIntencion(base)).toBe(claveDeIntencion({ ...base }));
  });

  it('cambia con cualquiera de sus cuatro componentes', () => {
    const distintas = [
      { ...base, companyId: '99999999-9999-9999-9999-999999999999' },
      { ...base, ambiente: 'homologacion' as const },
      { ...base, origenTipo: 'OTRO_ORIGEN' },
      { ...base, origenId: '33333333-3333-3333-3333-333333333333' },
    ].map(claveDeIntencion);

    expect(new Set([claveDeIntencion(base), ...distintas]).size).toBe(5);
  });

  it('un componente vacío o en blanco no arma una clave', () => {
    expect(() => claveDeIntencion({ ...base, origenId: '' })).toThrow(/vacío/u);
    expect(() => claveDeIntencion({ ...base, origenTipo: '   ' })).toThrow(/vacío/u);
  });

  it('un componente con el separador adentro se rechaza', () => {
    // Sin esta guarda, un origen que contuviera el separador podría fabricar la
    // clave de otra intención y esquivar el índice único.
    expect(() => claveDeIntencion({ ...base, origenTipo: 'AB' })).toThrow(/separador/u);
  });
});
