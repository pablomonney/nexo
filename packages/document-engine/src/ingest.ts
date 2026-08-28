/**
 * Pipeline de ingesta.
 *
 * Orden deliberado: **primero se archiva, después se interpreta**.
 *
 * El documento se hashea y se guarda antes de intentar leerlo, y se guarda
 * aunque la lectura falle por completo. Un sistema que descarta lo que no supo
 * interpretar pierde justamente los comprobantes raros —los que traen el
 * problema contable interesante— y deja al contador sin el papel para mirarlo a
 * mano. Acá el peor caso es un documento archivado con cero campos leídos y una
 * nota que dice por qué.
 *
 * El pipeline no toca la base ni la red: recibe sus dependencias como puertos.
 * Eso permite correrlo entero en un test, con un store en memoria y un OCR
 * simulado, y es lo que hace que las métricas de extracción se puedan medir
 * sobre un corpus sin levantar nada.
 */

import type { Currency } from '@aai/shared';
import { controlarCoherencia, type Hallazgo } from './coherencia.js';
import {
  detectarDuplicados,
  type ClaveLogica,
  type Coincidencia,
  type HuellaDocumento,
} from './duplicates.js';
import { sha256 } from './hash.js';
import type { OcrEngine } from './ocr/engine.js';
import { NullOcrEngine } from './ocr/engine.js';
import { extraerDeTexto } from './readers/texto.js';
import { leerXml, type PerfilXml } from './readers/xml.js';
import { EXTENSION_POR_TIPO, type DocumentStore } from './storage.js';
import { mimeDe, sniff, verificarCoherencia } from './sniff.js';
import type {
  CampoExtraido,
  DocumentoIngresado,
  MotivoSinExtraccion,
  OrigenDocumento,
  ResultadoExtraccion,
  TipoContenido,
} from './types.js';

export interface EntradaIngesta {
  readonly companyId: string;
  readonly nombreOriginal: string;
  readonly mimeDeclarado?: string;
  readonly origen: OrigenDocumento;
  readonly bytes: Buffer;
}

export type MotivoRechazo =
  | 'ARCHIVO_VACIO'
  | 'DEMASIADO_GRANDE'
  | 'TIPO_NO_RECONOCIDO'
  | 'TIPO_DECLARADO_NO_COINCIDE';

export interface IngestaAceptada {
  readonly ok: true;
  readonly documento: DocumentoIngresado;
  readonly extraccion: ResultadoExtraccion;
  readonly hallazgos: readonly Hallazgo[];
  readonly duplicados: readonly Coincidencia[];
}

export interface IngestaRechazada {
  readonly ok: false;
  readonly motivo: MotivoRechazo;
  readonly detalle: string;
  /** Se calcula igual: sirve para reconocer un archivo que ya fue rechazado antes. */
  readonly sha256: string;
}

export type ResultadoIngesta = IngestaAceptada | IngestaRechazada;

/** Puerto de consulta para deduplicar. Lo implementa la capa que habla con la base. */
export interface RepositorioHuellas {
  huellasDe(companyId: string): Promise<readonly HuellaDocumento[]>;
}

export class SinHuellasPrevias implements RepositorioHuellas {
  async huellasDe(): Promise<readonly HuellaDocumento[]> {
    return [];
  }
}

export interface OpcionesIngesta {
  readonly store: DocumentStore;
  readonly ocr?: OcrEngine;
  readonly huellas?: RepositorioHuellas;
  readonly perfilXml?: PerfilXml;
  readonly moneda?: Currency;
  readonly maxBytes?: number;
  readonly documentIdNuevo?: string;
}

/** 25 MB: un escaneo de 20 páginas a 300 dpi entra holgado. */
export const MAX_BYTES_POR_DEFECTO = 25 * 1024 * 1024;

export async function ingerir(
  entrada: EntradaIngesta,
  opciones: OpcionesIngesta,
): Promise<ResultadoIngesta> {
  const hash = sha256(entrada.bytes);
  const maxBytes = opciones.maxBytes ?? MAX_BYTES_POR_DEFECTO;

  if (entrada.bytes.length === 0) {
    return { ok: false, motivo: 'ARCHIVO_VACIO', detalle: 'El archivo no tiene contenido', sha256: hash };
  }
  if (entrada.bytes.length > maxBytes) {
    return {
      ok: false,
      motivo: 'DEMASIADO_GRANDE',
      detalle: `El archivo pesa ${entrada.bytes.length} bytes y el máximo es ${maxBytes}`,
      sha256: hash,
    };
  }

  const detectado = sniff(entrada.bytes, entrada.nombreOriginal);
  if (detectado.tipo === 'DESCONOCIDO') {
    const riesgo = detectado.riesgos[0];
    return {
      ok: false,
      motivo: 'TIPO_NO_RECONOCIDO',
      detalle:
        riesgo?.detalle ??
        'El contenido no corresponde a ninguno de los tipos admitidos (PDF, JPG, PNG, XML, CSV, XLSX)',
      sha256: hash,
    };
  }

  const incoherencia = verificarCoherencia(
    detectado.tipo,
    entrada.nombreOriginal,
    entrada.mimeDeclarado,
  );
  if (incoherencia !== null) {
    return { ok: false, motivo: 'TIPO_DECLARADO_NO_COINCIDE', detalle: incoherencia, sha256: hash };
  }

  const storageKey = await opciones.store.put(
    entrada.companyId,
    hash,
    EXTENSION_POR_TIPO[detectado.tipo] ?? 'bin',
    entrada.bytes,
  );

  const documento: DocumentoIngresado = {
    sha256: hash,
    bytes: entrada.bytes.length,
    tipo: detectado.tipo,
    mime: mimeDe(detectado.tipo),
    nombreOriginal: entrada.nombreOriginal,
    origen: entrada.origen,
    storageKey,
    riesgos: detectado.riesgos,
  };

  const extraccion = await extraer(entrada.bytes, detectado.tipo, opciones);
  const hallazgos = extraccion.disponible ? controlarCoherencia(extraccion.campos) : [];

  const existentes = await (opciones.huellas ?? new SinHuellasPrevias()).huellasDe(
    entrada.companyId,
  );
  const duplicados = detectarDuplicados(
    { documentId: opciones.documentIdNuevo ?? hash, sha256: hash, ...huellaDe(extraccion.campos) },
    existentes,
  );

  return { ok: true, documento, extraccion, hallazgos, duplicados };
}

export async function extraer(
  bytes: Buffer,
  tipo: TipoContenido,
  opciones: OpcionesIngesta,
): Promise<ResultadoExtraccion> {
  if (tipo === 'XML') {
    try {
      const leido = leerXml(bytes, {
        ...(opciones.perfilXml !== undefined ? { perfil: opciones.perfilXml } : {}),
        ...(opciones.moneda !== undefined ? { moneda: opciones.moneda } : {}),
      });
      return {
        motor: `xml:${leido.perfil}`,
        motorVersion: '1',
        campos: leido.campos,
        confianzaGlobal: confianzaGlobal(leido.campos),
        disponible: true,
        payloadCrudo: leido.payloadCrudo,
      };
    } catch (error) {
      return sinExtraccion('xml', 'MOTOR_FALLO', error instanceof Error ? error.message : undefined);
    }
  }

  if (tipo === 'CSV' || tipo === 'XLSX') {
    // Una planilla no es un comprobante: es un lote. Se archiva y queda
    // disponible para los procesos de importación, que sí saben qué columnas
    // esperan. Aplicarle las reglas de extracción de facturas produciría campos
    // sueltos tomados de la primera fila que coincidiera.
    return sinExtraccion(
      'tabular',
      'TIPO_NO_SOPORTADO',
      'Los archivos tabulares se procesan por importación, no por extracción de comprobante',
    );
  }

  // Se le pregunta al motor incluso si `soporta()` dice que no: el motivo lo da
  // él. "No hay motor de OCR" y "este motor no lee PDF" son cosas distintas, y
  // decidirlo acá afuera colapsaría las dos en la segunda.
  const ocr = opciones.ocr ?? new NullOcrEngine();

  let reconocido;
  try {
    reconocido = await ocr.reconocer({ bytes, tipo });
  } catch (error) {
    return sinExtraccion(ocr.nombre, 'MOTOR_FALLO', error instanceof Error ? error.message : undefined);
  }

  if (!reconocido.disponible || reconocido.paginas.length === 0) {
    return {
      motor: ocr.nombre,
      motorVersion: ocr.version,
      campos: [],
      confianzaGlobal: 0,
      disponible: false,
      motivoNoDisponible: reconocido.motivo ?? 'DOCUMENTO_ILEGIBLE',
    };
  }

  const campos = extraerDeTexto(reconocido.paginas, {
    ...(opciones.moneda !== undefined ? { moneda: opciones.moneda } : {}),
  });

  return {
    motor: ocr.nombre,
    motorVersion: ocr.version,
    campos,
    confianzaGlobal: confianzaGlobal(campos),
    disponible: true,
  };
}

function sinExtraccion(
  motor: string,
  motivo: MotivoSinExtraccion,
  detalle?: string,
): ResultadoExtraccion {
  return {
    motor,
    motorVersion: '0',
    campos: [],
    confianzaGlobal: 0,
    disponible: false,
    motivoNoDisponible: motivo,
    ...(detalle !== undefined ? { payloadCrudo: { detalle } } : {}),
  };
}

/**
 * Confianza del conjunto: la **mínima** de los campos interpretados, no el
 * promedio. Un documento con nueve campos perfectos y el total dudoso no es un
 * documento con 0.9 de confianza: es un documento con el total dudoso.
 */
function confianzaGlobal(campos: readonly CampoExtraido[]): number {
  const interpretados = campos.filter((campo) => campo.parsedValue !== null);
  if (interpretados.length === 0) return 0;
  return Math.min(...interpretados.map((campo) => campo.confidence));
}

/** Arma la huella lógica del documento a partir de lo que se pudo interpretar. */
function huellaDe(campos: readonly CampoExtraido[]): Partial<HuellaDocumento> {
  const buscar = (fieldPath: string): CampoExtraido | undefined =>
    campos.find((campo) => campo.fieldPath === fieldPath && campo.parsedValue !== null);

  const huella: {
    total?: string;
    moneda?: string;
    fecha?: string;
    cuitContraparte?: string;
  } = {};

  const total = buscar('importes.total');
  if (total?.parsedValue?.kind === 'MONEY') {
    huella.total = total.parsedValue.amount;
    huella.moneda = total.parsedValue.currency;
  }

  const fecha = buscar('comprobante.fecha');
  if (fecha?.parsedValue?.kind === 'DATE') huella.fecha = fecha.parsedValue.value;

  const cuit = buscar('emisor.cuit');
  if (cuit?.parsedValue?.kind === 'CUIT') huella.cuitContraparte = cuit.parsedValue.value;

  const clave = claveLogicaDe(campos, huella.cuitContraparte);
  return clave === null ? huella : { ...huella, claveLogica: clave };
}

/**
 * Clave lógica del comprobante, si los cuatro componentes están interpretados.
 *
 * Requiere el **tipo numérico**, que hoy solo llega por XML: de un OCR se lee la
 * letra impresa, y traducir letra a `CbteTipo` exige el catálogo del organismo
 * (ver `catalogo.ts`). Sin los cuatro no se arma una clave parcial: una clave
 * incompleta produciría falsos duplicados entre comprobantes de tipos distintos
 * con el mismo número, que es una situación perfectamente normal.
 */
function claveLogicaDe(
  campos: readonly CampoExtraido[],
  cuitEmisor: string | undefined,
): ClaveLogica | null {
  if (cuitEmisor === undefined) return null;

  const entero = (fieldPath: string): number | null => {
    const campo = campos.find((candidato) => candidato.fieldPath === fieldPath);
    const valor = campo?.parsedValue;
    if (valor?.kind !== 'INTEGER') return null;
    const numero = Number.parseInt(valor.value, 10);
    return Number.isSafeInteger(numero) ? numero : null;
  };

  const tipo = entero('comprobante.tipo');
  const puntoVenta = entero('comprobante.puntoVenta');
  const numero = entero('comprobante.numero');
  if (tipo === null || puntoVenta === null || numero === null) return null;

  return { cuitEmisor, tipoComprobante: tipo, puntoVenta, numero };
}
