/**
 * El QR de la RG 4892/2020.
 *
 * Los nombres de campo salen del documento oficial archivado con hash:
 *
 *     docs/normative-sources/originals/ARCA_QR_especificaciones.pdf
 *     https://www.afip.gob.ar/fe/qr/documentos/QRespecificaciones.pdf
 *
 * El PDF trae la tabla y, al final, un JSON de ejemplo completo — que es lo que
 * permite verificar la transcripción campo por campo en vez de confiar en ella:
 *
 *     {"ver":1,"fecha":"2020-10-13","cuit":30000000007,"ptoVta":10,"tipoCmp":1,
 *      "nroCmp":94,"importe":12100,"moneda":"DOL","ctz":65,"tipoDocRec":80,
 *      "nroDocRec":20000000001,"tipoCodAut":"E","codAut":70417054367476}
 *
 * ## Un conflicto de URL que no se resuelve en silencio
 *
 * El documento dice dos cosas distintas sobre a dónde apunta el QR:
 *
 * - En la especificación técnica: `{URL}=https://www.arca.gob.ar/fe/qr/`
 * - En el ejemplo del pie:        `https://www.afip.gob.ar/fe/qr/?p=...`
 *
 * Y el ABC de ARCA (consulta 26035850) dice que al escanear se llega a
 * `https://serviciosweb.afip.gob.ar/genericos/comprobantes/cae.aspx`.
 *
 * Las tres pueden ser ciertas a la vez —el organismo migró de `afip` a `arca` y
 * `/fe/qr/` redirige al servicio de constatación— pero **cuál se codifica es una
 * decisión, no un dato**. Por eso la URL vive en la especificación transcripta y
 * no como constante acá: se codifica la que el documento declara como `{URL}`, y
 * el que quiera cambiarla ve el conflicto anotado al lado.
 *
 * ## Los tipos numéricos van como número, no como string
 *
 * En el ejemplo, `cuit`, `nroDocRec` y `codAut` son números JSON sin comillas.
 * `codAut` tiene 14 dígitos y `nroDocRec` hasta 20: los dos superan `2^53`, así
 * que convertirlos con `Number` perdería precisión en silencio. Se emiten con
 * `JSON.rawJSON` cuando está disponible y, si no, insertando el literal — nunca
 * pasando por `Number`.
 */

import type { ComprobanteAutorizado } from './contracts.js';

/** El tipo de un campo, tal como lo clasifica la tabla del documento. */
export type TipoCampoQr = 'NUMERICO' | 'DECIMAL' | 'ALFANUMERICO' | 'FECHA';

export interface CampoQr {
  readonly nombreArca: string;
  readonly origen: keyof ComprobanteAutorizado | 'version';
  readonly tipo: TipoCampoQr;
  /**
   * `false` para los que el documento marca «DE CORRESPONDER».
   *
   * Los dos campos del receptor no corresponden cuando no hay receptor
   * identificado —`DocTipo` 99, consumidor final—, y en ese caso se omiten en
   * vez de mandarse en cero. Mandar `tipoDocRec: 99` afirmaría que el receptor
   * es de un tipo; omitirlo dice que no hay.
   */
  readonly obligatorio: boolean;
}

export interface EspecificacionQr {
  readonly version: number;
  /** La que el documento declara como `{URL}`. Ver el conflicto arriba. */
  readonly url: string;
  readonly fuente: string;
  readonly campos: readonly CampoQr[];
}

export type ResultadoQr =
  | { readonly ok: true; readonly url: string; readonly payload: string }
  | { readonly ok: false; readonly motivo: string; readonly queHacer: string };

export function construirQr(
  comprobante: ComprobanteAutorizado,
  especificacion: EspecificacionQr | null,
): ResultadoQr {
  if (especificacion === null) {
    return {
      ok: false,
      motivo: 'No se pasó la especificación del QR.',
      queHacer:
        'Cargar scripts/especificacion-qr.json, transcripto de ARCA_QR_especificaciones.pdf.',
    };
  }

  if (especificacion.campos.length === 0) {
    return {
      ok: false,
      motivo: 'La especificación está declarada pero no tiene campos.',
      queHacer: 'Completar el array `campos` en scripts/especificacion-qr.json.',
    };
  }

  const sinReceptor = comprobante.docTipo === 99;
  const piezas: string[] = [];

  for (const campo of especificacion.campos) {
    if (!campo.obligatorio && sinReceptor) continue;

    const bruto = campo.origen === 'version' ? especificacion.version : comprobante[campo.origen];
    piezas.push(`${JSON.stringify(campo.nombreArca)}:${literalDe(bruto, campo.tipo)}`);
  }

  const payload = Buffer.from(`{${piezas.join(',')}}`, 'utf8').toString('base64');
  return { ok: true, url: `${especificacion.url}?p=${payload}`, payload };
}

/**
 * El literal JSON de un valor, sin pasar por `Number` cuando no hace falta.
 *
 * `codAut` tiene 14 dígitos y `nroDocRec` hasta 20. `Number('70417054367476')`
 * todavía es exacto, pero `nroDocRec` de veinte dígitos no lo sería, y el error
 * aparecería como un QR que apunta a otro receptor. Se arma el literal a mano.
 */
function literalDe(valor: unknown, tipo: TipoCampoQr): string {
  if (tipo === 'FECHA') {
    const texto = String(valor);
    // El WSFEv1 devuelve `AAAAMMDD`; el QR pide full-date de RFC 3339.
    const iso = /^\d{8}$/.test(texto)
      ? `${texto.slice(0, 4)}-${texto.slice(4, 6)}-${texto.slice(6, 8)}`
      : texto;
    return JSON.stringify(iso);
  }

  if (tipo === 'NUMERICO' || tipo === 'DECIMAL') {
    const texto = String(valor).trim();
    // Un literal numérico bien formado se copia tal cual: es la única forma de
    // conservar los dígitos de un entero que no entra en un `double`.
    if (/^-?\d+(\.\d+)?$/.test(texto)) return texto.replace(/^(-?)0+(\d)/, '$1$2');
    return JSON.stringify(texto);
  }

  return JSON.stringify(String(valor));
}
