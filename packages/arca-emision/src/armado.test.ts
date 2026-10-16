/**
 * E3 — del documento comercial al comprobante. Lo que se afirma, y por qué importa:
 *
 *   1. **La letra** sale de la RG 1415 (arts. 15 y 16) y se prueba entera, combinación por combinación.
 *   2. **Los códigos** (`CbteTipo`, condición del receptor, alícuotas, `DocTipo`) son los que contestó ARCA en homologación:
 *      se comparan contra el JSON archivado, no contra otra constante nuestra.
 *   3. **`ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA` por construcción**, con importes exactos
 *      (`0,10 + 0,20 = 0,30`) y para cualquier combinación de líneas.
 *   4. **Una factura C no manda el nodo `Iva`** (ni vacío), y una A/B sí.
 *   5. **Todo lo que impide armar sale junto**, no de a uno.
 *   6. **Lo que no se sabe no se supone**: condición desconocida, alícuota que no se deduce, moneda sin cotización.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withCheckDigit } from '@aai/shared';
import { describe, expect, it } from 'vitest';
import { endpointsFor } from '@aai/arca';
import {
  ALICUOTAS_DE_ARCA,
  CBTE_TIPO_FACTURA,
  CONDICIONES_ADMITIDAS_POR_LETRA,
  ClienteWsfev1,
  DOC_TIPO,
  armarComprobante,
  letraDeFactura,
  verificarDestinoDeEmision,
  type CondicionIvaDelSistema,
  type EntradaDeArmado,
  type LineaParaArmar,
} from './index.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TABLAS = JSON.parse(
  readFileSync(join(RAIZ, 'docs/normative-sources/extracted/arca-wsfev1-tablas-homologacion-2026-10-16.json'), 'utf8'),
) as {
  tiposDeComprobante: Array<{ Id: number; Desc: string }>;
  condicionesIvaReceptorA: Array<{ Id: number }>;
  condicionesIvaReceptorB: Array<{ Id: number }>;
  condicionesIvaReceptorC: Array<{ Id: number }>;
  tiposDeIva: Array<{ Id: string; Desc: string }>;
  tiposDeDocumento: Array<{ Id: number; Desc: string }>;
};

const CUIT_EMISOR = withCheckDigit('2045214832');
const CUIT_CLIENTE = withCheckDigit('3071234567');

const linea = (neto: string, iva = '0.00', extra: Partial<LineaParaArmar> = {}): LineaParaArmar => ({
  tipo: 'PRODUCTO',
  tratamiento: 'GRAVADO',
  neto,
  iva,
  ...extra,
});

function entrada(cambios: Partial<EntradaDeArmado> = {}): EntradaDeArmado {
  return {
    emisor: { cuit: CUIT_EMISOR, condicionIva: 'RESPONSABLE_INSCRIPTO' },
    receptor: { condicionIva: 'RESPONSABLE_INSCRIPTO', tipoDocumento: 'CUIT', numeroDocumento: CUIT_CLIENTE },
    clase: 'FACTURA',
    puntoDeVenta: 1,
    numero: 52,
    fecha: '2026-10-16',
    lineas: [linea('100.00', '21.00')],
    ...cambios,
  };
}

function armado(cambios: Partial<EntradaDeArmado> = {}) {
  const r = armarComprobante(entrada(cambios));
  if (!r.ok) throw new Error('se esperaba armar y no: ' + r.problemas.map((p) => p.codigo).join(', '));
  return r.comprobante;
}
const problemasDe = (cambios: Partial<EntradaDeArmado>): string[] => {
  const r = armarComprobante(entrada(cambios));
  return r.ok ? [] : r.problemas.map((p) => p.codigo);
};

const centavos = (t: string | number): bigint => BigInt(String(t).replace('.', ''));

describe('E3 · las tablas son las que contestó ARCA en homologación', () => {
  it('Factura A, B y C', () => {
    for (const [letra, id] of Object.entries(CBTE_TIPO_FACTURA)) {
      expect(TABLAS.tiposDeComprobante.find((t) => t.Id === id)?.Desc).toBe(`Factura ${letra}`);
    }
  });

  it('las condiciones del receptor admitidas por letra', () => {
    const set = (a: Array<{ Id: number }>) => [...a.map((x) => x.Id)].sort((x, y) => x - y);
    expect([...CONDICIONES_ADMITIDAS_POR_LETRA.A].sort((x, y) => x - y)).toEqual(set(TABLAS.condicionesIvaReceptorA));
    expect([...CONDICIONES_ADMITIDAS_POR_LETRA.B].sort((x, y) => x - y)).toEqual(set(TABLAS.condicionesIvaReceptorB));
    expect([...CONDICIONES_ADMITIDAS_POR_LETRA.C].sort((x, y) => x - y)).toEqual(set(TABLAS.condicionesIvaReceptorC));
  });

  it('las alícuotas: cada Id es el que ARCA da a ese porcentaje', () => {
    for (const a of ALICUOTAS_DE_ARCA) {
      const de = TABLAS.tiposDeIva.find((t) => t.Id === String(a.id));
      expect(de?.Desc, `Id ${a.id}`).toBe(`${a.porcentaje}%`);
    }
    expect(ALICUOTAS_DE_ARCA).toHaveLength(TABLAS.tiposDeIva.length);
  });

  it('los tipos de documento', () => {
    const desc = (id: number) => TABLAS.tiposDeDocumento.find((t) => t.Id === id)?.Desc;
    expect(desc(DOC_TIPO.CUIT)).toBe('CUIT');
    expect(desc(DOC_TIPO.CUIL)).toBe('CUIL');
    expect(desc(DOC_TIPO.DNI)).toBe('DNI');
    expect(desc(DOC_TIPO.PASAPORTE)).toBe('Pasaporte');
    expect(desc(DOC_TIPO.OTRO)).toBe('Doc. (Otro)');
  });
});

describe('E3 · la letra (RG 1415, arts. 15 y 16)', () => {
  const todas: CondicionIvaDelSistema[] = ['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL', 'NO_CATEGORIZADO', 'DESCONOCIDA'];
  const esperado: Record<string, string> = {
    'RESPONSABLE_INSCRIPTO→RESPONSABLE_INSCRIPTO': 'A',
    'RESPONSABLE_INSCRIPTO→MONOTRIBUTO': 'A',
    'RESPONSABLE_INSCRIPTO→EXENTO': 'B',
    'RESPONSABLE_INSCRIPTO→CONSUMIDOR_FINAL': 'B',
    'RESPONSABLE_INSCRIPTO→NO_CATEGORIZADO': 'B',
  };

  it.each(todas)('emisor responsable inscripto → receptor %s', (receptor) => {
    const r = letraDeFactura('RESPONSABLE_INSCRIPTO', receptor);
    const clave = `RESPONSABLE_INSCRIPTO→${receptor}`;
    if (esperado[clave] === undefined) {
      expect(r).toMatchObject({ ok: false, problema: { codigo: 'RECEPTOR_CONDICION_DESCONOCIDA' } });
    } else {
      expect(r).toEqual({ ok: true, letra: esperado[clave] });
    }
  });

  it.each(todas)('emisor monotributista o exento → C, sea cual sea el receptor (%s)', (receptor) => {
    expect(letraDeFactura('MONOTRIBUTO', receptor)).toEqual({ ok: true, letra: 'C' });
    expect(letraDeFactura('EXENTO', receptor)).toEqual({ ok: true, letra: 'C' });
  });

  it('un emisor sin condición declarada no emite: no se supone', () => {
    for (const e of ['DESCONOCIDA', 'CONSUMIDOR_FINAL', 'NO_CATEGORIZADO'] as const) {
      expect(letraDeFactura(e, 'RESPONSABLE_INSCRIPTO')).toMatchObject({ ok: false, problema: { codigo: 'EMISOR_CONDICION_NO_SOPORTADA' } });
    }
  });
});

describe('E3 · Factura C (monotributista o exento): sin IVA discriminado', () => {
  const base = (): Partial<EntradaDeArmado> => ({
    emisor: { cuit: CUIT_EMISOR, condicionIva: 'MONOTRIBUTO' },
    receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'DNI', numeroDocumento: '30111222' },
    lineas: [linea('129660.12')],
  });

  it('arma el tipo 11, con el total en ImpNeto, IVA en cero y SIN el nodo Iva', () => {
    const c = armado(base());
    expect(c.cabecera).toEqual({ CantReg: 1, PtoVta: 1, CbteTipo: 11 });
    expect(c.detalle).toEqual({
      Concepto: 1,
      DocTipo: 96,
      DocNro: '30111222',
      CbteDesde: 52,
      CbteHasta: 52,
      CbteFch: '20261016',
      ImpTotal: '129660.12',
      ImpTotConc: '0.00',
      ImpNeto: '129660.12',
      ImpOpEx: '0.00',
      ImpTrib: '0.00',
      ImpIVA: '0.00',
      MonId: 'PES',
      MonCotiz: '1',
      CondicionIVAReceptorId: 5,
    });
    expect('Iva' in c.detalle).toBe(false);
    expect(c.resumen).toMatchObject({ letra: 'C', cbteTipo: 11, condicionIvaReceptorId: 5, alicuotas: [] });
  });

  it('una línea con IVA en una factura C se rechaza: la C no discrimina', () => {
    expect(problemasDe({ ...base(), lineas: [linea('100.00', '21.00')] })).toEqual(['IVA_EN_FACTURA_C']);
  });

  it('el consumidor final sin identificar se arma como «Doc. (Otro)» 0 y avisa del umbral', () => {
    const c = armado({ ...base(), receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null } });
    expect(c.detalle).toMatchObject({ DocTipo: 99, DocNro: '0' });
    expect(c.avisos.join(' ')).toMatch(/identificar/u);
  });

  it('un monotributista puede facturarle a un responsable inscripto: sigue siendo C, con la condición 1', () => {
    const c = armado({ ...base(), receptor: { condicionIva: 'RESPONSABLE_INSCRIPTO', tipoDocumento: 'CUIT', numeroDocumento: CUIT_CLIENTE } });
    expect(c.resumen).toMatchObject({ letra: 'C', condicionIvaReceptorId: 1 });
    expect(c.detalle).toMatchObject({ DocTipo: 80, DocNro: CUIT_CLIENTE });
  });
});

describe('E3 · Factura A y B (emisor responsable inscripto): IVA discriminado', () => {
  it('A a un responsable inscripto: tipo 1, condición 1, Iva agrupado por alícuota', () => {
    const c = armado({ lineas: [linea('100.00', '21.00'), linea('50.00', '5.25'), linea('200.00', '42.00')] });
    expect(c.cabecera.CbteTipo).toBe(1);
    expect(c.detalle).toMatchObject({
      ImpNeto: '350.00',
      ImpIVA: '68.25',
      ImpTotal: '418.25',
      ImpTotConc: '0.00',
      ImpOpEx: '0.00',
      CondicionIVAReceptorId: 1,
      DocTipo: 80,
    });
    expect(c.detalle.Iva).toEqual([
      { Id: 5, BaseImp: '300.00', Importe: '63.00' },
      { Id: 4, BaseImp: '50.00', Importe: '5.25' },
    ].sort((a, b) => a.Id - b.Id));
    expect(c.avisos).toEqual([]);
  });

  it('A a un monotributista: tipo 1 y condición 6 (que la A admite)', () => {
    const c = armado({ receptor: { condicionIva: 'MONOTRIBUTO', tipoDocumento: 'CUIT', numeroDocumento: CUIT_CLIENTE } });
    expect(c.resumen).toMatchObject({ letra: 'A', cbteTipo: 1, condicionIvaReceptorId: 6 });
  });

  it('B a un consumidor final: tipo 6 y la condición 5, con el IVA igual informado a ARCA', () => {
    const c = armado({ receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'DNI', numeroDocumento: '30111222' } });
    expect(c.cabecera.CbteTipo).toBe(6);
    expect(c.detalle).toMatchObject({ CondicionIVAReceptorId: 5, ImpIVA: '21.00', ImpTotal: '121.00' });
    expect(c.detalle.Iva).toEqual([{ Id: 5, BaseImp: '100.00', Importe: '21.00' }]);
  });

  it('exento y no gravado van aparte y suman al total', () => {
    const c = armado({
      lineas: [linea('100.00', '21.00'), linea('40.00', '0.00', { tratamiento: 'EXENTO' }), linea('15.50', '0.00', { tratamiento: 'NO_GRAVADO' })],
    });
    expect(c.detalle).toMatchObject({ ImpNeto: '100.00', ImpOpEx: '40.00', ImpTotConc: '15.50', ImpIVA: '21.00', ImpTotal: '176.50' });
  });

  it('una línea gravada con IVA en cero es la alícuota 0 % (Id 3) y la base va en ImpNeto', () => {
    const c = armado({ lineas: [linea('80.00', '0.00')] });
    expect(c.detalle.Iva).toEqual([{ Id: 3, BaseImp: '80.00', Importe: '0.00' }]);
    expect(c.detalle).toMatchObject({ ImpNeto: '80.00', ImpIVA: '0.00', ImpTotal: '80.00' });
  });

  it('una A necesita receptor identificado por CUIT', () => {
    expect(problemasDe({ receptor: { condicionIva: 'RESPONSABLE_INSCRIPTO', tipoDocumento: 'DNI', numeroDocumento: '30111222' } })).toContain(
      'RECEPTOR_SIN_CUIT_PARA_FACTURA_A',
    );
  });

  it('una línea exenta o no gravada con IVA se rechaza', () => {
    expect(problemasDe({ lineas: [linea('10.00', '2.10', { tratamiento: 'EXENTO' })] })).toEqual(['LINEA_INVALIDA']);
  });
});

describe('E3 · la alícuota se deduce de forma exacta o se pide', () => {
  it.each([
    ['100.00', '21.00', 5],
    ['100.00', '10.50', 4],
    ['100.00', '27.00', 6],
    ['100.00', '5.00', 8],
    ['100.00', '2.50', 9],
    ['100.00', '0.00', 3],
  ])('neto %s con IVA %s → Id %i', (neto, iva, id) => {
    expect(armado({ lineas: [linea(neto, iva)] }).detalle.Iva).toEqual([{ Id: id, BaseImp: neto, Importe: iva }]);
  });

  it('un IVA que no es el de ninguna alícuota se rechaza y pide la alícuota', () => {
    const r = armarComprobante(entrada({ lineas: [linea('100.00', '15.00')] }));
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.problemas.map((p) => p.codigo)).toEqual(['ALICUOTA_NO_DEDUCIBLE']);
  });

  it('con la alícuota explícita se acepta («10,5» y «10.50» son lo mismo) y se comprueba que cierre', () => {
    expect(armado({ lineas: [linea('100.00', '10.50', { alicuota: '10,5' })] }).detalle.Iva).toEqual([{ Id: 4, BaseImp: '100.00', Importe: '10.50' }]);
    expect(armado({ lineas: [linea('100.00', '10.50', { alicuota: '10.50' })] }).detalle.Iva).toEqual([{ Id: 4, BaseImp: '100.00', Importe: '10.50' }]);
    expect(problemasDe({ lineas: [linea('100.00', '21.00', { alicuota: '10.5' })] })).toEqual(['ALICUOTA_NO_DEDUCIBLE']);
    expect(problemasDe({ lineas: [linea('100.00', '19.00', { alicuota: '19' })] })).toEqual(['ALICUOTA_DESCONOCIDA']);
  });
});

describe('E3 · los importes son exactos y el total se cumple por construcción', () => {
  it('0,10 + 0,20 = 0,30 (lo que un número de punto flotante no da)', () => {
    const c = armado({ lineas: [linea('0.10'), linea('0.20')], emisor: { cuit: CUIT_EMISOR, condicionIva: 'MONOTRIBUTO' } });
    expect(c.detalle.ImpTotal).toBe('0.30');
    expect(c.detalle.ImpNeto).toBe('0.30');
  });

  it('más de dos decimales en un importe se rechaza: no se trunca en silencio', () => {
    expect(problemasDe({ lineas: [linea('10.005', '2.10')] })).toEqual(['LINEA_INVALIDA']);
  });

  it('ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA, para cualquier combinación de líneas', () => {
    let semilla = 12345;
    const azar = (n: number): number => {
      semilla = (semilla * 1664525 + 1013904223) >>> 0;
      return semilla % n;
    };
    const tasas = [0, 5, 10.5, 21, 27];
    for (let caso = 0; caso < 300; caso += 1) {
      const lineas: LineaParaArmar[] = [];
      for (let i = 0, n = 1 + azar(6); i < n; i += 1) {
        const neto = BigInt(1 + azar(9_999_999)); // centavos
        const t = azar(8);
        if (t === 0) lineas.push({ tipo: 'PRODUCTO', tratamiento: 'EXENTO', neto: bigATexto(neto), iva: '0.00' });
        else if (t === 1) lineas.push({ tipo: 'SERVICIO', tratamiento: 'NO_GRAVADO', neto: bigATexto(neto), iva: '0.00' });
        else {
          const tasa = tasas[azar(tasas.length)]!;
          // IVA exacto = neto × tasa / 100 redondeado a mitad hacia arriba, con enteros.
          const num = neto * BigInt(Math.round(tasa * 10));
          const iva = (num + 500n) / 1000n;
          lineas.push({ tipo: 'PRODUCTO', tratamiento: 'GRAVADO', neto: bigATexto(neto), iva: bigATexto(iva), alicuota: String(tasa) });
        }
      }
      const hayServicio = lineas.some((l) => l.tipo === 'SERVICIO');
      const r = armarComprobante(
        entrada({
          lineas,
          ...(hayServicio ? { servicio: { desde: '2026-10-01', hasta: '2026-10-31', vencimientoDePago: '2026-11-10' } } : {}),
        }),
      );
      if (!r.ok) throw new Error(`caso ${caso}: ${r.problemas.map((p) => p.mensaje).join(' | ')}`);
      const d = r.comprobante.detalle;
      const suma = centavos(d.ImpTotConc) + centavos(d.ImpNeto) + centavos(d.ImpOpEx) + centavos(d.ImpTrib) + centavos(d.ImpIVA);
      expect(centavos(d.ImpTotal), `caso ${caso}`).toBe(suma);
      const ivaPorGrupos = (d.Iva ?? []).reduce((a, x) => a + centavos(x.Importe), 0n);
      expect(ivaPorGrupos, `caso ${caso}`).toBe(centavos(d.ImpIVA));
      const basePorGrupos = (d.Iva ?? []).reduce((a, x) => a + centavos(x.BaseImp), 0n);
      expect(basePorGrupos, `caso ${caso}`).toBe(centavos(d.ImpNeto));
    }
  });

  it('el redondeo línea por línea que no coincide con el del grupo se avisa, no se oculta', () => {
    const lineas = Array.from({ length: 10 }, () => linea('0.05', '0.01', { alicuota: '21' }));
    const c = armado({ lineas });
    expect(c.detalle.Iva).toEqual([{ Id: 5, BaseImp: '0.50', Importe: '0.10' }]);
    expect(c.avisos.join(' ')).toMatch(/redondeo/u);
  });
});

describe('E3 · concepto y período del servicio', () => {
  const servicio = { desde: '2026-10-01', hasta: '2026-10-31', vencimientoDePago: '2026-11-10' };
  const svc = (neto: string, iva: string): LineaParaArmar => ({ tipo: 'SERVICIO', tratamiento: 'GRAVADO', neto, iva });

  it('sólo productos → concepto 1 y no manda fechas de servicio', () => {
    const d = armado({ servicio }).detalle;
    expect(d.Concepto).toBe(1);
    expect('FchServDesde' in d).toBe(false);
  });

  it('sólo servicios → 2, con las tres fechas', () => {
    const d = armado({ lineas: [svc('100.00', '21.00')], servicio }).detalle;
    expect(d).toMatchObject({ Concepto: 2, FchServDesde: '20261001', FchServHasta: '20261031', FchVtoPago: '20261110' });
  });

  it('productos y servicios → 3', () => {
    expect(armado({ lineas: [linea('100.00', '21.00'), svc('50.00', '10.50')], servicio }).detalle.Concepto).toBe(3);
  });

  it('un servicio sin período se rechaza', () => {
    expect(problemasDe({ lineas: [svc('100.00', '21.00')] })).toEqual(['SERVICIO_SIN_PERIODO']);
  });

  it('un período al revés, o un vencimiento anterior al comprobante, se rechaza', () => {
    const l = [svc('100.00', '21.00')];
    expect(problemasDe({ lineas: l, servicio: { ...servicio, desde: '2026-11-01' } })).toEqual(['PERIODO_INVALIDO']);
    expect(problemasDe({ lineas: l, servicio: { ...servicio, vencimientoDePago: '2026-10-01' } })).toEqual(['PERIODO_INVALIDO']);
  });
});

describe('E3 · moneda, número, fecha, documentos y lo que todavía no se emite', () => {
  it('dólares: DOL y la cotización, que es obligatoria', () => {
    expect(armado({ moneda: 'USD', cotizacion: '1050.5' }).detalle).toMatchObject({ MonId: 'DOL', MonCotiz: '1050.5' });
    expect(problemasDe({ moneda: 'USD' })).toEqual(['COTIZACION_INVALIDA']);
    expect(problemasDe({ moneda: 'USD', cotizacion: '0' })).toEqual(['COTIZACION_INVALIDA']);
    expect(problemasDe({ moneda: 'USD', cotizacion: '1.1234567' })).toEqual(['COTIZACION_INVALIDA']);
  });

  it('otra moneda no se emite todavía', () => {
    expect(problemasDe({ moneda: 'EUR', cotizacion: '1' })).toContain('MONEDA_NO_SOPORTADA');
  });

  it('número, punto de venta y fecha inválidos', () => {
    expect(problemasDe({ numero: 0 })).toEqual(['NUMERO_INVALIDO']);
    expect(problemasDe({ puntoDeVenta: 100_000 })).toEqual(['PUNTO_DE_VENTA_INVALIDO']);
    expect(problemasDe({ fecha: '2026-02-30' })).toEqual(['FECHA_INVALIDA']);
  });

  it('documentos del receptor: CUIT inválido, DNI corto, sin identificar sólo para consumidor final, extranjero no', () => {
    const rec = (condicionIva: CondicionIvaDelSistema, tipoDocumento: 'CUIT' | 'DNI' | 'SIN_IDENTIFICAR' | 'DOC_EXTRANJERO', numeroDocumento: string | null) =>
      ({ receptor: { condicionIva, tipoDocumento, numeroDocumento } }) as Partial<EntradaDeArmado>;
    expect(problemasDe(rec('RESPONSABLE_INSCRIPTO', 'CUIT', CUIT_CLIENTE.slice(0, 10) + String((Number(CUIT_CLIENTE[10]) + 1) % 10)))).toContain('RECEPTOR_DOCUMENTO_INVALIDO');
    expect(problemasDe(rec('CONSUMIDOR_FINAL', 'DNI', '123'))).toContain('RECEPTOR_DOCUMENTO_INVALIDO');
    expect(problemasDe(rec('EXENTO', 'SIN_IDENTIFICAR', null))).toContain('RECEPTOR_DOCUMENTO_INVALIDO');
    expect(problemasDe(rec('CONSUMIDOR_FINAL', 'DOC_EXTRANJERO', 'X1'))).toContain('RECEPTOR_NO_SOPORTADO');
  });

  it('percepciones o tributos distintos de cero se rechazan: todavía no se arman', () => {
    expect(problemasDe({ percepciones: '10.00' })).toEqual(['PERCEPCIONES_NO_SOPORTADAS']);
    expect(armarComprobante(entrada({ percepciones: '0.00' })).ok).toBe(true);
  });

  it('sin líneas, y con total cero', () => {
    expect(problemasDe({ lineas: [] })).toContain('SIN_LINEAS');
    expect(problemasDe({ lineas: [linea('0.00')] })).toEqual(['IMPORTE_NO_POSITIVO']);
  });

  it('el CUIT del emisor se valida', () => {
    expect(problemasDe({ emisor: { cuit: '20-45214832-0', condicionIva: 'RESPONSABLE_INSCRIPTO' } })).toContain('EMISOR_INVALIDO');
  });

  it('todo lo que impide armar sale junto, no de a uno', () => {
    const p = problemasDe({
      emisor: { cuit: '11', condicionIva: 'RESPONSABLE_INSCRIPTO' },
      receptor: { condicionIva: 'DESCONOCIDA', tipoDocumento: 'CUIT', numeroDocumento: '1' },
      numero: 0,
      fecha: 'ayer',
      lineas: [],
    });
    expect(p).toEqual(
      expect.arrayContaining(['EMISOR_INVALIDO', 'RECEPTOR_CONDICION_DESCONOCIDA', 'RECEPTOR_DOCUMENTO_INVALIDO', 'NUMERO_INVALIDO', 'FECHA_INVALIDA', 'SIN_LINEAS']),
    );
  });
});

describe('E3 · lo armado viaja al sobre de WSFEv1 con los importes como texto exacto', () => {
  const HOMO = endpointsFor('homologacion');
  const permiso = verificarDestinoDeEmision({ ambiente: 'homologacion', endpointWsfev1: HOMO.wsfev1, endpointWsaa: HOMO.wsaa });
  const auth = { Token: 't', Sign: 's', Cuit: CUIT_EMISOR };

  async function sobreDe(e: Partial<EntradaDeArmado>): Promise<string> {
    const c = armado(e);
    const cuerpos: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      cuerpos.push(String(init.body));
      return new Response(
        '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FECAESolicitarResponse><FECAESolicitarResult>' +
          '<FeCabResp><Resultado>A</Resultado></FeCabResp></FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>',
        { status: 200, headers: { 'Content-Type': 'text/xml' } },
      );
    }) as unknown as typeof fetch;
    if (!permiso.permitido) throw new Error('permiso');
    await new ClienteWsfev1({ permiso, fetchImpl }).solicitarCae(auth, c.cabecera, [c.detalle]);
    return cuerpos[0]!;
  }

  it('una A manda Iva con Id, BaseImp e Importe y la condición del receptor', async () => {
    const xml = await sobreDe({ lineas: [linea('100.00', '21.00')] });
    expect(xml).toContain('<ar:CbteTipo>1</ar:CbteTipo>');
    expect(xml).toContain('<ar:ImpTotal>121.00</ar:ImpTotal>');
    expect(xml).toContain('<ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>100.00</ar:BaseImp><ar:Importe>21.00</ar:Importe></ar:AlicIva>');
    expect(xml).toContain('<ar:CondicionIVAReceptorId>1</ar:CondicionIVAReceptorId>');
  });

  it('una C no manda el nodo Iva', async () => {
    const xml = await sobreDe({
      emisor: { cuit: CUIT_EMISOR, condicionIva: 'MONOTRIBUTO' },
      receptor: { condicionIva: 'CONSUMIDOR_FINAL', tipoDocumento: 'SIN_IDENTIFICAR', numeroDocumento: null },
      lineas: [linea('1500.00')],
    });
    expect(xml).toContain('<ar:CbteTipo>11</ar:CbteTipo>');
    expect(xml).not.toContain('<ar:Iva>');
    expect(xml).toContain('<ar:ImpNeto>1500.00</ar:ImpNeto>');
  });
});

/** Centavos → texto decimal (sólo para armar entradas de prueba). */
function bigATexto(c: bigint): string {
  const s = c.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
