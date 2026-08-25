/**
 * Puerto de OCR.
 *
 * Mismo criterio que con ARCA en FASE 3a: el motor concreto vive detrás de una
 * interfaz, y **la ausencia de motor se informa, no se disimula**. Un pipeline
 * que devuelve "cero campos encontrados" cuando en realidad no había OCR
 * instalado produce documentos que el contador cree revisados y nadie leyó.
 *
 * Por eso `ResultadoOcr` tiene `disponible`, y `NullOcrEngine` —el que corre por
 * defecto— responde `disponible: false` con motivo `SIN_MOTOR_OCR`.
 *
 * El motor tampoco decide qué significa lo que leyó: devuelve texto, posiciones
 * y confianzas. La interpretación es de `parsers/`, y esa separación es la que
 * permite cambiar de proveedor sin revisar una sola regla contable (§28).
 */

import type { Recuadro } from '../types.js';

export interface PalabraReconocida {
  readonly texto: string;
  /** Confianza del motor, 0..1. Se acota después por `TECHO_CONFIANZA`. */
  readonly confianza: number;
  readonly bbox?: Recuadro;
}

export interface PaginaReconocida {
  readonly numero: number;
  readonly texto: string;
  readonly palabras: readonly PalabraReconocida[];
  readonly ancho?: number;
  readonly alto?: number;
}

export interface EntradaOcr {
  readonly bytes: Buffer;
  readonly tipo: string;
  /** Sugerencia de idioma. El motor puede ignorarla. */
  readonly idioma?: string;
}

export interface ResultadoOcr {
  readonly disponible: boolean;
  readonly paginas: readonly PaginaReconocida[];
  readonly motivo?: 'SIN_MOTOR_OCR' | 'TIPO_NO_SOPORTADO' | 'MOTOR_FALLO' | 'DOCUMENTO_ILEGIBLE';
  readonly detalle?: string;
}

export interface OcrEngine {
  readonly nombre: string;
  readonly version: string;
  /** Tipos que este motor sabe leer. */
  soporta(tipo: string): boolean;
  reconocer(entrada: EntradaOcr): Promise<ResultadoOcr>;
}

/**
 * El motor por defecto: no reconoce nada y lo dice.
 *
 * No es un placeholder que haya que reemplazar antes de usar el sistema. Es la
 * respuesta correcta cuando no hay OCR configurado: los documentos se ingieren,
 * se hashean, se almacenan y se deduplican igual, y los campos quedan
 * declarados como no extraídos en lugar de inexistentes.
 */
export class NullOcrEngine implements OcrEngine {
  readonly nombre = 'null';
  readonly version = '0';

  soporta(): boolean {
    return false;
  }

  async reconocer(): Promise<ResultadoOcr> {
    return {
      disponible: false,
      paginas: [],
      motivo: 'SIN_MOTOR_OCR',
      detalle:
        'No hay motor de OCR configurado. El documento se archivó completo; ningún campo fue leído.',
    };
  }
}
