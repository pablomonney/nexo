/**
 * tax-engine — IVA.
 *
 * Este archivo solo DEFINE; `index.ts` solo reexporta.
 *
 * La decisión que gobierna todo el paquete: **ninguna alícuota está escrita
 * acá**. No hay un `21` en el código, ni un `0.21`, ni una constante llamada
 * `IVA_GENERAL`. Las alícuotas llegan resueltas desde `tax_rates`, que tiene
 * `norm_version_id NOT NULL` — si alguien quiere cargar una, tiene que decir de
 * qué norma sale (ADR-005).
 *
 * La segunda decisión, más incómoda: **el motor no dice si un crédito fiscal es
 * computable**. La regla de fondo está en la Ley 23.349, que no está archivada.
 * Lo que sí hace es verificar todo lo verificable —el comprobante, el emisor, la
 * discriminación, la alícuota— y devolver `NO_DETERMINABLE` con esa lista. Es
 * exactamente el §11: validación fiscal ≠ validación contable ≠ validación
 * económica, y confundirlas es cómo un sistema termina afirmando que un crédito
 * se puede tomar cuando lo único que verificó fue que la factura existe.
 */

import type { CalendarDate, Money, Result } from '@aai/shared';

export type DireccionIva = 'COMPRAS' | 'VENTAS';

/** Cómo el comprobante afecta al período. Las notas de crédito restan. */
export type SignoOperacion = 1n | -1n;

export interface AlicuotaRelevada {
  readonly id: string;
  /** Numerador y denominador. Nunca un `number`: 0.21 no es 21/100 en binario. */
  readonly numerador: bigint;
  readonly denominador: bigint;
  readonly etiqueta: string;
  readonly vigenteDesde: CalendarDate;
  readonly vigenteHasta: CalendarDate | null;
  /**
   * De qué versión de qué norma sale. Sin esto la alícuota no existe: la base
   * lo impone con `tax_rates.norm_version_id NOT NULL`.
   */
  readonly normVersionId: string;
}

/**
 * Una línea de comprobante con su tratamiento frente al IVA.
 *
 * `neto`, `iva`, `noGravado` y `exento` son montos, no porcentajes. El motor no
 * calcula el IVA a partir del neto: **lee el que el comprobante discrimina** y
 * verifica que sea coherente con alguna alícuota relevada. Calcularlo sería
 * reemplazar lo que el emisor declaró por lo que el sistema cree.
 */
export interface RenglonIva {
  readonly neto: Money;
  readonly iva: Money;
  readonly noGravado: Money;
  readonly exento: Money;
  /** `null` cuando el comprobante no la identifica y hay que deducirla. */
  readonly alicuotaId: string | null;
}

export type CondicionIva =
  | 'RESPONSABLE_INSCRIPTO'
  | 'MONOTRIBUTO'
  | 'EXENTO'
  | 'CONSUMIDOR_FINAL'
  | 'NO_CATEGORIZADO'
  | 'DESCONOCIDA';

export type ResultadoConstatacion = 'OK' | 'WARN' | 'FAIL' | 'NO_VERIFICABLE' | 'NO_CONSULTADO';

/**
 * Clase del comprobante, resuelta desde `arca_comprobante_types` **por fecha**.
 *
 * `null` cuando el código no está en el catálogo vigente a esa fecha. No es un
 * detalle: de la clase depende si el comprobante suma o resta en el período, y
 * el catálogo es una tabla que ARCA versiona en el tiempo (hallazgo de FASE 3b).
 */
export type ClaseComprobante =
  | 'FACTURA'
  | 'NOTA_DEBITO'
  | 'NOTA_CREDITO'
  | 'RECIBO'
  | 'LIQUIDACION';

export interface ComprobanteIva {
  readonly id: string;
  readonly direccion: DireccionIva;
  /** Código de tipo de ARCA. El catálogo vive en `arca_comprobante_types`. */
  readonly tipoComprobante: number;
  /** Resuelta del catálogo a la fecha del comprobante. `null` = no está. */
  readonly clase: ClaseComprobante | null;
  readonly puntoVenta: number;
  readonly numero: number;
  readonly fecha: CalendarDate;
  readonly cuitContraparte: string | null;
  readonly razonSocialContraparte: string | null;
  readonly condicionContraparte: CondicionIva;
  readonly renglones: readonly RenglonIva[];
  readonly percepciones: Money;
  readonly total: Money;
  /** Resultado de la constatación en ARCA (§11, validación fiscal). */
  readonly constatacion: ResultadoConstatacion;
  /** `null` cuando no se pudo consultar. No es lo mismo que "no es apócrifo". */
  readonly emisorApocrifo: boolean | null;
  /** El asiento que lo registra, si ya está imputado. */
  readonly entryId: string | null;
  readonly documentId: string | null;
}

// ---------------------------------------------------------------------------
// Hallazgos
// ---------------------------------------------------------------------------

export type CodigoHallazgoIva =
  | 'SIN_ALICUOTAS_RELEVADAS'
  | 'ALICUOTA_NO_IDENTIFICADA'
  | 'IVA_NO_DISCRIMINADO'
  | 'IVA_INCOHERENTE_CON_ALICUOTA'
  | 'TOTAL_NO_CIERRA'
  | 'CONSTATACION_NO_OK'
  | 'CONSTATACION_NO_CONSULTADA'
  | 'EMISOR_APOCRIFO'
  | 'EMISOR_SIN_VERIFICAR'
  | 'CONDICION_CONTRAPARTE_DESCONOCIDA'
  | 'TIPO_COMPROBANTE_DESCONOCIDO';

export interface HallazgoIva {
  readonly codigo: CodigoHallazgoIva;
  readonly mensaje: string;
  /** `true` cuando impide llevar el comprobante al subdiario. */
  readonly bloquea: boolean;
  readonly renglon?: number;
}

/**
 * Lo que el motor puede decir sobre un crédito fiscal.
 *
 * No hay `COMPUTABLE`. Es deliberado y es la afirmación central del módulo: la
 * computabilidad la deciden los arts. 12 y 13 de la Ley 23.349 —vinculación con
 * operaciones gravadas, regla de tope, prorrateo—, y esa ley no está archivada.
 * Un motor que devolviera `COMPUTABLE` estaría afirmando algo que no verificó.
 */
export type EstadoCreditoFiscal =
  | 'NO_DETERMINABLE'
  | 'IMPEDIDO_POR_FORMA'
  | 'FUENTE_NO_ENCONTRADA';

export interface EvaluacionCreditoFiscal {
  readonly comprobanteId: string;
  readonly estado: EstadoCreditoFiscal;
  /** Lo que sí se verificó, con su resultado. Es el valor real de la respuesta. */
  readonly hallazgos: readonly HallazgoIva[];
  readonly ivaDiscriminado: Money;
  /** Qué falta para poder decidir. Vacío nunca: siempre falta la ley. */
  readonly faltaRelevar: readonly string[];
  readonly mensaje: string;
}

export type ResultadoIva<T> = Result<T, readonly HallazgoIva[]>;
