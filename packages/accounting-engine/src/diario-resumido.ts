/**
 * Diario resumido — la única forma legal de que el Diario no tenga una línea por
 * cada factura.
 *
 * CCyC art. 327: «En el Diario se deben registrar todas las operaciones […]
 * individualmente o en registros resumidos que cubran períodos de duración no
 * superiores al mes. Estos resúmenes deben surgir de anotaciones detalladas
 * practicadas en subdiarios, los que deben ser llevados en las formas y
 * condiciones establecidas en los artículos 323, 324 y 325.»
 *
 * Las dos condiciones de esa frase son las dos razones por las que este módulo
 * se niega:
 *
 *   1. **El período no puede pasar del mes.** No "treinta días": el mes
 *      calendario. Un resumen del 15/03 al 14/04 abarca dos meses.
 *   2. **El resumen tiene que salir de un subdiario.** No de una suma hecha al
 *      vuelo sobre el Diario. Si el subdiario no está declarado, el resumen no
 *      tiene de dónde surgir y no se emite.
 *
 * La segunda es la que un sistema de contabilidad se saltea sin pensarlo:
 * agrupar por mes y sumar es trivial, y el resultado se ve igual. Lo que cambia
 * es que en un caso hay un registro detallado atrás y en el otro no, y esa es
 * exactamente la diferencia que el artículo exige.
 */

import type { CalendarDate, Currency, Money } from '@aai/shared';
import type { Result } from '@aai/shared';
import { add, err, monthOf, ok, yearOf, zero } from '@aai/shared';
import type { JournalCode } from './contracts.js';
import type { AsientoDelLibro } from './libro-diario.js';

/**
 * El subdiario del que sale un resumen.
 *
 * No es una etiqueta: es la declaración de que existe un registro detallado, con
 * su rango cubierto y su respaldo. Sin `desde`/`hasta` no se puede verificar que
 * cubra el mes que se está resumiendo.
 */
export interface SubdiarioDeclarado {
  readonly journalCode: JournalCode;
  readonly nombre: string;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  /**
   * Dónde está el detalle: identificador del libro auxiliar rubricado o del
   * archivo emitido con su hash. Es lo que hace verificable la afirmación.
   */
  readonly referencia: string;
}

export interface LineaResumida {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly debe: Money;
  readonly haber: Money;
  /** Cuántos asientos del detalle se condensaron en esta línea. */
  readonly operaciones: number;
}

export interface AsientoResumido {
  readonly journalCode: JournalCode;
  readonly anio: number;
  readonly mes: number;
  /** Último día con movimiento del mes. El resumen se asienta al cierre del período. */
  readonly fecha: CalendarDate;
  readonly descripcion: string;
  readonly lineas: readonly LineaResumida[];
  readonly totalDebe: Money;
  readonly totalHaber: Money;
  /** Los asientos del detalle. El hilo hacia atrás no se corta al resumir. */
  readonly asientosResumidos: readonly string[];
  readonly subdiario: SubdiarioDeclarado;
}

export type MotivoRechazoResumen =
  | 'SUBDIARIO_NO_DECLARADO'
  | 'SUBDIARIO_NO_CUBRE_EL_PERIODO'
  | 'PERIODO_MAYOR_A_UN_MES';

export interface RechazoResumen {
  readonly motivo: MotivoRechazoResumen;
  readonly journalCode: JournalCode;
  readonly detalle: string;
  readonly fundamento: string;
}

const ART_327 =
  'CCyC art. 327 — los resúmenes no pueden cubrir más de un mes y deben surgir de anotaciones detalladas practicadas en subdiarios';

/**
 * Arma los asientos resumidos de un conjunto de asientos del Diario.
 *
 * Devuelve `err` con **todos** los motivos, no con el primero: quien está por
 * cerrar el mes necesita saber de una vez qué subdiarios le faltan declarar, no
 * descubrirlos de a uno.
 *
 * Los asientos que no se pueden resumir no se pierden ni se resumen igual: si
 * hay un rechazo, no hay resumen, y el Diario va detallado. Detallado siempre es
 * legal; resumido sin subdiario, no.
 */
export function resumirPorMes(
  asientos: readonly AsientoDelLibro[],
  subdiarios: readonly SubdiarioDeclarado[],
  moneda: Currency,
): Result<AsientoResumido[], RechazoResumen[]> {
  const porSubdiario = new Map(subdiarios.map((sub) => [sub.journalCode, sub]));
  const grupos = new Map<string, AsientoDelLibro[]>();

  for (const asiento of asientos) {
    const clave = `${asiento.journalCode}|${yearOf(asiento.entryDate)}|${monthOf(asiento.entryDate)}`;
    const grupo = grupos.get(clave);
    if (grupo === undefined) grupos.set(clave, [asiento]);
    else grupo.push(asiento);
  }

  const rechazos: RechazoResumen[] = [];
  const resumenes: AsientoResumido[] = [];

  for (const [clave, delGrupo] of grupos) {
    const primero = delGrupo[0];
    if (primero === undefined) continue;
    const journalCode = primero.journalCode;
    const anio = yearOf(primero.entryDate);
    const mes = monthOf(primero.entryDate);

    const subdiario = porSubdiario.get(journalCode);
    if (subdiario === undefined) {
      rechazos.push({
        motivo: 'SUBDIARIO_NO_DECLARADO',
        journalCode,
        detalle: `No hay subdiario declarado para ${journalCode}. Un resumen sin registro detallado atrás no cumple el art. 327: registrá el Diario en detalle o declará el subdiario.`,
        fundamento: ART_327,
      });
      continue;
    }

    const fechas = delGrupo.map((asiento) => asiento.entryDate).sort();
    const primera = fechas[0];
    const ultima = fechas.at(-1);
    if (primera === undefined || ultima === undefined) continue;

    if (yearOf(primera) !== yearOf(ultima) || monthOf(primera) !== monthOf(ultima)) {
      // No debería poder pasar: la clave del grupo ya es (libro, año, mes). Si
      // pasa, la agrupación está rota y resumir sería tapar el problema.
      rechazos.push({
        motivo: 'PERIODO_MAYOR_A_UN_MES',
        journalCode,
        detalle: `El grupo ${clave} abarca de ${primera} a ${ultima}, más de un mes calendario`,
        fundamento: ART_327,
      });
      continue;
    }

    if (subdiario.desde > primera || subdiario.hasta < ultima) {
      rechazos.push({
        motivo: 'SUBDIARIO_NO_CUBRE_EL_PERIODO',
        journalCode,
        detalle: `El subdiario ${subdiario.nombre} cubre ${subdiario.desde} a ${subdiario.hasta}, y el resumen abarca ${primera} a ${ultima}. El tramo descubierto no tiene detalle que lo respalde.`,
        fundamento: ART_327,
      });
      continue;
    }

    resumenes.push(condensar(delGrupo, journalCode, anio, mes, ultima, subdiario, moneda));
  }

  if (rechazos.length > 0) return err(rechazos);

  resumenes.sort((a, b) => {
    if (a.anio !== b.anio) return a.anio - b.anio;
    if (a.mes !== b.mes) return a.mes - b.mes;
    return a.journalCode < b.journalCode ? -1 : a.journalCode > b.journalCode ? 1 : 0;
  });

  return ok(resumenes);
}

function condensar(
  asientos: readonly AsientoDelLibro[],
  journalCode: JournalCode,
  anio: number,
  mes: number,
  fecha: CalendarDate,
  subdiario: SubdiarioDeclarado,
  moneda: Currency,
): AsientoResumido {
  const porCuenta = new Map<
    string,
    { code: string; name: string; debe: Money; haber: Money; operaciones: Set<string> }
  >();

  for (const asiento of asientos) {
    for (const linea of asiento.lines) {
      let acumulado = porCuenta.get(linea.accountId);
      if (acumulado === undefined) {
        acumulado = {
          code: linea.accountCode,
          name: linea.accountName,
          debe: zero(moneda),
          haber: zero(moneda),
          operaciones: new Set(),
        };
        porCuenta.set(linea.accountId, acumulado);
      }
      acumulado.debe = add(acumulado.debe, linea.debit);
      acumulado.haber = add(acumulado.haber, linea.credit);
      acumulado.operaciones.add(asiento.id);
    }
  }

  const lineas: LineaResumida[] = [...porCuenta.entries()]
    .map(([accountId, acumulado]) => ({
      accountId,
      accountCode: acumulado.code,
      accountName: acumulado.name,
      debe: acumulado.debe,
      haber: acumulado.haber,
      operaciones: acumulado.operaciones.size,
    }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    journalCode,
    anio,
    mes,
    fecha,
    descripcion: `Resumen mensual ${journalCode} ${String(anio)}-${String(mes).padStart(2, '0')} · ${asientos.length} operaciones · subdiario ${subdiario.nombre} (${subdiario.referencia})`,
    lineas,
    totalDebe: lineas.reduce((acc, linea) => add(acc, linea.debe), zero(moneda)),
    totalHaber: lineas.reduce((acc, linea) => add(acc, linea.haber), zero(moneda)),
    asientosResumidos: asientos.map((asiento) => asiento.id),
    subdiario,
  };
}

/**
 * El resumen suma exactamente lo mismo que el detalle.
 *
 * Es cierto por construcción, y por eso mismo se verifica: el día que alguien
 * cambie `condensar` para excluir algo —anulados, cuentas de orden, lo que
 * sea— este control se cae antes de que el resumen llegue a un libro.
 */
export function resumenCoincideConDetalle(
  resumen: AsientoResumido,
  detalle: readonly AsientoDelLibro[],
): boolean {
  const incluidos = new Set(resumen.asientosResumidos);
  let debe = 0n;
  let haber = 0n;
  for (const asiento of detalle) {
    if (!incluidos.has(asiento.id)) continue;
    for (const linea of asiento.lines) {
      debe += linea.debit.amount;
      haber += linea.credit.amount;
    }
  }
  return debe === resumen.totalDebe.amount && haber === resumen.totalHaber.amount;
}
