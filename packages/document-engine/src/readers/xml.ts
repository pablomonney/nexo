/**
 * Lectura de comprobantes en XML.
 *
 * Una aclaración necesaria para no prometer de más: **no existe, entre las
 * fuentes archivadas, un esquema oficial único de "factura electrónica en XML"**
 * que los sistemas de gestión deban emitir. Lo que sí está archivado con hash es
 * la nomenclatura de los web services de ARCA —`CbteFch`, `ImpTotal`, `CAE`,
 * `PtoVta`, `CbteNro`, `DocNro`— en el manual del wsfev1 v4.6, y muchos sistemas
 * exportan usando esos nombres justamente porque son los que le mandan al
 * organismo.
 *
 * Por eso este lector funciona con **perfiles**: un perfil es un mapa de
 * `fieldPath` a rutas candidatas dentro del XML. El perfil `WSFEV1` está
 * respaldado por el manual archivado; cualquier otro formato de proveedor se
 * agrega como perfil propio, con su origen documentado, en vez de ensanchar
 * heurísticas hasta que "más o menos funcione con todos".
 *
 * Un XML no leído por falta de perfil devuelve campos vacíos con nota, no un
 * documento sin campos.
 */

import { XMLParser } from 'fast-xml-parser';
import type { Currency } from '@aai/shared';
import { isValidCuit, normalizeCuit } from '@aai/shared';
import type { CampoExtraido, MetodoExtraccion } from '../types.js';
import { acotarConfianza } from '../types.js';
import { parseFechaAr } from '../parsers/fecha.js';
import { parseImporteAr } from '../parsers/importe.js';
import { parseCodigoAutorizacion } from '../parsers/comprobante.js';

const METODO: MetodoExtraccion = 'XML';

export interface PerfilXml {
  readonly nombre: string;
  readonly fuente: string;
  /** `fieldPath` → nombres de elemento aceptados, en orden de preferencia. */
  readonly campos: Readonly<Record<string, readonly string[]>>;
}

/**
 * Nomenclatura de los web services de ARCA.
 *
 * Elementos tomados del manual del desarrollador wsfev1 v4.6 archivado
 * (`FECAEDetRequest` y `FECAEDetResponse`) y del WSCDC v4 (`CmpReq`).
 */
export const PERFIL_WSFEV1: PerfilXml = {
  nombre: 'WSFEV1',
  fuente: 'ARCA_manual_desarrollador_wsfev1_v4.6.pdf (V1) — elementos FECAEDetRequest/Response',
  campos: {
    'emisor.cuit': ['Cuit', 'CuitEmisor'],
    'receptor.documento': ['DocNro', 'DocNroReceptor'],
    'comprobante.tipo': ['CbteTipo'],
    'comprobante.puntoVenta': ['PtoVta'],
    'comprobante.numero': ['CbteNro', 'CbteDesde'],
    'comprobante.fecha': ['CbteFch'],
    'comprobante.codigoAutorizacion': ['CAE', 'CodAutorizacion'],
    'comprobante.vencimientoAutorizacion': ['CAEFchVto', 'FchVto'],
    'importes.total': ['ImpTotal'],
    'importes.neto': ['ImpNeto'],
    'importes.iva': ['ImpIVA'],
    'importes.exento': ['ImpOpEx'],
    'importes.tributos': ['ImpTrib'],
    'comprobante.moneda': ['MonId'],
  },
};

export interface OpcionesXml {
  readonly perfil?: PerfilXml;
  readonly moneda?: Currency;
}

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

export interface ResultadoLecturaXml {
  readonly campos: readonly CampoExtraido[];
  readonly perfil: string;
  readonly payloadCrudo: unknown;
}

export function leerXml(bytes: Buffer, opciones: OpcionesXml = {}): ResultadoLecturaXml {
  const perfil = opciones.perfil ?? PERFIL_WSFEV1;
  const moneda = opciones.moneda ?? 'ARS';
  const texto = bytes.toString('utf8');

  // Defensa en profundidad: `sniff` ya rechaza los XML con DOCTYPE, pero este
  // lector también puede llamarse directo desde un job de importación.
  if (/<!DOCTYPE|<!ENTITY/i.test(texto)) {
    throw new Error('El XML declara DOCTYPE o entidades: no se procesa');
  }

  const arbol = parser.parse(texto) as unknown;
  const campos: CampoExtraido[] = [];

  for (const [fieldPath, nombres] of Object.entries(perfil.campos)) {
    const bruto = primerValor(arbol, nombres);
    if (bruto === null) {
      campos.push({
        fieldPath,
        rawValue: null,
        parsedValue: null,
        confidence: 0,
        method: METODO,
        nota: `El XML no trae ninguno de los elementos ${nombres.join(', ')}`,
      });
      continue;
    }
    campos.push(interpretar(fieldPath, bruto, moneda));
  }

  return { campos, perfil: perfil.nombre, payloadCrudo: arbol };
}

function interpretar(fieldPath: string, bruto: string, moneda: Currency): CampoExtraido {
  const base = { fieldPath, rawValue: bruto, method: METODO } as const;

  if (fieldPath.startsWith('importes.')) {
    // Los importes de los web services vienen con punto decimal, no con formato
    // argentino. El parser resuelve los dos, y se abstiene si el archivo mezcla.
    const resultado = parseImporteAr(bruto, moneda);
    if (!resultado.ok) {
      return { ...base, parsedValue: null, confidence: 0, nota: resultado.error.mensaje };
    }
    return {
      ...base,
      parsedValue: {
        kind: 'MONEY',
        amount: resultado.value.money.amount.toString(),
        currency: moneda,
      },
      confidence: acotarConfianza(METODO, resultado.value.confianza),
    };
  }

  if (fieldPath.endsWith('.fecha') || fieldPath.includes('vencimiento')) {
    const resultado = parseFechaAr(bruto);
    if (!resultado.ok) {
      return { ...base, parsedValue: null, confidence: 0, nota: resultado.error.mensaje };
    }
    return {
      ...base,
      parsedValue: { kind: 'DATE', value: resultado.value.fecha },
      confidence: acotarConfianza(METODO, resultado.value.confianza),
    };
  }

  if (fieldPath.endsWith('.cuit')) {
    const normalizado = normalizeCuit(bruto);
    if (!isValidCuit(normalizado)) {
      return {
        ...base,
        parsedValue: null,
        confidence: 0,
        nota: `"${bruto}" no verifica el dígito de control: no es un CUIT válido`,
      };
    }
    return {
      ...base,
      parsedValue: { kind: 'CUIT', value: normalizado },
      confidence: acotarConfianza(METODO, 1),
    };
  }

  if (fieldPath === 'comprobante.codigoAutorizacion') {
    const resultado = parseCodigoAutorizacion(bruto);
    if (!resultado.ok) {
      return { ...base, parsedValue: null, confidence: 0, nota: resultado.error.mensaje };
    }
    return {
      ...base,
      parsedValue: { kind: 'TEXT', value: resultado.value },
      confidence: acotarConfianza(METODO, 1),
    };
  }

  if (/^\d+$/.test(bruto)) {
    return {
      ...base,
      parsedValue: { kind: 'INTEGER', value: bruto },
      confidence: acotarConfianza(METODO, 1),
    };
  }

  return {
    ...base,
    parsedValue: { kind: 'TEXT', value: bruto },
    confidence: acotarConfianza(METODO, 1),
  };
}

/** Primer valor escalar cuyo elemento coincida con alguno de los nombres. */
function primerValor(nodo: unknown, nombres: readonly string[]): string | null {
  for (const nombre of nombres) {
    const encontrado = buscar(nodo, nombre);
    if (encontrado !== null) return encontrado;
  }
  return null;
}

function buscar(nodo: unknown, nombre: string): string | null {
  if (nodo === null || typeof nodo !== 'object') return null;
  for (const [clave, valor] of Object.entries(nodo as Record<string, unknown>)) {
    // Se aceptan elementos con prefijo de namespace: `ar:ImpTotal`.
    if (clave === nombre || clave.endsWith(`:${nombre}`)) {
      if (typeof valor === 'string' && valor.length > 0) return valor;
      if (typeof valor === 'number') return String(valor);
      if (Array.isArray(valor) && typeof valor[0] === 'string') return valor[0];
    }
    const anidado = buscar(valor, nombre);
    if (anidado !== null) return anidado;
  }
  return null;
}
