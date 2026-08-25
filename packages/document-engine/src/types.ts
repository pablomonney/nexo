/**
 * Tipos del motor documental.
 *
 * El núcleo de este módulo es `CampoExtraido`, que separa cuatro cosas que los
 * sistemas de ingesta suelen colapsar en una sola (§10 del pliego):
 *
 *   · `rawValue`     — lo que literalmente decía el documento
 *   · `parsedValue`  — cómo lo interpretó el sistema
 *   · `confidence`   — cuánto vale esa lectura
 *   · `method`       — quién la produjo
 *
 * Colapsarlas hace imposible auditar una imputación: si un total quedó mal, no
 * hay forma de saber si el OCR leyó mal, si el intérprete confundió el separador
 * de miles, o si alguien lo corrigió a mano. Con los cuatro campos, sí.
 */

import type { Currency } from '@aai/shared';

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

/** De dónde entró el documento. Determina cuánta confianza merece el origen. */
export type OrigenDocumento = 'UPLOAD' | 'EMAIL' | 'FOLDER' | 'API';

/**
 * Tipo real del contenido, determinado por sus bytes.
 *
 * Nunca por la extensión ni por el `Content-Type` que declara el cliente: ambos
 * los elige quien sube el archivo.
 */
export type TipoContenido = 'PDF' | 'JPEG' | 'PNG' | 'XML' | 'CSV' | 'XLSX' | 'DESCONOCIDO';

export interface DocumentoIngresado {
  readonly sha256: string;
  readonly bytes: number;
  readonly tipo: TipoContenido;
  readonly mime: string;
  readonly nombreOriginal: string;
  readonly origen: OrigenDocumento;
  readonly storageKey: string;
  /** Hallazgos del análisis del archivo que no impiden ingresarlo pero se registran. */
  readonly riesgos: readonly RiesgoArchivo[];
}

export interface RiesgoArchivo {
  readonly codigo: string;
  readonly detalle: string;
}

// ---------------------------------------------------------------------------
// Extracción
// ---------------------------------------------------------------------------

export type MetodoExtraccion = 'OCR' | 'XML' | 'REGEX' | 'LLM' | 'MANUAL';

export type ValorInterpretado =
  | { readonly kind: 'MONEY'; readonly amount: string; readonly currency: Currency }
  | { readonly kind: 'DATE'; readonly value: string }
  | { readonly kind: 'CUIT'; readonly value: string }
  | { readonly kind: 'INTEGER'; readonly value: string }
  | { readonly kind: 'TEXT'; readonly value: string };

export interface Recuadro {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}

export interface CampoExtraido {
  /** Ruta estable del campo: `comprobante.total`, `emisor.cuit`, … */
  readonly fieldPath: string;
  /** Exactamente lo que se leyó. `null` solo si el campo no apareció. */
  readonly rawValue: string | null;
  /** `null` cuando no se pudo interpretar. El `rawValue` se conserva igual. */
  readonly parsedValue: ValorInterpretado | null;
  readonly confidence: number;
  readonly method: MetodoExtraccion;
  readonly page?: number;
  readonly bbox?: Recuadro;
  /** Por qué no se interpretó, o qué supuesto se usó para interpretarlo. */
  readonly nota?: string;
}

export interface ResultadoExtraccion {
  readonly motor: string;
  readonly motorVersion: string;
  readonly campos: readonly CampoExtraido[];
  /** Mínimo de las confianzas de los campos con valor interpretado. */
  readonly confianzaGlobal: number;
  readonly disponible: boolean;
  /** Cuando `disponible` es falso: por qué no se pudo extraer. */
  readonly motivoNoDisponible?: MotivoSinExtraccion;
  readonly payloadCrudo?: unknown;
}

export type MotivoSinExtraccion =
  | 'SIN_MOTOR_OCR'
  | 'TIPO_NO_SOPORTADO'
  | 'MOTOR_FALLO'
  | 'DOCUMENTO_ILEGIBLE';

/**
 * Techo de confianza por método.
 *
 * Un motor de OCR que reporta 0.99 no vale lo mismo que un XML estructurado, y
 * sin embargo un umbral de aprobación automática los trataría igual. El techo
 * hace que la diferencia sobreviva al viaje hasta el sistema de confianza:
 * ninguna lectura de imagen puede alcanzar el nivel de un dato leído de un campo.
 */
export const TECHO_CONFIANZA: Record<MetodoExtraccion, number> = {
  MANUAL: 1,
  XML: 1,
  REGEX: 0.9,
  OCR: 0.95,
  LLM: 0.85,
};

export function acotarConfianza(method: MetodoExtraccion, valor: number): number {
  const acotado = Math.min(Math.max(valor, 0), TECHO_CONFIANZA[method]);
  // Redondeo a 4 decimales para que el valor sea estable al serializar.
  return Math.round(acotado * 10_000) / 10_000;
}
