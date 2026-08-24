/**
 * WSAA — obtención del Ticket de Acceso.
 *
 * Flujo, según <https://www.afip.gob.ar/ws/documentacion/wsaa.asp> (archivado):
 *
 *   TRA (XML)  →  firma CMS/PKCS#7 con el certificado X.509 de ARCA
 *              →  LoginCms(in0 = CMS en base64)
 *              →  TA con {token, sign} y vigencia acotada
 *
 * ⚠️  ESTA IMPLEMENTACIÓN NO ESTÁ VERIFICADA CONTRA EL SERVICIO REAL.
 *     Se escribió siguiendo el manual oficial, pero no se pudo ejecutar de punta
 *     a punta porque requiere un certificado emitido por ARCA. El script
 *     `npm run arca:check` hace esa verificación en homologación el día que el
 *     certificado exista. Hasta entonces el sistema opera con `MockArcaClient` y
 *     la falta de verificación está declarada, no disimulada.
 */

import forge from 'node-forge';
import { XMLParser } from 'fast-xml-parser';
import type { AccessTicket, CompanyCertificate } from '../credentials.js';
import type { ServiceName } from '../environment.js';

export interface WsaaOptions {
  readonly endpoint: string;
  /** Ventana de validez solicitada. ARCA rechaza TRA con ventanas excesivas. */
  readonly ttlSeconds?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/** Construye el Ticket Request Access que se firma. */
export function buildTra(service: ServiceName, now: Date, ttlSeconds: number): string {
  // El uniqueId debe variar entre pedidos; ARCA rechaza TRA repetidos.
  const uniqueId = Math.floor(now.getTime() / 1000);
  // Margen hacia atrás por desfasaje de reloj entre el cliente y el organismo.
  const generationTime = new Date(now.getTime() - 60_000).toISOString();
  const expirationTime = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<loginTicketRequest version="1.0">',
    '<header>',
    `<uniqueId>${uniqueId}</uniqueId>`,
    `<generationTime>${generationTime}</generationTime>`,
    `<expirationTime>${expirationTime}</expirationTime>`,
    '</header>',
    `<service>${service}</service>`,
    '</loginTicketRequest>',
  ].join('');
}

/**
 * OIDs de PKCS#7. `forge.pki.oids` está tipado como diccionario abierto, así que
 * los accesos devuelven `string | undefined`; se resuelven acá una sola vez en
 * lugar de sembrar aserciones por todo el firmado.
 */
const OID = {
  sha256: forge.pki.oids['sha256'] as string,
  contentType: forge.pki.oids['contentType'] as string,
  data: forge.pki.oids['data'] as string,
  messageDigest: forge.pki.oids['messageDigest'] as string,
  signingTime: forge.pki.oids['signingTime'] as string,
} as const;

/** Firma el TRA en CMS/PKCS#7 y lo devuelve en base64, como espera LoginCms. */
export function signTra(tra: string, certificate: CompanyCertificate): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(forge.pki.certificateFromPem(certificate.certificatePem));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(certificate.privateKeyPem),
    certificate: forge.pki.certificateFromPem(certificate.certificatePem),
    digestAlgorithm: OID.sha256,
    authenticatedAttributes: [
      { type: OID.contentType, value: OID.data },
      { type: OID.messageDigest },
      { type: OID.signingTime, value: new Date().toISOString() },
    ],
  });
  p7.sign();
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.encode64(der);
}

export class WsaaAuthenticator {
  readonly #options: Required<Pick<WsaaOptions, 'endpoint' | 'ttlSeconds'>> & WsaaOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: WsaaOptions) {
    this.#options = { ttlSeconds: 600, ...options };
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async login(certificate: CompanyCertificate, service: ServiceName): Promise<AccessTicket> {
    if (certificate.notAfter.getTime() <= this.#now().getTime()) {
      throw new Error(
        `El certificado de la empresa ${certificate.companyId} venció el ${certificate.notAfter.toISOString()}. ` +
          'Hay que renovarlo en el Administrador de Certificados Digitales.',
      );
    }

    const tra = buildTra(service, this.#now(), this.#options.ttlSeconds);
    const cms = signTra(tra, certificate);

    const envelope = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ',
      'xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">',
      '<soapenv:Header/><soapenv:Body><wsaa:loginCms>',
      `<wsaa:in0>${cms}</wsaa:in0>`,
      '</wsaa:loginCms></soapenv:Body></soapenv:Envelope>',
    ].join('');

    const response = await this.#fetch(this.#options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: envelope,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`WSAA respondió ${response.status}: ${text.slice(0, 500)}`);
    }

    return parseLoginResponse(text, certificate.cuit, service);
  }
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

/** Extrae el TA del `loginCmsReturn`, que viene como XML escapado dentro del SOAP. */
export function parseLoginResponse(
  soapResponse: string,
  cuit: string,
  service: ServiceName,
): AccessTicket {
  const outer = parser.parse(soapResponse) as Record<string, unknown>;
  const inner = findValue(outer, 'loginCmsReturn');
  if (typeof inner !== 'string') {
    throw new Error(`Respuesta de WSAA sin loginCmsReturn: ${soapResponse.slice(0, 500)}`);
  }

  const ticket = parser.parse(inner) as Record<string, unknown>;
  const token = findValue(ticket, 'token');
  const sign = findValue(ticket, 'sign');
  const generationTime = findValue(ticket, 'generationTime');
  const expirationTime = findValue(ticket, 'expirationTime');

  if (typeof token !== 'string' || typeof sign !== 'string') {
    throw new Error('El ticket de acceso no trae token y sign');
  }

  return {
    token,
    sign,
    cuit,
    service,
    generationTime: new Date(String(generationTime)),
    expirationTime: new Date(String(expirationTime)),
  };
}

/** Búsqueda por nombre de tag, sin depender del prefijo de namespace. */
function findValue(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    if (name === key || name.endsWith(`:${key}`)) return value;
    const nested = findValue(value, key);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
