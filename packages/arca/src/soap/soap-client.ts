/**
 * Cliente SOAP real de ARCA.
 *
 * Estado de verificación (2026-08-24, vía `npm run arca:check`):
 *
 *   ✅ Los endpoints del manual archivado responden.
 *   ✅ `ComprobanteDummy` funciona contra homologación real: el sobre SOAP que
 *      arma esta clase lo entiende ARCA y la respuesta se parsea bien.
 *   ⚠️ `ComprobanteConstatar` NO está verificado de punta a punta: necesita un
 *      ticket de acceso, y por lo tanto el certificado. La estructura del
 *      request sale del manual oficial archivado
 *      (`ARCA_manual_desarrollador_wscdcv1_v4.pdf`, §2.2).
 *
 * Regla de esta clase: **jamás propaga una excepción de red al dominio**. Toda
 * indisponibilidad se traduce a `NO_VERIFICABLE` con su motivo. La lógica
 * contable no debe romperse porque ARCA esté de mantenimiento.
 */

import { XMLParser } from 'fast-xml-parser';
import type { ArcaClient } from '../client.js';
import type { CapabilityStore, CredentialStore, TicketCache } from '../credentials.js';
import { InMemoryTicketCache, AllEnabledCapabilityStore } from '../credentials.js';
import { endpointsFor, SERVICE_NAMES, type ArcaEnvironment } from '../environment.js';
import type {
  ComprobanteAConstatar,
  EstadoServicio,
  ObservacionArca,
  ResultadoApocrifo,
  ResultadoConstatacion,
  ResultadoPadron,
} from '../types.js';
import { WsaaAuthenticator } from './wsaa.js';

const NS = 'http://servicios1.afip.gob.ar/wscdc/';

export interface SoapClientOptions {
  readonly environment: Exclude<ArcaEnvironment, 'mock'>;
  readonly credentials: CredentialStore;
  readonly capabilities?: CapabilityStore;
  readonly ticketCache?: TicketCache;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

export class SoapArcaClient implements ArcaClient {
  readonly environment: Exclude<ArcaEnvironment, 'mock'>;

  readonly #options: SoapClientOptions;
  readonly #capabilities: CapabilityStore;
  readonly #tickets: TicketCache;
  readonly #wsaa: WsaaAuthenticator;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: SoapClientOptions) {
    this.environment = options.environment;
    this.#options = options;
    this.#capabilities = options.capabilities ?? new AllEnabledCapabilityStore();
    this.#tickets = options.ticketCache ?? new InMemoryTicketCache();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#wsaa = new WsaaAuthenticator({
      endpoint: endpointsFor(options.environment).wsaa,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  async #auth(
    companyId: string,
    service: (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES],
  ): Promise<
    | { ok: true; token: string; sign: string; cuit: string }
    | { ok: false; motivo: 'SIN_CREDENCIAL' | 'SERVICIO_NO_HABILITADO' | 'SERVICIO_CAIDO' }
  > {
    const certificate = await this.#options.credentials.getCertificate(companyId);
    if (certificate === null) return { ok: false, motivo: 'SIN_CREDENCIAL' };

    if (!(await this.#capabilities.isEnabled(companyId, service))) {
      return { ok: false, motivo: 'SERVICIO_NO_HABILITADO' };
    }

    const cached = await this.#tickets.get(certificate.cuit, service);
    if (cached !== null) {
      return { ok: true, token: cached.token, sign: cached.sign, cuit: certificate.cuit };
    }

    try {
      const ticket = await this.#wsaa.login(certificate, service);
      await this.#tickets.put(ticket);
      return { ok: true, token: ticket.token, sign: ticket.sign, cuit: certificate.cuit };
    } catch {
      // Incluye el caso de certificado vencido: para el dominio es indistinguible
      // de no poder preguntar, y en ambos casos la respuesta correcta es la misma.
      return { ok: false, motivo: 'SERVICIO_CAIDO' };
    }
  }

  async #post(url: string, action: string, body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 20_000);
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async constatarComprobante(
    companyId: string,
    comprobante: ComprobanteAConstatar,
  ): Promise<ResultadoConstatacion> {
    const consultadoEn = this.#now().toISOString();
    const base = { observaciones: [], errores: [], consultadoEn, ambiente: this.environment };

    const auth = await this.#auth(companyId, SERVICE_NAMES.wscdc);
    if (!auth.ok) {
      return { ...base, estado: 'NO_VERIFICABLE', motivoNoVerificable: auth.motivo };
    }

    const envelope = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">`,
      '<soap:Body><ar:ComprobanteConstatar>',
      `<ar:Auth><ar:Token>${auth.token}</ar:Token><ar:Sign>${auth.sign}</ar:Sign>`,
      `<ar:Cuit>${auth.cuit}</ar:Cuit></ar:Auth>`,
      '<ar:CmpReq>',
      `<ar:CbteModo>${comprobante.modalidad}</ar:CbteModo>`,
      `<ar:CuitEmisor>${comprobante.cuitEmisor}</ar:CuitEmisor>`,
      `<ar:PtoVta>${comprobante.puntoVenta}</ar:PtoVta>`,
      `<ar:CbteTipo>${comprobante.tipoComprobante}</ar:CbteTipo>`,
      `<ar:CbteNro>${comprobante.numeroComprobante}</ar:CbteNro>`,
      `<ar:CbteFch>${comprobante.fecha}</ar:CbteFch>`,
      `<ar:ImpTotal>${comprobante.importeTotal}</ar:ImpTotal>`,
      `<ar:CodAutorizacion>${comprobante.codigoAutorizacion}</ar:CodAutorizacion>`,
      `<ar:DocTipoReceptor>${comprobante.tipoDocReceptor}</ar:DocTipoReceptor>`,
      `<ar:DocNroReceptor>${comprobante.nroDocReceptor}</ar:DocNroReceptor>`,
      '</ar:CmpReq></ar:ComprobanteConstatar></soap:Body></soap:Envelope>',
    ].join('');

    let raw: string;
    try {
      raw = await this.#post(endpointsFor(this.environment).wscdc, `${NS}ComprobanteConstatar`, envelope);
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ...base,
        estado: 'NO_VERIFICABLE',
        motivoNoVerificable: aborted ? 'TIMEOUT' : 'SERVICIO_CAIDO',
      };
    }

    try {
      return { ...parseConstatacion(raw), consultadoEn, ambiente: this.environment };
    } catch {
      return { ...base, estado: 'NO_VERIFICABLE', motivoNoVerificable: 'RESPUESTA_INESPERADA' };
    }
  }

  async consultarPadron(companyId: string, cuit: string): Promise<ResultadoPadron> {
    const consultadoEn = this.#now().toISOString();
    const auth = await this.#auth(companyId, SERVICE_NAMES.padronA13);
    if (!auth.ok) {
      return { encontrado: false, datos: null, motivoNoVerificable: auth.motivo, consultadoEn };
    }
    // Pendiente de FASE 3: el manual de padrón A13 todavía no está archivado con
    // hash, así que no se implementa el envelope a partir de fuentes secundarias.
    void cuit;
    return { encontrado: false, datos: null, motivoNoVerificable: 'RESPUESTA_INESPERADA', consultadoEn };
  }

  async consultarApocrifo(companyId: string, cuit: string): Promise<ResultadoApocrifo> {
    const consultadoEn = this.#now().toISOString();
    const auth = await this.#auth(companyId, SERVICE_NAMES.wscdc);
    if (!auth.ok) return { esApocrifo: null, motivoNoVerificable: auth.motivo, consultadoEn };
    void cuit;
    return { esApocrifo: null, motivoNoVerificable: 'RESPUESTA_INESPERADA', consultadoEn };
  }

  async estadoServicio(): Promise<EstadoServicio> {
    const envelope = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}">`,
      '<soap:Body><ar:ComprobanteDummy/></soap:Body></soap:Envelope>',
    ].join('');

    try {
      const raw = await this.#post(
        endpointsFor(this.environment).wscdc,
        `${NS}ComprobanteDummy`,
        envelope,
      );
      const parsed = parser.parse(raw) as Record<string, unknown>;
      const appServer = String(deepFind(parsed, 'AppServer') ?? 'DESCONOCIDO');
      const dbServer = String(deepFind(parsed, 'DbServer') ?? 'DESCONOCIDO');
      const authServer = String(deepFind(parsed, 'AuthServer') ?? 'DESCONOCIDO');
      return {
        appServer,
        dbServer,
        authServer,
        disponible: [appServer, dbServer, authServer].every((value) => value === 'OK'),
      };
    } catch {
      return {
        appServer: 'ERROR',
        dbServer: 'ERROR',
        authServer: 'ERROR',
        disponible: false,
      };
    }
  }
}

/** Traduce la respuesta del WSCDC al modelo de dominio. */
export function parseConstatacion(
  raw: string,
): Pick<ResultadoConstatacion, 'estado' | 'observaciones' | 'errores' | 'respuestaCruda'> {
  const parsed = parser.parse(raw) as Record<string, unknown>;
  const resultado = deepFind(parsed, 'Resultado');
  if (resultado === undefined) {
    throw new Error('La respuesta no contiene <Resultado>');
  }

  return {
    // A = Autorizado, R = Rechazado (manual WSCDC, §"Resultado").
    estado: String(resultado) === 'A' ? 'APROBADO' : 'RECHAZADO',
    observaciones: collectObs(deepFind(parsed, 'Observaciones')),
    errores: collectObs(deepFind(parsed, 'Errores')),
    respuestaCruda: parsed,
  };
}

function collectObs(node: unknown): ObservacionArca[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  const container = node as Record<string, unknown>;
  const entries = container['Obs'] ?? container['Err'] ?? [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      codigo: Number(item['Code'] ?? 0),
      mensaje: String(item['Msg'] ?? ''),
    }));
}

function deepFind(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
    if (name === key || name.endsWith(`:${key}`)) return value;
    const nested = deepFind(value, key);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
