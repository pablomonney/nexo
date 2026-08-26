/**
 * bank-engine — conciliación bancaria.
 *
 * Este archivo solo DEFINE; `index.ts` solo reexporta.
 *
 * La conciliación es el lugar donde un sistema contable miente más fácil. El
 * modo de falla es siempre el mismo: proponer un match plausible, que el humano
 * lo apruebe sin mirar porque los otros cuarenta estaban bien, y que un pago a
 * un proveedor quede cancelando la factura de otro. Los saldos cierran igual.
 * Nadie se entera hasta que el proveedor reclama.
 *
 * De ahí las tres reglas duras del motor:
 *
 * 1. **El importe tiene que coincidir exacto.** No hay match "por poco". Una
 *    diferencia de importe no es un match con menos confianza: es una partida
 *    conciliatoria, que es otra cosa y se muestra en otro lado.
 * 2. **El empate no se resuelve.** Si dos líneas contables puntúan igual contra
 *    el mismo movimiento, el motor devuelve las dos y no elige. Elegir la
 *    primera por orden de fecha es una decisión arbitraria disfrazada de
 *    resultado.
 * 3. **Nada se confirma solo.** Ni el match perfecto. El criterio de la fase es
 *    "0 conciliaciones confirmadas sin intervención humana", y está en la base
 *    como constraint, no como costumbre.
 */

import type { CalendarDate, Money } from '@aai/shared';

/**
 * Hacia dónde se movió la plata, **siempre desde la caja de la empresa**.
 *
 * No se llaman `DEBITO` y `CREDITO` a propósito, y esta es la decisión que más
 * errores evita en todo el paquete.
 *
 * En el extracto, "débito" significa que salió plata de la cuenta: el banco
 * debita *su* deuda con la empresa. En el libro, un débito en la cuenta Banco
 * significa exactamente lo contrario — entró plata, aumentó el activo. Las dos
 * palabras son correctas y opuestas, y quien escribe el código tiene que
 * acordarse todo el tiempo de en qué óptica está parado.
 *
 * `ENTRADA` y `SALIDA` no tienen dos lecturas. El importador traduce las columnas
 * del banco a esta convención una sola vez, y de ahí en adelante comparar un
 * movimiento con una línea contable es comparar dos cosas que significan lo
 * mismo.
 */
export type SentidoBancario = 'ENTRADA' | 'SALIDA';

/**
 * Un movimiento del extracto bancario.
 *
 * `importe` es siempre **positivo**; el sentido va aparte. Guardarlo con signo
 * obligaría a fijar una convención —¿un débito es negativo desde la óptica del
 * banco o desde la de la empresa?— y esa convención se invierte según quién mire.
 */
export interface MovimientoBancario {
  readonly id: string;
  readonly fecha: CalendarDate;
  /** Fecha valor, cuando el banco la informa. Puede diferir de la de imputación. */
  readonly fechaValor: CalendarDate | null;
  readonly descripcion: string;
  readonly importe: Money;
  readonly sentido: SentidoBancario;
  /** Número de comprobante, cheque o referencia que el banco imprime. */
  readonly referencia: string | null;
  /** Saldo que el extracto declara después de este movimiento, si lo trae. */
  readonly saldoPosterior: Money | null;
  /** La fila original, tal como vino. Sin esto no se puede auditar la lectura. */
  readonly crudo: string;
}

/**
 * Una línea contable candidata a conciliar.
 *
 * Son las líneas del Mayor imputadas a la cuenta bancaria. Vienen del Diario:
 * el motor de conciliación no consulta nada.
 */
export interface LineaConciliable {
  readonly entryLineId: string;
  readonly entryId: string;
  readonly fecha: CalendarDate;
  readonly descripcion: string;
  readonly importe: Money;
  /** `ENTRADA` = débito en la cuenta Banco del libro. Entra plata. */
  readonly sentido: SentidoBancario;
  readonly referencia: string | null;
  readonly documentId: string | null;
  /** `true` si ya quedó conciliada en una conciliación anterior. */
  readonly yaConciliada: boolean;
}

export type TipoMatch = 'EXACTO' | 'APROXIMADO' | 'AGRUPADO' | 'MANUAL';

/**
 * Una propuesta de conciliación.
 *
 * `score` es un entero de 0 a 100. Entero, no decimal: un puntaje en punto
 * flotante que se compara con `>` para decidir un empate es una fuente de
 * resultados distintos entre corridas.
 */
export interface PropuestaMatch {
  readonly tipo: TipoMatch;
  readonly movimientoIds: readonly string[];
  readonly entryLineIds: readonly string[];
  readonly score: number;
  /** Qué sumó y qué no. Es lo que el contador lee antes de aprobar. */
  readonly senales: readonly SenalDeMatch[];
  readonly importe: Money;
}

export interface SenalDeMatch {
  readonly codigo: CodigoSenal;
  readonly aporte: number;
  readonly detalle: string;
}

export type CodigoSenal =
  | 'IMPORTE_EXACTO'
  | 'MISMA_FECHA'
  | 'FECHA_CERCANA'
  | 'FECHA_LEJANA'
  | 'REFERENCIA_COINCIDE'
  | 'REFERENCIA_AUSENTE'
  | 'DESCRIPCION_COINCIDE'
  | 'DESCRIPCION_DISTINTA'
  | 'AGRUPACION';

/**
 * Un movimiento cuyo match no se pudo decidir.
 *
 * No es un error: es la respuesta correcta cuando hay más de un candidato con el
 * mismo puntaje. El motor devuelve todos y la persona elige.
 */
export interface Ambiguedad {
  readonly movimientoId: string;
  readonly candidatos: readonly PropuestaMatch[];
  readonly motivo: string;
}

/**
 * Las partidas conciliatorias clásicas.
 *
 * La clasificación es **determinística por lado y sentido**: qué quedó sin
 * conciliar y de qué lado del libro estaba. No hay interpretación acá — lo que
 * cada partida *significa* (si es una comisión, un impuesto, un error) lo dice
 * el contador, y para eso está `explicacion`.
 */
export type TipoDiferencia =
  | 'EN_BANCO_NO_EN_LIBRO'
  | 'EN_LIBRO_NO_EN_BANCO'
  | 'SALDO_INICIAL_NO_COINCIDE'
  | 'SALDO_FINAL_NO_COINCIDE';

export interface DiferenciaConciliacion {
  readonly tipo: TipoDiferencia;
  readonly movimientoId: string | null;
  readonly entryLineId: string | null;
  readonly importe: Money;
  readonly sentido: SentidoBancario;
  readonly fecha: CalendarDate | null;
  readonly descripcion: string;
  /**
   * Qué suele ser una partida así. **Es una pista, no una imputación.**
   *
   * El motor no clasifica una comisión bancaria como comisión: no tiene cómo
   * saberlo, y si lo dijera alguien lo tomaría por bueno. Dice de qué lado
   * quedó y sugiere dónde mirar.
   */
  readonly dondeMirar: string;
}

export interface ActaDeConciliacion {
  readonly bankAccountId: string;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly saldoSegunExtracto: Money;
  readonly saldoSegunLibro: Money;
  readonly conciliados: readonly PropuestaMatch[];
  readonly ambiguos: readonly Ambiguedad[];
  readonly diferencias: readonly DiferenciaConciliacion[];
  /** Suma de las partidas conciliatorias, con signo respecto del extracto. */
  readonly ajusteNeto: Money;
  /** `saldoSegunExtracto + ajusteNeto`. Debe dar `saldoSegunLibro`. */
  readonly saldoConciliado: Money;
  readonly cierra: boolean;
  readonly explicacion: string;
  /** Cuántos movimientos se propusieron sobre el total. El 80% del criterio. */
  readonly cobertura: Cobertura;
}

export interface Cobertura {
  readonly movimientos: number;
  readonly propuestos: number;
  readonly ambiguos: number;
  readonly sinCandidato: number;
  /** Porcentaje entero. Nunca un decimal: es un indicador, no una medición. */
  readonly porcentaje: number;
}
