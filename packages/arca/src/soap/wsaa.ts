/**
 * WSAA — obtención del Ticket de Acceso.
 *
 * Flujo, según <https://www.afip.gob.ar/ws/documentacion/wsaa.asp> (archivado):
 *
 *   TRA (XML)  →  firma CMS/PKCS#7 con el certificado X.509 de ARCA
 *              →  LoginCms(in0 = CMS en base64)
 *              →  TA con {token, sign} y vigencia acotada
 *
 * ESTADO DE VERIFICACIÓN CONTRA EL SERVICIO REAL (2026-08-26, homologación,
 * certificado emitido por `CN=Computadores Test, O=AFIP, C=AR`):
 *
 *   ✔ VERIFICADO — `buildTra` + `signTra`. Se mandó el mismo CMS dos veces, una
 *     íntegro y una con ocho bytes de la firma invertidos. El servicio contestó
 *     `ns1:coe.notAuthorized` al íntegro y `ns1:cms.bad` al corrompido. Que
 *     distinga los dos casos es la prueba: el WSAA validó nuestra firma y la
 *     aceptó. El rechazo del íntegro es de permiso, no de criptografía.
 *
 *   ✔ VERIFICADO (2026-08-27) — `parseLoginResponse`. Autorizado el certificado
 *     al servicio `wsfe` en WSASS, el login devolvió un TA real y el parseo
 *     sacó token, sign y vencimiento de la respuesta del servicio. Hasta el día
 *     anterior esto estaba probado solo contra XML escrito a mano.
 *
 * La distinción entre las dos líneas importa: "la firma anda" y "el login anda"
 * no son lo mismo, y durante un día fue cierta la primera y no la segunda. Se
 * escribieron por separado para poder tachar una sin arrastrar la otra.
 */

import forge from 'node-forge';
import { XMLParser } from 'fast-xml-parser';
import type { AccessTicket, CompanyCertificate, TicketCache } from '../credentials.js';
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
      throw describirFallaWsaa(response.status, text);
    }

    return parseLoginResponse(text, certificate.cuit, service);
  }
}

/**
 * Lecturas de `faultcode` **observadas directamente** contra el WSAA.
 *
 * ARCA no publica una tabla de estos códigos, y el manual del WSAA no está
 * archivado en `docs/normative-sources/`. Por eso acá solo hay códigos que se
 * vieron con los ojos, con la fecha en que se vieron. Un código que no esté en
 * esta tabla se muestra crudo: inventarle un significado a un error es la forma
 * más silenciosa de mandar a alguien a arreglar lo que no está roto.
 */
const LECTURAS_OBSERVADAS: ReadonlyMap<string, string> = new Map([
  [
    'coe.notAuthorized',
    'El certificado es válido y la firma fue aceptada, pero ese certificado no está ' +
      'autorizado a ESE servicio. Falta el paso de asociar servicio y certificado ' +
      '(WSASS en homologación; Administrador de Relaciones en producción). ' +
      'No es un problema del código ni del certificado. [observado 2026-08-26]',
  ],
  [
    'coe.alreadyAuthenticated',
    'Ya hay un ticket vivo para ese CUIT y ese servicio, y el WSAA no emite un segundo ' +
      'mientras el primero no venza. No es un rechazo: es que el ticket que se pidió antes ' +
      'sigue siendo válido y hay que reusarlo. Para eso está `TicketCacheFs`; si el ticket ' +
      'se perdió, hay que esperar a que venza. [observado 2026-08-27]',
  ],
  [
    'cms.bad',
    'El servicio no pudo validar la firma CMS: llegó mal armada, corrompida en tránsito, ' +
      'o firmada con una clave que no corresponde al certificado. [observado 2026-08-26]',
  ],
]);

/** Extrae `faultcode` y `faultstring` de un SOAP Fault, si los hay. */
export function leerFallaSoap(cuerpo: string): { code: string; message: string } | null {
  const code = /<faultcode[^>]*>([^<]*)<\/faultcode>/.exec(cuerpo)?.[1];
  if (code === undefined) return null;
  const message = /<faultstring[^>]*>([^<]*)<\/faultstring>/.exec(cuerpo)?.[1] ?? '';
  return { code: code.trim(), message: message.trim() };
}

/**
 * Falla del WSAA con el `faultcode` accesible como dato.
 *
 * Quien la atrapa no tiene que leerle el mensaje con una expresión regular para
 * saber si la causa está identificada: `lectura` es `null` cuando no lo está, y
 * ahí —y solo ahí— tiene sentido ofrecer una lista de sospechas.
 */
export class WsaaFaultError extends Error {
  readonly code: string;
  readonly lectura: string | null;

  constructor(code: string, faultstring: string, lectura: string | null) {
    super(
      `WSAA rechazó el login [${code}]${faultstring ? `: ${faultstring}` : ''}` +
        (lectura === null ? '' : `\n    → ${lectura}`),
    );
    this.name = 'WsaaFaultError';
    this.code = code;
    this.lectura = lectura;
  }
}

export function describirFallaWsaa(status: number, cuerpo: string): Error {
  const falla = leerFallaSoap(cuerpo);
  if (falla === null) return new Error(`WSAA respondió ${status}: ${cuerpo.slice(0, 500)}`);

  // El prefijo de namespace (`ns1:`) lo elige el servidor y puede cambiar.
  const desnudo = falla.code.replace(/^[^:]*:/, '');
  return new WsaaFaultError(falla.code, falla.message, LECTURAS_OBSERVADAS.get(desnudo) ?? null);
}

/**
 * Login que primero mira la caché.
 *
 * Pedir un TA cuando ya hay uno vivo no es una ineficiencia: el WSAA lo rechaza
 * con `coe.alreadyAuthenticated`, y el propio organismo advierte que pedir
 * tickets de más es motivo de bloqueo. La caché no es una optimización, es la
 * forma correcta de usar el servicio.
 */
export async function loginConCache(
  authenticator: WsaaAuthenticator,
  cache: TicketCache,
  certificate: CompanyCertificate,
  service: ServiceName,
): Promise<{ ticket: AccessTicket; deLaCache: boolean }> {
  const guardado = await cache.get(certificate.cuit, service);
  if (guardado !== null) return { ticket: guardado, deLaCache: true };

  const ticket = await authenticator.login(certificate, service);
  await cache.put(ticket);
  return { ticket, deLaCache: false };
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
