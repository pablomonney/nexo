/**
 * Libro de IVA Digital — RG AFIP 4597/2019, texto actualizado.
 *
 * Fuente: `docs/normative-sources/originals/INFOLEG_AFIP_RG_4597_2019_texto_actualizado.htm`,
 * archivada con su sha256, en su versión **modificada por la RG ARCA 5707/2025**
 * (B.O. 02/06/2025), cuyas disposiciones rigen desde el **01/12/2025** salvo la
 * derogación del Título II, que rige desde el 01/07/2025 (art. 2° de la 5707).
 *
 * Este módulo hace tres cosas y **se niega a hacer otras tres**. Las negativas
 * son la parte que importa.
 *
 * ## Lo que hace
 *
 * 1. Calcula el vencimiento del período (art. 12: quince días corridos del mes
 *    siguiente).
 * 2. Determina si corresponde la novedad `SIN MOVIMIENTO` (art. 12: la
 *    obligación se cumple aun sin operaciones).
 * 3. Verifica la secuencialidad (art. 12: un período solo se puede presentar si
 *    se generó el anterior).
 *
 * ## Lo que NO hace, y por qué
 *
 * 1. **No genera el archivo de importación de ARCA.** El art. 8° dice que los
 *    diseños de registro "se especifican en el micrositio IVA del sitio web
 *    institucional" — no están en la norma. Inventar un layout produciría un
 *    archivo que ARCA rechaza, o peor, uno que acepta con los campos corridos.
 * 2. **No presenta el libro.** El art. 6° exige ingresar al PORTAL IVA con Clave
 *    Fiscal Nivel 3. Este sistema no pide, no guarda y no usa la Clave Fiscal
 *    (regla establecida en FASE 3a). La presentación la hace una persona.
 * 3. **No dice quién está obligado para períodos anteriores al 01/12/2025.** El
 *    art. 2° vigente —sustituido por la RG 5707— alcanza a los *sujetos exentos*
 *    en el IVA. El texto anterior lo sustituyó la RG 5133/2021, que no está
 *    archivada: el "texto actualizado" de InfoLeg lista la modificación en sus
 *    Antecedentes pero no transcribe el texto viejo. Responder con la regla de
 *    hoy sobre un período de 2024 sería exactamente lo que el §6 prohíbe.
 */

import type { CalendarDate } from '@aai/shared';
import { addDays, calendarDate, daysInMonth, parseCalendarDate } from '@aai/shared';

/** Cita exacta de la norma que gobierna este módulo. */
export const FUENTE_LIBRO_IVA = {
  norma: 'RG AFIP 4597/2019, texto actualizado',
  modificadaPor: 'RG ARCA 5707/2025 (B.O. 02/06/2025)',
  archivo: 'INFOLEG_AFIP_RG_4597_2019_texto_actualizado.htm',
  articulos: {
    obligados: 'Art. 2° (sustituido por RG 5707/2025 punto 1)',
    acceso: 'Art. 6° (PORTAL IVA con Clave Fiscal Nivel 3)',
    disenosDeRegistro: 'Art. 8° (los diseños se publican en el micrositio, no en la norma)',
    presentacion: 'Art. 9° (confirmación con carácter de declaración jurada)',
    periodicidad: 'Art. 12 (mes calendario, 15 días corridos, SIN MOVIMIENTO, secuencialidad)',
  },
} as const;

/**
 * Desde cuándo rige el art. 2° que el sistema conoce.
 *
 * Antes de esta fecha regía otro texto que no está archivado. La constante
 * existe para que la frontera sea explícita y comprobable, no para tratarla como
 * si el régimen hubiera empezado ese día.
 */
export const VIGENCIA_TEXTO_ACTUAL = parseCalendarDate('2025-12-01');

export interface PeriodoIva {
  readonly anio: number;
  readonly mes: number;
}

export type EstadoLibroIva =
  | 'PENDIENTE'
  | 'GENERADO'
  | 'PRESENTADO_POR_TERCERO'
  | 'SIN_MOVIMIENTO';

export interface LibroIvaDigital {
  readonly companyId: string;
  readonly periodo: PeriodoIva;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  /** Art. 12: dentro de los primeros QUINCE (15) días corridos del mes siguiente. */
  readonly vencimiento: CalendarDate;
  readonly comprobantesCompras: number;
  readonly comprobantesVentas: number;
  /** Art. 12: la obligación se cumple aun sin operaciones, informando la novedad. */
  readonly sinMovimiento: boolean;
  readonly bloqueos: readonly BloqueoLibroIva[];
  readonly fuente: typeof FUENTE_LIBRO_IVA;
}

export type CodigoBloqueoLibroIva =
  | 'PERIODO_ANTERIOR_NO_GENERADO'
  | 'OBLIGACION_NO_DETERMINABLE'
  | 'SUBDIARIO_CON_EXCLUIDOS';

export interface BloqueoLibroIva {
  readonly codigo: CodigoBloqueoLibroIva;
  readonly mensaje: string;
  readonly fundamento: string;
}

export interface EstadoPeriodoAnterior {
  readonly periodo: PeriodoIva;
  readonly estado: EstadoLibroIva;
}

export interface ArmadoLibroIva {
  readonly companyId: string;
  readonly periodo: PeriodoIva;
  readonly comprobantesCompras: number;
  readonly comprobantesVentas: number;
  readonly excluidos: number;
  readonly periodoAnterior: EstadoPeriodoAnterior | null;
}

export function armarLibroIvaDigital(entrada: ArmadoLibroIva): LibroIvaDigital {
  const desde = calendarDate(entrada.periodo.anio, entrada.periodo.mes, 1);
  const hasta = calendarDate(
    entrada.periodo.anio,
    entrada.periodo.mes,
    daysInMonth(entrada.periodo.anio, entrada.periodo.mes),
  );

  const bloqueos: BloqueoLibroIva[] = [
    ...controlarSecuencialidad(entrada),
    ...controlarObligacion(desde),
    ...controlarExcluidos(entrada),
  ];

  return {
    companyId: entrada.companyId,
    periodo: entrada.periodo,
    desde,
    hasta,
    vencimiento: vencimientoDe(entrada.periodo),
    comprobantesCompras: entrada.comprobantesCompras,
    comprobantesVentas: entrada.comprobantesVentas,
    sinMovimiento: entrada.comprobantesCompras === 0 && entrada.comprobantesVentas === 0,
    bloqueos,
    fuente: FUENTE_LIBRO_IVA,
  };
}

/**
 * Art. 12: "dentro de los primeros QUINCE (15) días corridos del mes inmediato
 * siguiente".
 *
 * Días **corridos**, no hábiles: el artículo lo dice con esas palabras. Y el
 * último día del plazo es el 15, no el 14 — "dentro de los primeros quince"
 * incluye al decimoquinto.
 *
 * El motor **no** corre el vencimiento al hábil siguiente cuando cae fin de
 * semana o feriado. El traslado sale del art. 7° del Decreto 1397/79 y del
 * calendario de feriados, ninguno de los dos archivado; aplicarlo de memoria
 * daría una fecha que el sistema no puede fundar.
 */
export function vencimientoDe(periodo: PeriodoIva): CalendarDate {
  const mesSiguiente = periodo.mes === 12 ? 1 : periodo.mes + 1;
  const anioSiguiente = periodo.mes === 12 ? periodo.anio + 1 : periodo.anio;
  return addDays(calendarDate(anioSiguiente, mesSiguiente, 1), 14);
}

/**
 * Art. 12, último párrafo: "La presentación del Libro de IVA Digital de los
 * períodos sucesivos solo podrá efectuarse si previamente se generó el Libro de
 * IVA Digital del período anterior."
 *
 * `SIN_MOVIMIENTO` cuenta como generado: el mismo artículo dice que la
 * obligación se cumple informando esa novedad.
 */
function controlarSecuencialidad(entrada: ArmadoLibroIva): BloqueoLibroIva[] {
  if (entrada.periodoAnterior === null) return [];

  const generado =
    entrada.periodoAnterior.estado === 'GENERADO' ||
    entrada.periodoAnterior.estado === 'PRESENTADO_POR_TERCERO' ||
    entrada.periodoAnterior.estado === 'SIN_MOVIMIENTO';

  if (generado) return [];

  const { anio, mes } = entrada.periodoAnterior.periodo;
  return [
    {
      codigo: 'PERIODO_ANTERIOR_NO_GENERADO',
      mensaje: `El período ${String(anio)}-${String(mes).padStart(2, '0')} está en ${entrada.periodoAnterior.estado}. Hasta que se genere, este período no se puede presentar.`,
      fundamento: FUENTE_LIBRO_IVA.articulos.periodicidad,
    },
  ];
}

/**
 * Quién está obligado — y hasta dónde llega lo que el sistema sabe.
 *
 * Para períodos que empiezan antes del 01/12/2025 el art. 2° tenía otro texto,
 * sustituido por la RG 5133/2021 y no archivado. El sistema dice que no puede
 * determinarlo en vez de aplicar la regla de hoy hacia atrás.
 */
function controlarObligacion(desde: CalendarDate): BloqueoLibroIva[] {
  if (desde >= VIGENCIA_TEXTO_ACTUAL) return [];

  return [
    {
      codigo: 'OBLIGACION_NO_DETERMINABLE',
      mensaje: `El período empieza el ${desde}, antes del ${VIGENCIA_TEXTO_ACTUAL}. El art. 2° que este sistema conoce lo sustituyó la RG 5707/2025 y rige desde esa fecha; el texto anterior (RG 5133/2021) no está archivado. NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE: el libro se arma igual, pero quién está obligado lo determina el profesional.`,
      fundamento: FUENTE_LIBRO_IVA.articulos.obligados,
    },
  ];
}

function controlarExcluidos(entrada: ArmadoLibroIva): BloqueoLibroIva[] {
  if (entrada.excluidos === 0) return [];

  return [
    {
      codigo: 'SUBDIARIO_CON_EXCLUIDOS',
      mensaje: `${entrada.excluidos} comprobante(s) quedaron fuera de los totales por hallazgos bloqueantes. Un libro presentado con comprobantes silenciosamente ausentes es una declaración jurada incompleta.`,
      fundamento: FUENTE_LIBRO_IVA.articulos.presentacion,
    },
  ];
}

// ---------------------------------------------------------------------------
// Las dos negativas, como funciones
// ---------------------------------------------------------------------------

export interface Negativa {
  readonly puede: false;
  readonly motivo: string;
  readonly fundamento: string;
  readonly queHacer: string;
}

/**
 * Generar el archivo de importación de ARCA: no.
 *
 * Es una función y no un comentario porque la pregunta se la va a hacer alguien
 * desde la UI, y merece una respuesta con el artículo adentro en vez de un botón
 * que no existe.
 */
export function puedeGenerarArchivoDeImportacion(): Negativa {
  return {
    puede: false,
    motivo:
      'Los diseños de registro del Libro de IVA Digital no están en la resolución: el art. 8° los remite al micrositio IVA del sitio de ARCA. Inventar un layout produciría un archivo rechazado, o peor, uno aceptado con los campos corridos.',
    fundamento: `${FUENTE_LIBRO_IVA.norma}, ${FUENTE_LIBRO_IVA.articulos.disenosDeRegistro}`,
    queHacer:
      'Archivar los diseños de registro publicados en el micrositio, con su fecha y su hash, y recién entonces implementar el exportador contra esa fuente.',
  };
}

/**
 * Presentar el libro desde el sistema: no.
 *
 * No es una limitación técnica. Es la regla de FASE 3a: la Clave Fiscal no se
 * pide, no se guarda y no se usa. Un sistema que guarda la Clave Fiscal de un
 * estudio guarda la llave de todos sus clientes.
 */
export function puedePresentarPorElContribuyente(): Negativa {
  return {
    puede: false,
    motivo:
      'La presentación exige ingresar al PORTAL IVA con Clave Fiscal Nivel 3. Este sistema no pide, no almacena y no usa la Clave Fiscal. Los certificados X.509 habilitan los WebServices, no el portal web.',
    fundamento: `${FUENTE_LIBRO_IVA.norma}, ${FUENTE_LIBRO_IVA.articulos.acceso}`,
    queHacer:
      'El sistema arma el libro y lo exporta para control. La confirmación con carácter de declaración jurada (art. 9°) la hace una persona en el portal.',
  };
}
