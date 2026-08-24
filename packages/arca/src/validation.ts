/**
 * Traducción de la respuesta de ARCA a las tres dimensiones de validación del §11.
 *
 * El pliego es explícito y tiene razón:
 *
 *   VALIDACIÓN FISCAL   ≠   VALIDACIÓN CONTABLE   ≠   VALIDACIÓN ECONÓMICA
 *
 * Que ARCA confirme un CAE prueba que el comprobante **fue autorizado**. No
 * prueba que la operación haya existido, ni que corresponda imputarla a esta
 * empresa, ni que el bien o servicio se haya recibido. Una factura apócrifa
 * perfectamente autorizada existe y es, justamente, el caso que interesa
 * detectar.
 *
 * Por eso este módulo produce **solo** el sello FISCAL. Los otros dos los
 * emiten otros procesos, y la UI los muestra por separado.
 */

import type { ResultadoConstatacion } from './types.js';

export type ResultadoValidacion = 'OK' | 'WARN' | 'FAIL' | 'NO_VERIFICABLE';

export interface SelloValidacionFiscal {
  readonly kind: 'FISCAL';
  readonly result: ResultadoValidacion;
  readonly source: 'ARCA_WSCDCV1';
  readonly evidence: {
    readonly estado: string;
    readonly observaciones: readonly { codigo: number; mensaje: string }[];
    readonly errores: readonly { codigo: number; mensaje: string }[];
    readonly motivoNoVerificable?: string;
    readonly ambiente: string;
    readonly consultadoEn: string;
  };
  /** Texto que la UI muestra al contador. */
  readonly explicacion: string;
}

const EXPLICACION_NO_VERIFICABLE: Record<string, string> = {
  SIN_CREDENCIAL:
    'No hay certificado digital configurado para esta empresa, así que no se pudo consultar a ARCA.',
  SERVICIO_NO_HABILITADO:
    'El CUIT no tiene habilitado el servicio de constatación de comprobantes ante ARCA.',
  SERVICIO_CAIDO: 'El servicio de ARCA no respondió. El comprobante queda sin constatar.',
  TIMEOUT: 'La consulta a ARCA excedió el tiempo de espera. El comprobante queda sin constatar.',
  RESPUESTA_INESPERADA: 'ARCA devolvió una respuesta que el sistema no pudo interpretar.',
  AMBIENTE_MOCK:
    'Ambiente de simulación: este resultado NO proviene de ARCA y no tiene valor probatorio.',
};

export function aSelloFiscal(resultado: ResultadoConstatacion): SelloValidacionFiscal {
  const evidence = {
    estado: resultado.estado,
    observaciones: resultado.observaciones,
    errores: resultado.errores,
    ...(resultado.motivoNoVerificable !== undefined
      ? { motivoNoVerificable: resultado.motivoNoVerificable }
      : {}),
    ambiente: resultado.ambiente,
    consultadoEn: resultado.consultadoEn,
  };

  if (resultado.estado === 'NO_VERIFICABLE') {
    const motivo = resultado.motivoNoVerificable ?? 'RESPUESTA_INESPERADA';
    return {
      kind: 'FISCAL',
      result: 'NO_VERIFICABLE',
      source: 'ARCA_WSCDCV1',
      evidence,
      explicacion: EXPLICACION_NO_VERIFICABLE[motivo] ?? 'No se pudo constatar el comprobante.',
    };
  }

  if (resultado.estado === 'RECHAZADO') {
    const detalle = [...resultado.observaciones, ...resultado.errores]
      .map((obs) => `${obs.codigo}: ${obs.mensaje}`)
      .join(' · ');
    return {
      kind: 'FISCAL',
      result: 'FAIL',
      source: 'ARCA_WSCDCV1',
      evidence,
      explicacion: `ARCA rechazó la constatación${detalle.length > 0 ? `. ${detalle}` : '.'}`,
    };
  }

  // Autorizado pero observado. El manual del WSCDC muestra este caso explícito
  // (Resultado=A con Obs 200): no se descarta la observación por estar aprobado.
  if (resultado.observaciones.length > 0) {
    const detalle = resultado.observaciones.map((obs) => `${obs.codigo}: ${obs.mensaje}`).join(' · ');
    return {
      kind: 'FISCAL',
      result: 'WARN',
      source: 'ARCA_WSCDCV1',
      evidence,
      explicacion: `Comprobante autorizado, con observaciones. ${detalle}`,
    };
  }

  // Un resultado del ambiente de simulación nunca se presenta como OK real.
  if (resultado.ambiente === 'mock') {
    return {
      kind: 'FISCAL',
      result: 'NO_VERIFICABLE',
      source: 'ARCA_WSCDCV1',
      evidence,
      explicacion: EXPLICACION_NO_VERIFICABLE['AMBIENTE_MOCK']!,
    };
  }

  return {
    kind: 'FISCAL',
    result: 'OK',
    source: 'ARCA_WSCDCV1',
    evidence,
    explicacion: 'ARCA confirma que el comprobante está autorizado.',
  };
}

/**
 * Disparadores duros para el sistema de confianza (§13).
 *
 * Cualquiera de estos fuerza 🔴 sin importar el score que devuelva el modelo:
 * la clasificación puede ser buenísima y el comprobante seguir sin constatar.
 */
export function bloqueaAprobacionAutomatica(sello: SelloValidacionFiscal): boolean {
  return sello.result === 'FAIL' || sello.result === 'NO_VERIFICABLE';
}
