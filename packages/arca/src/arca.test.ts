import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { NullCredentialStore, type CapabilityStore, type CompanyCertificate, type CredentialStore } from './credentials.js';
import { createArcaClient, parseEnvironment } from './factory.js';
import { endpointsFor } from './environment.js';
import { MockArcaClient } from './mock/mock-client.js';
import { COMPROBANTES_PRUEBA, CUIT_PRUEBA } from './mock/fixtures.js';
import { parseConstatacion } from './soap/soap-client.js';
import {
  buildTra,
  describirFallaWsaa,
  parseLoginResponse,
  signTra,
  WsaaFaultError,
} from './soap/wsaa.js';
import type { ComprobanteAConstatar } from './types.js';
import { aSelloFiscal, bloqueaAprobacionAutomatica } from './validation.js';

const COMPANY = '01a03589-0000-7000-8000-000000000001';

function comprobante(overrides: Partial<ComprobanteAConstatar> = {}): ComprobanteAConstatar {
  const base = COMPROBANTES_PRUEBA[0]!;
  return {
    modalidad: 'CAE',
    cuitEmisor: base.cuitEmisor,
    puntoVenta: base.puntoVenta,
    tipoComprobante: base.tipoComprobante,
    numeroComprobante: base.numeroComprobante,
    fecha: base.fecha,
    importeTotal: base.importeTotal,
    codigoAutorizacion: base.codigoAutorizacion,
    tipoDocReceptor: '80',
    nroDocReceptor: '30710000001',
    ...overrides,
  };
}

describe('selección de ambiente', () => {
  it('sin configurar, el ambiente es mock', () => {
    expect(parseEnvironment(undefined)).toBe('mock');
    expect(parseEnvironment('')).toBe('mock');
  });

  it('rechaza un ambiente desconocido en vez de adivinar', () => {
    expect(() => parseEnvironment('produccion-real')).toThrow(/ARCA_ENVIRONMENT inválido/);
  });

  it('los endpoints de homologación y producción son distintos', () => {
    const homo = endpointsFor('homologacion');
    const prod = endpointsFor('produccion');
    expect(homo.wscdc).not.toBe(prod.wscdc);
    expect(homo.wsaa).toContain('wsaahomo');
    expect(prod.wscdc).toContain('servicios1.arca.gob.ar');
  });

  it('en producción SIN credenciales NO cae al mock', async () => {
    // La comodidad de "si no hay credencial, mockeá" produciría validaciones
    // fiscales inventadas presentadas como reales. Debe fallar visible.
    const client = createArcaClient({ environment: 'produccion' });
    expect(client.environment).toBe('produccion');

    const resultado = await client.constatarComprobante(COMPANY, comprobante());
    expect(resultado.estado).toBe('NO_VERIFICABLE');
    expect(resultado.motivoNoVerificable).toBe('SIN_CREDENCIAL');
  });
});

describe('MockArcaClient', () => {
  it('resuelve los escenarios del juego de fixtures', async () => {
    const client = new MockArcaClient();

    const aprobado = await client.constatarComprobante(COMPANY, comprobante());
    expect(aprobado.estado).toBe('APROBADO');
    expect(aprobado.observaciones).toEqual([]);

    const observado = await client.constatarComprobante(
      COMPANY,
      comprobante({ tipoComprobante: 6, numeroComprobante: 1002 }),
    );
    expect(observado.estado).toBe('APROBADO');
    expect(observado.observaciones[0]?.codigo).toBe(200);

    const rechazado = await client.constatarComprobante(
      COMPANY,
      comprobante({ numeroComprobante: 1003, fecha: '20200101' }),
    );
    expect(rechazado.estado).toBe('RECHAZADO');
    expect(rechazado.observaciones[0]?.codigo).toBe(108);
  });

  it('un comprobante desconocido se considera inexistente, no aprobado', async () => {
    const client = new MockArcaClient();
    const resultado = await client.constatarComprobante(
      COMPANY,
      comprobante({ numeroComprobante: 424_242 }),
    );
    expect(resultado.estado).toBe('RECHAZADO');
  });

  it('es determinístico', async () => {
    const client = new MockArcaClient();
    const primero = await client.constatarComprobante(COMPANY, comprobante());
    const segundo = await client.constatarComprobante(COMPANY, comprobante());
    expect(primero.estado).toBe(segundo.estado);
    expect(primero.observaciones).toEqual(segundo.observaciones);
  });

  it('sabe simular un servicio caído y un timeout', async () => {
    for (const escenario of ['SERVICIO_CAIDO', 'TIMEOUT'] as const) {
      const client = new MockArcaClient({ forzarEscenario: escenario });
      const resultado = await client.constatarComprobante(COMPANY, comprobante());
      expect(resultado.estado).toBe('NO_VERIFICABLE');
      expect(resultado.motivoNoVerificable).toBe(escenario);
      expect((await client.estadoServicio()).disponible).toBe(false);
    }
  });

  it('sin credencial devuelve NO_VERIFICABLE, no un rechazo', async () => {
    const client = new MockArcaClient({ credentials: new NullCredentialStore() });
    const resultado = await client.constatarComprobante(COMPANY, comprobante());
    expect(resultado.estado).toBe('NO_VERIFICABLE');
    expect(resultado.motivoNoVerificable).toBe('SIN_CREDENCIAL');
  });

  it('distingue "servicio no habilitado" de "sin credencial"', async () => {
    const credentials: CredentialStore = {
      async getCertificate() {
        return {
          companyId: COMPANY,
          cuit: '30710000001',
          certificatePem: '',
          privateKeyPem: '',
          notAfter: new Date(Date.now() + 86_400_000),
        };
      },
    };
    const capabilities: CapabilityStore = { async isEnabled() { return false; } };

    const client = new MockArcaClient({ credentials, capabilities });
    const resultado = await client.constatarComprobante(COMPANY, comprobante());
    expect(resultado.motivoNoVerificable).toBe('SERVICIO_NO_HABILITADO');
  });

  it('no saber si un CUIT es apócrifo no es saber que no lo es', async () => {
    const sinAcceso = new MockArcaClient({ credentials: new NullCredentialStore() });
    const desconocido = await sinAcceso.consultarApocrifo(COMPANY, CUIT_PRUEBA.proveedorNormal);
    expect(desconocido.esApocrifo).toBeNull();

    const conAcceso = new MockArcaClient();
    expect((await conAcceso.consultarApocrifo(COMPANY, CUIT_PRUEBA.proveedorApocrifo)).esApocrifo).toBe(true);
    expect((await conAcceso.consultarApocrifo(COMPANY, CUIT_PRUEBA.proveedorNormal)).esApocrifo).toBe(false);
  });

  it('registra las llamadas para poder auditar qué consultó el sistema', async () => {
    const client = new MockArcaClient();
    await client.constatarComprobante(COMPANY, comprobante());
    await client.consultarPadron(COMPANY, CUIT_PRUEBA.proveedorNormal);
    expect(client.llamadas.map((l) => l.metodo)).toEqual(['constatarComprobante', 'consultarPadron']);
  });
});

describe('parseo de la respuesta real del WSCDC', () => {
  // XML tomado del ejemplo del manual oficial archivado
  // (ARCA_manual_desarrollador_wscdcv1_v4.pdf, §2.2).
  const RECHAZADO = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <ComprobanteConstatarResponse>
      <ComprobanteConstatarResult>
        <CmpResp>
          <CbteModo>CAI</CbteModo>
          <CuitEmisor>30000000007</CuitEmisor>
          <PtoVta>63</PtoVta>
          <CbteTipo>4</CbteTipo>
          <CbteNro>20</CbteNro>
          <CbteFch>20130801</CbteFch>
          <ImpTotal>150.88</ImpTotal>
          <CodAutorizacion>12345678901235</CodAutorizacion>
          <DocTipoReceptor>80</DocTipoReceptor>
          <DocNroReceptor>30000000007</DocNroReceptor>
        </CmpResp>
        <Resultado>R</Resultado>
        <Observaciones>
          <Obs>
            <Code>108</Code>
            <Msg>La fecha consignada no se encuentra dentro del rango de fechas habilitadas para el CAI ingresado</Msg>
          </Obs>
        </Observaciones>
        <FchProceso>20130912110834</FchProceso>
      </ComprobanteConstatarResult>
    </ComprobanteConstatarResponse>
  </soap:Body>
</soap:Envelope>`;

  const APROBADO_CON_OBS = RECHAZADO.replace('<Resultado>R</Resultado>', '<Resultado>A</Resultado>');

  it('interpreta un rechazo con su observación', () => {
    const parsed = parseConstatacion(RECHAZADO);
    expect(parsed.estado).toBe('RECHAZADO');
    expect(parsed.observaciones).toHaveLength(1);
    expect(parsed.observaciones[0]?.codigo).toBe(108);
    expect(parsed.observaciones[0]?.mensaje).toContain('rango de fechas habilitadas');
  });

  it('conserva las observaciones aunque el resultado sea aprobado', () => {
    const parsed = parseConstatacion(APROBADO_CON_OBS);
    expect(parsed.estado).toBe('APROBADO');
    expect(parsed.observaciones).toHaveLength(1);
  });

  it('una respuesta sin <Resultado> es un error, no un aprobado', () => {
    expect(() => parseConstatacion('<soap:Envelope/>')).toThrow(/Resultado/);
  });
});

describe('sello de validación FISCAL (§11)', () => {
  it('un resultado del ambiente mock nunca se presenta como OK', async () => {
    const client = new MockArcaClient();
    const sello = aSelloFiscal(await client.constatarComprobante(COMPANY, comprobante()));
    expect(sello.result).toBe('NO_VERIFICABLE');
    expect(sello.explicacion).toContain('no tiene valor probatorio');
  });

  it('aprobado en un ambiente real da OK', () => {
    const sello = aSelloFiscal({
      estado: 'APROBADO',
      observaciones: [],
      errores: [],
      consultadoEn: new Date().toISOString(),
      ambiente: 'produccion',
    });
    expect(sello.result).toBe('OK');
  });

  it('aprobado con observaciones da WARN, no OK', () => {
    const sello = aSelloFiscal({
      estado: 'APROBADO',
      observaciones: [{ codigo: 200, mensaje: 'Existe CAEA, no fue rendido' }],
      errores: [],
      consultadoEn: new Date().toISOString(),
      ambiente: 'produccion',
    });
    expect(sello.result).toBe('WARN');
    expect(sello.explicacion).toContain('200');
  });

  it('rechazado da FAIL con el detalle de la observación', () => {
    const sello = aSelloFiscal({
      estado: 'RECHAZADO',
      observaciones: [{ codigo: 108, mensaje: 'Fecha fuera de rango' }],
      errores: [],
      consultadoEn: new Date().toISOString(),
      ambiente: 'produccion',
    });
    expect(sello.result).toBe('FAIL');
    expect(sello.explicacion).toContain('108');
  });

  it('cada motivo de no verificable tiene una explicación para el contador', () => {
    for (const motivo of [
      'SIN_CREDENCIAL', 'SERVICIO_NO_HABILITADO', 'SERVICIO_CAIDO', 'TIMEOUT', 'RESPUESTA_INESPERADA',
    ] as const) {
      const sello = aSelloFiscal({
        estado: 'NO_VERIFICABLE',
        observaciones: [],
        errores: [],
        motivoNoVerificable: motivo,
        consultadoEn: new Date().toISOString(),
        ambiente: 'homologacion',
      });
      expect(sello.result).toBe('NO_VERIFICABLE');
      expect(sello.explicacion.length).toBeGreaterThan(20);
    }
  });

  it('FAIL y NO_VERIFICABLE bloquean la aprobación automática', () => {
    const base = { observaciones: [], errores: [], consultadoEn: '', ambiente: 'produccion' } as const;
    expect(bloqueaAprobacionAutomatica(aSelloFiscal({ ...base, estado: 'RECHAZADO' }))).toBe(true);
    expect(bloqueaAprobacionAutomatica(aSelloFiscal({ ...base, estado: 'NO_VERIFICABLE' }))).toBe(true);
    expect(bloqueaAprobacionAutomatica(aSelloFiscal({ ...base, estado: 'APROBADO' }))).toBe(false);
  });
});

describe('WSAA — construcción y firma del TRA', () => {
  /**
   * Certificado autofirmado generado en el test.
   *
   * No sirve para hablar con ARCA —el suyo lo emite su propia autoridad
   * certificante— pero sí permite verificar que el TRA se arma bien y que la
   * firma CMS produce un PKCS#7 válido y verificable. Es todo lo que se puede
   * comprobar sin el trámite hecho, y es más de lo que parecía.
   */
  function selfSigned(): CompanyCertificate {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
    const attrs = [{ name: 'commonName', value: 'aai-test' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    return {
      companyId: COMPANY,
      cuit: '30710000001',
      certificatePem: forge.pki.certificateToPem(cert),
      privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
      notAfter: cert.validity.notAfter,
    };
  }

  it('el TRA tiene la estructura que espera WSAA', () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const tra = buildTra('wscdc', now, 600);
    expect(tra).toContain('<loginTicketRequest version="1.0">');
    expect(tra).toContain('<service>wscdc</service>');
    expect(tra).toMatch(/<uniqueId>\d+<\/uniqueId>/);

    // generationTime hacia atrás y expirationTime hacia adelante: el margen
    // evita rechazos por desfasaje de reloj con el organismo.
    const generation = /<generationTime>([^<]+)<\/generationTime>/.exec(tra)![1]!;
    const expiration = /<expirationTime>([^<]+)<\/expirationTime>/.exec(tra)![1]!;
    expect(new Date(generation).getTime()).toBeLessThan(now.getTime());
    expect(new Date(expiration).getTime()).toBeGreaterThan(now.getTime());
  });

  it('dos TRA consecutivos no tienen el mismo uniqueId', () => {
    const a = buildTra('wscdc', new Date('2026-08-24T12:00:00Z'), 600);
    const b = buildTra('wscdc', new Date('2026-08-24T12:00:05Z'), 600);
    expect(a).not.toBe(b);
  });

  it('la firma CMS produce un PKCS#7 verificable que contiene el TRA', () => {
    const certificate = selfSigned();
    const tra = buildTra('wscdc', new Date(), 600);
    const cms = signTra(tra, certificate);

    expect(cms).toMatch(/^[A-Za-z0-9+/=]+$/);

    const der = forge.util.decode64(cms);
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(der)) as forge.pkcs7.PkcsSignedData;
    expect(p7.certificates).toHaveLength(1);
    // El contenido firmado es el TRA original, no otra cosa.
    const content = (p7.rawCapture as { content?: { value?: Array<{ value: string }> } }).content;
    expect(content?.value?.[0]?.value).toContain('<service>wscdc</service>');
  });

  it('rechaza firmar con un certificado vencido antes de salir a la red', async () => {
    const { WsaaAuthenticator } = await import('./soap/wsaa.js');
    const authenticator = new WsaaAuthenticator({
      endpoint: 'https://no-se-usa.invalid',
      fetchImpl: () => {
        throw new Error('no debería llegar a la red');
      },
    });
    const vencido = { ...selfSigned(), notAfter: new Date(Date.now() - 1000) };
    await expect(authenticator.login(vencido, 'wscdc')).rejects.toThrow(/venció/);
  });

  it('extrae token y sign del ticket de acceso', () => {
    const ticketXml =
      '<loginTicketResponse><header><generationTime>2026-08-24T12:00:00-03:00</generationTime>' +
      '<expirationTime>2026-08-24T24:00:00-03:00</expirationTime></header>' +
      '<credentials><token>TOKEN-ABC</token><sign>SIGN-XYZ</sign></credentials></loginTicketResponse>';
    const soap =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
      `<loginCmsResponse><loginCmsReturn>${ticketXml
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</loginCmsReturn></loginCmsResponse>` +
      '</soapenv:Body></soapenv:Envelope>';

    const ticket = parseLoginResponse(soap, '30710000001', 'wscdc');
    expect(ticket.token).toBe('TOKEN-ABC');
    expect(ticket.sign).toBe('SIGN-XYZ');
    expect(ticket.service).toBe('wscdc');
  });

  it('una respuesta de WSAA sin ticket falla en vez de devolver credenciales vacías', () => {
    expect(() => parseLoginResponse('<soapenv:Envelope/>', '30710000001', 'wscdc')).toThrow(
      /loginCmsReturn/,
    );
  });
});

/**
 * Los dos cuerpos de abajo son respuestas REALES del WSAA de homologación,
 * capturadas el 2026-08-26 con un certificado de `CN=Computadores Test`.
 * No están construidas a mano: por eso sirven.
 */
describe('WSAA — leer la falla en vez de adivinarla', () => {
  const falla = (code: string, str: string) =>
    '<?xml version="1.0" encoding="utf-8"?><soapenv:Envelope ' +
    'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
    `<faultcode xmlns:ns1="http://xml.apache.org/axis/">${code}</faultcode>` +
    `<faultstring>${str}</faultstring>` +
    '</soapenv:Fault></soapenv:Body></soapenv:Envelope>';

  const NO_AUTORIZADO = falla('ns1:coe.notAuthorized', 'Computador no autorizado a acceder al servicio');
  const CMS_MALO = falla('ns1:cms.bad', 'El CMS no es valido');

  it('distingue el permiso faltante de la firma inválida', () => {
    const permiso = describirFallaWsaa(500, NO_AUTORIZADO);
    const firma = describirFallaWsaa(500, CMS_MALO);

    expect(permiso).toBeInstanceOf(WsaaFaultError);
    expect(firma).toBeInstanceOf(WsaaFaultError);
    expect((permiso as WsaaFaultError).code).toBe('ns1:coe.notAuthorized');
    expect((firma as WsaaFaultError).code).toBe('ns1:cms.bad');

    // El de permiso tiene que decir que el código NO es el problema: es la
    // conclusión equivocada más cara de todo este camino.
    expect((permiso as WsaaFaultError).lectura).toMatch(/no está autorizado a ESE servicio/);
    expect((permiso as WsaaFaultError).lectura).not.toBeNull();
    expect((firma as WsaaFaultError).lectura).toMatch(/firma CMS/);
  });

  it('un faultcode desconocido se muestra crudo y se declara sin lectura', () => {
    const error = describirFallaWsaa(500, falla('ns1:algo.que.nadie.vio', 'Mensaje nuevo'));
    expect(error).toBeInstanceOf(WsaaFaultError);
    expect((error as WsaaFaultError).code).toBe('ns1:algo.que.nadie.vio');
    // Sin lectura inventada: quien lo atrape sabe que todavía no sabemos.
    expect((error as WsaaFaultError).lectura).toBeNull();
    expect(error.message).toContain('algo.que.nadie.vio');
    expect(error.message).toContain('Mensaje nuevo');
  });

  it('el prefijo de namespace lo elige el servidor, así que no forma parte de la clave', () => {
    const otroPrefijo = describirFallaWsaa(500, falla('zz42:coe.notAuthorized', 'x'));
    expect((otroPrefijo as WsaaFaultError).lectura).not.toBeNull();
  });

  it('una respuesta que no es un SOAP Fault no se fuerza a serlo', () => {
    const error = describirFallaWsaa(502, '<html><body>Bad Gateway</body></html>');
    expect(error).not.toBeInstanceOf(WsaaFaultError);
    expect(error.message).toContain('502');
    expect(error.message).toContain('Bad Gateway');
  });
});
