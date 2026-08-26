/**
 * Extracción de campos desde el texto que devolvió el OCR.
 *
 * El método es deliberadamente aburrido: etiquetas conocidas + patrón de valor.
 * No hay modelo acá. Un LLM leyendo una factura acierta casi siempre y falla en
 * silencio; una regla que no encuentra la etiqueta devuelve "no encontrado", que
 * es un estado que el contador puede ver y resolver.
 *
 * Cada campo extraído sale con las cuatro dimensiones del §10 completas, y con
 * una regla de composición que importa:
 *
 *     confianza = confianza_de_lectura × confianza_de_interpretación
 *
 * Son cosas distintas. El OCR puede haber leído `1.234` con total nitidez
 * (lectura 0.99) y el intérprete no poder decidir si son mil doscientos o uno
 * coma doscientos (interpretación: se abstiene). Multiplicarlas evita que una
 * lectura nítida de algo ambiguo se presente como un dato firme.
 */

import type { Currency } from '@aai/shared';
import type { CampoExtraido, MetodoExtraccion, ValorInterpretado } from '../types.js';
import { acotarConfianza } from '../types.js';
import { parseImporteAr } from '../parsers/importe.js';
import { parseFechaAr } from '../parsers/fecha.js';
import {
  PATRON_ETIQUETADO,
  parseCodigoAutorizacion,
  parseLetraComprobante,
  parsePuntoVentaYNumero,
} from '../parsers/comprobante.js';
import { isValidCuit, normalizeCuit } from '@aai/shared';
import type { PaginaReconocida } from '../ocr/engine.js';

const METODO: MetodoExtraccion = 'REGEX';

type Interprete = (
  bruto: string,
  contexto: ContextoLectura,
) => { valor: ValorInterpretado; confianza: number; nota?: string } | { error: string };

interface ContextoLectura {
  readonly moneda: Currency;
  readonly anioReferencia?: number;
}

interface ReglaCampo {
  readonly fieldPath: string;
  /** Etiquetas impresas que anteceden al valor. */
  readonly etiquetas: readonly RegExp[];
  /** Patrón del valor buscado a continuación de la etiqueta. */
  readonly valor: RegExp;
  readonly interpretar: Interprete;
  /** Cuánto confiar en que la etiqueta identifica realmente a este campo. */
  readonly confianzaRegla: number;
}

const importe =
  (): Interprete =>
  (bruto, contexto) => {
    const resultado = parseImporteAr(bruto, contexto.moneda);
    if (!resultado.ok) return { error: resultado.error.mensaje };
    return {
      valor: {
        kind: 'MONEY',
        // En unidades menores, que es como viaja el dinero en todo el sistema:
        // pasar por decimal acá reintroduciría el problema que `Money` evita.
        amount: resultado.value.money.amount.toString(),
        currency: contexto.moneda,
      },
      confianza: resultado.value.confianza,
      ...(resultado.value.nota !== undefined ? { nota: resultado.value.nota } : {}),
    };
  };

const REGLAS: readonly ReglaCampo[] = [
  {
    fieldPath: 'emisor.cuit',
    etiquetas: [/c\.?u\.?i\.?t\.?/i],
    valor: /(\d{2}[-\s]?\d{8}[-\s]?\d)/,
    confianzaRegla: 0.8,
    interpretar: (bruto) => {
      const normalizado = normalizeCuit(bruto);
      if (!isValidCuit(normalizado)) {
        return {
          error: `"${bruto}" no verifica el dígito de control: no es un CUIT válido`,
        };
      }
      return { valor: { kind: 'CUIT', value: normalizado }, confianza: 1 };
    },
  },
  {
    fieldPath: 'comprobante.fecha',
    etiquetas: [/fecha\s*(?:de\s*)?(?:emisi[oó]n)?/i],
    valor: /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{8})/,
    confianzaRegla: 0.9,
    interpretar: (bruto, contexto) => {
      const resultado = parseFechaAr(
        bruto,
        contexto.anioReferencia !== undefined ? { anioReferencia: contexto.anioReferencia } : {},
      );
      if (!resultado.ok) return { error: resultado.error.mensaje };
      return {
        valor: { kind: 'DATE', value: resultado.value.fecha },
        confianza: resultado.value.confianza,
        ...(resultado.value.nota !== undefined ? { nota: resultado.value.nota } : {}),
      };
    },
  },
  {
    fieldPath: 'comprobante.identificacion',
    etiquetas: [/(?:comp\.?|comprobante|factura|nro\.?|n[°º]|punto\s*de\s*venta)/i],
    // Dos formas, y la segunda es la que emite ARCA:
    //
    //     0010-00000001                              ← un solo bloque con guión
    //     Punto de Venta: 0010   Comp. Nro: 00000001  ← dos campos etiquetados
    //
    // La segunda tiene que capturar **la etiqueta incluida**, porque es lo que
    // `parsePuntoVentaYNumero` necesita para saber cuál número es cuál. Como el
    // motor de reglas prueba primero el texto que sigue a la etiqueta y recién
    // después la línea entera, esta alternativa matchea en el segundo intento —
    // que es exactamente para lo que ese fallback existe.
    valor: new RegExp(`(\\d{4,5}\\s*[-–—]\\s*\\d{6,8}|${PATRON_ETIQUETADO.source})`, 'i'),
    confianzaRegla: 0.85,
    interpretar: (bruto) => {
      const resultado = parsePuntoVentaYNumero(bruto);
      if (!resultado.ok) return { error: resultado.error.mensaje };
      return {
        valor: {
          kind: 'TEXT',
          value: `${String(resultado.value.puntoVenta).padStart(5, '0')}-${String(resultado.value.numero).padStart(8, '0')}`,
        },
        confianza: resultado.value.confianza,
      };
    },
  },
  {
    fieldPath: 'comprobante.codigoAutorizacion',
    etiquetas: [/\b(?:cae|caea|cai)\b/i],
    // Deliberadamente laxo: captura primero, valida después. Un patrón que
    // exigiera 14 dígitos exactos haría que un CAE al que el OCR le comió un
    // dígito no se capturara en absoluto, y el campo quedaría como "no
    // encontrado" en vez de "leído y con un dígito de menos" —que es lo que
    // efectivamente pasó, y lo que el contador necesita ver.
    valor: /(\d[\d\s-]{6,22}\d)/,
    confianzaRegla: 0.9,
    interpretar: (bruto) => {
      const resultado = parseCodigoAutorizacion(bruto);
      if (!resultado.ok) return { error: resultado.error.mensaje };
      return { valor: { kind: 'TEXT', value: resultado.value }, confianza: 1 };
    },
  },
  {
    fieldPath: 'comprobante.letra',
    // La letra suele estar sola en el recuadro central del comprobante, sin
    // etiqueta que la anteceda: se busca una línea que sea solo la letra.
    etiquetas: [/^/],
    valor: /^\s*([ABCEM])\s*(?:cod\.?\s*\d{2})?\s*$/i,
    confianzaRegla: 0.6,
    interpretar: (bruto) => {
      const resultado = parseLetraComprobante(bruto);
      if (!resultado.ok) return { error: resultado.error.mensaje };
      return { valor: { kind: 'TEXT', value: resultado.value }, confianza: 1 };
    },
  },
  {
    fieldPath: 'importes.neto',
    etiquetas: [/(?:importe\s*)?neto\s*(?:gravado)?/i, /subtotal/i],
    valor: /([-(]?[\d.,]{1,20}\)?)/,
    confianzaRegla: 0.85,
    interpretar: importe(),
  },
  {
    fieldPath: 'importes.iva',
    etiquetas: [/iva(?:\s*\d{1,2}[.,]?\d{0,2}\s*%?)?/i],
    valor: /([-(]?[\d.,]{1,20}\)?)/,
    confianzaRegla: 0.8,
    interpretar: importe(),
  },
  {
    fieldPath: 'importes.total',
    etiquetas: [/importe\s*total/i, /^total\b/i],
    valor: /([-(]?[\d.,]{1,20}\)?)/,
    confianzaRegla: 0.9,
    interpretar: importe(),
  },
];

export interface OpcionesLectura {
  readonly moneda?: Currency;
  readonly anioReferencia?: number;
}

/**
 * Recorre las páginas y devuelve un campo por regla.
 *
 * Las reglas que no encuentran su etiqueta **no desaparecen**: devuelven un
 * campo con `rawValue: null`. Un campo ausente y un campo no buscado se ven
 * igual en una lista de resultados, y no son lo mismo para quien revisa.
 */
export function extraerDeTexto(
  paginas: readonly PaginaReconocida[],
  opciones: OpcionesLectura = {},
): readonly CampoExtraido[] {
  const contexto: ContextoLectura = {
    moneda: opciones.moneda ?? 'ARS',
    ...(opciones.anioReferencia !== undefined ? { anioReferencia: opciones.anioReferencia } : {}),
  };

  return REGLAS.map((regla) => aplicar(regla, paginas, contexto));
}

function aplicar(
  regla: ReglaCampo,
  paginas: readonly PaginaReconocida[],
  contexto: ContextoLectura,
): CampoExtraido {
  for (const pagina of paginas) {
    for (const linea of pagina.texto.split(/\r?\n/)) {
      let encontrado: RegExpExecArray | null = null;
      for (const patron of regla.etiquetas) {
        encontrado = patron.exec(linea);
        if (encontrado !== null) break;
      }
      if (encontrado === null) continue;

      // El valor se busca después de la etiqueta. Si no está ahí, se acepta en
      // el resto de la línea: en un comprobante de dos columnas la etiqueta y su
      // valor a veces quedan invertidos al linealizar el texto.
      const resto = linea.slice(encontrado.index + encontrado[0].length);
      const match = regla.valor.exec(resto) ?? regla.valor.exec(linea);
      if (match === null) continue;

      const bruto = match[1]!;
      const confianzaLectura = confianzaDe(pagina, bruto) * regla.confianzaRegla;
      const interpretado = regla.interpretar(bruto, contexto);
      const bbox = recuadroDe(pagina, bruto);

      const base = {
        fieldPath: regla.fieldPath,
        rawValue: bruto,
        method: METODO,
        page: pagina.numero,
        ...(bbox !== undefined ? { bbox } : {}),
      };

      if ('error' in interpretado) {
        // La lectura se conserva aunque no se pueda interpretar. Tirarla dejaría
        // al contador sin saber qué decía el papel.
        return {
          ...base,
          parsedValue: null,
          confidence: acotarConfianza(METODO, confianzaLectura),
          nota: interpretado.error,
        };
      }

      return {
        ...base,
        parsedValue: interpretado.valor,
        confidence: acotarConfianza(METODO, confianzaLectura * interpretado.confianza),
        ...(interpretado.nota !== undefined ? { nota: interpretado.nota } : {}),
      };
    }
  }

  return {
    fieldPath: regla.fieldPath,
    rawValue: null,
    parsedValue: null,
    confidence: 0,
    method: METODO,
    nota: 'No se encontró la etiqueta de este campo en el documento',
  };
}

/** Confianza de lectura: la mínima de las palabras que componen el valor. */
function confianzaDe(pagina: PaginaReconocida, bruto: string): number {
  const piezas = bruto.split(/\s+/).filter((pieza) => pieza.length > 0);
  const confianzas = piezas.map((pieza) => {
    const palabra = pagina.palabras.find((candidata) => candidata.texto.includes(pieza));
    return palabra?.confianza ?? 0.5;
  });
  return confianzas.length === 0 ? 0.5 : Math.min(...confianzas);
}

function recuadroDe(pagina: PaginaReconocida, bruto: string): CampoExtraido['bbox'] {
  const primera = bruto.split(/\s+/)[0];
  if (primera === undefined) return undefined;
  return pagina.palabras.find((palabra) => palabra.texto.includes(primera))?.bbox;
}
