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
