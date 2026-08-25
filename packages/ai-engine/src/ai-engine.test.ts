import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_V1,
  ClassificationAgent,
  MockLLMProvider,
  NullLLMProvider,
  POLITICA_POR_DEFECTO,
  TECHO_PREFERENCIA,
  cambiosPorRevision,
  construirSchemaClasificacion,
  esImporteAtipico,
  promptPorHash,
  signalDe,
  sugerirPorPreferencia,
  validarContraSchema,
  validarSalida,
  type ContextoClasificacion,
  type CuentaDelPlan,
  type HechosDelComprobante,
  type NormaDisponible,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUENTAS: readonly CuentaDelPlan[] = [
  { id: 'acc-1', codigo: '5.1.01', nombre: 'Servicios', tipo: 'GASTO', imputable: true, usadaAntes: true },
  { id: 'acc-2', codigo: '5.1.02', nombre: 'Honorarios', tipo: 'GASTO', imputable: true, usadaAntes: true },
  { id: 'acc-3', codigo: '5.1.99', nombre: 'Cuenta nueva', tipo: 'GASTO', imputable: true, usadaAntes: false },
  { id: 'acc-4', codigo: '5.1', nombre: 'Gastos (agrupación)', tipo: 'GASTO', imputable: false, usadaAntes: true },
];

const NORMAS: readonly NormaDisponible[] = [
  {
    normVersionId: 'norm-v1',
    etiqueta: 'RT 54 art. 4',
    resumen: 'Reconocimiento de gastos del ejercicio',
    verificationLevel: 'V1',
  },
  {
    normVersionId: 'norm-v2',
    etiqueta: 'Guía CPCECABA',
    resumen: 'Material explicativo',
    verificationLevel: 'V4',
  },
];

/** Hechos "limpios": nada que dispare un bloqueo duro. */
const HECHOS_LIMPIOS: HechosDelComprobante = {
  cuitEmisor: '30712345671',
  razonSocialEmisor: 'PROVEEDOR DEMO SA',
  descripcion: 'Servicio de conectividad marzo',
  totalMenor: '123400',
  moneda: 'ARS',
  fecha: '2026-03-05',
  selloFiscal: 'OK',
  proveedorConocido: true,
  proveedorApocrifo: false,
  monedaExtranjeraSinCotizacion: false,
  periodoProximoACierre: false,
  historicoImportes: [],
  hallazgosBloqueantes: [],
  estadoNormativo: 'RESUELTO',
};

function contexto(overrides: Partial<ContextoClasificacion> = {}): ContextoClasificacion {
  return {
    companyId: 'empresa-1',
    documentId: 'doc-1',
    hechos: HECHOS_LIMPIOS,
    cuentas: CUENTAS,
    normas: NORMAS,
    preferencias: [],
    politica: POLITICA_POR_DEFECTO,
    tratamientos: ['GASTO_DEL_EJERCICIO', 'ACTIVO', 'NO_DETERMINADO'],
    ...overrides,
  };
}

function schemaDe(ctx: ContextoClasificacion = contexto()): Record<string, unknown> {
  return construirSchemaClasificacion({
    cuentas: ctx.cuentas.filter((c) => c.imputable).map((c) => ({ codigo: c.codigo, nombre: c.nombre })),
    citasPermitidas: ctx.normas.map((n) => n.normVersionId),
    tratamientos: [...ctx.tratamientos],
  });
}

const SALIDA_OK = {
  cuentaCodigo: '5.1.01',
  tratamiento: 'GASTO_DEL_EJERCICIO',
  confianza: 0.95,
  razon: 'Conectividad mensual del proveedor habitual, imputada como en meses anteriores.',
  citas: [{ normVersionId: 'norm-v1', articulo: '4' }],
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('schema de salida', () => {
  it('la cuenta es un conjunto cerrado con el plan real de la empresa', () => {
    const schema = schemaDe();
    const propiedades = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(propiedades['cuentaCodigo']!['enum']).toEqual(['5.1.01', '5.1.02', '5.1.99']);
    // La cuenta de agrupación no está entre las opciones.
    expect(propiedades['cuentaCodigo']!['enum']).not.toContain('5.1');
  });

  it('NO tiene ningún campo donde poner un importe', () => {
    // Esto no es una regla que alguien tenga que recordar: es que no existe el
    // lugar. Los importes los calcula el motor fiscal, no el modelo.
    const propiedades = Object.keys(
      schemaDe()['properties'] as Record<string, unknown>,
    );
    expect(propiedades).toEqual([
      'cuentaCodigo',
      'tratamiento',
      'confianza',
      'razon',
      'citas',
      'abstencion',
    ]);
  });

  it('solo se puede citar lo que vino en el contexto', () => {
    const propiedades = schemaDe()['properties'] as Record<string, Record<string, unknown>>;
    const items = (propiedades['citas']!['items'] as Record<string, unknown>)['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(items['normVersionId']!['enum']).toEqual(['norm-v1', 'norm-v2']);
  });

  it('el validador rechaza lo que no cumple, sin completar nada', () => {
    const schema = schemaDe();
    expect(validarContraSchema(SALIDA_OK, schema)).toHaveLength(0);

    const sinRazon = { ...SALIDA_OK, razon: undefined };
    expect(validarContraSchema(sinRazon, schema)[0]?.path).toBe('$.razon');

    const conExtra = { ...SALIDA_OK, importeTotal: 1234 };
    expect(validarContraSchema(conExtra, schema)[0]?.mensaje).toMatch(/no previsto/);

    const confianzaImposible = { ...SALIDA_OK, confianza: 1.4 };
    expect(validarContraSchema(confianzaImposible, schema)[0]?.mensaje).toMatch(/<= 1/);
  });
});

// ---------------------------------------------------------------------------
// Validation Layer
// ---------------------------------------------------------------------------

describe('Validation Layer', () => {
  it('admite una propuesta bien formada y fundada', () => {
    const veredicto = validarSalida(SALIDA_OK, schemaDe(), contexto());
    expect(veredicto.estado).toBe('ADMITIDA');
    if (veredicto.estado !== 'ADMITIDA') return;

    // El id de la cuenta lo pone la validación, no el modelo.
    expect(veredicto.propuesta.output.cuentaId).toBe('acc-1');
    expect(veredicto.propuesta.triage.band).toBe('ALTA');
    expect(veredicto.propuesta.advertencias).toHaveLength(0);
  });

  it('rechaza una cuenta que no existe en el plan, y lo marca como alucinación', () => {
    const veredicto = validarSalida(
      { ...SALIDA_OK, cuentaCodigo: '9.9.99' },
      schemaDe(),
      contexto(),
    );
    expect(veredicto.estado).toBe('RECHAZADA');
    if (veredicto.estado !== 'RECHAZADA') return;
    expect(veredicto.esAlucinacion).toBe(true);
  });

  it('rechaza una cuenta de agrupación, y NO la cuenta como alucinación', () => {
    // La distinción importa para la métrica de deriva: la cuenta existe, el
    // modelo se equivocó de criterio. No es lo mismo que inventarla.
    const schema = schemaDe();
    // Se saltea el enum a propósito: así se comprueba que la validación no
    // depende de que el schema haya hecho su trabajo.
    const veredicto = validarSalida({ ...SALIDA_OK, cuentaCodigo: '5.1' }, relajarEnum(schema), contexto());
    expect(veredicto.estado).toBe('RECHAZADA');
    if (veredicto.estado !== 'RECHAZADA') return;
    expect(veredicto.motivo).toBe('CUENTA_NO_IMPUTABLE');
    expect(veredicto.esAlucinacion).toBe(false);
  });

  it('rechaza una cita que no está en el contexto, aunque la norma exista en la realidad', () => {
    const veredicto = validarSalida(
      { ...SALIDA_OK, citas: [{ normVersionId: 'rt-54-de-memoria' }] },
      relajarEnum(schemaDe()),
      contexto(),
    );
    expect(veredicto.estado).toBe('RECHAZADA');
    if (veredicto.estado !== 'RECHAZADA') return;
    expect(veredicto.motivo).toBe('CITA_NO_RESOLUBLE');
    expect(veredicto.esAlucinacion).toBe(true);
  });

  it('una cita que no llega a V1 no tumba la propuesta pero le baja la banda', () => {
    const veredicto = validarSalida(
      { ...SALIDA_OK, citas: [{ normVersionId: 'norm-v2' }] },
      schemaDe(),
      contexto(),
    );
    expect(veredicto.estado).toBe('ADMITIDA');
    if (veredicto.estado !== 'ADMITIDA') return;
    expect(veredicto.propuesta.advertencias).toContain('CITA_NO_V1');
    // Confianza 0.95, y aun así no llega a aprobación en lote.
    expect(veredicto.propuesta.triage.band).toBe('MEDIA');
  });

  it('sin citas tampoco se aprueba en lote', () => {
    const veredicto = validarSalida({ ...SALIDA_OK, citas: [] }, schemaDe(), contexto());
    expect(veredicto.estado).toBe('ADMITIDA');
    if (veredicto.estado !== 'ADMITIDA') return;
    expect(veredicto.propuesta.advertencias).toContain('SIN_CITAS');
    expect(veredicto.propuesta.triage.band).toBe('MEDIA');
  });

  it('la abstención del modelo es una salida legítima, no un rechazo', () => {
    const veredicto = validarSalida(
      { ...SALIDA_OK, abstencion: true, razon: 'Ninguna cuenta del plan refleja este concepto.' },
      schemaDe(),
      contexto(),
    );
    expect(veredicto.estado).toBe('ABSTENCION');
  });

  it('una salida que no valida se descarta entera', () => {
    const veredicto = validarSalida({ cuentaCodigo: '5.1.01' }, schemaDe(), contexto());
    expect(veredicto.estado).toBe('RECHAZADA');
    if (veredicto.estado !== 'RECHAZADA') return;
    expect(veredicto.motivo).toBe('SCHEMA_INVALIDO');
  });
});

/** Quita los `enum` para probar la validación semántica sin el filtro del schema. */
function relajarEnum(schema: Record<string, unknown>): Record<string, unknown> {
  const copia = structuredClone(schema) as Record<string, unknown>;
  const propiedades = copia['properties'] as Record<string, Record<string, unknown>>;
  delete propiedades['cuentaCodigo']!['enum'];
  const items = (propiedades['citas']!['items'] as Record<string, unknown>)['properties'] as Record<
    string,
    Record<string, unknown>
  >;
  delete items['normVersionId']!['enum'];
  return copia;
}

// ---------------------------------------------------------------------------
// Disparadores duros
// ---------------------------------------------------------------------------

describe('disparadores duros', () => {
  const casos: readonly [string, Partial<HechosDelComprobante>, string][] = [
    ['proveedor nuevo', { proveedorConocido: false }, 'PROVEEDOR_NUEVO'],
    ['proveedor apócrifo', { proveedorApocrifo: true }, 'PROVEEDOR_APOCRIFO'],
    ['ARCA rechazó', { selloFiscal: 'FAIL' }, 'CONSTATACION_FISCAL_FALLIDA'],
    ['ARCA no respondió', { selloFiscal: 'NO_VERIFICABLE' }, 'CONSTATACION_FISCAL_FALLIDA'],
    ['sin norma relevada', { estadoNormativo: 'FUENTE_NO_ENCONTRADA' }, 'FUENTE_NO_ENCONTRADA'],
    ['conflicto normativo', { estadoNormativo: 'CONFLICTO_NORMATIVO' }, 'CONFLICTO_NORMATIVO'],
    ['moneda sin cotización', { monedaExtranjeraSinCotizacion: true }, 'FX_SIN_FUENTE'],
    ['período por cerrar', { periodoProximoACierre: true }, 'PERIODO_PROXIMO_A_CIERRE'],
  ];

  for (const [nombre, override, esperado] of casos) {
    it(`${nombre} fuerza 🔴 aunque el modelo diga 0.99`, () => {
      const veredicto = validarSalida(
        { ...SALIDA_OK, confianza: 0.99 },
        schemaDe(),
        contexto({ hechos: { ...HECHOS_LIMPIOS, ...override } }),
      );
      expect(veredicto.estado).toBe('ADMITIDA');
      if (veredicto.estado !== 'ADMITIDA') return;
      expect(veredicto.propuesta.triage.band).toBe('BAJA');
      expect(veredicto.propuesta.triage.hardBlocks).toContain(esperado);
    });
  }

  it('una cuenta que la empresa nunca usó también bloquea', () => {
    const veredicto = validarSalida(
      { ...SALIDA_OK, cuentaCodigo: '5.1.99', confianza: 0.99 },
      schemaDe(),
      contexto(),
    );
    expect(veredicto.estado).toBe('ADMITIDA');
    if (veredicto.estado !== 'ADMITIDA') return;
    expect(veredicto.propuesta.triage.hardBlocks).toContain('CUENTA_NUNCA_USADA');
  });

  it('"no pude preguntarle a ARCA" y "ARCA dijo que no" bloquean los dos', () => {
    // Colapsarlos convertiría una caída del organismo en aprobaciones en
    // silencio. Es el R-14, visto desde el sistema de confianza.
    for (const sello of ['FAIL', 'NO_VERIFICABLE'] as const) {
      const veredicto = validarSalida(
        SALIDA_OK,
        schemaDe(),
        contexto({ hechos: { ...HECHOS_LIMPIOS, selloFiscal: sello } }),
      );
      if (veredicto.estado !== 'ADMITIDA') throw new Error('esperaba ADMITIDA');
      expect(veredicto.propuesta.triage.band).toBe('BAJA');
    }
  });
});

describe('detección de importes atípicos', () => {
  const historico = ['100000', '102000', '98000', '101000', '99000', '103000', '97000', '100500'];

  it('no opina con pocas observaciones', () => {
    expect(esImporteAtipico('9999999', historico.slice(0, 3))).toBe(false);
  });

  it('marca un importe que se sale del historial', () => {
    expect(esImporteAtipico('5000000', historico)).toBe(true);
  });

  it('no marca un importe normal', () => {
    expect(esImporteAtipico('101500', historico)).toBe(false);
  });

  it('un outlier en el historial no arrastra el umbral', () => {
    // Con media y desvío estándar, un único valor gigante en la historia infla
    // el desvío y hace que el siguiente outlier pase inadvertido. La mediana y
    // la MAD no se dejan arrastrar — que es todo el motivo de usarlas.
    const conOutlier = [...historico, '900000000'];
    expect(esImporteAtipico('5000000', conOutlier)).toBe(true);
  });

  it('con un abono fijo, exige un desvío grande antes de marcar', () => {
    const fijo = Array.from({ length: 10 }, () => '100000');
    expect(esImporteAtipico('100050', fijo)).toBe(false);
    expect(esImporteAtipico('300000', fijo)).toBe(true);
  });

  it('funciona con importes por encima de 2^53', () => {
    const grandes = Array.from({ length: 10 }, () => '9007199254740993');
    // Si esto pasara por `number`, los dos valores serían indistinguibles.
    expect(esImporteAtipico('9007199254740993', grandes)).toBe(false);
    expect(esImporteAtipico('90071992547409930', grandes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agente
// ---------------------------------------------------------------------------

describe('ClassificationAgent', () => {
  it('produce una propuesta y registra el hash del prompt usado', async () => {
    const provider = new MockLLMProvider({ respuestas: [{ output: SALIDA_OK }] });
    const agente = new ClassificationAgent({ provider });

    const resultado = await agente.clasificar(contexto());
    expect(resultado.estado).toBe('PROPUESTA');
    if (resultado.estado !== 'PROPUESTA') return;

    expect(resultado.propuesta.output.cuentaId).toBe('acc-1');
    expect(resultado.propuesta.promptHash).toBe(CLASSIFICATION_V1.hash);
    // El hash resuelve a un prompt archivado, no a algo que ya no existe.
    expect(promptPorHash(resultado.propuesta.promptHash)?.name).toBe('classification');
  });

  it('le manda al proveedor temperatura 0 y el plan de cuentas real', async () => {
    const provider = new MockLLMProvider({ respuestas: [{ output: SALIDA_OK }] });
    await new ClassificationAgent({ provider }).clasificar(contexto());

    const pedido = provider.pedidos[0]!;
    expect(pedido.temperature).toBe(0);
    const propiedades = pedido.schema['properties'] as Record<string, Record<string, unknown>>;
    expect(propiedades['cuentaCodigo']!['enum']).toContain('5.1.01');
    // El prompt de sistema no enseña contabilidad: la lógica vive en el dominio.
    expect(pedido.system).toBe(CLASSIFICATION_V1.texto);
  });

  it('repregunta con contexto ampliado cuando la confianza es baja', async () => {
    const provider = new MockLLMProvider({
      respuestas: [
        { output: { ...SALIDA_OK, confianza: 0.4 } },
        { output: { ...SALIDA_OK, confianza: 0.93 } },
      ],
    });
    const resultado = await new ClassificationAgent({ provider }).clasificar(contexto());

    expect(provider.pedidos).toHaveLength(2);
    expect(provider.pedidos[1]!.messages).toHaveLength(2);
    if (resultado.estado !== 'PROPUESTA') throw new Error('esperaba propuesta');
    expect(resultado.propuesta.pasadas).toBe(2);
  });

  it('NO repregunta cuando lo que bloquea es un hecho', async () => {
    // Repreguntar no va a hacer que el proveedor deje de ser nuevo. Sería gastar
    // una llamada para llegar exactamente al mismo lugar.
    const provider = new MockLLMProvider({
      respuestas: [{ output: { ...SALIDA_OK, confianza: 0.2 } }],
    });
    await new ClassificationAgent({ provider }).clasificar(
      contexto({ hechos: { ...HECHOS_LIMPIOS, proveedorConocido: false } }),
    );
    expect(provider.pedidos).toHaveLength(1);
  });

  it('sin proveedor de IA, sugiere con la historia de la empresa', async () => {
    const agente = new ClassificationAgent({ provider: new NullLLMProvider() });
    const resultado = await agente.clasificar(
      contexto({
        preferencias: [
          {
            signal: 'proveedor:30712345671',
            cuentaId: 'acc-2',
            cuentaCodigo: '5.1.02',
            vecesConfirmada: 12,
            ultimaConfirmacion: null,
          },
        ],
      }),
    );

    expect(resultado.estado).toBe('PROPUESTA');
    if (resultado.estado !== 'PROPUESTA') return;
    expect(resultado.propuesta.output.cuentaCodigo).toBe('5.1.02');
    expect(resultado.propuesta.modelProvider).toBe('DETERMINISTIC');
    expect(resultado.propuesta.normativeSources).toHaveLength(0);
    // Una frecuencia no es un fundamento: nunca llega a aprobación en lote.
    expect(resultado.propuesta.triage.band).not.toBe('ALTA');
  });

  it('sin proveedor y sin historia, no inventa una sugerencia', async () => {
    const agente = new ClassificationAgent({ provider: new NullLLMProvider() });
    const resultado = await agente.clasificar(contexto());
    expect(resultado.estado).toBe('SIN_SUGERENCIA');
    if (resultado.estado !== 'SIN_SUGERENCIA') return;
    expect(resultado.motivo).toBe('IA_DESHABILITADA');
  });

  it('si el modelo se abstiene, todavía puede responder la historia de la empresa', async () => {
    const provider = new MockLLMProvider({
      respuestas: [{ output: { ...SALIDA_OK, abstencion: true } }],
    });
    const resultado = await new ClassificationAgent({ provider }).clasificar(
      contexto({
        preferencias: [
          {
            signal: 'proveedor:30712345671',
            cuentaId: 'acc-1',
            cuentaCodigo: '5.1.01',
            vecesConfirmada: 3,
            ultimaConfirmacion: null,
          },
        ],
      }),
    );
    if (resultado.estado !== 'PROPUESTA') throw new Error('esperaba propuesta');
    expect(resultado.propuesta.modelProvider).toBe('DETERMINISTIC');
  });

  it('una preferencia que apunta a una cuenta ya no imputable se descarta', async () => {
    const agente = new ClassificationAgent({ provider: new NullLLMProvider() });
    const resultado = await agente.clasificar(
      contexto({
        preferencias: [
          {
            signal: 'proveedor:30712345671',
            cuentaId: 'acc-4', // la de agrupación
            cuentaCodigo: '5.1',
            vecesConfirmada: 30,
            ultimaConfirmacion: null,
          },
        ],
      }),
    );
    expect(resultado.estado).toBe('SIN_SUGERENCIA');
  });

  it('devuelve el rechazo cuando el modelo inventó algo', async () => {
    const provider = new MockLLMProvider({
      respuestas: [{ output: { ...SALIDA_OK, citas: [{ normVersionId: 'inventada' }] } }],
    });
    const resultado = await new ClassificationAgent({ provider }).clasificar(contexto());
    expect(resultado.estado).toBe('SIN_SUGERENCIA');
    if (resultado.estado !== 'SIN_SUGERENCIA') return;
    expect(resultado.motivo).toBe('PROPUESTA_RECHAZADA');
    expect(resultado.rechazo?.esAlucinacion).toBe(true);
  });

  it('sin cuentas imputables lo dice, en vez de proponer cualquier cosa', async () => {
    const provider = new MockLLMProvider({ respuestas: [{ output: SALIDA_OK }] });
    const resultado = await new ClassificationAgent({ provider }).clasificar(
      contexto({ cuentas: CUENTAS.filter((cuenta) => !cuenta.imputable) }),
    );
    expect(resultado.estado).toBe('SIN_SUGERENCIA');
    if (resultado.estado !== 'SIN_SUGERENCIA') return;
    expect(resultado.motivo).toBe('SIN_CUENTAS_IMPUTABLES');
    expect(provider.pedidos).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Aprendizaje
// ---------------------------------------------------------------------------

describe('aprendizaje por empresa', () => {
  it('la señal prefiere el CUIT, que es estable', () => {
    expect(signalDe(HECHOS_LIMPIOS)).toBe('proveedor:30712345671');
  });

  it('sin CUIT usa el concepto, normalizado', () => {
    const signal = signalDe({
      ...HECHOS_LIMPIOS,
      cuitEmisor: null,
      descripcion: 'Servicio de Conectividad — MARZO 2026',
    });
    // Sin tildes, sin puntuación, sin palabras vacías.
    expect(signal).toBe('concepto:conectividad marzo 2026');
  });

  it('sin CUIT ni concepto, no hay señal que acumular', () => {
    expect(signalDe({ ...HECHOS_LIMPIOS, cuitEmisor: null, descripcion: null })).toBeNull();
  });

  it('la confianza de una preferencia tiene techo, y está por debajo del umbral automático', () => {
    const sugerencia = sugerirPorPreferencia(
      HECHOS_LIMPIOS,
      [
        {
          signal: 'proveedor:30712345671',
          cuentaId: 'acc-1',
          cuentaCodigo: '5.1.01',
          vecesConfirmada: 500,
          ultimaConfirmacion: null,
        },
      ],
    );
    expect(sugerencia?.confianza).toBeLessThanOrEqual(TECHO_PREFERENCIA);
    expect(sugerencia?.confianza).toBeLessThan(POLITICA_POR_DEFECTO.autoThreshold);
  });

  it('una preferencia vieja pesa menos', () => {
    const ahora = new Date('2026-03-05T00:00:00Z');
    const reciente = sugerirPorPreferencia(
      HECHOS_LIMPIOS,
      [preferencia('2026-01-05T00:00:00Z')],
      ahora,
    );
    const antigua = sugerirPorPreferencia(
      HECHOS_LIMPIOS,
      [preferencia('2021-01-05T00:00:00Z')],
      ahora,
    );
    expect(antigua!.confianza).toBeLessThan(reciente!.confianza);
  });

  it('la corrección del contador vale más que una aprobación', () => {
    const cambios = cambiosPorRevision({
      hechos: HECHOS_LIMPIOS,
      decision: 'MODIFICADA',
      cuentaPropuestaId: 'acc-1',
      cuentaFinalId: 'acc-2',
    });
    expect(cambios).toEqual([
      { signal: 'proveedor:30712345671', cuentaId: 'acc-1', delta: -1, confirmar: false },
      { signal: 'proveedor:30712345671', cuentaId: 'acc-2', delta: 2, confirmar: true },
    ]);
  });

  it('un rechazo resta, no borra', () => {
    const cambios = cambiosPorRevision({
      hechos: HECHOS_LIMPIOS,
      decision: 'RECHAZADA',
      cuentaPropuestaId: 'acc-1',
    });
    expect(cambios[0]?.delta).toBe(-1);
  });

  it('el aprendizaje NO puede levantar un bloqueo duro', async () => {
    // Es el límite del §14 visto desde el comportamiento: por más que la empresa
    // haya imputado a esta cuenta cien veces, si el proveedor es apócrifo el
    // comprobante va a revisión profesional igual.
    const agente = new ClassificationAgent({ provider: new NullLLMProvider() });
    const resultado = await agente.clasificar(
      contexto({
        hechos: { ...HECHOS_LIMPIOS, proveedorApocrifo: true },
        preferencias: [
          {
            signal: 'proveedor:30712345671',
            cuentaId: 'acc-1',
            cuentaCodigo: '5.1.01',
            vecesConfirmada: 100,
            ultimaConfirmacion: null,
          },
        ],
      }),
    );
    if (resultado.estado !== 'PROPUESTA') throw new Error('esperaba propuesta');
    expect(resultado.propuesta.triage.band).toBe('BAJA');
    expect(resultado.propuesta.triage.hardBlocks).toContain('PROVEEDOR_APOCRIFO');
  });
});

function preferencia(ultimaConfirmacion: string) {
  return {
    signal: 'proveedor:30712345671',
    cuentaId: 'acc-1',
    cuentaCodigo: '5.1.01',
    vecesConfirmada: 10,
    ultimaConfirmacion,
  };
}
