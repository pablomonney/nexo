/**
 * Tests del paquete de emisión.
 *
 * El primer `describe` es el que importa. No prueba que el candado rechace
 * producción —eso lo haría cualquier lista negra— sino que rechace **todo lo que
 * no sea exactamente el destino de homologación que el repositorio declara**.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointsFor } from '@aai/arca';
import {
  ClienteWsfev1,
  construirQr,
  explicarRechazoEmision,
  verificarDestinoDeEmision,
  type DetalleComprobante,
  type EspecificacionQr,
  type ComprobanteAutorizado,
} from './index.js';

const HOMO = endpointsFor('homologacion');
const PROD = endpointsFor('produccion');

const destino = (overrides: Partial<Parameters<typeof verificarDestinoDeEmision>[0]> = {}) => ({
  ambiente: 'homologacion' as const,
  endpointWsfev1: HOMO.wsfev1,
  endpointWsaa: HOMO.wsaa,
  ...overrides,
});

describe('el candado de emisión prueba que el destino es homologación', () => {
  it('el destino declarado para homologación pasa', () => {
    const permiso = verificarDestinoDeEmision(destino());
    expect(permiso.permitido).toBe(true);
  });

  it('producción se rechaza por ambiente y por endpoint, no por una sola cosa', () => {
    const permiso = verificarDestinoDeEmision(
      destino({ ambiente: 'produccion', endpointWsfev1: PROD.wsfev1, endpointWsaa: PROD.wsaa }),
    );

    expect(permiso.permitido).toBe(false);
    if (permiso.permitido) return;
    expect(permiso.rechazos.map((r) => r.motivo).sort()).toEqual([
      'AMBIENTE_NO_ES_HOMOLOGACION',
      'ENDPOINT_DE_PRODUCCION',
      'WSAA_NO_ES_DE_HOMOLOGACION',
    ]);
  });

  it('un endpoint desconocido no pasa aunque no sea el de producción', () => {
    // Es el caso central. Este endpoint no es producción: es otro. Y no pasa
    // igual, porque la pregunta no es "¿es producción?" sino "¿es el de
    // homologación que declaramos?".
    const permiso = verificarDestinoDeEmision(
      destino({ endpointWsfev1: 'https://proxy.interno/wsfev1/service.asmx' }),
    );

    expect(permiso.permitido).toBe(false);
    if (permiso.permitido) return;
    expect(permiso.rechazos[0]?.motivo).toBe('ENDPOINT_NO_DECLARADO');
  });

  it('un endpoint que solo CONTIENE el de homologación tampoco pasa', () => {
    // `includes` en vez de igualdad dejaría pasar esto, y es exactamente el
    // control que no conviene aflojar.
    const permiso = verificarDestinoDeEmision(
      destino({ endpointWsfev1: `${HOMO.wsfev1}/../../produccion` }),
    );

    expect(permiso.permitido).toBe(false);
  });

  it('el ambiente mock tampoco emite: apunta a homologación pero no es homologación', () => {
    const permiso = verificarDestinoDeEmision(destino({ ambiente: 'mock' }));

    expect(permiso.permitido).toBe(false);
    if (permiso.permitido) return;
    expect(permiso.rechazos.map((r) => r.motivo)).toEqual(['AMBIENTE_NO_ES_HOMOLOGACION']);
  });

  it('un WSAA de producción con un wsfev1 de homologación se rechaza', () => {
    // El ticket es lo que autoriza. Pedirlo al WSAA de producción y usarlo
    // contra homologación no funcionaría, pero el candado no lo deja llegar a
    // depender de eso.
    const permiso = verificarDestinoDeEmision(destino({ endpointWsaa: PROD.wsaa }));

    expect(permiso.permitido).toBe(false);
    if (permiso.permitido) return;
    expect(permiso.rechazos[0]?.motivo).toBe('WSAA_NO_ES_DE_HOMOLOGACION');
  });

  it('el mensaje de rechazo dice también lo que el candado NO prueba', () => {
    const texto = explicarRechazoEmision(verificarDestinoDeEmision(destino({ ambiente: 'mock' })));

    expect(texto).toMatch(/falla del lado\s+seguro/);
    // Un candado que no declara sus límites se lee como si no tuviera.
    expect(texto).toMatch(/ninguno prueba con QUÉ certificado/i);
  });
});

describe('el QR se arma con la especificación transcripta del documento', () => {
  /**
   * La especificación real, leída del archivo que usa el generador.
   *
   * No se re-declara acá: si el test trajera su propia copia, probaría una
   * transcripción que nadie usa. Lo que interesa verificar es **el archivo**.
   */
  const spec = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'scripts', 'especificacion-qr.json'), 'utf8'),
  ) as EspecificacionQr;

  /**
   * El comprobante del ejemplo que trae el propio PDF de ARCA, en su página 2.
   *
   * Es lo que convierte a estos tests en una verificación de la transcripción y
   * no en una comprobación de que el código hace lo que el código hace: si un
   * nombre de campo está mal copiado, el JSON no coincide.
   */
  const DEL_DOCUMENTO: ComprobanteAutorizado = {
    cuitEmisor: '30000000007',
    ptoVta: 10,
    cbteTipo: 1,
    cbteNro: 94,
    cbteFch: '20201013',
    docTipo: 80,
    docNro: '20000000001',
    impTotal: 12100,
    moneda: 'DOL',
    cotizacion: 65,
    cae: '70417054367476',
    caeFchVto: '20201023',
    concepto: 'ejemplo del documento',
    tipoCodAut: 'E',
  };

  const ESPERADO_DEL_DOCUMENTO =
    '{"ver":1,"fecha":"2020-10-13","cuit":30000000007,"ptoVta":10,"tipoCmp":1,"nroCmp":94,' +
    '"importe":12100,"moneda":"DOL","ctz":65,"tipoDocRec":80,"nroDocRec":20000000001,' +
    '"tipoCodAut":"E","codAut":70417054367476}';

  it('reproduce exactamente el JSON de ejemplo del documento oficial', () => {
    const resultado = construirQr(DEL_DOCUMENTO, spec);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(Buffer.from(resultado.payload, 'base64').toString('utf8')).toBe(ESPERADO_DEL_DOCUMENTO);
  });

  it('los enteros largos no pasan por Number', () => {
    // `nroDocRec` admite hasta 20 dígitos y `codAut` tiene 14. Convertirlos con
    // `Number` perdería precisión arriba de 2^53, y el error se vería como un QR
    // que apunta a otro receptor — no como un error.
    const largo = { ...DEL_DOCUMENTO, docNro: '99999999999999999999' };
    const resultado = construirQr(largo, spec);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(Buffer.from(resultado.payload, 'base64').toString('utf8')).toContain(
      '"nroDocRec":99999999999999999999',
    );
  });

  it('sin receptor identificado omite los campos DE CORRESPONDER', () => {
    // El documento marca `tipoDocRec` y `nroDocRec` como "DE CORRESPONDER".
    // Con DocTipo 99 —consumidor final sin identificar— no corresponden, y
    // mandar `tipoDocRec: 99` afirmaría que el receptor es de ese tipo.
    const sinReceptor = { ...DEL_DOCUMENTO, docTipo: 99, docNro: '0' };
    const resultado = construirQr(sinReceptor, spec);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    const json = Buffer.from(resultado.payload, 'base64').toString('utf8');
    expect(json).not.toContain('tipoDocRec');
    expect(json).not.toContain('nroDocRec');
    // Y los obligatorios siguen todos.
    expect(json).toContain('"tipoCodAut":"E"');
    expect(json).toContain('"codAut":70417054367476');
  });

  it('la URL es la que el documento declara como {URL}', () => {
    const resultado = construirQr(DEL_DOCUMENTO, spec);

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    // El documento se contradice: su especificación técnica dice arca.gob.ar y
    // su propio ejemplo usa afip.gob.ar. Se codifica la declarada, y el
    // conflicto queda anotado en el archivo de especificación en vez de
    // resuelto en silencio adentro del código.
    expect(resultado.url.startsWith('https://www.arca.gob.ar/fe/qr/?p=')).toBe(true);
  });

  it('sin especificación no arma nada, y dice qué falta', () => {
    const resultado = construirQr(DEL_DOCUMENTO, null);

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.queHacer).toMatch(/especificacion-qr\.json/);
  });

  it('una especificación sin campos tampoco alcanza', () => {
    expect(construirQr(DEL_DOCUMENTO, { ...spec, campos: [] }).ok).toBe(false);
  });
});

describe('el sobre del WSFEv1 respeta el contrato del WSDL', () => {
  function capturar(): { cuerpos: string[]; fetchImpl: typeof fetch } {
    const cuerpos: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      cuerpos.push(String(init.body));
      return new Response(
        '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
          '<soap:Body><FECAESolicitarResponse><FECAESolicitarResult>' +
          '<FeCabResp><Resultado>A</Resultado></FeCabResp>' +
          '<FeDetResp><FECAEDetResponse><Resultado>A</Resultado><CAE>75123456789012</CAE>' +
          '<CAEFchVto>20260315</CAEFchVto><CbteDesde>45</CbteDesde><CbteHasta>45</CbteHasta>' +
          '</FECAEDetResponse></FeDetResp>' +
          '</FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>',
        { status: 200, headers: { 'Content-Type': 'text/xml' } },
      );
    }) as unknown as typeof fetch;
    return { cuerpos, fetchImpl };
  }

  const permiso = verificarDestinoDeEmision(destino());

  const detalle: DetalleComprobante = {
    Concepto: 2,
    DocTipo: 99,
    DocNro: '0',
    CbteDesde: 45,
    CbteHasta: 45,
    CbteFch: '20260305',
    ImpTotal: 1234,
    ImpTotConc: 0,
    ImpNeto: 1234,
    ImpOpEx: 0,
    ImpTrib: 0,
    ImpIVA: 0,
    FchServDesde: '20260301',
    FchServHasta: '20260331',
    FchVtoPago: '20260331',
    MonId: 'PES',
    MonCotiz: 1,
  };

  it('los importes van en el orden del WSDL, que es una sequence', () => {
    if (!permiso.permitido) throw new Error('el destino de prueba debería pasar');
    const { cuerpos, fetchImpl } = capturar();
    const cliente = new ClienteWsfev1({ permiso, fetchImpl });

    return cliente
      .solicitarCae({ Token: 't', Sign: 's', Cuit: '30712345671' }, { CantReg: 1, PtoVta: 1, CbteTipo: 11 }, [detalle])
      .then((r) => {
        expect(r.Resultado).toBe('A');
        expect(r.comprobantes[0]?.CAE).toBe('75123456789012');

        const cuerpo = cuerpos[0] ?? '';
        // El esquema es `s:sequence`: mandar ImpNeto antes que ImpTotConc da un
        // error de validación cuyo mensaje no menciona el orden.
        const orden = ['ImpTotal', 'ImpTotConc', 'ImpNeto', 'ImpOpEx', 'ImpTrib', 'ImpIVA'];
        const posiciones = orden.map((campo) => cuerpo.indexOf(`<ar:${campo}>`));
        expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
        expect(posiciones.every((p) => p > 0)).toBe(true);
      });
  });

  it('sin alícuotas NO manda el nodo Iva, ni siquiera vacío', () => {
    // Es el rechazo más común de una Factura C: la clase C no discrimina IVA, y
    // un `<Iva/>` vacío no es lo mismo que no mandarlo.
    if (!permiso.permitido) throw new Error('el destino de prueba debería pasar');
    const { cuerpos, fetchImpl } = capturar();
    const cliente = new ClienteWsfev1({ permiso, fetchImpl });

    return cliente
      .solicitarCae({ Token: 't', Sign: 's', Cuit: '30712345671' }, { CantReg: 1, PtoVta: 1, CbteTipo: 11 }, [detalle])
      .then(() => {
        expect(cuerpos[0]).not.toContain('<ar:Iva>');
      });
  });

  it('el SOAPAction y el endpoint salen del permiso, no de un parámetro', () => {
    if (!permiso.permitido) throw new Error('el destino de prueba debería pasar');
    const urls: string[] = [];
    const acciones: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      acciones.push(String((init.headers as Record<string, string>)['SOAPAction']));
      return new Response(
        '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
          '<soap:Body><FEDummyResponse><FEDummyResult><AppServer>OK</AppServer>' +
          '<DbServer>OK</DbServer><AuthServer>OK</AuthServer></FEDummyResult></FEDummyResponse>' +
          '</soap:Body></soap:Envelope>',
        { status: 200, headers: { 'Content-Type': 'text/xml' } },
      );
    }) as unknown as typeof fetch;

    return new ClienteWsfev1({ permiso, fetchImpl }).dummy().then((estado) => {
      expect(estado.appServer).toBe('OK');
      expect(urls[0]).toBe(HOMO.wsfev1);
      expect(acciones[0]).toBe('http://ar.gov.afip.dif.FEV1/FEDummy');
    });
  });
});
