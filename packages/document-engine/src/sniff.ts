/**
 * Determinación del tipo de contenido a partir de los bytes.
 *
 * La regla de este módulo: **el tipo declarado nunca gana sobre el contenido**.
 * Tanto la extensión como el `Content-Type` los elige quien sube el archivo, y
 * los documentos de un sistema contable llegan mayormente por mail desde
 * terceros. Un `.pdf` que en realidad es un ZIP no es una curiosidad: es la
 * forma más barata de que un parser haga algo que nadie previó.
 *
 * Cuando lo declarado y lo real no coinciden, el archivo se rechaza en lugar de
 * corregirse en silencio. Que el remitente se haya equivocado de extensión es
 * información útil para el contador, no ruido a ocultar.
 */

import type { RiesgoArchivo, TipoContenido } from './types.js';

export interface Sniffed {
  readonly tipo: TipoContenido;
  readonly mime: string;
  readonly riesgos: readonly RiesgoArchivo[];
}

const MIME: Record<TipoContenido, string> = {
  PDF: 'application/pdf',
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  XML: 'application/xml',
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DESCONOCIDO: 'application/octet-stream',
};

export function mimeDe(tipo: TipoContenido): string {
  return MIME[tipo];
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Marcadores de PDF que ejecutan algo al abrirse o traen archivos adentro.
 *
 * No bloquean la ingesta —una factura con un adjunto embebido sigue siendo una
 * factura— pero quedan registrados en el documento. Sin ese registro, el día que
 * uno de estos archivos cause un problema no hay forma de saber cuáles entraron.
 */
const MARCADORES_PDF_ACTIVOS: readonly (readonly [string, string])[] = [
  ['/JavaScript', 'El PDF contiene JavaScript embebido'],
  ['/OpenAction', 'El PDF ejecuta una acción al abrirse'],
  ['/Launch', 'El PDF contiene una acción de lanzamiento de programa'],
  ['/EmbeddedFile', 'El PDF contiene archivos embebidos'],
];

export function sniff(bytes: Buffer, nombreOriginal: string): Sniffed {
  const riesgos: RiesgoArchivo[] = [];

  if (bytes.length === 0) return { tipo: 'DESCONOCIDO', mime: MIME.DESCONOCIDO, riesgos };

  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    const texto = bytes.toString('latin1');
    for (const [marcador, detalle] of MARCADORES_PDF_ACTIVOS) {
      if (texto.includes(marcador)) riesgos.push({ codigo: 'PDF_ACTIVO', detalle });
    }
    return { tipo: 'PDF', mime: MIME.PDF, riesgos };
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { tipo: 'JPEG', mime: MIME.JPEG, riesgos };
  }

  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return { tipo: 'PNG', mime: MIME.PNG, riesgos };
  }

  // Los XLSX son ZIP. Distinguirlos de un ZIP cualquiera exige mirar adentro:
  // aceptar todo ZIP como planilla haría que el lector reciba cualquier cosa.
  if (bytes.length >= 4 && bytes.subarray(0, 2).toString('latin1') === 'PK') {
    const cabeza = bytes.subarray(0, Math.min(bytes.length, 8192)).toString('latin1');
    const cola = bytes.subarray(Math.max(0, bytes.length - 65_536)).toString('latin1');
    const contenido = cabeza + cola;
    const esOoxml = contenido.includes('[Content_Types].xml');
    const tieneHojas = /xl\/(workbook\.xml|worksheets\/)/.test(contenido);
    if (esOoxml && tieneHojas) return { tipo: 'XLSX', mime: MIME.XLSX, riesgos };
    return { tipo: 'DESCONOCIDO', mime: MIME.DESCONOCIDO, riesgos };
  }

  const texto = decodificarTexto(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (texto === null) return { tipo: 'DESCONOCIDO', mime: MIME.DESCONOCIDO, riesgos };

  // `0xFEFF` es el BOM: Excel y varios sistemas de gestión lo anteponen, y sin
  // sacarlo el XML "no empieza con <?xml".
  const inicio = (texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto).trimStart();
  if (inicio.startsWith('<?xml') || /^<[A-Za-z_]/.test(inicio)) {
    // XXE y "billion laughs" entran por acá. La declaración de tipo de documento
    // no es necesaria en ningún comprobante electrónico, así que rechazarla no
    // cuesta nada y cierra la clase entera de ataques.
    if (/<!DOCTYPE|<!ENTITY/i.test(texto)) {
      return {
        tipo: 'DESCONOCIDO',
        mime: MIME.DESCONOCIDO,
        riesgos: [
          {
            codigo: 'XML_CON_DOCTYPE',
            detalle: 'El XML declara DOCTYPE o entidades: no se procesa',
          },
        ],
      };
    }
    return { tipo: 'XML', mime: MIME.XML, riesgos };
  }

  // No existe firma de CSV: es texto plano con separadores. Se acepta solo si el
  // nombre lo declara y el contenido es texto con un separador consistente.
  if (/\.(csv|txt)$/i.test(nombreOriginal) && pareceTabular(texto)) {
    return { tipo: 'CSV', mime: MIME.CSV, riesgos };
  }

  return { tipo: 'DESCONOCIDO', mime: MIME.DESCONOCIDO, riesgos };
}

/** Decodifica como UTF-8 y, si tiene bytes inválidos, como Latin-1. `null` si es binario. */
function decodificarTexto(bytes: Buffer): string | null {
  // Un NUL en los primeros KB descarta que sea texto en cualquiera de las dos.
  if (bytes.includes(0x00)) return null;
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return bytes.toString('latin1');
}

function pareceTabular(texto: string): boolean {
  const lineas = texto
    .split(/\r?\n/)
    .filter((linea) => linea.trim().length > 0)
    .slice(0, 5);
  if (lineas.length < 2) return false;
  return [',', ';', '\t', '|'].some((sep) => {
    const cuentas = lineas.map((linea) => linea.split(sep).length);
    return cuentas[0]! > 1 && cuentas.every((cuenta) => cuenta === cuentas[0]);
  });
}

const ESPERADO_POR_EXTENSION: Record<string, TipoContenido> = {
  pdf: 'PDF',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  png: 'PNG',
  xml: 'XML',
  csv: 'CSV',
  txt: 'CSV',
  xlsx: 'XLSX',
};

/**
 * Compara lo que el cliente declaró con lo que realmente es.
 *
 * Devuelve el motivo del rechazo, o `null` si son compatibles.
 */
export function verificarCoherencia(
  detectado: TipoContenido,
  nombreOriginal: string,
  mimeDeclarado: string | undefined,
): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(nombreOriginal)?.[1]?.toLowerCase();
  const esperado = ext === undefined ? undefined : ESPERADO_POR_EXTENSION[ext];

  if (esperado !== undefined && esperado !== detectado) {
    return `El archivo se llama .${ext} pero su contenido es ${detectado}`;
  }

  if (mimeDeclarado !== undefined && mimeDeclarado !== 'application/octet-stream') {
    const base = mimeDeclarado.split(';')[0]!.trim().toLowerCase();
    const compatible =
      base === MIME[detectado] ||
      (detectado === 'CSV' && (base === 'text/plain' || base === 'application/csv')) ||
      (detectado === 'XML' && base === 'text/xml');
    if (!compatible) {
      return `El cliente declaró ${base} pero el contenido es ${detectado}`;
    }
  }

  return null;
}
