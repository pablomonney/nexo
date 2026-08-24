/**
 * Tipos de dominio de la integración con ARCA.
 *
 * Son deliberadamente independientes del SOAP: quien consume el cliente no debe
 * saber que del otro lado hay un `.asmx`. Eso permite que el mock, el cliente
 * real y cualquier reemplazo futuro sean intercambiables sin tocar la lógica
 * contable.
 */

/** Modalidad de autorización del comprobante (campo `CbteModo` del WSCDC). */
export type ModalidadAutorizacion = 'CAE' | 'CAEA' | 'CAI';

export interface ComprobanteAConstatar {
  readonly modalidad: ModalidadAutorizacion;
  readonly cuitEmisor: string;
  readonly puntoVenta: number;
  readonly tipoComprobante: number;
  readonly numeroComprobante: number;
  /** Fecha del comprobante en formato AAAAMMDD, como lo exige el servicio. */
  readonly fecha: string;
  /** Importe total. Se transporta como string decimal: nunca como float. */
  readonly importeTotal: string;
  readonly codigoAutorizacion: string;
  readonly tipoDocReceptor: string;
  readonly nroDocReceptor: string;
}

export interface ObservacionArca {
  readonly codigo: number;
  readonly mensaje: string;
}

/**
 * Resultado de la constatación.
 *
 * `estado` distingue tres situaciones que NO son lo mismo:
 *   · `APROBADO`       — ARCA confirma que el comprobante está autorizado
 *   · `RECHAZADO`      — ARCA responde que no lo está
 *   · `NO_VERIFICABLE` — no se pudo preguntar (servicio caído, CUIT sin
 *                        habilitación, credencial ausente, timeout)
 *
 * El tercero es el que más importa. Un sistema que colapse "no pude preguntar"
 * con "está bien" convierte una caída del organismo en un comprobante aprobado
 * en silencio. Ver `docs/RISKS.md` R-14.
 */
export type EstadoConstatacion = 'APROBADO' | 'RECHAZADO' | 'NO_VERIFICABLE';

export type MotivoNoVerificable =
  | 'SIN_CREDENCIAL'
  | 'SERVICIO_NO_HABILITADO'
  | 'SERVICIO_CAIDO'
  | 'TIMEOUT'
  | 'RESPUESTA_INESPERADA'
  | 'AMBIENTE_MOCK';

export interface ResultadoConstatacion {
  readonly estado: EstadoConstatacion;
  /**
   * Un comprobante puede estar APROBADO y observado a la vez: el manual del
   * WSCDC muestra `Resultado=A` junto a `Obs 200 "Existe CAEA, no fue rendido"`.
   * Las observaciones no se descartan aunque el estado sea aprobado.
   */
  readonly observaciones: readonly ObservacionArca[];
  readonly errores: readonly ObservacionArca[];
  readonly motivoNoVerificable?: MotivoNoVerificable;
  /** Eco de lo que ARCA devolvió, para archivar como evidencia. */
  readonly respuestaCruda?: unknown;
  readonly consultadoEn: string;
  readonly ambiente: string;
}

export interface DatosPadron {
  readonly cuit: string;
  readonly razonSocial: string | null;
  readonly estadoClave: string | null;
  readonly condicionIva: string | null;
  readonly domicilioFiscal: string | null;
}

export interface ResultadoPadron {
  readonly encontrado: boolean;
  readonly datos: DatosPadron | null;
  readonly motivoNoVerificable?: MotivoNoVerificable;
  readonly consultadoEn: string;
}

export interface ResultadoApocrifo {
  readonly esApocrifo: boolean | null;
  readonly motivoNoVerificable?: MotivoNoVerificable;
  readonly consultadoEn: string;
}

/** Ping del servicio: los WS de ARCA exponen un `Dummy` para esto. */
export interface EstadoServicio {
  readonly appServer: string;
  readonly dbServer: string;
  readonly authServer: string;
  readonly disponible: boolean;
}
