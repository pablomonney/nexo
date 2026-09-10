/**
 * Comparar el origen contra NEXO, y mostrar la diferencia.
 *
 * ## Para qué sirve de verdad
 *
 * Una importación puede terminar sin un solo error y haber traído la mitad de
 * los clientes, porque la otra mitad se descartó por duplicada. Los contadores
 * de la importación no lo dicen; la reconciliación sí.
 *
 * La pregunta que contesta es una sola: **¿lo que había allá está acá?**
 *
 * ## La diferencia no se esconde
 *
 * Cuando no cierra, se informa con las dos cifras y el signo. No se ajusta, no
 * se redondea y no se explica sola. El §13 lo dice para la contabilidad y vale
 * para todo: una migración que hace cuadrar las cuentas por su cuenta es una
 * migración en la que no se puede confiar.
 */

import type { Entidad } from './canonico.js';

export interface Conteo {
  readonly entidad: Entidad;
  /** Cuántos registros traía el origen, después de leerlo. */
  readonly enOrigen: number;
  /** Cuántos entraron a NEXO como filas nuevas. */
  readonly importados: number;
  /** Cuántos ya existían y se reconocieron como el mismo. */
  readonly yaEstaban: number;
  /** Cuántos no se pudieron importar. */
  readonly rechazados: number;
}

export interface DiferenciaDeConteo extends Conteo {
  /** `enOrigen - (importados + yaEstaban + rechazados)`. Cero es lo esperado. */
  readonly sinExplicar: number;
  readonly cuadra: boolean;
}

/**
 * Todo registro del origen tiene que haber terminado en alguna parte.
 *
 * Importado, reconocido como existente, o rechazado. Un registro que no está en
 * ninguna de las tres se perdió en el camino, y esa es la falla más silenciosa
 * que puede tener una migración: nada falla, y faltan datos.
 */
export function reconciliarConteos(conteos: readonly Conteo[]): readonly DiferenciaDeConteo[] {
  return conteos.map((c) => {
    const sinExplicar = c.enOrigen - (c.importados + c.yaEstaban + c.rechazados);
    return { ...c, sinExplicar, cuadra: sinExplicar === 0 };
  });
}

export interface SaldoComparado {
  readonly concepto: string;
  /** En unidades mínimas: centavos para importes, unidades para cantidades. */
  readonly enOrigen: bigint;
  readonly enNexo: bigint;
}

export interface DiferenciaDeSaldo extends SaldoComparado {
  readonly diferencia: bigint;
  readonly cuadra: boolean;
}

export function reconciliarSaldos(
  saldos: readonly SaldoComparado[],
): readonly DiferenciaDeSaldo[] {
  return saldos.map((s) => {
    const diferencia = s.enNexo - s.enOrigen;
    return { ...s, diferencia, cuadra: diferencia === 0n };
  });
}

export interface Reconciliacion {
  readonly conteos: readonly DiferenciaDeConteo[];
  readonly saldos: readonly DiferenciaDeSaldo[];
  /** Verdadero solo si cierra todo: un solo renglón abierto lo pone en falso. */
  readonly cierra: boolean;
}

export function reconciliar(
  conteos: readonly Conteo[],
  saldos: readonly SaldoComparado[],
): Reconciliacion {
  const c = reconciliarConteos(conteos);
  const s = reconciliarSaldos(saldos);
  return { conteos: c, saldos: s, cierra: c.every((x) => x.cuadra) && s.every((x) => x.cuadra) };
}

/**
 * La identidad con la que un registro importado se reconoce después.
 *
 * Es la clave de la idempotencia (§21): la misma fuente procesada dos veces
 * produce las mismas identidades, y la segunda vez no entra nada. Se arma con
 * tres partes y no con el hash de la fila entera **a propósito** — si el
 * sistema de origen corrige el teléfono de un cliente, sigue siendo el mismo
 * cliente, y con el hash sería uno nuevo.
 */
export function identidadExterna(
  sistema: string,
  entidad: Entidad,
  idExterno: string,
): string {
  return `${sistema}:${entidad}:${idExterno}`;
}
