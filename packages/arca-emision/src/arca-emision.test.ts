/**
 * Tests del paquete de emisión.
 *
 * El primer `describe` es el que importa. No prueba que el candado rechace
 * producción —eso lo haría cualquier lista negra— sino que rechace **todo lo que
 * no sea exactamente el destino de homologación que el repositorio declara**.
 */

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

describe('el QR no se arma sin su especificación', () => {
  const comprobante: ComprobanteAutorizado = {
    cuitEmisor: '30712345671',
    ptoVta: 1,
    cbteTipo: 11,
    cbteNro: 45,
    cbteFch: '20260305',
    docTipo: 99,
    docNro: '0',
    impTotal: 1234,
    moneda: 'PES',
    cotizacion: 1,
    cae: '75123456789012',
    caeFchVto: '20260315',
    concepto: 'Servicios',
  };

  it('sin especificación devuelve una negativa que dice qué hacer', () => {
    const resultado = construirQr(comprobante, null);

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toMatch(/imagen/);
    expect(resultado.queHacer).toMatch(/QRespecificaciones\.pdf/);
    // El punto entero: por qué no se escribe de memoria.
    expect(resultado.queHacer).toMatch(/se imprime bien y que ARCA no valida/);
  });

  it('una especificación vacía tampoco alcanza', () => {
    const vacia: EspecificacionQr = { version: 1, fuente: 'x', campos: [] };
    expect(construirQr(comprobante, vacia).ok).toBe(false);
  });

  it('con especificación arma la URL oficial con el JSON en base64', () => {
    const spec: EspecificacionQr = {
      version: 1,
      fuente: 'fixture del test, no la especificación real',
      campos: [
        { nombreArca: 'ver', origen: 'version', tipo: 'NUMERICO' },
        { nombreArca: 'fecha', origen: 'cbteFch', tipo: 'FECHA' },
        { nombreArca: 'cuit', origen: 'cuitEmisor', tipo: 'NUMERICO' },
        { nombreArca: 'importe', origen: 'impTotal', tipo: 'DECIMAL' },
      ],
    };

    const resultado = construirQr(comprobante, spec);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;

    expect(resultado.url).toMatch(
      /^https:\/\/serviciosweb\.afip\.gob\.ar\/genericos\/comprobantes\/cae\.aspx\?p=/,
    );
    const datos = JSON.parse(Buffer.from(resultado.payload, 'base64').toString('utf8'));
    // La fecha del WSFEv1 viene AAAAMMDD y el QR la lleva con guiones.
    expect(datos).toEqual({ ver: 1, fecha: '2026-03-05', cuit: 30712345671, importe: 1234 });
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
