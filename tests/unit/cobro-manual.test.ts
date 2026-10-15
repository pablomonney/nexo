/**
 * Las partes puras del cobro manual (`scripts/lib/cobro-manual.mjs`): importes en centavos, lectura del extracto,
 * conciliación y comprobante.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — módulo .mjs sin tipos (es un script del operador)
import * as lib from '../../scripts/lib/cobro-manual.mjs';

const { aCentavos, deCentavos, parsearExtracto, conciliar, claveDeCobro, armarComprobante } = lib as {
  aCentavos: (t: string) => bigint | null;
  deCentavos: (c: bigint) => string;
  parsearExtracto: (t: string) => { movimientos: Array<{ linea: number; fecha: string; descripcion: string; centavos: bigint; referencia: string | null }>; descartadas: unknown[] };
  conciliar: (m: unknown[], d: unknown[], r: Iterable<string>) => Array<{ estado: string; candidatos: Array<{ numero: string }>; porTexto?: boolean }>;
  claveDeCobro: (id: string, ref: string) => string;
  armarComprobante: (d: Record<string, unknown>) => string;
};

describe('importes en centavos', () => {
  it.each([
    ['3000.00', 300000n],
    ['3000', 300000n],
    ['3.000,50', 300050n],
    ['3,000.50', 300050n],
    ['1.234.567,89', 123456789n],
    ['1.234.567', 123456700n],
    ['0,5', 50n],
    ['12.5', 1250n],
    ['$ 1.000,00', 100000n],
    ['-45,10', -4510n],
  ])('%s → %s', (texto, esperado) => {
    expect(aCentavos(texto)).toBe(esperado);
  });

  it.each(['', 'abc', '1,2,3x', '12,345', '1.2.3,456', null as unknown as string])('«%s» no es un importe', (texto) => {
    expect(aCentavos(texto)).toBeNull();
  });

  it('ida y vuelta sin perder un centavo', () => {
    for (const c of [0n, 1n, 99n, 100n, 123456789n, -5n]) expect(aCentavos(deCentavos(c))).toBe(c);
  });
});

describe('extracto', () => {
  it('lee sólo los CRÉDITOS, con fechas AAAA-MM-DD o DD/MM/AAAA y importes es-AR', () => {
    const { movimientos, descartadas } = parsearExtracto(
      ['fecha;descripcion;importe;referencia', '2026-11-03;TRANSF ACME SRL;3.000,00;0012345', '04/11/2026;DEBITO COMISION;-150,00;', '05/11/2026;TRANSF OTRO;500,50;0099999', 'sin fecha;x;10,00;'].join('\n'),
    );
    expect(movimientos.map((m) => [m.fecha, deCentavos(m.centavos), m.referencia])).toEqual([
      ['2026-11-03', '3000.00', '0012345'],
      ['2026-11-05', '500.50', '0099999'],
    ]);
    expect(descartadas).toHaveLength(1);
  });

  it('sin las columnas mínimas se niega con un mensaje que dice qué falta', () => {
    expect(() => parsearExtracto('a;b\n1;2')).toThrow(/fecha.*importe/u);
  });
});

describe('conciliación: sólo propone', () => {
  const docs = [
    { id: 'd1', numero: '1', empresa: 'Acme Servicios SRL', cuit: '30111111114', centavos: 300000n },
    { id: 'd2', numero: '2', empresa: 'Beta Comercial SA', cuit: '30222222227', centavos: 300000n },
    { id: 'd3', numero: '3', empresa: 'Gamma SRL', cuit: '30333333330', centavos: 120000n },
  ];
  const mov = (centavos: bigint, descripcion = '', referencia: string | null = null) => ({ linea: 2, fecha: '2026-11-03', descripcion, centavos, referencia });

  it('un importe, un documento: UNICA', () => {
    const [r] = conciliar([mov(120000n)], docs, []);
    expect(r!.estado).toBe('UNICA');
    expect(r!.candidatos[0]!.numero).toBe('3');
  });

  it('dos documentos por el mismo importe y nada que los distinga: AMBIGUA (no elige)', () => {
    const [r] = conciliar([mov(300000n, 'TRANSFERENCIA RECIBIDA')], docs, []);
    expect(r!.estado).toBe('AMBIGUA');
    expect(r!.candidatos).toHaveLength(2);
  });

  it('con el CUIT o el nombre en el texto, desambigua', () => {
    expect(conciliar([mov(300000n, 'TRF 30-22222222-7 PAGO')], docs, [])[0]!.candidatos[0]!.numero).toBe('2');
    const [r] = conciliar([mov(300000n, 'pago acme servicios srl')], docs, []);
    expect(r!.estado).toBe('UNICA');
    expect(r!.porTexto).toBe(true);
    expect(r!.candidatos[0]!.numero).toBe('1');
  });

  it('un importe que no es de ningún documento: SIN_DOCUMENTO (un pago parcial no se adivina)', () => {
    expect(conciliar([mov(299999n)], docs, [])[0]!.estado).toBe('SIN_DOCUMENTO');
  });

  it('una referencia ya registrada: YA_REGISTRADO (procesar dos veces el mismo extracto no duplica)', () => {
    expect(conciliar([mov(120000n, '', ' 0012345 ')], docs, ['0012345'])[0]!.estado).toBe('YA_REGISTRADO');
  });
});

describe('clave de cobro y comprobante', () => {
  it('el mismo documento con la misma referencia es la misma clave; otra referencia, otra clave', () => {
    expect(claveDeCobro('doc-1', ' Op 123 ')).toBe(claveDeCobro('doc-1', 'op 123'));
    expect(claveDeCobro('doc-1', 'a')).not.toBe(claveDeCobro('doc-1', 'b'));
    expect(claveDeCobro('doc-1', 'a')).not.toBe(claveDeCobro('doc-2', 'a'));
  });

  const datos = { numero: '12', empresa: 'Acme SRL', cuit: '30111111114', concepto: 'Suscripción a NEXO (mensual)', moneda: 'ARS', importe: '3000.00', pagadoEl: '2026-11-03', referencia: '0012345', estado: 'PAGADO', esFiscal: false, cae: null, emitidoEl: '2026-11-04' };

  it('dice que NO es un comprobante fiscal y lleva la huella de su propio texto', () => {
    const t = armarComprobante(datos);
    expect(t).toContain('NO ES UN COMPROBANTE FISCAL');
    expect(t).toContain('no: este documento no es un comprobante fiscal');
    expect(t).toMatch(/Huella \(SHA-256 del texto de arriba\): [0-9a-f]{64}\n$/u);
  });

  it('es determinístico y cualquier cambio cambia la huella', () => {
    expect(armarComprobante(datos)).toBe(armarComprobante({ ...datos }));
    expect(armarComprobante({ ...datos, importe: '3000.01' })).not.toBe(armarComprobante(datos));
  });
});

describe('scripts/cobro-manual.sh (el envoltorio del servidor)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sh = (): string => require('node:fs').readFileSync(new URL('../../scripts/cobro-manual.sh', import.meta.url), 'utf8') as string;
  const codigo = (): string => sh().split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  it('corre dentro de la imagen, con el sistema de archivos de sólo lectura y sin privilegios nuevos', () => {
    expect(codigo()).toContain('--read-only');
    expect(codigo()).toContain('--security-opt no-new-privileges:true');
    expect(codigo()).toContain('--network nexo');
    expect(codigo()).toContain('--env-file "$RAIZ/.env"');
  });

  it('no carga el .env con `.`/source ni pone la contraseña en los argumentos del proceso', () => {
    expect(codigo()).not.toMatch(/^\s*(\.|source)\s+.*\.env/mu);
    expect(codigo()).not.toMatch(/POSTGRES_PASSWORD=/u);
    expect(codigo()).toContain('process.env.POSTGRES_PASSWORD'); // se lee DENTRO del contenedor
  });

  it('el único montaje es el extracto y de sólo lectura', () => {
    const lineas = codigo().split('\n').filter((l) => /(^|[\s(])-v\s/u.test(l));
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toContain(':/tmp/extracto.csv:ro"');
  });
});
