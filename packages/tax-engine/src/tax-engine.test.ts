/**
 * Tests del motor de IVA.
 *
 * Los primeros dos `describe` prueban las dos negativas del módulo, que son su
 * contenido real: que sin alícuotas relevadas el motor no supone 21%, y que
 * sobre un crédito fiscal nunca dice `COMPUTABLE`.
 */

import { describe, expect, it } from 'vitest';
import { money, parseCalendarDate, zero, type CalendarDate, type Money } from '@aai/shared';
import {
  armarLibroIvaDigital,
  comoSubdiarioDeclarado,
  construirSubdiario,
  evaluarCreditoFiscal,
  identificarAlicuota,
  ivaSegunAlicuota,
  puedeGenerarArchivoDeImportacion,
  puedePresentarPorElContribuyente,
  signoDe,
  vencimientoDe,
  verificarIvaDeclarado,
  type AlicuotaRelevada,
  type ComprobanteIva,
  type RenglonIva,
} from './index.js';

const fecha = (iso: string): CalendarDate => parseCalendarDate(iso);
const pesos = (centavos: bigint): Money => money(centavos, 'ARS');

/**
 * Un catálogo de prueba.
 *
 * Existe SOLO en los tests. En producción `tax_rates` está vacía hasta que
 * alguien archive la Ley 23.349, y ese es el punto de la mitad de este archivo.
 */
const GENERAL: AlicuotaRelevada = {
  id: 'rate-general',
  numerador: 21n,
  denominador: 100n,
  etiqueta: '21%',
  vigenteDesde: fecha('2020-01-01'),
  vigenteHasta: null,
  normVersionId: 'nv-ficticia',
};

const REDUCIDA: AlicuotaRelevada = {
  ...GENERAL,
  id: 'rate-reducida',
  numerador: 105n,
  denominador: 1000n,
  etiqueta: '10,5%',
};

const CATALOGO = [GENERAL, REDUCIDA];

function renglon(overrides: Partial<RenglonIva> = {}): RenglonIva {
  return {
    neto: zero('ARS'),
    iva: zero('ARS'),
    noGravado: zero('ARS'),
    exento: zero('ARS'),
    alicuotaId: null,
    ...overrides,
  };
}

function comprobante(overrides: Partial<ComprobanteIva> = {}): ComprobanteIva {
  const renglones = overrides.renglones ?? [
    renglon({ neto: pesos(100_000n), iva: pesos(21_000n) }),
  ];
  const total =
    overrides.total ??
    pesos(
      renglones.reduce(
        (acc, r) => acc + r.neto.amount + r.iva.amount + r.noGravado.amount + r.exento.amount,
        0n,
      ) + (overrides.percepciones?.amount ?? 0n),
    );
  return {
    id: 'cbte-1',
    direccion: 'COMPRAS',
    tipoComprobante: 1,
    clase: 'FACTURA',
    puntoVenta: 1,
    numero: 45231,
    fecha: fecha('2026-03-10'),
    cuitContraparte: '30500010912',
    razonSocialContraparte: 'Proveedor S.A.',
    condicionContraparte: 'RESPONSABLE_INSCRIPTO',
    percepciones: zero('ARS'),
    constatacion: 'OK',
    emisorApocrifo: false,
    entryId: 'je-1',
    documentId: 'doc-1',
    ...overrides,
    renglones,
    total,
  };
}

// ---------------------------------------------------------------------------
// La primera negativa: sin alícuota relevada, no se supone 21%
// ---------------------------------------------------------------------------

describe('el motor no supone la alícuota general', () => {
  it('sin catálogo devuelve SIN_ALICUOTAS_RELEVADAS, no 21%', () => {
    const resultado = identificarAlicuota(pesos(100_000n), pesos(21_000n), [], fecha('2026-03-10'));

    expect(resultado.alicuota).toBeNull();
    expect(resultado.hallazgos[0]?.codigo).toBe('SIN_ALICUOTAS_RELEVADAS');
    expect(resultado.hallazgos[0]?.bloquea).toBe(true);
    expect(resultado.hallazgos[0]?.mensaje).toMatch(/no supone 21%/);
    expect(resultado.hallazgos[0]?.mensaje).toMatch(/Ley 23\.349/);
  });

  it('con catálogo identifica la alícuota exacta', () => {
    const general = identificarAlicuota(
      pesos(100_000n),
      pesos(21_000n),
      CATALOGO,
      fecha('2026-03-10'),
    );
    const reducida = identificarAlicuota(
      pesos(100_000n),
      pesos(10_500n),
      CATALOGO,
      fecha('2026-03-10'),
    );

    expect(general.alicuota?.id).toBe('rate-general');
    expect(reducida.alicuota?.id).toBe('rate-reducida');
  });

  it('no elige la más cercana cuando ninguna da', () => {
    const resultado = identificarAlicuota(
      pesos(100_000n),
      pesos(19_000n),
      CATALOGO,
      fecha('2026-03-10'),
    );

    expect(resultado.alicuota).toBeNull();
    expect(resultado.hallazgos[0]?.codigo).toBe('ALICUOTA_NO_IDENTIFICADA');
    // El mensaje enumera las que sí hay: sirve para decidir qué falta relevar.
    expect(resultado.hallazgos[0]?.mensaje).toContain('21%');
    expect(resultado.hallazgos[0]?.mensaje).toContain('10,5%');
  });

  it('admite el centavo de redondeo del emisor, y nada más', () => {
    const unCentavo = identificarAlicuota(
      pesos(100_000n),
      pesos(20_999n),
      CATALOGO,
      fecha('2026-03-10'),
    );
    const dosCentavos = identificarAlicuota(
      pesos(100_000n),
      pesos(20_998n),
      CATALOGO,
      fecha('2026-03-10'),
    );

    expect(unCentavo.alicuota?.id).toBe('rate-general');
    expect(dosCentavos.alicuota).toBeNull();
  });

  it('respeta la vigencia de la alícuota: el §6 también rige acá', () => {
    const antigua: AlicuotaRelevada = {
      ...GENERAL,
      id: 'rate-vieja',
      vigenteDesde: fecha('2010-01-01'),
      vigenteHasta: fecha('2019-12-31'),
    };

    const en2015 = identificarAlicuota(
      pesos(100_000n),
      pesos(21_000n),
      [antigua, GENERAL],
      fecha('2015-06-01'),
    );
    const en2026 = identificarAlicuota(
      pesos(100_000n),
      pesos(21_000n),
      [antigua, GENERAL],
      fecha('2026-03-10'),
    );

    expect(en2015.alicuota?.id).toBe('rate-vieja');
    expect(en2026.alicuota?.id).toBe('rate-general');
  });

  it('un IVA sobre un neto de cero no lo produce ninguna alícuota', () => {
    const resultado = identificarAlicuota(zero('ARS'), pesos(500n), CATALOGO, fecha('2026-03-10'));

    expect(resultado.alicuota).toBeNull();
    expect(resultado.hallazgos[0]?.codigo).toBe('IVA_INCOHERENTE_CON_ALICUOTA');
  });

  it('un renglón íntegramente exento no genera hallazgo', () => {
    const resultado = identificarAlicuota(zero('ARS'), zero('ARS'), CATALOGO, fecha('2026-03-10'));

    expect(resultado.alicuota).toBeNull();
    expect(resultado.hallazgos).toEqual([]);
  });

  it('el cálculo es entero y redondea al centavo más cercano', () => {
    // 1.000,10 al 21% = 210,021 → 210,02. Trunca la fracción, no la arrastra.
    expect(ivaSegunAlicuota(pesos(100_010n), GENERAL).amount).toBe(21_002n);
    // 0,50 al 21% = 0,105 → 0,11: el empate va para arriba.
    expect(ivaSegunAlicuota(pesos(50n), GENERAL).amount).toBe(11n);
    // Y sobre un importe negativo redondea simétrico, no hacia cero. Sin el
    // valor absoluto, la división de bigint daría -10 y una nota de crédito
    // devolvería un centavo menos del que retuvo la factura.
    expect(ivaSegunAlicuota(pesos(-50n), GENERAL).amount).toBe(-11n);
  });

  it('un comprobante que declara una alícuota y no le cierra es un hallazgo', () => {
    const hallazgos = verificarIvaDeclarado(pesos(100_000n), pesos(15_000n), GENERAL);

    expect(hallazgos).toHaveLength(1);
    expect(hallazgos[0]?.codigo).toBe('IVA_INCOHERENTE_CON_ALICUOTA');
    expect(hallazgos[0]?.mensaje).toContain('21%');
    expect(hallazgos[0]?.mensaje).toContain('6000');
  });
});

// ---------------------------------------------------------------------------
// La segunda negativa: el crédito fiscal nunca es COMPUTABLE
// ---------------------------------------------------------------------------

describe('el motor nunca dice que un crédito fiscal sea computable', () => {
  it('con todo en orden devuelve NO_DETERMINABLE y dice qué falta', () => {
    const evaluacion = evaluarCreditoFiscal(comprobante(), CATALOGO);

    expect(evaluacion.estado).toBe('NO_DETERMINABLE');
    expect(evaluacion.hallazgos).toEqual([]);
    expect(evaluacion.ivaDiscriminado.amount).toBe(21_000n);
    expect(evaluacion.faltaRelevar.join(' ')).toMatch(/Ley 23\.349/);
    expect(evaluacion.mensaje).toMatch(/NO está determinada/);
    expect(evaluacion.mensaje).toMatch(/Lo decide el profesional/);
  });

  it('distingue el comprobante rechazado del no consultado', () => {
    const rechazado = evaluarCreditoFiscal(comprobante({ constatacion: 'FAIL' }), CATALOGO);
    const sinConsultar = evaluarCreditoFiscal(
      comprobante({ constatacion: 'NO_CONSULTADO' }),
      CATALOGO,
    );

    expect(rechazado.hallazgos[0]?.codigo).toBe('CONSTATACION_NO_OK');
    expect(sinConsultar.hallazgos[0]?.codigo).toBe('CONSTATACION_NO_CONSULTADA');
    expect(sinConsultar.hallazgos[0]?.mensaje).toMatch(/no es lo mismo que no válido/);
    expect(rechazado.estado).toBe('IMPEDIDO_POR_FORMA');
  });

  it('un emisor apócrifo bloquea; uno sin verificar avisa sin bloquear', () => {
    const apocrifo = evaluarCreditoFiscal(comprobante({ emisorApocrifo: true }), CATALOGO);
    const sinDato = evaluarCreditoFiscal(comprobante({ emisorApocrifo: null }), CATALOGO);

    expect(apocrifo.estado).toBe('IMPEDIDO_POR_FORMA');
    expect(sinDato.estado).toBe('NO_DETERMINABLE');
    expect(sinDato.hallazgos[0]?.codigo).toBe('EMISOR_SIN_VERIFICAR');
    expect(sinDato.hallazgos[0]?.bloquea).toBe(false);
    expect(sinDato.hallazgos[0]?.mensaje).toMatch(/no se asume que esté limpio/);
  });

  it('un comprobante sin IVA discriminado no genera crédito', () => {
    const evaluacion = evaluarCreditoFiscal(
      comprobante({
        renglones: [renglon({ neto: pesos(100_000n) })],
      }),
      CATALOGO,
    );

    expect(evaluacion.hallazgos[0]?.codigo).toBe('IVA_NO_DISCRIMINADO');
    expect(evaluacion.hallazgos[0]?.renglon).toBe(1);
    expect(evaluacion.estado).toBe('IMPEDIDO_POR_FORMA');
  });

  it('el total tiene que ser la suma de sus partes, sin tolerancia', () => {
    const evaluacion = evaluarCreditoFiscal(
      comprobante({
        renglones: [renglon({ neto: pesos(100_000n), iva: pesos(21_000n) })],
        total: pesos(121_001n),
      }),
      CATALOGO,
    );

    const hallazgo = evaluacion.hallazgos.find((h) => h.codigo === 'TOTAL_NO_CIERRA');
    expect(hallazgo?.mensaje).toMatch(/concepto que el sistema no está leyendo/);
  });

  it('una percepción entra en el total y no lo descuadra', () => {
    const evaluacion = evaluarCreditoFiscal(
      comprobante({
        renglones: [renglon({ neto: pesos(100_000n), iva: pesos(21_000n) })],
        percepciones: pesos(3_000n),
        total: pesos(124_000n),
      }),
      CATALOGO,
    );

    expect(evaluacion.hallazgos.some((h) => h.codigo === 'TOTAL_NO_CIERRA')).toBe(false);
  });

  it('sin alícuotas relevadas queda impedido, sin llegar a la cuestión de fondo', () => {
    const evaluacion = evaluarCreditoFiscal(comprobante(), []);

    expect(evaluacion.estado).toBe('IMPEDIDO_POR_FORMA');
    expect(evaluacion.hallazgos[0]?.codigo).toBe('SIN_ALICUOTAS_RELEVADAS');
    expect(evaluacion.mensaje).toMatch(/no se puede llegar a la cuestión de fondo/i);
  });
});

// ---------------------------------------------------------------------------
// Subdiarios
// ---------------------------------------------------------------------------

describe('subdiarios de IVA', () => {
  const opciones = {
    companyId: 'co-1',
    direccion: 'COMPRAS' as const,
    anio: 2026,
    mes: 3,
    desde: fecha('2026-03-01'),
    hasta: fecha('2026-03-31'),
    moneda: 'ARS' as const,
    catalogo: CATALOGO,
  };

  const factura = comprobante({ id: 'f-1', numero: 1, fecha: fecha('2026-03-05') });
  const notaDeCredito = comprobante({
    id: 'nc-1',
    numero: 2,
    fecha: fecha('2026-03-20'),
    tipoComprobante: 3,
    clase: 'NOTA_CREDITO',
    // Al 10,5%: 50.000,00 × 10,5% = 5.250,00. Una alícuota distinta a la de la
    // factura, para que el total por alícuota tenga dos filas.
    renglones: [renglon({ neto: pesos(50_000n), iva: pesos(5_250n) })],
  });

  it('la nota de crédito resta del período', () => {
    const subdiario = construirSubdiario([factura, notaDeCredito], opciones);

    expect(subdiario.renglones).toHaveLength(2);
    expect(subdiario.totalNeto.amount).toBe(50_000n);
    expect(subdiario.totalIva.amount).toBe(15_750n);
    // Y el renglón de la NC está guardado en negativo, no en una columna aparte.
    const nc = subdiario.renglones.find((r) => r.comprobanteId === 'nc-1');
    expect(nc?.neto.amount).toBe(-50_000n);
  });

  it('un tipo de comprobante fuera del catálogo no se supone que suma', () => {
    const desconocido = comprobante({
      id: 'x-1',
      numero: 3,
      tipoComprobante: 991,
      clase: null,
      fecha: fecha('2026-03-25'),
    });

    const subdiario = construirSubdiario([factura, desconocido], opciones);

    expect(subdiario.excluidos).toHaveLength(1);
    expect(subdiario.excluidos[0]?.motivo).toMatch(/no está en el catálogo/);
    expect(subdiario.excluidos[0]?.motivo).toMatch(/suponer que suma infla el período/);
    // Está excluido del total, pero el renglón sigue visible con su hallazgo.
    expect(subdiario.totalNeto.amount).toBe(100_000n);
    expect(subdiario.renglones).toHaveLength(2);
    expect(
      subdiario.renglones.find((r) => r.comprobanteId === 'x-1')?.hallazgos[0]?.codigo,
    ).toBe('TIPO_COMPROBANTE_DESCONOCIDO');
  });

  it('totaliza por alícuota y muestra aparte lo que no pudo identificar', () => {
    const raro = comprobante({
      id: 'r-1',
      numero: 4,
      fecha: fecha('2026-03-26'),
      renglones: [renglon({ neto: pesos(100_000n), iva: pesos(19_000n) })],
    });

    const subdiario = construirSubdiario([factura, notaDeCredito, raro], opciones);
    const etiquetas = subdiario.porAlicuota.map((total) => total.etiqueta);

    expect(etiquetas).toContain('21%');
    expect(etiquetas).toContain('10,5%');
    // El de alícuota no identificada quedó excluido del total, así que no
    // aparece: si apareciera bajo SIN IDENTIFICAR, estaría sumando al período.
    expect(subdiario.excluidos.map((e) => e.comprobanteId)).toEqual(['r-1']);
  });

  it('ignora lo de otra dirección y lo de fuera del mes', () => {
    const venta = comprobante({ id: 'v-1', direccion: 'VENTAS', numero: 9 });
    const abril = comprobante({ id: 'a-1', numero: 10, fecha: fecha('2026-04-02') });

    const subdiario = construirSubdiario([factura, venta, abril], opciones);

    expect(subdiario.renglones.map((r) => r.comprobanteId)).toEqual(['f-1']);
  });

  it('ordena por fecha, punto de venta y número', () => {
    const tarde = comprobante({ id: 't-1', numero: 1, fecha: fecha('2026-03-28') });
    const temprano = comprobante({ id: 'e-1', numero: 1, fecha: fecha('2026-03-02') });

    const subdiario = construirSubdiario([tarde, temprano], opciones);

    expect(subdiario.renglones.map((r) => r.comprobanteId)).toEqual(['e-1', 't-1']);
  });

  it('el signo lo decide la clase, no el código', () => {
    expect(signoDe('NOTA_CREDITO')).toBe(-1n);
    expect(signoDe('FACTURA')).toBe(1n);
    expect(signoDe('NOTA_DEBITO')).toBe(1n);
    expect(signoDe(null)).toBeNull();
  });

  it('se declara como subdiario del art. 327 con su hash', () => {
    const subdiario = construirSubdiario([factura], opciones);
    const declarado = comoSubdiarioDeclarado(subdiario, 'a'.repeat(64));

    expect(declarado.journalCode).toBe('COMPRAS');
    expect(declarado.desde).toBe('2026-03-01');
    expect(declarado.hasta).toBe('2026-03-31');
    expect(declarado.referencia).toContain('sha256:');
    expect(declarado.nombre).toBe('Subdiario de IVA Compras 2026-03');
  });
});

describe('casos que se dan todos los días y suelen quedar sin probar', () => {
  const opciones = {
    companyId: 'co-1',
    direccion: 'COMPRAS' as const,
    anio: 2026,
    mes: 3,
    desde: fecha('2026-03-01'),
    hasta: fecha('2026-03-31'),
    moneda: 'ARS' as const,
    catalogo: CATALOGO,
  };

  it('cuando el comprobante ya dice su alícuota, no se vuelve a deducir', () => {
    const conAlicuota = comprobante({
      renglones: [renglon({ neto: pesos(100_000n), iva: pesos(21_000n), alicuotaId: 'rate-general' })],
    });

    const subdiario = construirSubdiario([conAlicuota], opciones);
    expect(subdiario.renglones[0]?.alicuotaId).toBe('rate-general');
    expect(subdiario.excluidos).toEqual([]);

    // Y si lo que dice no le cierra, es un hallazgo: el comprobante está mal
    // emitido y llevarlo así al subdiario traslada el error a la DDJJ.
    const mentiroso = comprobante({
      renglones: [renglon({ neto: pesos(100_000n), iva: pesos(10_500n), alicuotaId: 'rate-general' })],
    });
    const evaluacion = evaluarCreditoFiscal(mentiroso, CATALOGO);
    expect(evaluacion.hallazgos[0]?.codigo).toBe('IVA_INCOHERENTE_CON_ALICUOTA');
  });

  it('una compra íntegramente exenta entra al subdiario sin hallazgos', () => {
    const exenta = comprobante({
      id: 'ex-1',
      renglones: [renglon({ exento: pesos(80_000n) })],
    });

    const subdiario = construirSubdiario([exenta], opciones);

    expect(subdiario.excluidos).toEqual([]);
    expect(subdiario.totalExento.amount).toBe(80_000n);
    expect(subdiario.totalIva.amount).toBe(0n);
    expect(subdiario.renglones[0]?.hallazgos).toEqual([]);
  });

  it('dos comprobantes del mismo día se ordenan por punto de venta', () => {
    const pv5 = comprobante({ id: 'a', puntoVenta: 5, numero: 1, fecha: fecha('2026-03-07') });
    const pv2 = comprobante({ id: 'b', puntoVenta: 2, numero: 9, fecha: fecha('2026-03-07') });

    const subdiario = construirSubdiario([pv5, pv2], opciones);

    expect(subdiario.renglones.map((r) => r.comprobanteId)).toEqual(['b', 'a']);
  });

  it('la fila SIN IDENTIFICAR existe para lo que entró sin alícuota', () => {
    // Un renglón sin IVA y sin neto no bloquea, pero tampoco tiene alícuota:
    // termina en la fila SIN IDENTIFICAR, que es donde se lo ve.
    const soloNoGravado = comprobante({
      id: 'ng-1',
      renglones: [renglon({ noGravado: pesos(40_000n) })],
    });

    const subdiario = construirSubdiario([soloNoGravado], opciones);
    const sinIdentificar = subdiario.porAlicuota.find((t) => t.alicuotaId === null);

    expect(sinIdentificar?.etiqueta).toBe('SIN IDENTIFICAR');
    expect(subdiario.totalNoGravado.amount).toBe(40_000n);
  });

  it('una constatación WARN no es OK, y una que no se pudo completar tampoco', () => {
    const warn = evaluarCreditoFiscal(comprobante({ constatacion: 'WARN' }), CATALOGO);
    const noVerificable = evaluarCreditoFiscal(
      comprobante({ constatacion: 'NO_VERIFICABLE' }),
      CATALOGO,
    );

    expect(warn.hallazgos[0]?.codigo).toBe('CONSTATACION_NO_OK');
    expect(warn.hallazgos[0]?.mensaje).toContain('WARN');
    expect(noVerificable.hallazgos[0]?.codigo).toBe('CONSTATACION_NO_CONSULTADA');
    expect(noVerificable.hallazgos[0]?.mensaje).toMatch(/Reintentar antes de decidir/);
  });

  it('no saber la condición del emisor se avisa, sin bloquear la compra', () => {
    const evaluacion = evaluarCreditoFiscal(
      comprobante({ condicionContraparte: 'DESCONOCIDA' }),
      CATALOGO,
    );

    const hallazgo = evaluacion.hallazgos.find(
      (h) => h.codigo === 'CONDICION_CONTRAPARTE_DESCONOCIDA',
    );
    expect(hallazgo?.bloquea).toBe(false);
    expect(evaluacion.estado).toBe('NO_DETERMINABLE');
  });
});

// ---------------------------------------------------------------------------
// Libro de IVA Digital — RG 4597 T.O.
// ---------------------------------------------------------------------------

describe('Libro de IVA Digital (RG 4597 T.O. por RG 5707/2025)', () => {
  const base = {
    companyId: 'co-1',
    periodo: { anio: 2026, mes: 3 },
    comprobantesCompras: 12,
    comprobantesVentas: 30,
    excluidos: 0,
    periodoAnterior: { periodo: { anio: 2026, mes: 2 }, estado: 'GENERADO' as const },
  };

  it('el vencimiento es el día 15 del mes siguiente, corridos', () => {
    expect(vencimientoDe({ anio: 2026, mes: 3 })).toBe('2026-04-15');
    // Y cruza el año sin ayuda.
    expect(vencimientoDe({ anio: 2026, mes: 12 })).toBe('2027-01-15');
    // Febrero no cambia nada: el plazo cuenta sobre el mes siguiente.
    expect(vencimientoDe({ anio: 2028, mes: 2 })).toBe('2028-03-15');
  });

  it('sin operaciones corresponde la novedad SIN MOVIMIENTO', () => {
    const libro = armarLibroIvaDigital({
      ...base,
      comprobantesCompras: 0,
      comprobantesVentas: 0,
    });

    expect(libro.sinMovimiento).toBe(true);
    expect(libro.desde).toBe('2026-03-01');
    expect(libro.hasta).toBe('2026-03-31');
  });

  it('no se puede presentar si el período anterior no se generó', () => {
    const libro = armarLibroIvaDigital({
      ...base,
      periodoAnterior: { periodo: { anio: 2026, mes: 2 }, estado: 'PENDIENTE' },
    });

    const bloqueo = libro.bloqueos.find((b) => b.codigo === 'PERIODO_ANTERIOR_NO_GENERADO');
    expect(bloqueo?.mensaje).toContain('2026-02');
    expect(bloqueo?.fundamento).toMatch(/Art\. 12/);
  });

  it('SIN MOVIMIENTO del período anterior cuenta como generado', () => {
    const libro = armarLibroIvaDigital({
      ...base,
      periodoAnterior: { periodo: { anio: 2026, mes: 2 }, estado: 'SIN_MOVIMIENTO' },
    });

    expect(libro.bloqueos.some((b) => b.codigo === 'PERIODO_ANTERIOR_NO_GENERADO')).toBe(false);
  });

  it('para períodos anteriores al 01/12/2025 no determina quién está obligado', () => {
    const viejo = armarLibroIvaDigital({ ...base, periodo: { anio: 2024, mes: 8 } });
    const nuevo = armarLibroIvaDigital({ ...base, periodo: { anio: 2026, mes: 3 } });

    const bloqueo = viejo.bloqueos.find((b) => b.codigo === 'OBLIGACION_NO_DETERMINABLE');
    expect(bloqueo?.mensaje).toMatch(/NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE/);
    expect(bloqueo?.mensaje).toMatch(/RG 5133\/2021/);
    expect(bloqueo?.fundamento).toMatch(/Art\. 2°/);
    // El libro se arma igual: negarse a armarlo no ayudaría a nadie.
    expect(viejo.vencimiento).toBe('2024-09-15');
    expect(nuevo.bloqueos.some((b) => b.codigo === 'OBLIGACION_NO_DETERMINABLE')).toBe(false);
  });

  it('avisa cuando hay comprobantes excluidos de los totales', () => {
    const libro = armarLibroIvaDigital({ ...base, excluidos: 3 });

    const bloqueo = libro.bloqueos.find((b) => b.codigo === 'SUBDIARIO_CON_EXCLUIDOS');
    expect(bloqueo?.mensaje).toMatch(/declaración jurada incompleta/);
  });

  it('el libro lleva su fuente adentro, con los artículos', () => {
    const libro = armarLibroIvaDigital(base);

    expect(libro.fuente.norma).toContain('4597');
    expect(libro.fuente.modificadaPor).toContain('5707');
    expect(libro.fuente.articulos.periodicidad).toMatch(/Art\. 12/);
  });

  it('no genera el archivo de importación de ARCA, y explica por qué', () => {
    const negativa = puedeGenerarArchivoDeImportacion();

    expect(negativa.puede).toBe(false);
    expect(negativa.motivo).toMatch(/no están en la resolución/);
    expect(negativa.motivo).toMatch(/micrositio/);
    expect(negativa.fundamento).toMatch(/Art\. 8°/);
    expect(negativa.queHacer).toMatch(/Archivar los diseños de registro/);
  });

  it('no presenta el libro: haría falta la Clave Fiscal, que no se guarda', () => {
    const negativa = puedePresentarPorElContribuyente();

    expect(negativa.puede).toBe(false);
    expect(negativa.motivo).toMatch(/Clave Fiscal Nivel 3/);
    expect(negativa.motivo).toMatch(/no pide, no almacena y no usa/);
    expect(negativa.fundamento).toMatch(/Art\. 6°/);
  });
});
