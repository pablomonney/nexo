/**
 * Detección de duplicados en tres niveles.
 *
 * La distinción entre los niveles no es una gradación de certeza: son cosas
 * **distintas**, y confundirlas produce los dos errores opuestos.
 *
 * | Nivel | Qué significa | Qué hace el sistema |
 * |---|---|---|
 * | `ARCHIVO_IDENTICO` | Mismos bytes, misma empresa. El contador volvió a subir el mismo PDF | Vincula al documento existente. **No** es un hecho contable nuevo |
 * | `COMPROBANTE_REPETIDO` | Mismo emisor, tipo, punto de venta y número, en otro archivo | Bloquea la imputación automática y pide decisión humana |
 * | `POSIBLE_DUPLICADO` | Mismo tercero, mismo importe, fechas cercanas | Advierte. No bloquea |
 *
 * El segundo nivel es el que importa: dos archivos distintos con el mismo número
 * de comprobante son, o un rescaneo, o una factura computada dos veces. La
 * primera opción es trivial; la segunda es crédito fiscal computado de más. El
 * sistema no adivina cuál es — las presenta y deja que el contador decida.
 *
 * **Nada se descarta nunca.** Un duplicado se registra y se vincula; el archivo
 * queda archivado igual. El §38 prohíbe que una operación desaparezca sin
 * trazabilidad, y un "ya lo tenías, lo ignoré" es exactamente eso.
 */

export type NivelDuplicado = 'ARCHIVO_IDENTICO' | 'COMPROBANTE_REPETIDO' | 'POSIBLE_DUPLICADO';

export interface ClaveLogica {
  readonly cuitEmisor: string;
  readonly tipoComprobante: number;
  readonly puntoVenta: number;
  readonly numero: number;
}

export interface HuellaDocumento {
  readonly documentId: string;
  readonly sha256: string;
  readonly claveLogica?: ClaveLogica;
  /** Importe total en unidades menores, como texto. */
  readonly total?: string;
  readonly moneda?: string;
  /** Fecha del comprobante en formato ISO. */
  readonly fecha?: string;
  readonly cuitContraparte?: string;
}

export interface Coincidencia {
  readonly nivel: NivelDuplicado;
  readonly documentIdExistente: string;
  readonly explicacion: string;
  /** `true` cuando el hallazgo impide imputar sin intervención humana. */
  readonly bloquea: boolean;
}

export interface OpcionesDuplicado {
  /** Ventana en días para el nivel 3. */
  readonly ventanaDias?: number;
}

export function claveLogicaComoTexto(clave: ClaveLogica): string {
  return [
    clave.cuitEmisor,
    String(clave.tipoComprobante).padStart(3, '0'),
    String(clave.puntoVenta).padStart(5, '0'),
    String(clave.numero).padStart(8, '0'),
  ].join('-');
}

/**
 * Compara un documento nuevo contra los que ya existen **en la misma empresa**.
 *
 * El alcance por empresa no es una optimización: comparar contra el universo
 * revelaría que otra empresa tiene el mismo comprobante, que es información de
 * un tercero.
 */
export function detectarDuplicados(
  nuevo: HuellaDocumento,
  existentes: readonly HuellaDocumento[],
  opciones: OpcionesDuplicado = {},
): readonly Coincidencia[] {
  const ventanaDias = opciones.ventanaDias ?? 5;
  const coincidencias: Coincidencia[] = [];

  for (const existente of existentes) {
    if (existente.documentId === nuevo.documentId) continue;

    if (existente.sha256 === nuevo.sha256) {
      coincidencias.push({
        nivel: 'ARCHIVO_IDENTICO',
        documentIdExistente: existente.documentId,
        explicacion:
          'El archivo es byte por byte el mismo que uno ya cargado. No constituye una operación nueva.',
        bloquea: false,
      });
      continue;
    }

    if (
      nuevo.claveLogica !== undefined &&
      existente.claveLogica !== undefined &&
      claveLogicaComoTexto(nuevo.claveLogica) === claveLogicaComoTexto(existente.claveLogica)
    ) {
      coincidencias.push({
        nivel: 'COMPROBANTE_REPETIDO',
        documentIdExistente: existente.documentId,
        explicacion:
          `Ya hay un documento distinto con el mismo comprobante ` +
          `(${claveLogicaComoTexto(nuevo.claveLogica)}). Puede ser un rescaneo o una duplicación ` +
          'de cómputo: requiere decisión del contador.',
        bloquea: true,
      });
      continue;
    }

    const cerca = fechasCercanas(nuevo.fecha, existente.fecha, ventanaDias);
    const mismoImporte =
      nuevo.total !== undefined &&
      nuevo.total === existente.total &&
      nuevo.moneda === existente.moneda;
    const mismaContraparte =
      nuevo.cuitContraparte !== undefined && nuevo.cuitContraparte === existente.cuitContraparte;

    if (cerca && mismoImporte && mismaContraparte) {
      coincidencias.push({
        nivel: 'POSIBLE_DUPLICADO',
        documentIdExistente: existente.documentId,
        explicacion:
          `Mismo tercero, mismo importe y fechas dentro de ${ventanaDias} días. ` +
          'Puede ser legítimo —abonos, cuotas iguales— o una carga repetida.',
        bloquea: false,
      });
    }
  }

  return coincidencias;
}

function fechasCercanas(a: string | undefined, b: string | undefined, dias: number): boolean {
  if (a === undefined || b === undefined) return false;
  const unDia = 86_400_000;
  const diferencia = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(diferencia) && diferencia <= dias * unDia;
}

/** ¿Alguno de los hallazgos impide imputar sin que intervenga una persona? */
export function bloqueaImputacion(coincidencias: readonly Coincidencia[]): boolean {
  return coincidencias.some((coincidencia) => coincidencia.bloquea);
}
