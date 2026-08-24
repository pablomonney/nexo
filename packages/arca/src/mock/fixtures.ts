/**
 * Escenarios de prueba para el cliente mock.
 *
 * Los códigos y mensajes de observación NO están inventados: salen de los
 * ejemplos del manual oficial `ARCA_manual_desarrollador_wscdcv1_v4.pdf`,
 * archivado con hash en `docs/normative-sources/originals/`. Un mock que
 * devuelve respuestas plausibles pero irreales entrena al sistema para manejar
 * un servicio que no existe.
 *
 * Los CUIT son sintéticos: tienen dígito verificador válido para pasar la
 * validación de formato, pero no corresponden a contribuyentes reales.
 */

import type { ObservacionArca } from '../types.js';

export type EscenarioArca =
  | 'APROBADO'
  | 'APROBADO_CON_OBSERVACIONES'
  | 'RECHAZADO_FECHA'
  | 'RECHAZADO_INEXISTENTE'
  | 'SERVICIO_CAIDO'
  | 'TIMEOUT';

export interface DefinicionEscenario {
  readonly resultado: 'A' | 'R';
  readonly observaciones: readonly ObservacionArca[];
  readonly errores: readonly ObservacionArca[];
  /** Simula indisponibilidad del organismo en vez de una respuesta de negocio. */
  readonly falla?: 'SERVICIO_CAIDO' | 'TIMEOUT';
}

export const ESCENARIOS: Record<EscenarioArca, DefinicionEscenario> = {
  APROBADO: {
    resultado: 'A',
    observaciones: [],
    errores: [],
  },

  // Del manual: Resultado=A junto a una observación. Un comprobante puede estar
  // autorizado y observado a la vez, y el sistema no debe descartar la
  // observación solo porque el estado sea aprobado.
  APROBADO_CON_OBSERVACIONES: {
    resultado: 'A',
    observaciones: [
      { codigo: 200, mensaje: 'Existe CAEA, no fue rendido o no coincide con los datos registrados.' },
    ],
    errores: [],
  },

  RECHAZADO_FECHA: {
    resultado: 'R',
    observaciones: [
      { codigo: 108, mensaje: 'La fecha consignada no se encuentra dentro del rango habilitado.' },
    ],
    errores: [],
  },

  RECHAZADO_INEXISTENTE: {
    resultado: 'R',
    observaciones: [
      { codigo: 102, mensaje: 'El comprobante consultado no se encuentra registrado.' },
    ],
    errores: [],
  },

  SERVICIO_CAIDO: { resultado: 'R', observaciones: [], errores: [], falla: 'SERVICIO_CAIDO' },
  TIMEOUT: { resultado: 'R', observaciones: [], errores: [], falla: 'TIMEOUT' },
};

/** CUIT sintéticos con dígito verificador válido, para fixtures y tests. */
export const CUIT_PRUEBA = {
  /** Proveedor habitual, sin observaciones. */
  proveedorNormal: '30710000001',
  /** Marcado como apócrifo por el mock de `consultarApocrifo`. */
  proveedorApocrifo: '30710000028',
  /** No figura en el padrón. */
  desconocido: '30710000036',
} as const;

export interface ComprobantePrueba {
  readonly descripcion: string;
  readonly escenario: EscenarioArca;
  readonly cuitEmisor: string;
  readonly puntoVenta: number;
  readonly tipoComprobante: number;
  readonly numeroComprobante: number;
  readonly fecha: string;
  readonly importeTotal: string;
  readonly codigoAutorizacion: string;
}

/**
 * Juego de comprobantes de prueba.
 *
 * Cubre las variantes que el §33 del pliego exige testear en la parte de
 * validación fiscal. Los importes son strings: en todo el repositorio el dinero
 * jamás viaja como float.
 */
export const COMPROBANTES_PRUEBA: readonly ComprobantePrueba[] = [
  {
    descripcion: 'Factura A autorizada por CAE',
    escenario: 'APROBADO',
    cuitEmisor: CUIT_PRUEBA.proveedorNormal,
    puntoVenta: 1,
    tipoComprobante: 1,
    numeroComprobante: 1001,
    fecha: '20250115',
    importeTotal: '121000.00',
    codigoAutorizacion: '75000000000001',
  },
  {
    descripcion: 'Factura B con CAEA no rendido: autorizada pero observada',
    escenario: 'APROBADO_CON_OBSERVACIONES',
    cuitEmisor: CUIT_PRUEBA.proveedorNormal,
    puntoVenta: 1,
    tipoComprobante: 6,
    numeroComprobante: 1002,
    fecha: '20250116',
    importeTotal: '60500.00',
    codigoAutorizacion: '75000000000002',
  },
  {
    descripcion: 'Comprobante con fecha fuera del rango habilitado',
    escenario: 'RECHAZADO_FECHA',
    cuitEmisor: CUIT_PRUEBA.proveedorNormal,
    puntoVenta: 1,
    tipoComprobante: 1,
    numeroComprobante: 1003,
    fecha: '20200101',
    importeTotal: '10000.00',
    codigoAutorizacion: '75000000000003',
  },
  {
    descripcion: 'Comprobante inexistente en los registros de ARCA',
    escenario: 'RECHAZADO_INEXISTENTE',
    cuitEmisor: CUIT_PRUEBA.proveedorNormal,
    puntoVenta: 99,
    tipoComprobante: 1,
    numeroComprobante: 999_999,
    fecha: '20250120',
    importeTotal: '1.00',
    codigoAutorizacion: '00000000000000',
  },
  {
    descripcion: 'Emisor marcado como apócrifo',
    escenario: 'APROBADO',
    cuitEmisor: CUIT_PRUEBA.proveedorApocrifo,
    puntoVenta: 3,
    tipoComprobante: 1,
    numeroComprobante: 77,
    fecha: '20250118',
    importeTotal: '500000.00',
    codigoAutorizacion: '75000000000077',
  },
];

/** Clave de escenario por comprobante, tal como la arma el mock. */
export function claveComprobante(
  cuitEmisor: string,
  puntoVenta: number,
  tipoComprobante: number,
  numeroComprobante: number,
): string {
  return `${cuitEmisor}-${puntoVenta}-${tipoComprobante}-${numeroComprobante}`;
}
