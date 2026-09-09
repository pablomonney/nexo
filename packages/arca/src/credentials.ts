/**
 * Credenciales y tickets de acceso.
 *
 * Todo el acoplamiento con el certificado X.509 vive detrás de estas dos
 * interfaces. Mientras el estudio no complete el trámite ante ARCA, se usa
 * `NullCredentialStore` y el resto del sistema funciona igual: las validaciones
 * fiscales devuelven `NO_VERIFICABLE` con motivo `SIN_CREDENCIAL`, que es
 * exactamente lo que corresponde informar.
 *
 * Ver `docs/api/arca-onboarding.md` para el trámite.
 */

import forge from 'node-forge';
import type { ServiceName } from './environment.js';

/**
 * Certificado y clave privada de una empresa.
 *
 * SECURITY.md §5: la clave privada se guarda cifrada con sobre (DEK por empresa
 * envuelta con la KEK del KMS) y **nunca** se materializa en disco de la
 * aplicación. Esta interfaz devuelve el material en memoria y por el tiempo
 * mínimo necesario para firmar el TRA.
 */
export interface CompanyCertificate {
  readonly companyId: string;
  /** CUIT del contribuyente representado. */
  readonly cuit: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: Date;
}

export interface CredentialStore {
  /** `null` cuando la empresa todavía no tiene certificado cargado. */
  getCertificate(companyId: string): Promise<CompanyCertificate | null>;
}

/**
 * Ticket de acceso emitido por WSAA.
 *
 * Tiene vigencia acotada y se cachea: pedir tickets de más es motivo de bloqueo
 * por parte del organismo. La caché es por `(cuit, servicio)`, no por empresa,
 * porque un mismo CUIT puede operar para varias.
 */
export interface AccessTicket {
  readonly token: string;
  readonly sign: string;
  readonly cuit: string;
  readonly service: ServiceName;
  readonly generationTime: Date;
  readonly expirationTime: Date;
}

export interface TicketCache {
  get(cuit: string, service: ServiceName): Promise<AccessTicket | null>;
  put(ticket: AccessTicket): Promise<void>;
}

/** Store vacío: el modo por defecto durante el desarrollo. */
export class NullCredentialStore implements CredentialStore {
  async getCertificate(): Promise<CompanyCertificate | null> {
    return null;
  }
}

/** Caché en memoria. En producción se usa la tabla `arca_access_tickets`. */
export class InMemoryTicketCache implements TicketCache {
  readonly #tickets = new Map<string, AccessTicket>();

  #key(cuit: string, service: ServiceName): string {
    return `${cuit}:${service}`;
  }

  async get(cuit: string, service: ServiceName): Promise<AccessTicket | null> {
    const ticket = this.#tickets.get(this.#key(cuit, service));
    if (ticket === undefined) return null;
    // Se renueva con margen: un ticket que vence en pleno vuelo produce un
    // error que parece una caída del servicio y no lo es.
    if (ticket.expirationTime.getTime() - Date.now() < 60_000) return null;
    return ticket;
  }

  async put(ticket: AccessTicket): Promise<void> {
    this.#tickets.set(this.#key(ticket.cuit, ticket.service), ticket);
  }
}

/**
 * Capacidades habilitadas por empresa.
 *
 * El catálogo oficial de ARCA advierte que "para usar ciertos servicios se
 * requieren autorizaciones y acuerdos especiales". Que exista el certificado no
 * implica que el CUIT tenga habilitado el servicio: son dos trámites distintos.
 * La UI muestra qué validaciones están disponibles para cada empresa en lugar de
 * fallar sin explicación.
 */
export interface CapabilityStore {
  isEnabled(companyId: string, service: ServiceName): Promise<boolean>;
}

export class AllEnabledCapabilityStore implements CapabilityStore {
  async isEnabled(): Promise<boolean> {
    return true;
  }
}

/**
 * Arma un `CompanyCertificate` leyendo del PEM lo que el PEM ya dice.
 *
 * Existe por un error que costó una afirmación falsa sobre el organismo.
 * `scripts/arca-capabilities.mjs` construía el certificado a mano:
 *
 *     const certificate = { cuit, environment, certificatePem, privateKeyPem };
 *
 * Le faltaba `notAfter`. La primera línea de `WsaaAuthenticator.login` es
 * `certificate.notAfter.getTime()`, así que reventaba con un TypeError **antes
 * de abrir el socket** — y el `catch` de arriba clasificaba ese error como
 * «WSAA rechazó el servicio: el contribuyente tiene que delegarlo». El informe
 * decía `NO_DELEGADO` de los cuatro servicios sin haberle preguntado nada a
 * ARCA, y decía `wsfe` no delegado cuando la cabecera de `soap/wsaa.ts` tiene
 * anotado el día que `wsfe` devolvió un TA real.
 *
 * El script era `.mjs`, así que `tsc` nunca miró ese objeto. La corrección de
 * fondo no es agregarle el campo que falta: es que **no haya un objeto que
 * armar a mano**. La fecha de vencimiento no es un dato que el que llama tenga
 * que saber — está adentro del certificado, firmada.
 *
 * @throws si el PEM no parsea, o si el CUIT que se pide no es el del
 * certificado: firmar un TRA con el certificado de otro contribuyente produce
 * un rechazo de WSAA que se lee igual que una delegación faltante, y es otra
 * cosa.
 */
export function certificadoDesdePem(datos: {
  readonly companyId: string;
  readonly cuit: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}): CompanyCertificate {
  let cert: forge.pki.Certificate;
  try {
    cert = forge.pki.certificateFromPem(datos.certificatePem);
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error);
    throw new Error(`El certificado de ${datos.companyId} no es un X.509 en PEM válido: ${motivo}`);
  }

  const delCertificado = cuitDelSujeto(cert);
  if (delCertificado !== null && delCertificado !== datos.cuit) {
    throw new Error(
      `El certificado es del CUIT ${delCertificado} y se pidió operar como ${datos.cuit}. ` +
        'Firmar un TRA con el certificado de otro contribuyente lo rechaza WSAA, y ese ' +
        'rechazo se lee igual que un servicio sin delegar.',
    );
  }

  return {
    companyId: datos.companyId,
    cuit: datos.cuit,
    certificatePem: datos.certificatePem,
    privateKeyPem: datos.privateKeyPem,
    notAfter: cert.validity.notAfter,
  };
}

/**
 * El CUIT que ARCA pone en el sujeto del certificado, como `serialNumber`.
 *
 * Devuelve `null` —no una cadena vacía ni el CUIT pedido— cuando el atributo no
 * está: significa «no se puede afirmar de quién es este certificado», y con eso
 * no se rechaza nada. Un certificado emitido por otra autoridad puede no traerlo.
 */
function cuitDelSujeto(cert: forge.pki.Certificate): string | null {
  const atributo = cert.subject.getField({ name: 'serialNumber' }) as { value?: unknown } | null;
  const valor = typeof atributo?.value === 'string' ? atributo.value : null;
  if (valor === null) return null;
  const numero = /(\d{11})/.exec(valor);
  return numero?.[1] ?? null;
}
