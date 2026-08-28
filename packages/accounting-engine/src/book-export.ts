/**
 * Exportación de libros — una forma canónica, y su hash.
 *
 * El objetivo no es "generar un CSV". Es que el Diario de marzo emitido hoy y el
 * Diario de marzo emitido en 2031 sean **el mismo archivo**, byte por byte, y
 * que eso se pueda demostrar sin abrir los dos. De ahí salen todas las
 * decisiones raras de este archivo:
 *
 * - **Separador decimal punto, no coma.** Un número formateado según el locale
 *   de la máquina hace que el hash dependa de dónde se corrió la exportación.
 *   Contrapartida real: Excel en es-AR no lo abre bien con doble clic; hay que
 *   importarlo eligiendo el punto como decimal. Es un costo de usabilidad
 *   asumido a cambio de reproducibilidad, y está documentado en BOOKS.md.
 * - **Nada de `toLocaleString`, `Intl` ni `Date`.** Las tres cambian de salida
 *   con el entorno o con la versión de ICU.
 * - **Fin de línea LF**, siempre, aunque el archivo se genere en Windows.
 * - **BOM al principio**, incluido en el hash. Lo que se descarga es exactamente
 *   lo que se hashea; si el BOM quedara fuera, el hash sería de un archivo que
 *   nadie tiene.
 */

import { createHash } from 'node:crypto';
import type { Money } from '@aai/shared';
import { toDecimalString } from '@aai/shared';
import type { LibroDiario } from './libro-diario.js';
import type { LibroMayor } from './libro-mayor.js';

const BOM = '\uFEFF';
const SEP = ';';
const EOL = '\n';

const COLUMNAS_DIARIO = [
  'folio',
  'libro',
  'numero',
  'fecha',
  'tipo',
  'estado',
  'descripcion_asiento',
  'linea',
  'cuenta_codigo',
  'cuenta_nombre',
  'debe',
  'haber',
  'moneda',
  'moneda_original',
  'importe_original',
  'cotizacion',
  'cotizacion_fuente',
  'cotizacion_fecha',
  'centro_costo',
  'tercero',
  'descripcion_linea',
  'comprobante_tipo',
  'comprobante_id',
  'documento_id',
  'asiento_id',
  'linea_id',
  'anula_asiento_id',
  'decision_id',
  'prediccion_ia_id',
  'creado_por',
  'aprobado_por',
] as const;

const COLUMNAS_MAYOR = [
  'cuenta_codigo',
  'cuenta_nombre',
  'naturaleza',
  'fecha',
  'libro',
  'numero',
  'detalle',
  'debe',
  'haber',
  'saldo',
  'anulado',
  'documento_id',
  'comprobante_tipo',
  'comprobante_id',
  'decision_id',
  'asiento_id',
  'linea_id',
] as const;

/**
 * Diario en CSV plano: una fila por línea de asiento.
 *
 * Se repiten los datos de la cabecera en cada fila a propósito. Un CSV con
 * filas de cabecera y filas de detalle intercaladas no se puede filtrar ni
 * tabular sin escribir un parser, y quien pide el Diario en CSV lo pide
 * justamente para eso.
 */
export function exportarDiarioCsv(libro: LibroDiario): string {
  const filas: string[] = [COLUMNAS_DIARIO.join(SEP)];

  for (const folio of libro.folios) {
    for (const asiento of folio.asientos) {
      for (const linea of asiento.lines) {
        filas.push(
          [
            String(folio.numero),
            asiento.journalCode,
            String(asiento.entryNumber),
            asiento.entryDate,
            asiento.kind,
            asiento.status,
            asiento.description,
            String(linea.lineNo),
            linea.accountCode,
            linea.accountName,
            importe(linea.debit),
            importe(linea.credit),
            linea.debit.currency,
            linea.monedaOriginal ?? '',
            linea.importeOriginal === null ? '' : importe(linea.importeOriginal),
            linea.fxRate ?? '',
            linea.fxSource ?? '',
            linea.fxDate ?? '',
            linea.costCenterCode ?? '',
            linea.partyId ?? '',
            linea.description ?? '',
            asiento.sourceType,
            asiento.sourceId ?? '',
            asiento.documentId ?? '',
            asiento.id,
            linea.id,
            asiento.reversesEntryId ?? '',
            asiento.decisionId ?? '',
            asiento.aiPredictionId ?? '',
            asiento.createdBy,
            asiento.approvedBy ?? '',
          ]
            .map(escapar)
            .join(SEP),
        );
      }
    }
  }

  return BOM + filas.join(EOL) + EOL;
}

export function exportarMayorCsv(mayor: LibroMayor): string {
  const filas: string[] = [COLUMNAS_MAYOR.join(SEP)];

  for (const cuenta of mayor.cuentas) {
    for (const movimiento of cuenta.movimientos) {
      filas.push(
        [
          cuenta.accountCode,
          cuenta.accountName,
          cuenta.nature,
          movimiento.fecha,
          movimiento.journalCode,
          String(movimiento.entryNumber),
          movimiento.detalle,
          importe(movimiento.debe),
          importe(movimiento.haber),
          importe(movimiento.saldo),
          movimiento.anulado ? 'SI' : 'NO',
          movimiento.documentId ?? '',
          movimiento.sourceType,
          movimiento.sourceId ?? '',
          movimiento.decisionId ?? '',
          movimiento.entryId,
          movimiento.entryLineId,
        ]
          .map(escapar)
          .join(SEP),
      );
    }
  }

  return BOM + filas.join(EOL) + EOL;
}

/**
 * Hash del contenido emitido.
 *
 * Es lo que va a `book_emissions.content_sha256`. Se calcula sobre el texto
 * exacto que se descarga, en UTF-8, sin normalizar nada: normalizar sería
 * hashear una versión del archivo que el usuario no tiene.
 */
export function hashDeLibro(contenido: string): string {
  return createHash('sha256').update(contenido, 'utf8').digest('hex');
}

/**
 * Pie del libro, para el PDF y para la pantalla.
 *
 * Dice tres cosas que un libro emitido tiene que decir de sí mismo: qué abarca,
 * si pasó los controles de forma, y si hay autorización del Registro Público
 * para llevarlo por medios electrónicos (CCyC art. 329).
 *
 * Cuando la autorización no está cargada **no se afirma que falte**: puede
 * existir en el expediente y no haberse cargado acá. Se dice que el sistema no
 * la tiene, que es lo único que el sistema sabe.
 */
export function pieDeLibro(
  libro: LibroDiario,
  contenido: string,
  autorizacionRegistro: string | null,
): string {
  const lineas = [
    `Libro Diario — ${libro.desde} a ${libro.hasta}`,
    `Asientos: ${libro.asientos} · Folios: ${libro.folios.length}`,
    `Debe: ${importe(libro.totalDebe)} ${libro.moneda} · Haber: ${importe(libro.totalHaber)} ${libro.moneda}`,
    `SHA-256 del contenido: ${hashDeLibro(contenido)}`,
  ];

  if (libro.cumpleFormalidades) {
    lineas.push('Controles de forma (CCyC arts. 321, 324 y 325): sin observaciones.');
  } else {
    const fallidos = libro.controles.filter((control) => !control.cumple);
    lineas.push(
      `Controles de forma (CCyC arts. 321, 324 y 325): ${fallidos.length} con observaciones — ${fallidos
        .map((control) => control.codigo)
        .join(', ')}. El libro se emite igual; las observaciones quedan registradas.`,
    );
  }

  lineas.push(
    autorizacionRegistro === null
      ? 'Autorización del Registro Público para llevar los libros por medios electrónicos (CCyC art. 329): no cargada en el sistema. El sistema no puede afirmar si existe.'
      : `Autorización del Registro Público (CCyC art. 329): ${autorizacionRegistro}`,
  );

  return lineas.join(EOL);
}

/** Importe con punto decimal. Nunca `toFixed`, nunca `Intl`. */
function importe(value: Money): string {
  return toDecimalString(value);
}

function escapar(campo: string): string {
  if (campo.includes(SEP) || campo.includes('"') || campo.includes('\n') || campo.includes('\r')) {
    return `"${campo.replaceAll('"', '""')}"`;
  }
  return campo;
}
