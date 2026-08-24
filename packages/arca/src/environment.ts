/**
 * Ambientes de ARCA.
 *
 * Los endpoints salen de los manuales oficiales archivados en
 * `docs/normative-sources/originals/`, no de memoria:
 *   · WSAA   → ARCA_manual... / afip.gob.ar/ws/documentacion/wsaa.asp
 *   · WSCDC  → ARCA_manual_desarrollador_wscdcv1_v4.pdf, §"Ambientes"
 *
 * Nótese la mezcla de dominios: homologación sigue bajo `afip.gob.ar` y
 * producción ya migró a `arca.gob.ar`, mientras que los endpoints de WSAA
 * conservan `afip.gov.ar` (con `.gov`, no `.gob`). No es un error de tipeo:
 * es el estado real de la infraestructura del organismo (conflicto C-05).
 */

export type ArcaEnvironment = 'mock' | 'homologacion' | 'produccion';

export interface ServiceEndpoints {
  readonly wsaa: string;
  readonly wscdc: string;
  readonly padronA13: string;
  readonly padronA100: string;
  readonly wsfev1: string;
}

const HOMOLOGACION: ServiceEndpoints = {
  wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
  wscdc: 'https://wswhomo.afip.gob.ar/WSCDC/service.asmx',
  padronA13: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA13',
  padronA100: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA100',
  wsfev1: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
};

const PRODUCCION: ServiceEndpoints = {
  wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
  wscdc: 'https://servicios1.arca.gob.ar/WSCDC/service.asmx',
  padronA13: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13',
  padronA100: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA100',
  wsfev1: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
};

/**
 * Nivel de verificación de cada endpoint, con el mismo criterio que el motor
 * normativo: `V1` significa "leído de documentación oficial archivada".
 *
 * Los de WSAA y WSCDC están en `V1`. Los de padrón y wsfev1 provienen de la
 * documentación pública de ARCA pero sus manuales todavía no se archivaron con
 * hash, así que quedan en `V2` hasta que se descarguen. No se usan en FASE 3.
 */
export const ENDPOINT_VERIFICATION: Record<keyof ServiceEndpoints, 'V1' | 'V2'> = {
  wsaa: 'V1',
  wscdc: 'V1',
  padronA13: 'V2',
  padronA100: 'V2',
  wsfev1: 'V2',
};

export function endpointsFor(environment: ArcaEnvironment): ServiceEndpoints {
  switch (environment) {
    case 'produccion':
      return PRODUCCION;
    case 'homologacion':
      return HOMOLOGACION;
    case 'mock':
      // El cliente mock no hace red. Se devuelven los de homologación para que
      // cualquier log muestre a qué apuntaría, no una URL inventada.
      return HOMOLOGACION;
  }
}

/** Nombre del servicio tal como lo espera el TRA de WSAA. */
export const SERVICE_NAMES = {
  wscdc: 'wscdc',
  padronA13: 'ws_sr_padron_a13',
  padronA100: 'ws_sr_padron_a100',
  wsfev1: 'wsfe',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];
