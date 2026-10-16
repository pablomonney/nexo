/**
 * `FECompConsultar` y el reconciliador contra WSFEv1, con ARCA simulado (sin red ni credenciales).
 *
 * Lo que se afirma es la **política**: ante cualquier cosa que no sea una respuesta inequívoca, la duda sigue y NUNCA se
 * concluye «no se autorizó» (que habilitaría a facturar de nuevo algo que quizá existe).
 */

import { describe, expect, it } from 'vitest';
import { endpointsFor } from '@aai/arca';
import { ClienteWsfev1, ReconciliadorWsfev1, verificarDestinoDeEmision } from './index.js';

const HOMO = endpointsFor('homologacion');
const permiso = verificarDestinoDeEmision({ ambiente: 'homologacion', endpointWsfev1: HOMO.wsfev1, endpointWsaa: HOMO.wsaa });
const auth = { Token: 't', Sign: 's', Cuit: '20452148324' };

const sobre = (operacion: string, resultado: string): string =>
  '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  `<${operacion}Response><${operacion}Result>${resultado}</${operacion}Result></${operacion}Response>` +
  '</soap:Body></soap:Envelope>';

const ultimo = (n: number): string => sobre('FECompUltimoAutorizado', `<CbteNro>${String(n)}</CbteNro><PtoVta>1</PtoVta><CbteTipo>11</CbteTipo>`);
const error = (operacion: string, code: number, msg: string): string =>
  sobre(operacion, `<Errors><Err><Code>${String(code)}</Code><Msg>${msg}</Msg></Err></Errors>`);
const consultado = (nro: number, extra = ''): string =>
  sobre(
    'FECompConsultar',
    '<ResultGet><Concepto>1</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro>' +
      `<CbteDesde>${String(nro)}</CbteDesde><CbteHasta>${String(nro)}</CbteHasta><CbteFch>20261016</CbteFch>` +
      '<ImpTotal>1210.50</ImpTotal><ImpNeto>1000.00</ImpNeto><ImpIVA>210.50</ImpIVA><MonId>PES</MonId><MonCotiz>1</MonCotiz>' +
      '<Resultado>A</Resultado><CodAutorizacion>76123456789012</CodAutorizacion><EmisionTipo>CAE</EmisionTipo>' +
      '<FchVto>20261026</FchVto><FchProceso>20261016120000</FchProceso>' +
      extra +
      '</ResultGet>',
  );

/** Un ARCA que contesta según la operación, y anota qué se le preguntó. */
function arca(respuestas: Record<string, string | Error>): { fetchImpl: typeof fetch; preguntas: string[]; cuerpos: string[] } {
  const preguntas: string[] = [];
  const cuerpos: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const accion = String((init.headers as Record<string, string>)['SOAPAction']).split('/').at(-1)!;
    preguntas.push(accion);
    cuerpos.push(String(init.body));
    const r = respuestas[accion];
    if (r === undefined) throw new Error(`el ARCA simulado no esperaba ${accion}`);
    if (r instanceof Error) throw r;
    return new Response(r, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, preguntas, cuerpos };
}

const reconciliador = (respuestas: Record<string, string | Error>) => {
  const a = arca(respuestas);
  return { ...a, r: new ReconciliadorWsfev1(new ClienteWsfev1({ permiso, fetchImpl: a.fetchImpl }), async () => auth) };
};
const PEDIDO = { puntoVenta: 1, cbteTipo: 11, numeroReservado: 45 };

describe('FECompConsultar — consultarComprobante', () => {
  it('arma el sobre según el WSDL: Auth, FeCompConsReq{CbteTipo, CbteNro, PtoVta} en ese orden', async () => {
    const a = arca({ FECompConsultar: consultado(45) });
    await new ClienteWsfev1({ permiso, fetchImpl: a.fetchImpl }).consultarComprobante(auth, 1, 11, 45);
    const cuerpo = a.cuerpos[0]!;
    expect(cuerpo).toContain('<ar:FECompConsultar>');
    expect(cuerpo).toMatch(/<ar:FeCompConsReq><ar:CbteTipo>11<\/ar:CbteTipo><ar:CbteNro>45<\/ar:CbteNro><ar:PtoVta>1<\/ar:PtoVta><\/ar:FeCompConsReq>/u);
  });

  it('lee el CAE, su vencimiento y los importes (como texto, sin pasar por punto flotante)', async () => {
    const a = arca({ FECompConsultar: consultado(45) });
    const r = await new ClienteWsfev1({ permiso, fetchImpl: a.fetchImpl }).consultarComprobante(auth, 1, 11, 45);
    expect(r.estado).toBe('ENCONTRADO');
    if (r.estado !== 'ENCONTRADO') return;
    expect(r.comprobante).toMatchObject({
      Resultado: 'A', CAE: '76123456789012', CAEFchVto: '20261026', EmisionTipo: 'CAE',
      CbteDesde: 45, CbteHasta: 45, ImpTotal: '1210.50', ImpIVA: '210.50',
    });
  });

  it('sólo un código de «no existe» es NO_EXISTE; cualquier otro error es INDETERMINADO (no se asume que no existe)', async () => {
    const noExiste = await new ClienteWsfev1({ permiso, fetchImpl: arca({ FECompConsultar: error('FECompConsultar', 602, 'No existen datos') }).fetchImpl }).consultarComprobante(auth, 1, 11, 45);
    expect(noExiste.estado).toBe('NO_EXISTE');
    const otro = await new ClienteWsfev1({ permiso, fetchImpl: arca({ FECompConsultar: error('FECompConsultar', 600, 'Validación de Token') }).fetchImpl }).consultarComprobante(auth, 1, 11, 45);
    expect(otro.estado).toBe('INDETERMINADO');
    const mezcla = sobre('FECompConsultar', '<Errors><Err><Code>602</Code><Msg>x</Msg></Err><Err><Code>501</Code><Msg>y</Msg></Err></Errors>');
    expect((await new ClienteWsfev1({ permiso, fetchImpl: arca({ FECompConsultar: mezcla }).fetchImpl }).consultarComprobante(auth, 1, 11, 45)).estado).toBe('INDETERMINADO');
  });

  it('una respuesta sin comprobante y sin error es INDETERMINADO', async () => {
    const r = await new ClienteWsfev1({ permiso, fetchImpl: arca({ FECompConsultar: sobre('FECompConsultar', '') }).fetchImpl }).consultarComprobante(auth, 1, 11, 45);
    expect(r.estado).toBe('INDETERMINADO');
  });
});

describe('ReconciliadorWsfev1 — la duda sigue salvo respuesta inequívoca', () => {
  it('último ≥ reservado y la consulta trae el CAE → AUTORIZADO con evidencia, y se preguntó en el orden correcto', async () => {
    const { r, preguntas } = reconciliador({ FECompUltimoAutorizado: ultimo(45), FECompConsultar: consultado(45) });
    expect(await r.reconciliar(PEDIDO)).toEqual({
      estado: 'AUTORIZADO',
      evidencia: { cae: '76123456789012', caeVencimiento: '20261026', numeroAutorizado: 45 },
    });
    expect(preguntas).toEqual(['FECompUltimoAutorizado', 'FECompConsultar']);
  });

  it('último = reservado − 1 → NO_AUTORIZADO, y ni se consulta el comprobante', async () => {
    const { r, preguntas } = reconciliador({ FECompUltimoAutorizado: ultimo(44) });
    const x = await r.reconciliar(PEDIDO);
    expect(x.estado).toBe('NO_AUTORIZADO');
    expect(preguntas).toEqual(['FECompUltimoAutorizado']);
  });

  it('último < reservado − 1 → SIN_RESPUESTA (inconsistente: no se adivina)', async () => {
    const x = await reconciliador({ FECompUltimoAutorizado: ultimo(40) }).r.reconciliar(PEDIDO);
    expect(x.estado).toBe('SIN_RESPUESTA');
    expect((x as { detalle: string }).detalle).toMatch(/INCONSISTENTE/u);
  });

  it('un error de red al preguntar la numeración NUNCA produce NO_AUTORIZADO', async () => {
    const x = await reconciliador({ FECompUltimoAutorizado: new Error('fetch failed') }).r.reconciliar(PEDIDO);
    expect(x.estado).toBe('SIN_RESPUESTA');
  });

  it('una credencial que falla al autenticar tampoco: SIN_RESPUESTA', async () => {
    const a = arca({});
    const r = new ReconciliadorWsfev1(new ClienteWsfev1({ permiso, fetchImpl: a.fetchImpl }), async () => {
      throw new Error('coe.alreadyAuthenticated');
    });
    expect((await r.reconciliar(PEDIDO)).estado).toBe('SIN_RESPUESTA');
    expect(a.preguntas).toEqual([]);
  });

  it('existe pero la consulta falla o es indeterminada → EXISTE_SIN_EVIDENCIA (no se reintenta la emisión)', async () => {
    expect((await reconciliador({ FECompUltimoAutorizado: ultimo(45), FECompConsultar: new Error('timeout') }).r.reconciliar(PEDIDO)).estado).toBe('EXISTE_SIN_EVIDENCIA');
    expect((await reconciliador({ FECompUltimoAutorizado: ultimo(45), FECompConsultar: error('FECompConsultar', 600, 'token') }).r.reconciliar(PEDIDO)).estado).toBe('EXISTE_SIN_EVIDENCIA');
  });

  it('el último dice que existe y la consulta dice que no → CONTRADICCIÓN: SIN_RESPUESTA, no se concluye nada', async () => {
    const x = await reconciliador({ FECompUltimoAutorizado: ultimo(45), FECompConsultar: error('FECompConsultar', 602, 'No existen datos') }).r.reconciliar(PEDIDO);
    expect(x.estado).toBe('SIN_RESPUESTA');
    expect((x as { detalle: string }).detalle).toMatch(/CONTRADICCIÓN/u);
  });

  it('un comprobante con otro número que el reservado no es evidencia', async () => {
    const x = await reconciliador({ FECompUltimoAutorizado: ultimo(46), FECompConsultar: consultado(46) }).r.reconciliar(PEDIDO);
    expect(x.estado).toBe('SIN_RESPUESTA');
  });

  it('Resultado distinto de A, o sin CAE, no es evidencia', async () => {
    const rechazado = consultado(45).replace('<Resultado>A</Resultado>', '<Resultado>R</Resultado>');
    expect((await reconciliador({ FECompUltimoAutorizado: ultimo(45), FECompConsultar: rechazado }).r.reconciliar(PEDIDO)).estado).toBe('EXISTE_SIN_EVIDENCIA');
    const sinCae = consultado(45).replace('<CodAutorizacion>76123456789012</CodAutorizacion>', '');
    expect((await reconciliador({ FECompUltimoAutorizado: ultimo(45), FECompConsultar: sinCae }).r.reconciliar(PEDIDO)).estado).toBe('EXISTE_SIN_EVIDENCIA');
  });

  it('un número reservado inválido no pregunta nada', async () => {
    const { r, preguntas } = reconciliador({});
    expect((await r.reconciliar({ ...PEDIDO, numeroReservado: 0 })).estado).toBe('SIN_RESPUESTA');
    expect(preguntas).toEqual([]);
  });

  it('el mensaje de un error no filtra el token ni la firma', async () => {
    const a = arca({ FECompUltimoAutorizado: new Error('rechazo token=ABCDEF123456 sign=ZZZZ999') });
    const x = await new ReconciliadorWsfev1(new ClienteWsfev1({ permiso, fetchImpl: a.fetchImpl }), async () => auth).reconciliar(PEDIDO);
    expect((x as { detalle: string }).detalle).not.toContain('ABCDEF123456');
    expect((x as { detalle: string }).detalle).not.toContain('ZZZZ999');
  });
});
