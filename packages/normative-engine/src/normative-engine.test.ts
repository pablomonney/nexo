import { describe, expect, it } from 'vitest';
import { parseCalendarDate } from '@aai/shared';
import {
  ErrorDeRegla,
  aplicabilidad,
  citaHabilitaAplicacion,
  evaluar,
  hechosRequeridos,
  normasCitables,
  renderizarCita,
  resolverRegla,
  type AdoptionSnapshot,
  type CatalogoNormativo,
  type ContextoNormativo,
  type NormSnapshot,
  type NormVersionSnapshot,
  type RuleSnapshot,
} from './index.js';

const f = (iso: string) => parseCalendarDate(iso);

// ---------------------------------------------------------------------------
// Intérprete de condiciones
// ---------------------------------------------------------------------------

describe('intérprete cerrado de condiciones', () => {
  const hechos = {
    tipoComprobante: 'FACTURA_A',
    total: 123400n,
    esResponsableInscripto: true,
    centroCosto: null,
  };

  it('evalúa comparaciones, conjunciones y pertenencia', () => {
    expect(evaluar({ op: 'eq', field: 'tipoComprobante', value: 'FACTURA_A' }, hechos)).toBe(true);
    expect(evaluar({ op: 'ne', field: 'tipoComprobante', value: 'FACTURA_B' }, hechos)).toBe(true);
    expect(
      evaluar({ op: 'in', field: 'tipoComprobante', values: ['FACTURA_A', 'FACTURA_M'] }, hechos),
    ).toBe(true);
    expect(evaluar({ op: 'always' }, hechos)).toBe(true);
    expect(evaluar({ op: 'never' }, hechos)).toBe(false);
    expect(
      evaluar(
        {
          op: 'and',
          args: [
            { op: 'eq', field: 'esResponsableInscripto', value: true },
            { op: 'not', arg: { op: 'eq', field: 'tipoComprobante', value: 'FACTURA_C' } },
          ],
        },
        hechos,
      ),
    ).toBe(true);
  });

  it('compara importes como enteros, declarados explícitamente', () => {
    const literal = { type: 'bigint', value: '100000' };
    expect(evaluar({ op: 'gt', field: 'total', value: literal }, hechos)).toBe(true);
    expect(
      evaluar(
        { op: 'between', field: 'total', min: literal, max: { type: 'bigint', value: '200000' } },
        hechos,
      ),
    ).toBe(true);
  });

  // Los cuatro tests que definen el módulo.
  it('un operador desconocido FALLA, no vale false', () => {
    // "No aplica" y "no sé evaluarlo" son cosas distintas. Colapsarlas haría que
    // una regla mal escrita deje de aplicarse sin que nadie se entere.
    expect(() => evaluar({ op: 'matchesRegex', field: 'tipoComprobante', value: '.*' }, hechos))
      .toThrow(ErrorDeRegla);
  });

  it('un hecho ausente FALLA, no vale false', () => {
    expect(() => evaluar({ op: 'eq', field: 'inexistente', value: 1 }, hechos)).toThrow(
      /no está en el contexto/,
    );
  });

  it('mezclar tipos FALLA en lugar de devolver false en silencio', () => {
    // `100n === "100"` es false, y ese false parece una respuesta.
    expect(() => evaluar({ op: 'eq', field: 'total', value: '123400' }, hechos)).toThrow(
      /mezcla tipos/,
    );
  });

  it('no cortocircuita: un argumento mal escrito se detecta igual', () => {
    // Con cortocircuito, este `or` devolvería true y el segundo argumento roto
    // quedaría latente hasta el día que el primero cambie de valor.
    expect(() =>
      evaluar(
        { op: 'or', args: [{ op: 'always' }, { op: 'eq', field: 'noExiste', value: 1 }] },
        hechos,
      ),
    ).toThrow(ErrorDeRegla);
  });

  it('distingue un hecho con valor nulo de un hecho ausente', () => {
    expect(evaluar({ op: 'eq', field: 'centroCosto', value: null }, hechos)).toBe(true);
    expect(() => evaluar({ op: 'gt', field: 'centroCosto', value: 1 }, hechos)).toThrow(/nulo/);
  });

  it('acota profundidad y cantidad de nodos', () => {
    let profundo: unknown = { op: 'always' };
    for (let i = 0; i < 20; i += 1) profundo = { op: 'not', arg: profundo };
    expect(() => evaluar(profundo, hechos)).toThrow(/niveles/);

    const ancho = { op: 'and', args: Array.from({ length: 600 }, () => ({ op: 'always' })) };
    expect(() => evaluar(ancho, hechos)).toThrow(/nodos/);
  });

  it('rechaza un AST malformado en vez de interpretarlo con buena voluntad', () => {
    expect(() => evaluar(null, hechos)).toThrow(ErrorDeRegla);
    expect(() => evaluar({ field: 'total' }, hechos)).toThrow(/no declara operador/);
    expect(() => evaluar({ op: 'and', args: [] }, hechos)).toThrow(/al menos un argumento/);
    expect(() => evaluar({ op: 'eq', field: 'total', value: [1, 2] }, hechos)).toThrow(
      /no admitido/,
    );
  });

  it('sabe qué hechos necesita una condición sin evaluarla', () => {
    const condicion = {
      op: 'and',
      args: [
        { op: 'eq', field: 'tipoComprobante', value: 'FACTURA_A' },
        { op: 'not', arg: { op: 'gt', field: 'total', value: { type: 'bigint', value: '1' } } },
      ],
    };
    expect(hechosRequeridos(condicion)).toEqual(['tipoComprobante', 'total']);
  });
});

// ---------------------------------------------------------------------------
// Vigencia — el caso RT 54
// ---------------------------------------------------------------------------

const RT54: NormSnapshot = {
  id: 'norm-rt54',
  organismo: 'FACPCE',
  tipo: 'RT',
  numero: '54',
  anio: 2022,
  titulo: 'Norma Unificada Argentina de Contabilidad',
  jurisdiccion: 'AR',
  hierarchyLevel: 3,
  estado: 'VIGENTE',
};

const RT54_V1: NormVersionSnapshot = {
  id: 'ver-rt54-1',
  normId: 'norm-rt54',
  version: 1,
  fechaEmision: f('2022-07-01'),
  // FACPCE: ejercicios iniciados desde el 01/07/2024 (tras la RT 56).
  fechaVigencia: f('2024-07-01'),
  fechaDerogacion: null,
  recordedFrom: '2026-08-24T00:00:00.000Z',
  recordedTo: null,
  verificationLevel: 'V1',
  tieneDocumento: true,
};

/** CPCECABA, Res. CD 460/2024. Nótese el ancla de la anticipada: el CIERRE. */
const ADOPCION_CABA: AdoptionSnapshot = {
  normVersionId: 'ver-rt54-1',
  jurisdiction: 'AR-C',
  adoptingBody: 'CPCECABA',
  adoptionAct: 'Res. CD 460/2024',
  validFrom: f('2025-01-01'),
  validTo: null,
  earlyFrom: f('2024-09-30'),
  earlyAnchor: 'CIERRE_EJERCICIO',
};

function ctx(overrides: Partial<ContextoNormativo> = {}): ContextoNormativo {
  return {
    fechaHecho: f('2025-03-15'),
    inicioEjercicio: f('2025-01-01'),
    cierreEjercicio: f('2025-12-31'),
    jurisdiccion: 'AR-C',
    tipoEnte: 'SRL',
    marco: 'RT_FACPCE',
    asOf: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('vigencia de una norma profesional', () => {
  it('se resuelve por el acto de adopción de la jurisdicción, no por la fecha del emisor', () => {
    const resultado = aplicabilidad(RT54, RT54_V1, [ADOPCION_CABA], ctx());
    expect(resultado.estado).toBe('APLICA');
    // FACPCE dice 01/07/2024; en CABA rige desde el 01/01/2025. Los dos son
    // ciertos, y para este ente manda el segundo.
    expect(resultado.vigenteDesde).toBe('2025-01-01');
    expect(resultado.explicacion).toMatch(/CPCECABA/);
  });

  it('la vigencia se ancla al INICIO del ejercicio, no a la fecha del hecho', () => {
    // Hecho en marzo de 2025, pero el ejercicio arrancó en julio de 2024: todavía
    // no le aplica. Con un `fecha_vigencia <= hoy` habría dado que sí.
    const resultado = aplicabilidad(
      RT54,
      RT54_V1,
      [ADOPCION_CABA],
      ctx({ inicioEjercicio: f('2024-07-01'), cierreEjercicio: f('2025-06-30') }),
    );
    expect(resultado.aplica).toBe(false);
  });

  it('la aplicación anticipada se ancla al CIERRE, y ser elegible no es haber optado', () => {
    const elegible = ctx({
      inicioEjercicio: f('2024-07-01'),
      cierreEjercicio: f('2025-06-30'),
    });

    const sinOptar = aplicabilidad(RT54, RT54_V1, [ADOPCION_CABA], elegible);
    expect(sinOptar.estado).toBe('ELEGIBLE_ANTICIPADA_SIN_OPTAR');
    expect(sinOptar.aplica).toBe(false);
    expect(sinOptar.explicacion).toMatch(/no se infiere/);

    const optando = aplicabilidad(RT54, RT54_V1, [ADOPCION_CABA], {
      ...elegible,
      optoPorAnticipada: true,
    });
    expect(optando.estado).toBe('APLICA_POR_OPCION_ANTICIPADA');
    expect(optando.aplica).toBe(true);
  });

  it('sin acto de adopción en la jurisdicción, se abstiene: no cae a la fecha de FACPCE', () => {
    // Es el gap `adopcion_no_caba`, declarado desde FASE 1b. Suponer la fecha del
    // organismo emisor sería inventar una vigencia.
    const resultado = aplicabilidad(
      RT54,
      RT54_V1,
      [ADOPCION_CABA],
      ctx({ jurisdiccion: 'AR-X' }),
    );
    expect(resultado.estado).toBe('ADOPCION_NO_RELEVADA');
    expect(resultado.aplica).toBe(false);
  });

  it('respeta el eje de tiempo de SISTEMA', () => {
    // Consultado como si fuera enero de 2026: el sistema todavía no conocía esta
    // versión. Es lo que permite reproducir la decisión de entonces.
    const resultado = aplicabilidad(RT54, RT54_V1, [ADOPCION_CABA], {
      ...ctx(),
      asOf: '2026-01-01T00:00:00.000Z',
    });
    expect(resultado.estado).toBe('NO_CONOCIDA_AL_MOMENTO');
  });
});

describe('vigencia de una norma de organismo de control', () => {
  const RG: NormSnapshot = {
    id: 'norm-rg',
    organismo: 'ARCA',
    tipo: 'RG',
    numero: '5616',
    anio: 2024,
    titulo: 'Regímenes de emisión de comprobantes',
    jurisdiccion: 'AR',
    hierarchyLevel: 2,
    estado: 'VIGENTE',
  };
  const VERSION: NormVersionSnapshot = {
    id: 'ver-rg-1',
    normId: 'norm-rg',
    version: 1,
    fechaEmision: f('2024-12-17'),
    fechaVigencia: f('2024-12-18'),
    fechaDerogacion: null,
    recordedFrom: '2026-08-24T00:00:00.000Z',
    recordedTo: null,
    verificationLevel: 'V1',
    tieneDocumento: true,
  };

  it('rige desde su fecha de vigencia, contra la fecha del hecho', () => {
    expect(aplicabilidad(RG, VERSION, [], ctx()).aplica).toBe(true);
    expect(aplicabilidad(RG, VERSION, [], ctx({ fechaHecho: f('2024-12-01') })).aplica).toBe(false);
  });

  it('sin fecha de vigencia cargada, no la supone', () => {
    const sinFecha = { ...VERSION, fechaVigencia: null };
    expect(aplicabilidad(RG, sinFecha, [], ctx()).estado).toBe('AUN_NO_VIGENTE');
  });

  it('una norma derogada deja de aplicar desde la derogación', () => {
    const derogada = { ...VERSION, fechaDerogacion: f('2025-01-01') };
    expect(aplicabilidad(RG, derogada, [], ctx()).estado).toBe('DEROGADA');
    // Pero seguía vigente para los hechos anteriores.
    expect(
      aplicabilidad(RG, derogada, [], ctx({ fechaHecho: f('2024-12-20') })).aplica,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

function regla(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
  return {
    id: 'rule-1',
    ruleKey: 'AR-GASTO-DEVENGADO',
    version: 1,
    normVersionId: 'ver-rt54-1',
    domain: 'accounting',
    validFrom: f('2024-01-01'),
    validTo: null,
    jurisdiction: 'AR',
    entityTypes: [],
    frameworks: [],
    priority: 100,
    conditions: { op: 'always' },
    action: { tipo: 'IMPUTAR_GASTO' },
    status: 'ACTIVE',
    ...overrides,
  };
}

function catalogo(overrides: Partial<CatalogoNormativo> = {}): CatalogoNormativo {
  return {
    norms: [RT54],
    versions: [RT54_V1],
    adoptions: [ADOPCION_CABA],
    rules: [regla()],
    modifications: [],
    ...overrides,
  };
}

describe('resolución de reglas', () => {
  it('resuelve y devuelve la cita', () => {
    const resultado = resolverRegla('AR-GASTO-DEVENGADO', ctx(), catalogo());
    expect(resultado.estado).toBe('RESUELTA');
    if (resultado.estado !== 'RESUELTA') return;
    expect(resultado.regla.cita.organismo).toBe('FACPCE');
    expect(resultado.regla.cita.adoptadaEn).toMatch(/CPCECABA/);
    expect(resultado.regla.cita.nivelVerificacion).toBe('V1');
  });

  it('sin regla relevada devuelve FUENTE_NO_ENCONTRADA, no un resultado inventado', () => {
    const resultado = resolverRegla('AR-NO-EXISTE', ctx(), catalogo());
    expect(resultado.estado).toBe('SIN_FUENTE');
    if (resultado.estado !== 'SIN_FUENTE') return;
    expect(resultado.error.code).toBe('FUENTE_NO_ENCONTRADA');
  });

  it('una norma que no llega a V1 no funda una regla', () => {
    const resultado = resolverRegla(
      'AR-GASTO-DEVENGADO',
      ctx(),
      catalogo({ versions: [{ ...RT54_V1, verificationLevel: 'V3' }] }),
    );
    expect(resultado.estado).toBe('SIN_FUENTE');
    if (resultado.estado !== 'SIN_FUENTE') return;
    expect(resultado.descartadas[0]?.motivo).toMatch(/V3/);
  });

  it('una norma sin documento archivado tampoco', () => {
    // Una cita que no se puede abrir no es una cita.
    const resultado = resolverRegla(
      'AR-GASTO-DEVENGADO',
      ctx(),
      catalogo({ versions: [{ ...RT54_V1, tieneDocumento: false }] }),
    );
    expect(resultado.estado).toBe('SIN_FUENTE');
  });

  it('la falta de adopción se informa como tal, no como "no hay norma"', () => {
    // Son problemas distintos: uno se arregla cargando un acto de adopción; el
    // otro, relevando normativa que no existe en el sistema.
    const resultado = resolverRegla('AR-GASTO-DEVENGADO', ctx({ jurisdiccion: 'AR-X' }), catalogo());
    expect(resultado.estado).toBe('SIN_FUENTE');
    if (resultado.estado !== 'SIN_FUENTE') return;
    expect(resultado.error.code).toBe('ADOPCION_NO_RELEVADA');
  });

  it('descarta por estado, tipo de ente, marco y fecha', () => {
    const casos: [Partial<RuleSnapshot>, RegExp][] = [
      [{ status: 'DRAFT' }, /DRAFT/],
      [{ entityTypes: ['SA'] }, /tipo de ente/],
      [{ frameworks: ['NIIF'] }, /marco/],
      [{ validFrom: f('2026-01-01') }, /rige desde/],
      [{ validTo: f('2024-12-31') }, /rigió hasta/],
    ];
    for (const [override, patron] of casos) {
      const resultado = resolverRegla(
        'AR-GASTO-DEVENGADO',
        ctx(),
        catalogo({ rules: [regla(override)] }),
      );
      expect(resultado.estado).toBe('SIN_FUENTE');
      if (resultado.estado !== 'SIN_FUENTE') continue;
      expect(resultado.descartadas[0]?.motivo).toMatch(patron);
    }
  });

  it('la jerarquía decide: P2 le gana a P3', () => {
    const normaArca: NormSnapshot = {
      ...RT54,
      id: 'norm-arca',
      organismo: 'ARCA',
      tipo: 'RG',
      numero: '5616',
      hierarchyLevel: 2,
    };
    const versionArca: NormVersionSnapshot = {
      ...RT54_V1,
      id: 'ver-arca',
      normId: 'norm-arca',
      fechaVigencia: f('2024-01-01'),
    };

    const resultado = resolverRegla(
      'AR-GASTO-DEVENGADO',
      ctx(),
      catalogo({
        norms: [RT54, normaArca],
        versions: [RT54_V1, versionArca],
        rules: [regla(), regla({ id: 'rule-2', version: 2, normVersionId: 'ver-arca' })],
      }),
    );
    expect(resultado.estado).toBe('RESUELTA');
    if (resultado.estado !== 'RESUELTA') return;
    expect(resultado.regla.norm.organismo).toBe('ARCA');
  });

  // El corazón del módulo.
  it('dos reglas de igual jerarquía sin derogación declarada dan CONFLICTO, no un ganador', () => {
    const otraVersion: NormVersionSnapshot = { ...RT54_V1, id: 'ver-rt54-2', version: 2 };
    const otraAdopcion: AdoptionSnapshot = { ...ADOPCION_CABA, normVersionId: 'ver-rt54-2' };

    const resultado = resolverRegla(
      'AR-GASTO-DEVENGADO',
      ctx(),
      catalogo({
        versions: [RT54_V1, otraVersion],
        adoptions: [ADOPCION_CABA, otraAdopcion],
        rules: [regla(), regla({ id: 'rule-2', version: 2, normVersionId: 'ver-rt54-2' })],
      }),
    );

    expect(resultado.estado).toBe('CONFLICTO');
    if (resultado.estado !== 'CONFLICTO') return;
    expect(resultado.error.code).toBe('CONFLICTO_NORMATIVO');
    expect(resultado.candidatas).toHaveLength(2);
    // No hay heurística de "la más nueva gana": sería razonable y se equivocaría
    // en silencio, porque una norma posterior puede no derogar a la anterior.
    expect(resultado.error.message).toMatch(/no desempata/);
  });

  it('la MISMA situación se resuelve si hay una derogación declarada', () => {
    const otraVersion: NormVersionSnapshot = { ...RT54_V1, id: 'ver-rt54-2', version: 2 };
    const otraAdopcion: AdoptionSnapshot = { ...ADOPCION_CABA, normVersionId: 'ver-rt54-2' };

    const resultado = resolverRegla(
      'AR-GASTO-DEVENGADO',
      ctx(),
      catalogo({
        versions: [RT54_V1, otraVersion],
        adoptions: [ADOPCION_CABA, otraAdopcion],
        rules: [regla(), regla({ id: 'rule-2', version: 2, normVersionId: 'ver-rt54-2' })],
        modifications: [
          {
            modificadoraVersionId: 'ver-rt54-2',
            modificadaVersionId: 'ver-rt54-1',
            tipo: 'SUSTITUYE',
          },
        ],
      }),
    );

    expect(resultado.estado).toBe('RESUELTA');
    if (resultado.estado !== 'RESUELTA') return;
    expect(resultado.regla.version.id).toBe('ver-rt54-2');
  });

  it('solo ofrece como citables las normas de reglas que resolvieron', () => {
    // Una norma cuya regla quedó en conflicto no se ofrece al agente: sería
    // darle permiso para fundamentar en algo que el motor no pudo resolver.
    const citas = normasCitables(['AR-GASTO-DEVENGADO', 'AR-NO-EXISTE'], ctx(), catalogo());
    expect(citas).toHaveLength(1);
    expect(citas[0]?.normVersionId).toBe('ver-rt54-1');
  });
});

// ---------------------------------------------------------------------------
// Citas
// ---------------------------------------------------------------------------

describe('render de la cita', () => {
  const documento = {
    urlOficial: 'https://www.facpce.org.ar/…/RT54.pdf',
    archivo: 'FACPCE_RT_54_2022.pdf',
    sha256: '8e44476a7b2ff26664f59487e7369091e8cab32f3bf60380591a471bd84feac9',
    fechaDescarga: '2026-08-24',
  };

  const cita = {
    organismo: 'FACPCE',
    norma: 'RT N° 54/2022 — NUA',
    articulo: '4',
    version: 1,
    vigenciaDesde: f('2025-01-01'),
    adoptadaEn: 'CPCECABA — Res. CD 460/2024',
    nivelVerificacion: 'V1' as const,
    normVersionId: 'ver-rt54-1',
  };

  it('muestra la fuente completa, con el hash del documento', () => {
    const render = renderizarCita(cita, documento, 'AR-GASTO-DEVENGADO');
    expect(render.presentable).toBe(true);
    const texto = render.lineas.join('\n');
    expect(texto).toMatch(/sha256 8e44476a7b2f/);
    // Fecha en formato argentino: la lee un contador, no un parser. El alineado
    // de las etiquetas también se fija: quien audita compara citas de meses
    // distintos, y una columna que se mueve obliga a leer cada una entera.
    expect(texto).toMatch(/Vigente desde: {4}01\/01\/2025/);
    expect(texto).toMatch(/Adoptada en: {6}CPCECABA/);
  });

  it('sin documento archivado, la cita no se puede abrir y no se presenta', () => {
    const render = renderizarCita(cita, null);
    expect(render.presentable).toBe(false);
    expect(render.lineas[0]).toBe('NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE');
    expect(citaHabilitaAplicacion(cita, null)).toBe(false);
  });

  it('una fuente que no llega a V1 tampoco se presenta como regla aplicada', () => {
    const render = renderizarCita({ ...cita, nivelVerificacion: 'V4' }, documento);
    expect(render.presentable).toBe(false);
    expect(render.lineas.join('\n')).toMatch(/no alcanza el nivel V1/);
  });
});
