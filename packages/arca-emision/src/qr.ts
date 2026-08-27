/**
 * El QR de la RG 4892/2020 — y por qué este archivo todavía no lo arma.
 *
 * ## La situación, sin adornos
 *
 * El QR lleva un JSON en base64 dentro de una URL. Los **nombres de campo** de
 * ese JSON los define un documento oficial de ARCA que está archivado en este
 * repositorio con su hash:
 *
 *     docs/normative-sources/originals/ARCA_QR_especificaciones.pdf
 *     https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf
 *
 * Su contenido está como **imagen**, no como texto. No se pudo extraer, así que
 * los nombres de campo no están transcriptos acá.
 *
 * ## Por qué no se escriben de memoria
 *
 * Porque el modo de falla es invisible. Un QR con los campos mal nombrados se
 * genera igual, se imprime igual, y se ve idéntico a uno correcto: es un cuadrado
 * de puntos. La única forma de descubrir el error es escanearlo y que
 * `serviciosweb.afip.gob.ar` no reconozca el comprobante — es decir, después de
 * haber emitido.
 *
 * Es el §30 con una vuelta de tuerca incómoda: la fuente **existe, es oficial y
 * es pública**. Lo que falta no es la norma; es poder leerla en esta máquina.
 * Eso no cambia la conclusión.
 *
 * ## Lo que sí está confirmado, y de dónde
 *
 * Del ABC de ARCA (consultas 26029703, 26046095, 26035850, 26050193, 26056340),
 * que sí es texto:
 *
 * - El payload es **JSON**.
 * - El separador de decimales es el **punto**.
 * - No hace falta rellenar con ceros a la izquierda ni completar decimales.
 * - El QR va en el **frente** del comprobante.
 * - Apunta a `https://serviciosweb.afip.gob.ar/genericos/comprobantes/cae.aspx`
 *   para comprobantes con CAE (y `caea.aspx` para los que tienen CAEA).
 * - El campo de versión se corresponde con la versión del formato de los datos.
 *
 * Con eso alcanza para la URL y para el envoltorio. No alcanza para los nombres.
 *
 * ## Cómo se completa
 *
 * Transcribiendo la tabla del PDF a `especificacion-qr.json` y pasándola acá.
 * Mientras ese archivo no exista, `construirQr()` devuelve una negativa y el
 * generador emite los PDF **sin QR**, diciéndolo en el PDF y en la salida.
 *
 * Un PDF sin QR es un PDF incompleto y se nota. Un PDF con un QR inventado es un
 * PDF que parece completo.
 */

import type { ComprobanteAutorizado } from './contracts.js';

/** Confirmado en el ABC de ARCA, consulta 26035850. */
export const URL_CONSTATACION_CAE =
  'https://serviciosweb.afip.gob.ar/genericos/comprobantes/cae.aspx';

/**
 * La especificación transcripta del PDF oficial.
 *
 * `campos` mapea **nuestro** nombre interno al nombre que exige ARCA. El orden
 * del array es el orden en que van en el JSON.
 */
export interface EspecificacionQr {
  /** Versión del formato de los datos, según el propio documento. */
  readonly version: number;
  /** De qué documento y qué página salió, para poder volver a chequearlo. */
  readonly fuente: string;
  readonly campos: readonly {
    readonly nombreArca: string;
    readonly origen: keyof ComprobanteAutorizado | 'version';
    readonly tipo: 'NUMERICO' | 'DECIMAL' | 'ALFANUMERICO' | 'FECHA';
  }[];
}

export type ResultadoQr =
  | { readonly ok: true; readonly url: string; readonly payload: string }
  | { readonly ok: false; readonly motivo: string; readonly queHacer: string };

/**
 * Arma la URL del QR, o explica por qué no puede.
 *
 * La especificación se pasa como parámetro en vez de importarse: si no está, la
 * firma obliga a pasar `null` y el resultado es una negativa explícita. No hay
 * una rama por defecto que arme "algo".
 */
export function construirQr(
  comprobante: ComprobanteAutorizado,
  especificacion: EspecificacionQr | null,
): ResultadoQr {
  if (especificacion === null) {
    return {
      ok: false,
      motivo:
        'La especificación del QR no está transcripta. El documento oficial que define los nombres ' +
        'de campo está archivado (ARCA_QR_especificaciones.pdf) pero su contenido es una imagen y ' +
        'no se pudo extraer.',
      queHacer:
        'Abrir https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf y transcribir la ' +
        'tabla de campos a scripts/especificacion-qr.json. Son dos páginas. Escribir los nombres ' +
        'de memoria produciría un QR que se imprime bien y que ARCA no valida, y eso solo se ' +
        'descubre escaneando el comprobante ya emitido.',
    };
  }

  if (especificacion.campos.length === 0) {
    return {
      ok: false,
      motivo: 'La especificación está declarada pero no tiene campos.',
      queHacer: 'Completar el array `campos` en scripts/especificacion-qr.json.',
    };
  }

  const datos: Record<string, unknown> = {};
  for (const campo of especificacion.campos) {
    const valor =
      campo.origen === 'version' ? especificacion.version : comprobante[campo.origen];
    datos[campo.nombreArca] = normalizar(valor, campo.tipo);
  }

  // El ABC (26046095) dice JSON, y (26029703) que el separador decimal es el
  // punto — que es lo que `JSON.stringify` hace de todos modos.
  const payload = Buffer.from(JSON.stringify(datos), 'utf8').toString('base64');
  return { ok: true, url: `${URL_CONSTATACION_CAE}?p=${payload}`, payload };
}

function normalizar(valor: unknown, tipo: EspecificacionQr['campos'][number]['tipo']): unknown {
  if (tipo === 'FECHA' && typeof valor === 'string' && /^\d{8}$/.test(valor)) {
    // Las fechas del WSFEv1 vienen `AAAAMMDD`; el QR las lleva con guiones.
    return `${valor.slice(0, 4)}-${valor.slice(4, 6)}-${valor.slice(6, 8)}`;
  }
  if (tipo === 'NUMERICO' || tipo === 'DECIMAL') {
    return typeof valor === 'string' ? Number(valor) : valor;
  }
  return valor;
}
