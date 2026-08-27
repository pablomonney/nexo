/**
 * Los rechazos del cargador de reglas.
 *
 * Cada test rompe **una sola cosa** de una regla que por lo demás es válida. Es
 * la única forma de saber que el control que se cree que dispara es el que
 * dispara: un test que rompe tres cosas y espera "rechazada" pasaría igual con
 * dos de los tres controles borrados.
 */

import { describe, expect, it } from 'vitest';
import { ACCIONES_SOPORTADAS, validarReglaParaCarga, type ContextoDeCarga } from './carga-de-reglas.js';

const CITA =
  'Sólo darán lugar a cómputo del crédito fiscal las compras o importaciones definitivas, ' +
  'las locaciones y las prestaciones de servicios en la medida en que se vinculen con las ' +
  'operaciones gravadas, cualquiera fuese la etapa de su aplicación';

/** Un recorte del documento archivado, con el marcado y los saltos que trae. */
const DOCUMENTO = `
  <p>ARTICULO   11 — ... texto anterior ...</p>
  <p>ARTICULO 12 — Del impuesto determinado por aplicación de lo dispuesto en el
  artículo anterior los responsables restarán:  a) El gravamen que, en el período
  fiscal que se liquida, se les hubiera facturado por compra o importación
  definitiva de bienes.  ${CITA}   No se considerarán vinculadas con las
  operaciones gravadas: 1. Las compras ... de automóviles ...</p>
  <p>ARTICULO 13 — ...</p>
`;

const SHA = '180b1380c820cbabc572b707b540e9299e074423fcad4f69b920b06167eb3244';

const CONTEXTO_OK: ContextoDeCarga = {
  normVersionId: '01a03d41-c9e3-72ce-bf88-9a8a2ad21a45',
  sha256Registrado: SHA,
  sha256Calculado: SHA,
  textoDelDocumento: DOCUMENTO,
};

function reglaValida(): Record<string, unknown> {
  return {
    fuente: {
      organismo: 'CONGRESO',
      tipo: 'LEY',
      numero: '23349',
      anio: 1997,
      documento: { archivo: 'INFOLEG_LEY_IVA_23349_TO_1997_texto_actualizado.htm', sha256: SHA },
    },
    regla: {
      clave: 'AR-IVA-CF-VINCULACION-001',
      version: 1,
      dominio: 'tax',
      jurisdiccion: 'AR',
      tiposDeEnte: [],
      marcos: [],
      prioridad: 100,
      propuestaPor: 'cargador:carga-inicial',
    },
    condiciones: {
      hechosRequeridos: [{ campo: 'vinculadaConOperacionesGravadas', tipo: 'BOOLEANO' }],
      ast: { op: 'eq', field: 'vinculadaConOperacionesGravadas', value: false },
    },
    accion: { tipo: 'MARCAR_CREDITO_FISCAL', resultado: 'NO_COMPUTABLE' },
    cita: { articulo: '12', inciso: 'a)', texto: CITA },
    vigencia: { desde: '1997-04-15', hasta: null, fundamento: 'Fecha de publicación registrada en el corpus.' },
    estado: 'DRAFT',
  };
}

/** Aplica una mutación sobre la regla válida y devuelve los códigos rechazados. */
function codigosAlRomper(
  mutar: (r: Record<string, unknown>) => void,
  contexto: ContextoDeCarga = CONTEXTO_OK,
): string[] {
  const r = reglaValida();
  mutar(r);
  const resultado = validarReglaParaCarga(r, contexto);
  return resultado.ok ? [] : resultado.rechazos.map((x) => x.codigo);
}

describe('la regla completa pasa', () => {
  it('acepta la regla del art. 12 con todo en su lugar', () => {
    const resultado = validarReglaParaCarga(reglaValida(), CONTEXTO_OK);
    expect(resultado.ok).toBe(true);
    if (resultado.ok) {
      expect(resultado.hechosDetectados).toEqual(['vinculadaConOperacionesGravadas']);
    }
  });

  it('la cita se compara normalizando espacios, no byte a byte', () => {
    // El documento archivado parte el párrafo en varias líneas. Una cita
    // correcta no puede fallar por eso, y una parafraseada tiene que fallar
    // igual — lo comprueba el test de CITA_NO_COINCIDE_CON_DOCUMENTO.
    const resultado = validarReglaParaCarga(
      { ...reglaValida(), cita: { articulo: '12', texto: `  ${CITA.replace(/ /g, '\n  ')}  ` } },
      CONTEXTO_OK,
    );
    expect(resultado.ok).toBe(true);
  });
});

describe('rechazos', () => {
  it('SIN_CITA — la regla no transcribe nada', () => {
    expect(codigosAlRomper((r) => delete r['cita'])).toContain('SIN_CITA');
    expect(codigosAlRomper((r) => (r['cita'] = { articulo: '12', texto: '   ' }))).toContain('SIN_CITA');
  });

  it('CITA_NO_COINCIDE_CON_DOCUMENTO — el texto citado no está en el documento', () => {
    const codigos = codigosAlRomper((r) => {
      // Parafraseo plausible: dice casi lo mismo y no es lo que dice la norma.
      r['cita'] = {
        articulo: '12',
        texto: 'Solo se puede computar el crédito fiscal si la compra se vincula con operaciones gravadas',
      };
    });
    expect(codigos).toContain('CITA_NO_COINCIDE_CON_DOCUMENTO');
    expect(codigos).not.toContain('UBICACION_INEXISTENTE');
  });

  it('UBICACION_INEXISTENTE — el artículo citado no está en el documento', () => {
    const codigos = codigosAlRomper((r) => {
      (r['cita'] as Record<string, unknown>)['articulo'] = '999';
    });
    expect(codigos).toContain('UBICACION_INEXISTENTE');
  });

  it('SHA256_NO_COINCIDE — el documento en disco no es el que la regla declara', () => {
    const codigos = codigosAlRomper((r) => r, {
      ...CONTEXTO_OK,
      sha256Calculado: 'f'.repeat(64),
    });
    expect(codigos).toContain('SHA256_NO_COINCIDE');
  });

  it('SHA256_NO_COINCIDE — el corpus registra otro hash que el declarado', () => {
    // El caso feo: disco y archivo coinciden, y la base dice otra cosa. Sin este
    // control se cargaría una regla contra un documento distinto del archivado.
    const codigos = codigosAlRomper((r) => r, {
      ...CONTEXTO_OK,
      sha256Registrado: 'a'.repeat(64),
    });
    expect(codigos).toContain('SHA256_NO_COINCIDE');
  });

  it('SHA256_NO_COINCIDE — no se pudo leer el documento', () => {
    const codigos = codigosAlRomper((r) => r, {
      ...CONTEXTO_OK,
      sha256Calculado: null,
      textoDelDocumento: null,
    });
    expect(codigos).toContain('SHA256_NO_COINCIDE');
  });

  it('NORMA_INEXISTENTE_EN_CORPUS — la norma no está cargada', () => {
    const codigos = codigosAlRomper((r) => r, { ...CONTEXTO_OK, normVersionId: null });
    expect(codigos).toContain('NORMA_INEXISTENTE_EN_CORPUS');
  });

  it('CONDICION_FUERA_DEL_INTERPRETE — operador que el intérprete no tiene', () => {
    const codigos = codigosAlRomper((r) => {
      (r['condiciones'] as Record<string, unknown>)['ast'] = {
        op: 'regex',
        field: 'vinculadaConOperacionesGravadas',
        value: '.*',
      };
    });
    expect(codigos).toContain('CONDICION_FUERA_DEL_INTERPRETE');
  });

  it('CONDICION_FUERA_DEL_INTERPRETE — un AST que no es un nodo', () => {
    expect(
      codigosAlRomper((r) => {
        (r['condiciones'] as Record<string, unknown>)['ast'] = 'vinculada == false';
      }),
    ).toContain('CONDICION_FUERA_DEL_INTERPRETE');
  });

  it('HECHO_NO_DECLARADO — el AST usa un hecho que la regla no declaró', () => {
    const codigos = codigosAlRomper((r) => {
      (r['condiciones'] as Record<string, unknown>)['hechosRequeridos'] = [];
    });
    expect(codigos).toContain('HECHO_NO_DECLARADO');
  });

  it('ACCION_NO_SOPORTADA — tipo de acción fuera del catálogo', () => {
    expect(
      codigosAlRomper((r) => {
        r['accion'] = { tipo: 'ASENTAR_EN_EL_DIARIO', resultado: 'SI' };
      }),
    ).toContain('ACCION_NO_SOPORTADA');
  });

  it('ACCION_NO_SOPORTADA — resultado que esa acción no admite', () => {
    // `COMPUTABLE` está deliberadamente fuera del catálogo: el art. 12 enuncia
    // una condición necesaria, y de una necesaria no se deduce la afirmativa.
    expect(ACCIONES_SOPORTADAS.MARCAR_CREDITO_FISCAL).not.toContain('COMPUTABLE');
    expect(
      codigosAlRomper((r) => {
        r['accion'] = { tipo: 'MARCAR_CREDITO_FISCAL', resultado: 'COMPUTABLE' };
      }),
    ).toContain('ACCION_NO_SOPORTADA');
  });

  it('FALTA_INFORMACION_OBLIGATORIA — sin proponente no hay segregación de funciones', () => {
    expect(
      codigosAlRomper((r) => {
        delete (r['regla'] as Record<string, unknown>)['propuestaPor'];
      }),
    ).toContain('FALTA_INFORMACION_OBLIGATORIA');
  });

  it('FALTA_INFORMACION_OBLIGATORIA — una vigencia sin fundamento es una fecha inventada', () => {
    expect(
      codigosAlRomper((r) => {
        (r['vigencia'] as Record<string, unknown>)['fundamento'] = '';
      }),
    ).toContain('FALTA_INFORMACION_OBLIGATORIA');
  });

  it('FALTA_INFORMACION_OBLIGATORIA — dominio fuera de los tres admitidos', () => {
    expect(
      codigosAlRomper((r) => {
        (r['regla'] as Record<string, unknown>)['dominio'] = 'contabilidad';
      }),
    ).toContain('FALTA_INFORMACION_OBLIGATORIA');
  });

  it('ESTADO_NO_PERMITIDO — el cargador no admite ACTIVE por ninguna vía', () => {
    const codigos = codigosAlRomper((r) => {
      r['estado'] = 'ACTIVE';
    });
    expect(codigos).toContain('ESTADO_NO_PERMITIDO');
  });

  it('un archivo que no es un objeto se rechaza sin explotar', () => {
    for (const basura of [null, 42, 'una regla', []]) {
      const resultado = validarReglaParaCarga(basura, CONTEXTO_OK);
      expect(resultado.ok).toBe(false);
    }
  });

  it('acumula todos los motivos, no corta en el primero', () => {
    // Quien escribió la regla tiene que poder arreglarla de una vez.
    const codigos = codigosAlRomper((r) => {
      delete r['cita'];
      r['accion'] = { tipo: 'INVENTADA', resultado: 'X' };
      r['estado'] = 'ACTIVE';
    });
    expect(new Set(codigos)).toEqual(new Set(['SIN_CITA', 'ACCION_NO_SOPORTADA', 'ESTADO_NO_PERMITIDO']));
  });
});
