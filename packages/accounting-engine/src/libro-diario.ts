/**
 * Libro Diario — el libro, no el listado de asientos.
 *
 * La diferencia es la que hace este archivo. Un listado muestra lo que hay; un
 * libro además **declara si está bien llevado**, y ese juicio tiene forma legal.
 *
 * Fuente: Ley 26.994 — Código Civil y Comercial de la Nación, arts. 320 a 331.
 * Archivada en `docs/normative-sources/originals/SAIJ_CCyC_Ley_26994.pdf` con su
 * sha256. Los artículos que se citan acá están transcriptos de esa copia; si el
 * texto vigente hubiera cambiado, cambia la cita, no el código.
 *
 * Los controles de forma **no bloquean la emisión**. Un Diario con un hueco de
 * numeración existe y hay que poder verlo — justamente para poder arreglarlo. Lo
 * que no puede pasar es que se emita sin decir que tiene el hueco: por eso
 * `cumpleFormalidades` viaja con el libro y queda en `book_emissions`.
 */

import type { CalendarDate, Currency, Money } from '@aai/shared';
import { add, compareDates, zero } from '@aai/shared';
import type { EntryKind, JournalCode } from './contracts.js';

export type EntryStatus = 'BORRADOR' | 'PROPUESTO' | 'APROBADO' | 'ANULADO';

export interface LineaDelLibro {
  readonly id: string;
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  /** Importe en la moneda de la contabilidad. CCyC art. 325: moneda nacional. */
  readonly debit: Money;
  readonly credit: Money;
  /**
   * Moneda en la que se pactó la operación, cuando no es la de la contabilidad.
   *
   * El art. 325 obliga a llevar los libros en moneda nacional; no prohíbe operar
   * en otra. Lo que se registra es el importe convertido, y el original se
   * conserva al lado — sin él, la conversión no se puede verificar.
   */
  readonly monedaOriginal: Currency | null;
  readonly importeOriginal: Money | null;
  readonly fxRate: string | null;
  readonly fxSource: string | null;
  readonly fxDate: CalendarDate | null;
  readonly costCenterCode: string | null;
  readonly partyId: string | null;
  readonly description: string | null;
  readonly taxTransactionId: string | null;
}

export interface AsientoDelLibro {
  readonly id: string;
  readonly journalCode: JournalCode;
  readonly entryNumber: number;
  readonly entryDate: CalendarDate;
  readonly description: string;
  readonly kind: EntryKind;
  readonly status: EntryStatus;
  readonly fiscalYearId: string;
  readonly periodId: string;
  readonly reversesEntryId: string | null;
  readonly sourceType: 'INVOICE' | 'RECEIPT' | 'BANK' | 'MANUAL' | 'CLOSING';
  readonly sourceId: string | null;
  readonly documentId: string | null;
  readonly manualJustification: string | null;
  /**
   * La decisión contable que funda el asiento, si es la que lo funda.
   *
   * Es la tercera vía de trazabilidad, incorporada en `d350405`. El libro tiene
   * que mostrarla por la misma razón por la que muestra el comprobante: un
   * asiento que aparece sin ninguna de las tres se lee como un asiento sin
   * fundamento, aunque lo tenga.
   */
  readonly decisionId: string | null;
  readonly aiPredictionId: string | null;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly lines: readonly LineaDelLibro[];
}

export type CodigoControl =
  | 'ORDEN_CRONOLOGICO'
  | 'NUMERACION_CORRELATIVA'
  | 'SIN_DUPLICADOS'
  | 'PARTIDA_DOBLE'
  | 'MONEDA_DE_REGISTRO'
  | 'CORRECCIONES_SALVADAS'
  | 'RESPALDO_DOCUMENTAL';

export interface ControlDeForma {
  readonly codigo: CodigoControl;
  readonly cumple: boolean;
  /** De qué artículo sale la exigencia. Vacío no es una opción. */
  readonly fundamento: string;
  readonly detalle: string;
  /** Los asientos concretos que lo incumplen. Un booleano solo no se arregla. */
  readonly incumplen: readonly string[];
}

export interface FolioDelLibro {
  readonly numero: number;
  readonly asientos: readonly AsientoDelLibro[];
  /** Acumulado que viene del folio anterior. El primero arranca en cero. */
  readonly transporteDebe: Money;
  readonly transporteHaber: Money;
  /** Acumulado al pie de este folio: transporte + lo del folio. */
  readonly acumuladoDebe: Money;
  readonly acumuladoHaber: Money;
}

export interface LibroDiario {
  readonly companyId: string;
  readonly fiscalYearId: string;
  readonly moneda: Currency;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly folios: readonly FolioDelLibro[];
  readonly totalDebe: Money;
  readonly totalHaber: Money;
  readonly asientos: number;
  readonly controles: readonly ControlDeForma[];
  readonly cumpleFormalidades: boolean;
  /**
   * Asientos que se pidieron y no entraron al libro, con su motivo.
   *
   * Se devuelven en vez de descartarse en silencio: quien pidió el Diario de un
   * mes y ve menos asientos de los que esperaba tiene derecho a saber por qué.
   */
  readonly excluidos: readonly { readonly id: string; readonly motivo: string }[];
}

export interface OpcionesLibroDiario {
  readonly companyId: string;
  readonly fiscalYearId: string;
  readonly moneda: Currency;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  /** Asientos por folio. La foliatura es del art. 323; el tamaño es de imprenta. */
  readonly asientosPorFolio?: number;
}

const ASIENTOS_POR_FOLIO_POR_DEFECTO = 20;

/**
 * Un asiento en BORRADOR o PROPUESTO **no entra al Diario**.
 *
 * Todavía no es contabilidad: nadie lo firmó. Imprimirlo en el libro haría que
 * el libro afirme algo que el contador nunca aprobó — y el art. 330 le da a ese
 * libro eficacia probatoria en juicio.
 *
 * Un asiento ANULADO sí entra, con su contraasiento al lado. El art. 324 inc. c
 * es explícito: las equivocaciones se salvan «mediante un nuevo asiento», no
 * borrando el anterior.
 */
const ESTADOS_REGISTRABLES: readonly EntryStatus[] = ['APROBADO', 'ANULADO'];

export function construirLibroDiario(
  todos: readonly AsientoDelLibro[],
  opciones: OpcionesLibroDiario,
): LibroDiario {
  const { moneda } = opciones;
  const excluidos: { id: string; motivo: string }[] = [];
  const incluidos: AsientoDelLibro[] = [];

  for (const asiento of todos) {
    if (!ESTADOS_REGISTRABLES.includes(asiento.status)) {
      excluidos.push({
        id: asiento.id,
        motivo: `Estado ${asiento.status}: todavía no es una registración`,
      });
      continue;
    }
    if (asiento.fiscalYearId !== opciones.fiscalYearId) {
      excluidos.push({ id: asiento.id, motivo: 'Pertenece a otro ejercicio' });
      continue;
    }
    if (
      compareDates(asiento.entryDate, opciones.desde) < 0 ||
      compareDates(asiento.entryDate, opciones.hasta) > 0
    ) {
      excluidos.push({ id: asiento.id, motivo: 'Fuera del rango pedido' });
      continue;
    }
    incluidos.push(asiento);
  }

  const ordenados = [...incluidos].sort(compararParaElLibro);
  const controles = controlarFormalidades(ordenados, moneda);
  const folios = paginar(
    ordenados,
    opciones.asientosPorFolio ?? ASIENTOS_POR_FOLIO_POR_DEFECTO,
    moneda,
  );

  const ultimo = folios.at(-1);
  return {
    companyId: opciones.companyId,
    fiscalYearId: opciones.fiscalYearId,
    moneda,
    desde: opciones.desde,
    hasta: opciones.hasta,
    folios,
    totalDebe: ultimo?.acumuladoDebe ?? zero(moneda),
    totalHaber: ultimo?.acumuladoHaber ?? zero(moneda),
    asientos: ordenados.length,
    controles,
    cumpleFormalidades: controles.every((control) => control.cumple),
    excluidos,
  };
}

/**
 * Los asientos que quedaron dentro del Diario, en su orden, sin la foliatura.
 *
 * Existe para que el Mayor se construya sobre **exactamente** este conjunto y no
 * sobre uno parecido. `construirLibroMayor` documenta desde siempre que quien
 * llama le pasa la salida del Diario; mientras eso fue una recomendación en un
 * comentario, `routes/books.ts` le pasó la lista cruda de la base y el Mayor
 * terminó incluyendo BORRADOR y PROPUESTO. Un helper de una línea convierte esa
 * recomendación en algo que se puede usar sin volver a filtrar a mano.
 */
export function asientosDelDiario(libro: LibroDiario): readonly AsientoDelLibro[] {
  return libro.folios.flatMap((folio) => folio.asientos);
}

/**
 * Orden del libro: fecha, después libro auxiliar, después número.
 *
 * El desempate por `journalCode` antes que por número es deliberado. Los números
 * son correlativos **dentro de cada libro** (`UNIQUE (company, journal, año,
 * número)`), así que un COMPRAS 12 y un VENTAS 12 del mismo día son los dos
 * legítimos: ordenar solo por número los intercalaría de forma arbitraria y el
 * orden dejaría de ser reproducible.
 */
function compararParaElLibro(a: AsientoDelLibro, b: AsientoDelLibro): number {
  const porFecha = compareDates(a.entryDate, b.entryDate);
  if (porFecha !== 0) return porFecha;
  if (a.journalCode !== b.journalCode) return a.journalCode < b.journalCode ? -1 : 1;
  return a.entryNumber - b.entryNumber;
}

function paginar(
  asientos: readonly AsientoDelLibro[],
  porFolio: number,
  moneda: Currency,
): FolioDelLibro[] {
  if (porFolio < 1) {
    throw new RangeError('asientosPorFolio debe ser al menos 1');
  }

  const folios: FolioDelLibro[] = [];
  let transporteDebe = zero(moneda);
  let transporteHaber = zero(moneda);

  for (let indice = 0; indice < asientos.length; indice += porFolio) {
    const delFolio = asientos.slice(indice, indice + porFolio);
    let acumuladoDebe = transporteDebe;
    let acumuladoHaber = transporteHaber;

    for (const asiento of delFolio) {
      for (const linea of asiento.lines) {
        acumuladoDebe = add(acumuladoDebe, linea.debit);
        acumuladoHaber = add(acumuladoHaber, linea.credit);
      }
    }

    folios.push({
      numero: folios.length + 1,
      asientos: delFolio,
      transporteDebe,
      transporteHaber,
      acumuladoDebe,
      acumuladoHaber,
    });

    transporteDebe = acumuladoDebe;
    transporteHaber = acumuladoHaber;
  }

  return folios;
}

// ---------------------------------------------------------------------------
// Controles de forma
// ---------------------------------------------------------------------------

const ART_324_A = 'CCyC art. 324 inc. a — se prohíbe alterar el orden de los asientos';
const ART_324_B = 'CCyC art. 324 inc. b — se prohíbe dejar blancos entre los asientos';
const ART_324_C =
  'CCyC art. 324 inc. c — las equivocaciones se salvan mediante un nuevo asiento';
const ART_321 =
  'CCyC art. 321 — individualización de las operaciones y sus cuentas deudoras y acreedoras; los asientos deben respaldarse con la documentación respectiva';
const ART_325 = 'CCyC art. 325 — los libros deben llevarse en idioma y moneda nacional';

function controlarFormalidades(
  asientos: readonly AsientoDelLibro[],
  moneda: Currency,
): ControlDeForma[] {
  return [
    controlarOrden(asientos),
    controlarCorrelatividad(asientos),
    controlarDuplicados(asientos),
    controlarPartidaDoble(asientos),
    controlarMoneda(asientos, moneda),
    controlarCorrecciones(asientos),
    controlarRespaldo(asientos),
  ];
}

/**
 * El número no puede ir para atrás en el tiempo.
 *
 * Se verifica por libro auxiliar, porque la numeración lo es. Si dentro de
 * COMPRAS el asiento 15 tiene fecha anterior al 14, alguien intercaló una
 * operación en el pasado y el orden dejó de ser el de registración.
 */
function controlarOrden(asientos: readonly AsientoDelLibro[]): ControlDeForma {
  const incumplen: string[] = [];

  for (const [, delLibro] of agruparPorLibro(asientos)) {
    const porNumero = [...delLibro].sort((a, b) => a.entryNumber - b.entryNumber);
    for (let i = 1; i < porNumero.length; i += 1) {
      const previo = porNumero[i - 1];
      const actual = porNumero[i];
      if (previo === undefined || actual === undefined) continue;
      if (compareDates(actual.entryDate, previo.entryDate) < 0) {
        incumplen.push(actual.id);
      }
    }
  }

  return {
    codigo: 'ORDEN_CRONOLOGICO',
    cumple: incumplen.length === 0,
    fundamento: ART_324_A,
    detalle:
      incumplen.length === 0
        ? 'Los números avanzan con las fechas en todos los libros auxiliares'
        : `${incumplen.length} asiento(s) llevan un número posterior al de un asiento de fecha mayor`,
    incumplen,
  };
}

/**
 * Sin huecos en la numeración.
 *
 * Un hueco es el equivalente digital del blanco del inc. b: un lugar donde
 * después se puede intercalar algo. El control se hace contra el rango real
 * —del mínimo al máximo—, no contra 1, porque el libro puede pedirse por un mes
 * y arrancar en el número que arranque.
 */
function controlarCorrelatividad(asientos: readonly AsientoDelLibro[]): ControlDeForma {
  const faltantes: string[] = [];

  for (const [libro, delLibro] of agruparPorLibro(asientos)) {
    const numeros = new Set(delLibro.map((asiento) => asiento.entryNumber));
    const minimo = Math.min(...numeros);
    const maximo = Math.max(...numeros);
    for (let numero = minimo; numero <= maximo; numero += 1) {
      if (!numeros.has(numero)) faltantes.push(`${libro}#${numero}`);
    }
  }

  return {
    codigo: 'NUMERACION_CORRELATIVA',
    cumple: faltantes.length === 0,
    fundamento: ART_324_B,
    detalle:
      faltantes.length === 0
        ? 'La numeración es correlativa dentro de cada libro auxiliar'
        : `Faltan ${faltantes.length} número(s) en el rango emitido. Un número ausente puede ser un asiento en borrador, uno de otro período, o uno que se perdió: hay que mirarlo.`,
    incumplen: faltantes,
  };
}

function controlarDuplicados(asientos: readonly AsientoDelLibro[]): ControlDeForma {
  const vistos = new Map<string, string>();
  const incumplen: string[] = [];

  for (const asiento of asientos) {
    const clave = `${asiento.journalCode}#${asiento.entryNumber}`;
    const previo = vistos.get(clave);
    if (previo !== undefined) {
      incumplen.push(asiento.id);
      continue;
    }
    vistos.set(clave, asiento.id);
  }

  return {
    codigo: 'SIN_DUPLICADOS',
    cumple: incumplen.length === 0,
    fundamento: ART_324_B,
    detalle:
      incumplen.length === 0
        ? 'Ningún número se repite dentro de su libro auxiliar'
        : `${incumplen.length} asiento(s) repiten un número ya usado`,
    incumplen,
  };
}

function controlarPartidaDoble(asientos: readonly AsientoDelLibro[]): ControlDeForma {
  const incumplen: string[] = [];

  for (const asiento of asientos) {
    if (asiento.lines.length < 2) {
      incumplen.push(asiento.id);
      continue;
    }
    let debe = 0n;
    let haber = 0n;
    for (const linea of asiento.lines) {
      debe += linea.debit.amount;
      haber += linea.credit.amount;
    }
    if (debe !== haber || debe === 0n) incumplen.push(asiento.id);
  }

  return {
    codigo: 'PARTIDA_DOBLE',
    cumple: incumplen.length === 0,
    fundamento: ART_321,
    detalle:
      incumplen.length === 0
        ? 'Todos los asientos tienen al menos dos líneas y Debe = Haber'
        : `${incumplen.length} asiento(s) no cierran en partida doble. Esto no debería poder pasar: la base lo impide con je_balanced y je_entry_consistent. Si aparece, el problema está antes de este control.`,
    incumplen,
  };
}

/**
 * El libro se lleva en una sola moneda.
 *
 * Que una línea tenga `monedaOriginal` es normal y correcto. Lo que el art. 325
 * no admite es que el importe **registrado** esté en otra moneda: ahí el libro
 * dejaría de sumar.
 *
 * El otro medio control: si hay moneda original, tiene que haber cotización con
 * fuente. Sin ella la conversión no se puede rehacer, y una conversión que no se
 * puede rehacer es un número que hay que creer.
 */
function controlarMoneda(
  asientos: readonly AsientoDelLibro[],
  moneda: Currency,
): ControlDeForma {
  const incumplen: string[] = [];

  for (const asiento of asientos) {
    for (const linea of asiento.lines) {
      const registroEnOtraMoneda =
        linea.debit.currency !== moneda || linea.credit.currency !== moneda;
      const conversionSinRespaldo =
        linea.monedaOriginal !== null &&
        linea.monedaOriginal !== moneda &&
        (linea.fxRate === null || linea.fxSource === null || linea.fxDate === null);

      if (registroEnOtraMoneda || conversionSinRespaldo) {
        incumplen.push(`${asiento.id}:${linea.lineNo}`);
      }
    }
  }

  return {
    codigo: 'MONEDA_DE_REGISTRO',
    cumple: incumplen.length === 0,
    fundamento: ART_325,
    detalle:
      incumplen.length === 0
        ? `Todo se registra en ${moneda}, y cada conversión lleva cotización, fuente y fecha`
        : `${incumplen.length} línea(s) están registradas en otra moneda o convertidas sin cotización verificable`,
    incumplen,
  };
}

/**
 * Toda anulación tiene su contraasiento, y no está antedatado.
 *
 * El art. 324 inc. c pide que el asiento que salva el error lleve «la fecha en
 * que se advierta la omisión o el error». Un contraasiento con fecha anterior al
 * asiento que corrige es imposible: nadie advierte un error antes de cometerlo.
 * Es la forma más común de antedatar sin que se note.
 */
function controlarCorrecciones(asientos: readonly AsientoDelLibro[]): ControlDeForma {
  const porId = new Map(asientos.map((asiento) => [asiento.id, asiento]));
  const reversionesPorObjetivo = new Map<string, AsientoDelLibro>();
  const incumplen: string[] = [];

  for (const asiento of asientos) {
    if (asiento.reversesEntryId !== null) {
      reversionesPorObjetivo.set(asiento.reversesEntryId, asiento);
    }
  }

  for (const asiento of asientos) {
    if (asiento.status !== 'ANULADO') continue;
    const reversion = reversionesPorObjetivo.get(asiento.id);
    if (reversion === undefined) {
      incumplen.push(asiento.id);
      continue;
    }
    if (compareDates(reversion.entryDate, asiento.entryDate) < 0) {
      incumplen.push(reversion.id);
    }
  }

  for (const asiento of asientos) {
    if (asiento.reversesEntryId === null) continue;
    // El anulado puede quedar fuera del rango pedido: eso no es un incumplimiento
    // del libro, es un contraasiento de un mes anterior. Solo se controla la
    // fecha cuando los dos están a la vista.
    const objetivo = porId.get(asiento.reversesEntryId);
    if (objetivo !== undefined && compareDates(asiento.entryDate, objetivo.entryDate) < 0) {
      if (!incumplen.includes(asiento.id)) incumplen.push(asiento.id);
    }
  }

  return {
    codigo: 'CORRECCIONES_SALVADAS',
    cumple: incumplen.length === 0,
    fundamento: ART_324_C,
    detalle:
      incumplen.length === 0
        ? 'Cada anulación tiene su contraasiento, con fecha igual o posterior a la del asiento corregido'
        : `${incumplen.length} corrección(es) sin contraasiento o con fecha anterior al asiento que corrigen`,
    incumplen,
  };
}

/**
 * Cada asiento tiene detrás un documento, una justificación firmada o una
 * decisión contable.
 *
 * El art. 321 pide que los asientos «se respalden con la documentación
 * respectiva». Un asiento de cierre no tiene factura, y está bien: su respaldo
 * es el acto de cierre. Lo que no puede haber es un asiento sin ninguna de las
 * tres cosas.
 *
 * Las tres son las mismas que admite `E_NO_TRACEABILITY` en `validate.ts`, y
 * tienen que serlo: si el motor deja pasar un asiento y después el libro lo
 * denuncia como sin respaldo, uno de los dos está mintiendo.
 */
function controlarRespaldo(asientos: readonly AsientoDelLibro[]): ControlDeForma {
  const incumplen: string[] = [];

  for (const asiento of asientos) {
    const tieneDocumento = asiento.documentId !== null || asiento.sourceId !== null;
    const tieneJustificacion =
      asiento.manualJustification !== null && asiento.manualJustification.trim() !== '';
    // Se exige un id de verdad y no solo «distinto de null». Un llamador que
    // omita el campo lo deja en `undefined`, y con `!== null` eso alcanzaría
    // para dar por respaldados a todos los asientos del libro: el control se
    // apagaría entero sin que nada lo diga. Acá conviene fallar cerrado.
    const tieneDecision =
      typeof asiento.decisionId === 'string' && asiento.decisionId.trim() !== '';
    if (!tieneDocumento && !tieneJustificacion && !tieneDecision) incumplen.push(asiento.id);
  }

  return {
    codigo: 'RESPALDO_DOCUMENTAL',
    cumple: incumplen.length === 0,
    fundamento: ART_321,
    detalle:
      incumplen.length === 0
        ? 'Todos los asientos tienen documento respaldatorio, justificación firmada o decisión contable'
        : `${incumplen.length} asiento(s) no tienen ni comprobante, ni justificación, ni decisión`,
    incumplen,
  };
}

function agruparPorLibro(
  asientos: readonly AsientoDelLibro[],
): Map<JournalCode, AsientoDelLibro[]> {
  const grupos = new Map<JournalCode, AsientoDelLibro[]>();
  for (const asiento of asientos) {
    const grupo = grupos.get(asiento.journalCode);
    if (grupo === undefined) grupos.set(asiento.journalCode, [asiento]);
    else grupo.push(asiento);
  }
  return grupos;
}
