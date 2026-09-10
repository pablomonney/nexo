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
 * Los de WSAA y WSCDC están en `V1`.
 *
 * **wsfev1 y padrón siguen en `V2`, y el motivo cambió en B2.5.4.** Decía que
 * sus manuales «todavía no se archivaron con hash», y eso dejó de ser cierto:
 * `ARCA_manual_desarrollador_wsfev1_v4.6.pdf`, `ARCA_QR_especificaciones.pdf` y
 * los dos de padrón están archivados y `npm run norms:verify` los da íntegros.
 *
 * Lo que falta es distinto y más preciso: de wsfev1 **está confirmado el
 * extremo de homologación y no el de producción**. El que está archivado es
 * `ARCA_wsfev1_homologacion.wsdl`, y ahí figura exactamente
 * `https://wswhomo.afip.gov.ar/wsfev1/service.asmx`, que es el que declara este
 * archivo. Del de producción no hay fuente archivada que lo respalde.
 *
 * Se deja en `V2` por eso, y no por lo que decía antes. Confirmarlo contra el
 * WSDL de producción es un paso de la lista previa a emitir —ver
 * `NEXO_B2_5_4_ARCA_PRODUCCION.md` §23—: apuntar a un extremo equivocado en
 * producción no falla de forma obvia, falla como «ARCA no contesta».
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
