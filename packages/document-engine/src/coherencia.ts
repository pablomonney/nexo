/**
 * Controles de coherencia sobre los campos extraídos.
 *
 * Estos controles hacen algo que ningún puntaje de confianza puede hacer:
 * detectar un error **con confianza alta**. Un OCR nítido que leyó `1.019,83`
 * donde decía `7.019,83` devuelve confianza 0.98 y está equivocado. La
 * aritmética del comprobante sí lo nota, porque neto + IVA deja de dar el total.
 *
 * Por eso la salida de este módulo alimenta los disparadores duros del §13: un
 * comprobante que no cierra no se aprueba automáticamente por más alto que sea
 * el score de la extracción.
 *
 * Lo que este módulo **no** hace, y conviene que quede escrito: no valida que la
 * alícuota de IVA aplicada sea la que corresponde. Las alícuotas son normativa
 * (Ley 23.349 y sus modificatorias) y no están archivadas como fuente V1 en este
 * repositorio. Inferirlas de la aritmética del propio comprobante sería usar el
 * dato para validarse a sí mismo. Queda declarado como brecha.
 */

import type { Currency, Money } from '@aai/shared';
import { add, compare, isZero, money, subtract, toDecimalString, zero } from '@aai/shared';
import type { CampoExtraido } from './types.js';

export type SeveridadHallazgo = 'ERROR' | 'ADVERTENCIA' | 'INFO';

export interface Hallazgo {
  readonly codigo: string;
  readonly severidad: SeveridadHallazgo;
  readonly mensaje: string;
  readonly campos: readonly string[];
  /** `true` si impide aprobar la imputación sin intervención humana. */
  readonly bloquea: boolean;
}

/** Reconstruye un `Money` desde un campo extraído, o `null` si no se interpretó. */
export function importeDe(campos: readonly CampoExtraido[], fieldPath: string): Money | null {
  const campo = campos.find((candidato) => candidato.fieldPath === fieldPath);
  if (campo?.parsedValue == null || campo.parsedValue.kind !== 'MONEY') return null;
  return money(BigInt(campo.parsedValue.amount), campo.parsedValue.currency);
}

function monedaDe(campos: readonly CampoExtraido[]): Currency {
  for (const campo of campos) {
    if (campo.parsedValue?.kind === 'MONEY') return campo.parsedValue.currency;
  }
  return 'ARS';
}

export function controlarCoherencia(campos: readonly CampoExtraido[]): readonly Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const moneda = monedaDe(campos);

  const total = importeDe(campos, 'importes.total');
  const neto = importeDe(campos, 'importes.neto');
  const iva = importeDe(campos, 'importes.iva');
  const exento = importeDe(campos, 'importes.exento');
  const tributos = importeDe(campos, 'importes.tributos');

  // --- Control 1: la suma de los componentes tiene que dar el total ---------
  if (total !== null && neto !== null) {
    const componentes = [neto, iva, exento, tributos].filter(
      (componente): componente is Money => componente !== null,
    );
    const suma = componentes.reduce((acumulado, componente) => add(acumulado, componente), zero(moneda));
    const diferencia = subtract(total, suma);

    if (!isZero(diferencia)) {
      // Sin tolerancia. Un comprobante emitido cierra exacto; una diferencia de
      // un centavo es un dígito mal leído, no un redondeo aceptable.
      const faltantes = [
        iva === null ? 'IVA' : null,
        exento === null ? 'exento' : null,
        tributos === null ? 'tributos' : null,
      ].filter((nombre): nombre is string => nombre !== null);

      hallazgos.push({
        codigo: 'TOTAL_NO_CIERRA',
        severidad: 'ERROR',
        mensaje:
          `El total (${toDecimalString(total)}) no coincide con la suma de los componentes ` +
          `(${toDecimalString(suma)}): diferencia de ${toDecimalString(diferencia)}.` +
          (faltantes.length > 0
            ? ` No se leyeron: ${faltantes.join(', ')}, así que la diferencia puede deberse a eso.`
            : ''),
        campos: ['importes.total', 'importes.neto', 'importes.iva'],
        bloquea: true,
      });
    }
  }

  // --- Control 2: signos --------------------------------------------------
  if (total !== null && compare(total, zero(moneda)) < 0) {
    hallazgos.push({
      codigo: 'TOTAL_NEGATIVO',
      severidad: 'ADVERTENCIA',
      mensaje:
        'El total es negativo. En una nota de crédito es lo esperable; en una factura, no. ' +
        'Requiere confirmar el tipo de comprobante.',
      campos: ['importes.total'],
      bloquea: false,
    });
  }

  // --- Control 3: campos indispensables sin interpretar --------------------
  for (const fieldPath of ['comprobante.fecha', 'importes.total', 'emisor.cuit']) {
    const campo = campos.find((candidato) => candidato.fieldPath === fieldPath);
    if (campo === undefined) continue;
    if (campo.parsedValue !== null) continue;

    hallazgos.push({
      codigo: campo.rawValue === null ? 'CAMPO_AUSENTE' : 'CAMPO_NO_INTERPRETADO',
      severidad: 'ERROR',
      mensaje:
        campo.rawValue === null
          ? `No se encontró ${fieldPath} en el documento.`
          : `Se leyó "${campo.rawValue}" en ${fieldPath} pero no se pudo interpretar: ${campo.nota ?? 'sin detalle'}`,
      campos: [fieldPath],
      bloquea: true,
    });
  }

  // --- Control 4: confianza baja en campos que definen la imputación -------
  for (const campo of campos) {
    if (campo.parsedValue === null) continue;
    if (!ES_DETERMINANTE.has(campo.fieldPath)) continue;
    if (campo.confidence >= UMBRAL_REVISION) continue;

    hallazgos.push({
      codigo: 'CONFIANZA_BAJA',
      severidad: 'ADVERTENCIA',
      // no-float-check: allow — una confianza es un puntaje, no un importe.
      mensaje: `${campo.fieldPath} se interpretó con confianza ${campo.confidence.toFixed(2)}, por debajo de ${UMBRAL_REVISION}.`,
      campos: [campo.fieldPath],
      bloquea: false,
    });
  }

  return hallazgos;
}

/** Campos de los que depende la imputación: si están mal, el asiento está mal. */
const ES_DETERMINANTE = new Set([
  'emisor.cuit',
  'comprobante.fecha',
  'comprobante.identificacion',
  'importes.total',
  'importes.neto',
  'importes.iva',
]);

/**
 * Umbral por debajo del cual un campo determinante se marca para revisión.
 *
 * No es un umbral de aprobación automática: eso lo decide el sistema de
 * confianza de FASE 4, con la clasificación y la normativa a la vista. Acá solo
 * se señala que la lectura no fue firme.
 */
export const UMBRAL_REVISION = 0.75;

export function bloqueaAprobacion(hallazgos: readonly Hallazgo[]): boolean {
  return hallazgos.some((hallazgo) => hallazgo.bloquea);
}
