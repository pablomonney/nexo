/**
 * La decisión, y sobre todo cuándo se niega a proponer.
 *
 * El umbral de cobertura del motor contable es 95% porque sus negativas son lo
 * que lo hace confiable. Una rama que dice "acá no propongo" y que ningún test
 * ejercita es una promesa, no un candado.
 */

import { describe, expect, it } from 'vitest';
import { money } from '@aai/shared';
import {
  decidir,
  explicarDecision,
  hechosDocumentales,
  hechosTributarios,
  type ComprobanteNormalizado,
  type EntradaDeDecision,
  type LineaPropuesta,
  type ReferenciaNormativa,
  type ResultadoDeRegla,
} from './decision-de-comprobante.js';

const SHA = '180b1380c820cbabc572b707b540e9299e074423fcad4f69b920b06167eb3244';

const CITA: ReferenciaNormativa = {
  organismo: 'CONGRESO',
  norma: 'Ley 23.349',
  articulo: '12',
  inciso: 'a)',
  documentoSha256: SHA,
};

const COMPROBANTE: ComprobanteNormalizado = {
  taxTransactionId: 'tx-1',
  documentId: 'doc-1',
  companyId: 'co-1',
  direccion: 'VENTAS',
  cuitContraparte: '20452148324',
  razonSocial: 'Consumidor final',
  cbteTipo: 11,
  letra: 'C',
  puntoVenta: 1,
  numero: 5,
  fecha: '2026-08-27',
  moneda: 'ARS',
  neto: money(3_438_252n, 'ARS'),
  iva: money(0n, 'ARS'),
  total: money(3_438_252n, 'ARS'),
  cae: '86350818727839',
  caeVencimiento: '20260906',
};

const LINEAS = (c: ComprobanteNormalizado): readonly LineaPropuesta[] => [
  { accountCode: '1.1.01', debit: c.total, credit: money(0n, 'ARS'), descripcion: 'Cobro' },
  { accountCode: '4.1.01', debit: money(0n, 'ARS'), credit: c.total, descripcion: 'Venta' },
];

const REGLA_APLICADA: ResultadoDeRegla = {
  ruleKey: 'AR-IVA-CF-VINCULACION-001',
  version: 1,
  estado: 'APLICADA',
  motivo: 'Condiciones satisfechas',
  cita: CITA,
};

function entrada(overrides: Partial<EntradaDeDecision> = {}): EntradaDeDecision {
  return {
    comprobante: COMPROBANTE,
    sello: { estado: 'APROBADO', motivo: null },
    hechosProfesionales: [],
    reglas: [REGLA_APLICADA],
    revisionesPrevias: [],
    ...overrides,
  };
}

describe('hechos, y su origen', () => {
  it('los documentales dicen que salen del comprobante', () => {
    const hechos = hechosDocumentales(COMPROBANTE);
    expect(hechos.every((h) => h.origen === 'DOCUMENTAL' && h.fuente !== '')).toBe(true);
    expect(hechos.find((h) => h.campo === 'importes.total')?.valor).toBe('3438252');
    // Los importes viajan como texto: un `number` perdería centavos a partir de
    // cierto tamaño, y este módulo no es lugar para descubrirlo.
    expect(typeof hechos.find((h) => h.campo === 'importes.total')?.valor).toBe('string');
  });

  it('los tributarios dicen que salen de ARCA', () => {
    const hechos = hechosTributarios(COMPROBANTE, { estado: 'APROBADO', motivo: null });
    expect(hechos.every((h) => h.origen === 'TRIBUTARIO')).toBe(true);
    expect(hechos.map((h) => h.campo)).toContain('comprobante.cae');
  });

  it('sin CAE no se inventa el hecho del CAE', () => {
    const hechos = hechosTributarios({ ...COMPROBANTE, cae: null }, { estado: 'NO_VERIFICABLE', motivo: 'SIN_CREDENCIAL' });
    expect(hechos.map((h) => h.campo)).not.toContain('comprobante.cae');
    expect(hechos).toHaveLength(1);
  });
});

describe('la decisión propone', () => {
  it('con sello aprobado y una regla aplicada', () => {
    const d = decidir(entrada(), LINEAS, 'sistema:test');
    expect(d.estado).toBe('PROPUESTA_DE_ASIENTO');
    expect(d.revisiones).toEqual([]);
    expect(d.propuesta?.origen.reglaAplicada).toBe('AR-IVA-CF-VINCULACION-001');
    expect(d.propuesta?.origen.documentoSha256).toBe(SHA);
    expect(d.propuesta?.origen.propuestaPor).toBe('sistema:test');
  });

  it('y la propuesta cuadra', () => {
    const d = decidir(entrada(), LINEAS, 'sistema:test');
    const debe = d.propuesta!.lineas.reduce((a, l) => a + l.debit.amount, 0n);
    const haber = d.propuesta!.lineas.reduce((a, l) => a + l.credit.amount, 0n);
    expect(debe).toBe(haber);
  });

  it('los hechos profesionales que le pasan viajan con su origen', () => {
    const d = decidir(
      entrada({
        hechosProfesionales: [
          {
            campo: 'vinculadaConOperacionesGravadas',
            valor: true,
            origen: 'PROFESIONAL',
            fuente: 'declaración de user:contadora',
          },
        ],
      }),
      LINEAS,
      'sistema:test',
    );
    expect(d.hechos.filter((h) => h.origen === 'PROFESIONAL')).toHaveLength(1);
  });
});

describe('la decisión se niega', () => {
  it('si el sello fiscal no está aprobado', () => {
    const d = decidir(
      entrada({ sello: { estado: 'RECHAZADO', motivo: 'CAE inexistente' } }),
      LINEAS,
      'sistema:test',
    );
    expect(d.estado).toBe('REQUIERE_REVISION');
    expect(d.revisiones.map((r) => r.motivo)).toContain('SELLO_FISCAL_NO_APROBADO');
    expect(d.revisiones[0]!.detalle).toContain('CAE inexistente');
    expect(d.propuesta).toBeNull();
  });

  it('si el sello no es verificable, aunque no haya sido rechazado', () => {
    // "No se pudo verificar" no es "está bien". Es la misma distinción que
    // sostiene todo el resto del sistema.
    const d = decidir(
      entrada({ sello: { estado: 'NO_VERIFICABLE', motivo: null } }),
      LINEAS,
      'sistema:test',
    );
    expect(d.estado).toBe('REQUIERE_REVISION');
    expect(d.revisiones[0]!.detalle).not.toContain('null');
  });

  it('si no hay ninguna regla: SIN_REGLA_APLICABLE', () => {
    const d = decidir(entrada({ reglas: [] }), LINEAS, 'sistema:test');
    expect(d.revisiones.map((r) => r.motivo)).toContain('SIN_REGLA_APLICABLE');
    expect(d.propuesta).toBeNull();
  });

  it('si la regla existe pero está en DRAFT: REGLA_NO_ACTIVA, y la nombra', () => {
    const d = decidir(
      entrada({
        reglas: [
          { ...REGLA_APLICADA, estado: 'DESCARTADA', motivo: 'La regla está en estado DRAFT' },
        ],
      }),
      LINEAS,
      'sistema:test',
    );
    const revision = d.revisiones.find((r) => r.motivo === 'REGLA_NO_ACTIVA');
    expect(revision).toBeDefined();
    expect(revision!.detalle).toContain('AR-IVA-CF-VINCULACION-001');
    expect(revision!.detalle).toContain('§32');
  });

  it('una regla descartada por OTRO motivo no se confunde con una inactiva', () => {
    const d = decidir(
      entrada({
        reglas: [
          { ...REGLA_APLICADA, estado: 'DESCARTADA', motivo: 'La fecha queda fuera de su vigencia' },
        ],
      }),
      LINEAS,
      'sistema:test',
    );
    expect(d.revisiones.map((r) => r.motivo)).toContain('SIN_REGLA_APLICABLE');
    expect(d.revisiones.map((r) => r.motivo)).not.toContain('REGLA_NO_ACTIVA');
  });

  it('arrastra las revisiones que las capas de arriba ya detectaron', () => {
    const d = decidir(
      entrada({
        revisionesPrevias: [{ motivo: 'SIN_HECHO_REQUERIDO', detalle: 'Falta la afectación' }],
      }),
      LINEAS,
      'sistema:test',
    );
    // La regla se aplicó y aun así no propone: basta un motivo de revisión.
    expect(d.estado).toBe('REQUIERE_REVISION');
    expect(d.revisiones.map((r) => r.motivo)).toContain('SIN_HECHO_REQUERIDO');
    expect(d.propuesta).toBeNull();
  });

  it('cuando se niega, igual devuelve los hechos y la normativa consultada', () => {
    // Una negativa sin contexto es tan inútil como un booleano pelado.
    const d = decidir(entrada({ reglas: [] , sello: { estado: 'RECHAZADO', motivo: null } }), LINEAS, 'sistema:test');
    expect(d.hechos.length).toBeGreaterThan(0);
    expect(d.reglas).toEqual([]);
  });
});

describe('explicarDecision', () => {
  it('rinde una negativa con motivo, hechos, normativa y reglas', () => {
    const texto = explicarDecision(
      decidir(
        entrada({
          reglas: [{ ...REGLA_APLICADA, estado: 'DESCARTADA', motivo: 'La regla está en estado DRAFT' }],
        }),
        LINEAS,
        'sistema:test',
      ),
    );
    expect(texto).toContain('DECISIÓN: REQUIERE_REVISION');
    expect(texto).toContain('MOTIVO:');
    expect(texto).toContain('DOCUMENTAL:');
    expect(texto).toContain('TRIBUTARIO:');
    expect(texto).toContain('PROFESIONAL: (ninguno)');
    expect(texto).toContain('Ley 23.349');
    expect(texto).toContain('180b1380c820cbab');
  });

  it('rinde una propuesta con sus líneas', () => {
    const texto = explicarDecision(decidir(entrada(), LINEAS, 'sistema:test'));
    expect(texto).toContain('PROPUESTA DE ASIENTO (no es un asiento)');
    expect(texto).toContain('1.1.01');
    expect(texto).toContain('4.1.01');
  });

  it('dice explícitamente cuando no hay normativa ni reglas', () => {
    const texto = explicarDecision(decidir(entrada({ reglas: [] }), LINEAS, 'sistema:test'));
    expect(texto).toContain('(ninguna aportó cita)');
    expect(texto).toContain('(ninguna consultada)');
  });

  it('una regla sin versión no imprime "vundefined"', () => {
    const texto = explicarDecision(
      decidir(
        entrada({ reglas: [{ ...REGLA_APLICADA, version: null, cita: null }] }),
        LINEAS,
        'sistema:test',
      ),
    );
    expect(texto).not.toContain('vundefined');
    expect(texto).not.toContain('vnull');
  });
});
