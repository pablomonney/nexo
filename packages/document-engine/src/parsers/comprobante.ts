/**
 * Identificación de un comprobante: punto de venta, número y código de
 * autorización.
 *
 * Los rangos que valida este módulo NO son convenciones ni saber general: salen
 * del manual del desarrollador del WSCDC v4, archivado con hash en
 * `docs/normative-sources/originals/ARCA_manual_desarrollador_wscdcv1_v4.pdf`,
 * sección "Validaciones excluyentes" del objeto `CmpReq`:
 *
 *   · `PtoVta`          — numérico de hasta 5 dígitos, entre 1 y 99998
 *   · `CbteNro`         — numérico de hasta 8 dígitos, entre 1 y 99999999
 *   · `CodAutorizacion` — String (14)
 *   · `CbteFch`         — no puede ser anterior a 20130101
 *
 * Validar con estos rangos sirve para algo concreto: un número de comprobante
 * que no los cumple no va a poder constatarse nunca, y conviene saberlo al
 * momento de la lectura y no tres pasos después, con el asiento ya propuesto.
 */

import type { Result } from '@aai/shared';
import { err, ok } from '@aai/shared';
import type { ErrorParseo } from './importe.js';

export interface IdentificacionComprobante {
  readonly puntoVenta: number;
  readonly numero: number;
  readonly confianza: number;
  readonly nota?: string;
}

/** Rangos del manual WSCDC v4 (archivado, V1). */
export const LIMITES = {
  puntoVentaMin: 1,
  puntoVentaMax: 99_998,
  numeroMin: 1,
  numeroMax: 99_999_999,
  longitudCodigoAutorizacion: 14,
  /** `CbteFch` no puede ser anterior a esta fecha, según el mismo manual. */
  fechaMinima: '2013-01-01',
} as const;

/**
 * Punto de venta y número como **dos campos etiquetados por separado**.
 *
 * Es la forma del comprobante que genera ARCA, y por lejos la más común en un
 * PDF real:
 *
 *     Punto de Venta:   0010      Comp. Nro:   00000001
 *
 * Se exporta porque el lector de `readers/texto.ts` necesita reconocer la misma
 * forma para saber **qué región de la línea** entregarle a este parser. Tener el
 * patrón en los dos lados fue justamente el defecto: el parser sabía leer esta
 * forma desde el primer día y el lector nunca se la pasaba, porque su regex
 * exigía un guión. Cincuenta comprobantes con el formato de ARCA dieron cincuenta
 * `comprobante.identificacion` sin leer.
 */
export const PATRON_ETIQUETADO =
  /(?:p(?:to|unto)?\.?\s*(?:de\s*)?v(?:ta|enta)?\.?)\D{0,4}(\d{1,5})\D{1,20}?(?:n(?:ro|úm(?:ero)?|um(?:ero)?)?\.?|#)\D{0,4}(\d{1,8})/i;

/**
 * Interpreta `0001-00001234`, `0001 00001234`, `00010000123 4`, `PV 1 Nro 1234`.
 *
 * No intenta adivinar cuando hay un solo bloque de dígitos: `000100001234`
 * podría partirse en 4+8 y suele estarlo, pero también podría ser un número de
 * comprobante mal segmentado por el OCR. Se abstiene y lo deja para revisión.
 */
export function parsePuntoVentaYNumero(
  entrada: string,
): Result<IdentificacionComprobante, ErrorParseo> {
  const texto = entrada.trim();
  if (texto.length === 0) return err({ codigo: 'VACIO', mensaje: 'El campo está vacío' });

  const dosBloques = /(\d{1,5})\s*[-–—/]\s*(\d{1,8})/.exec(texto);
  if (dosBloques !== null) {
    return construir(Number(dosBloques[1]), Number(dosBloques[2]), entrada, 1, undefined);
  }

  const conEtiquetas = PATRON_ETIQUETADO.exec(texto);
  if (conEtiquetas !== null) {
    return construir(Number(conEtiquetas[1]), Number(conEtiquetas[2]), entrada, 0.95, undefined);
  }

  return err({
    codigo: 'AMBIGUO',
    mensaje:
      `"${entrada}" no separa punto de venta y número. Partir un bloque corrido de dígitos ` +
      'sería una suposición del sistema sobre dónde termina uno y empieza el otro.',
  });
}

function construir(
  puntoVenta: number,
  numero: number,
  entrada: string,
  confianza: number,
  nota: string | undefined,
): Result<IdentificacionComprobante, ErrorParseo> {
  if (puntoVenta < LIMITES.puntoVentaMin || puntoVenta > LIMITES.puntoVentaMax) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}": el punto de venta ${puntoVenta} está fuera del rango 1–99998 que admite ARCA`,
    });
  }
  if (numero < LIMITES.numeroMin || numero > LIMITES.numeroMax) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}": el número ${numero} está fuera del rango 1–99999999 que admite ARCA`,
    });
  }
  return ok({ puntoVenta, numero, confianza, ...(nota !== undefined ? { nota } : {}) });
}

/**
 * Código de autorización (CAE, CAEA o CAI).
 *
 * El manual lo define como `String (14)`. Se conserva **como texto**: son 14
 * dígitos que no representan una cantidad, y convertirlos a número perdería los
 * ceros a la izquierda y, arriba de 2^53, precisión.
 */
export function parseCodigoAutorizacion(entrada: string): Result<string, ErrorParseo> {
  const texto = entrada.replace(/[\s\p{Zs}-]/gu, '');
  if (texto.length === 0) return err({ codigo: 'VACIO', mensaje: 'El campo está vacío' });
  if (!/^\d+$/.test(texto)) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}" no es un código de autorización: contiene caracteres no numéricos`,
    });
  }
  if (texto.length !== LIMITES.longitudCodigoAutorizacion) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje:
        `"${entrada}" tiene ${texto.length} dígitos y el código de autorización tiene ` +
        `${LIMITES.longitudCodigoAutorizacion}. Probablemente el OCR perdió o agregó un dígito.`,
    });
  }
  return ok(texto);
}

/**
 * Letra del comprobante tal como figura impresa.
 *
 * Se extrae la letra, no el código numérico. La traducción letra → `CbteTipo` no
 * está en ninguna fuente archivada como función de la letra sola: el código
 * depende también de si es factura, nota de crédito, recibo o liquidación, y
 * la tabla vigente la publica el organismo con fechas de vigencia
 * (`FEParamGetTiposCbte` / `ComprobantesTipoConsultar`). Ver `catalogo.ts`.
 */
export function parseLetraComprobante(entrada: string): Result<string, ErrorParseo> {
  const match = /(?:^|[^A-Za-zÁÉÍÓÚÑ])(?:cod\.?\s*\d{2}\s*)?([ABCEM])(?:$|[^A-Za-zÁÉÍÓÚÑ])/.exec(
    entrada.trim().toUpperCase(),
  );
  if (match === null) {
    return err({
      codigo: 'FORMATO_INVALIDO',
      mensaje: `"${entrada}" no contiene una letra de comprobante reconocible`,
    });
  }
  return ok(match[1]!);
}
