/**
 * Subdiarios de IVA Compras y IVA Ventas.
 *
 * Un subdiario de IVA es dos cosas a la vez, y el sistema tiene que servir a las
 * dos:
 *
 * 1. El **registro fiscal** del que sale la declaración jurada del período.
 * 2. El **libro auxiliar contable** del que el art. 327 del CCyC permite que
 *    surja un asiento resumido en el Diario.
 *
 * Por eso `comoSubdiarioDeclarado()` existe: devuelve exactamente la estructura
 * que `resumirPorMes` del motor contable exige para aceptar un resumen mensual.
 * Sin ese puente, el estudio llevaría el subdiario de IVA por un lado y
 * declararía "hay un subdiario" por otro, que es la clase de afirmación que el
 * art. 327 pide poder verificar.
 *
 * Las notas de crédito **restan**. No se llevan a una columna aparte ni se
 * guardan con signo positivo para "mostrarlas mejor": el neto del período es lo
 * que se declara, y una nota de crédito que no resta lo infla.
 */

import type { CalendarDate, Currency, Money } from '@aai/shared';
import { add, money, subtract, zero } from '@aai/shared';
import type {
  AlicuotaRelevada,
  ClaseComprobante,
  ComprobanteIva,
  DireccionIva,
  HallazgoIva,
  SignoOperacion,
} from './contracts.js';
import { identificarAlicuota } from './alicuotas.js';

/**
 * Qué signo tiene un comprobante en el período.
 *
 * **No hay una lista de códigos en este archivo, a propósito.** Los tipos de
 * comprobante son una tabla que ARCA publica por WebService
 * (`FEParamGetTiposCbte`) con `FchDesde` y `FchHasta` por entrada — el hallazgo
 * de la FASE 3b. Escribir acá "las notas de crédito son la 3, la 8 y la 13"
 * sería cablear una tabla versionada en el tiempo, y además dejar afuera todos
 * los códigos que el manual archivado no describe.
 *
 * La clase llega resuelta desde `arca_comprobante_types`, consultada por fecha.
 * Cuando no se pudo resolver, el signo es `null`: el motor **no supone que suma**.
 * Suponerlo infla el período justo en el caso en que el código desconocido era
 * una nota de crédito.
 */
export function signoDe(clase: ClaseComprobante | null): SignoOperacion | null {
  if (clase === null) return null;
  return clase === 'NOTA_CREDITO' ? -1n : 1n;
}

export interface RenglonSubdiario {
  readonly comprobanteId: string;
  readonly fecha: CalendarDate;
  readonly tipoComprobante: number;
  readonly puntoVenta: number;
  readonly numero: number;
  readonly cuitContraparte: string | null;
  readonly razonSocialContraparte: string | null;
  readonly condicionContraparte: string;
  /** Ya con signo: una nota de crédito llega en negativo. */
  readonly neto: Money;
  readonly iva: Money;
  readonly noGravado: Money;
  readonly exento: Money;
  readonly percepciones: Money;
  readonly total: Money;
  readonly alicuotaId: string | null;
  readonly entryId: string | null;
  readonly documentId: string | null;
  readonly hallazgos: readonly HallazgoIva[];
}

export interface TotalPorAlicuota {
  readonly alicuotaId: string | null;
  readonly etiqueta: string;
  readonly neto: Money;
  readonly iva: Money;
}

export interface Subdiario {
  readonly companyId: string;
  readonly direccion: DireccionIva;
  readonly anio: number;
  readonly mes: number;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly moneda: Currency;
  readonly renglones: readonly RenglonSubdiario[];
  readonly porAlicuota: readonly TotalPorAlicuota[];
  readonly totalNeto: Money;
  readonly totalIva: Money;
  readonly totalNoGravado: Money;
  readonly totalExento: Money;
  readonly totalPercepciones: Money;
  readonly total: Money;
  /** Comprobantes con hallazgos bloqueantes. No entran al total. */
  readonly excluidos: readonly { readonly comprobanteId: string; readonly motivo: string }[];
}

export interface OpcionesSubdiario {
  readonly companyId: string;
  readonly direccion: DireccionIva;
  readonly anio: number;
  readonly mes: number;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly moneda: Currency;
  readonly catalogo: readonly AlicuotaRelevada[];
}

export function construirSubdiario(
  comprobantes: readonly ComprobanteIva[],
  opciones: OpcionesSubdiario,
): Subdiario {
  const { moneda } = opciones;
  const renglones: RenglonSubdiario[] = [];
  const excluidos: { comprobanteId: string; motivo: string }[] = [];

  for (const comprobante of comprobantes) {
    if (comprobante.direccion !== opciones.direccion) continue;
    if (comprobante.fecha < opciones.desde || comprobante.fecha > opciones.hasta) continue;

    const signo = signoDe(comprobante.clase);
    const hallazgos: HallazgoIva[] = [];

    if (signo === null) {
      hallazgos.push({
        codigo: 'TIPO_COMPROBANTE_DESCONOCIDO',
        mensaje: `El tipo de comprobante ${comprobante.tipoComprobante} no está en el catálogo vigente a la fecha ${comprobante.fecha}. Sin saber su clase no se sabe si suma o resta, y suponer que suma infla el período. Sincronizá el catálogo desde ARCA.`,
        bloquea: true,
      });
    }
    const signoEfectivo: SignoOperacion = signo ?? 1n;
    let neto = zero(moneda);
    let iva = zero(moneda);
    let noGravado = zero(moneda);
    let exento = zero(moneda);
    let alicuotaId: string | null = null;

    for (const renglon of comprobante.renglones) {
      neto = acumular(neto, renglon.neto, signoEfectivo);
      iva = acumular(iva, renglon.iva, signoEfectivo);
      noGravado = acumular(noGravado, renglon.noGravado, signoEfectivo);
      exento = acumular(exento, renglon.exento, signoEfectivo);

      if (renglon.alicuotaId !== null) {
        alicuotaId ??= renglon.alicuotaId;
        continue;
      }
      if (renglon.neto.amount === 0n && renglon.iva.amount === 0n) continue;

      const identificada = identificarAlicuota(
        renglon.neto,
        renglon.iva,
        opciones.catalogo,
        comprobante.fecha,
      );
      hallazgos.push(...identificada.hallazgos);
      if (identificada.alicuota !== null) alicuotaId ??= identificada.alicuota.id;
    }

    const bloqueante = hallazgos.find((hallazgo) => hallazgo.bloquea);
    if (bloqueante !== undefined) {
      // Se excluye del total pero NO se descarta: el renglón se devuelve igual,
      // con sus hallazgos. Un comprobante que desaparece del subdiario sin dejar
      // rastro es un comprobante que nadie va a ir a buscar.
      excluidos.push({ comprobanteId: comprobante.id, motivo: bloqueante.mensaje });
    }

    renglones.push({
      comprobanteId: comprobante.id,
      fecha: comprobante.fecha,
      tipoComprobante: comprobante.tipoComprobante,
      puntoVenta: comprobante.puntoVenta,
      numero: comprobante.numero,
      cuitContraparte: comprobante.cuitContraparte,
      razonSocialContraparte: comprobante.razonSocialContraparte,
      condicionContraparte: comprobante.condicionContraparte,
      neto,
      iva,
      noGravado,
      exento,
      percepciones: acumular(zero(moneda), comprobante.percepciones, signoEfectivo),
      total: acumular(zero(moneda), comprobante.total, signoEfectivo),
      alicuotaId,
      entryId: comprobante.entryId,
      documentId: comprobante.documentId,
      hallazgos,
    });
  }

  renglones.sort(porFechaYNumero);

  const bloqueados = new Set(excluidos.map((excluido) => excluido.comprobanteId));
  const computables = renglones.filter((renglon) => !bloqueados.has(renglon.comprobanteId));

  return {
    companyId: opciones.companyId,
    direccion: opciones.direccion,
    anio: opciones.anio,
    mes: opciones.mes,
    desde: opciones.desde,
    hasta: opciones.hasta,
    moneda,
    renglones,
    porAlicuota: totalizarPorAlicuota(computables, opciones.catalogo, moneda),
    totalNeto: sumar(computables, (renglon) => renglon.neto, moneda),
    totalIva: sumar(computables, (renglon) => renglon.iva, moneda),
    totalNoGravado: sumar(computables, (renglon) => renglon.noGravado, moneda),
    totalExento: sumar(computables, (renglon) => renglon.exento, moneda),
    totalPercepciones: sumar(computables, (renglon) => renglon.percepciones, moneda),
    total: sumar(computables, (renglon) => renglon.total, moneda),
    excluidos,
  };
}

/**
 * El puente con el art. 327 del CCyC.
 *
 * Devuelve la declaración de subdiario que el motor contable exige para aceptar
 * un asiento resumido mensual. La `referencia` incluye el hash del contenido:
 * decir "existe un subdiario" sin poder mostrar cuál no alcanza para el
 * artículo, que pide que el resumen *surja* de anotaciones detalladas.
 */
export function comoSubdiarioDeclarado(
  subdiario: Subdiario,
  hashDelContenido: string,
): {
  journalCode: 'COMPRAS' | 'VENTAS';
  nombre: string;
  desde: CalendarDate;
  hasta: CalendarDate;
  referencia: string;
} {
  return {
    journalCode: subdiario.direccion,
    nombre: `Subdiario de IVA ${subdiario.direccion === 'COMPRAS' ? 'Compras' : 'Ventas'} ${String(subdiario.anio)}-${String(subdiario.mes).padStart(2, '0')}`,
    desde: subdiario.desde,
    hasta: subdiario.hasta,
    referencia: `IVA-${subdiario.direccion}-${String(subdiario.anio)}-${String(subdiario.mes).padStart(2, '0')} sha256:${hashDelContenido}`,
  };
}

function acumular(acumulado: Money, valor: Money, signo: SignoOperacion): Money {
  return signo === 1n ? add(acumulado, valor) : subtract(acumulado, valor);
}

function sumar(
  renglones: readonly RenglonSubdiario[],
  campo: (renglon: RenglonSubdiario) => Money,
  moneda: Currency,
): Money {
  return renglones.reduce((acc, renglon) => add(acc, campo(renglon)), zero(moneda));
}

function porFechaYNumero(a: RenglonSubdiario, b: RenglonSubdiario): number {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  if (a.puntoVenta !== b.puntoVenta) return a.puntoVenta - b.puntoVenta;
  return a.numero - b.numero;
}

/**
 * Totales por alícuota — la fila que va a la declaración jurada.
 *
 * Los renglones sin alícuota identificada se agrupan bajo `null` con la etiqueta
 * `SIN IDENTIFICAR`, en vez de repartirse o de omitirse. Si esa fila tiene
 * importe, la declaración no está lista, y verlo es el punto.
 */
function totalizarPorAlicuota(
  renglones: readonly RenglonSubdiario[],
  catalogo: readonly AlicuotaRelevada[],
  moneda: Currency,
): TotalPorAlicuota[] {
  const acumulado = new Map<string, { neto: bigint; iva: bigint }>();

  for (const renglon of renglones) {
    const clave = renglon.alicuotaId ?? '';
    const previo = acumulado.get(clave) ?? { neto: 0n, iva: 0n };
    acumulado.set(clave, {
      neto: previo.neto + renglon.neto.amount,
      iva: previo.iva + renglon.iva.amount,
    });
  }

  return [...acumulado.entries()]
    .map(([clave, totales]) => ({
      alicuotaId: clave === '' ? null : clave,
      etiqueta:
        clave === ''
          ? 'SIN IDENTIFICAR'
          : (catalogo.find((alicuota) => alicuota.id === clave)?.etiqueta ?? clave),
      neto: money(totales.neto, moneda),
      iva: money(totales.iva, moneda),
    }))
    .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta));
}
