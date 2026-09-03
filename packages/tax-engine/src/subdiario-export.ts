/**
 * El subdiario como archivo, que es lo que el art. 327 pide poder mostrar.
 *
 * `comoSubdiarioDeclarado()` promete una `referencia` con el hash del contenido.
 * Hasta que existió este archivo, ese contenido no existía: se podía decir «hay
 * un subdiario» sin que hubiera nada que abrir. Un hash de nada no verifica nada.
 *
 * Las convenciones son **las mismas** que `book-export.ts` del motor contable, y
 * por el mismo motivo: el subdiario de marzo emitido hoy y el emitido en 2031
 * tienen que ser el mismo archivo byte por byte. Punto decimal (no coma), sin
 * `Intl` ni `toLocaleString`, LF siempre, y BOM al principio incluido en el
 * hash — lo que se descarga es exactamente lo que se hashea.
 *
 * Se exportan **todos** los renglones, incluidos los excluidos de los totales,
 * con una columna que dice cuál es cuál. Un comprobante que desaparece del
 * archivo detallado es un comprobante que nadie va a ir a buscar, y el archivo
 * detallado es justamente lo que respalda el resumen.
 */

import { toDecimalString, type Money } from '@aai/shared';
import type { Subdiario } from './subdiario.js';

const BOM = '\uFEFF';
const SEP = ';';
const EOL = '\n';

const COLUMNAS = [
  'fecha',
  'tipo_comprobante',
  'punto_venta',
  'numero',
  'cuit_contraparte',
  'razon_social',
  'condicion_iva',
  'neto',
  'iva',
  'no_gravado',
  'exento',
  'percepciones',
  'total',
  'alicuota_id',
  'comprobante_id',
  'asiento_id',
  'documento_id',
  'en_totales',
  'hallazgos',
] as const;

export function exportarSubdiarioCsv(subdiario: Subdiario): string {
  const excluidos = new Set(subdiario.excluidos.map((excluido) => excluido.comprobanteId));
  const filas: string[] = [COLUMNAS.join(SEP)];

  for (const renglon of subdiario.renglones) {
    filas.push(
      [
        renglon.fecha,
        String(renglon.tipoComprobante),
        String(renglon.puntoVenta),
        String(renglon.numero),
        renglon.cuitContraparte ?? '',
        renglon.razonSocialContraparte ?? '',
        renglon.condicionContraparte,
        importe(renglon.neto),
        importe(renglon.iva),
        importe(renglon.noGravado),
        importe(renglon.exento),
        importe(renglon.percepciones),
        importe(renglon.total),
        renglon.alicuotaId ?? '',
        renglon.comprobanteId,
        renglon.entryId ?? '',
        renglon.documentId ?? '',
        excluidos.has(renglon.comprobanteId) ? 'NO' : 'SI',
        renglon.hallazgos.map((hallazgo) => hallazgo.codigo).join(' '),
      ]
        .map(escapar)
        .join(SEP),
    );
  }

  return BOM + filas.join(EOL) + EOL;
}

function importe(value: Money): string {
  return toDecimalString(value);
}

function escapar(campo: string): string {
  if (campo.includes(SEP) || campo.includes('"') || campo.includes('\n') || campo.includes('\r')) {
    return `"${campo.replaceAll('"', '""')}"`;
  }
  return campo;
}
