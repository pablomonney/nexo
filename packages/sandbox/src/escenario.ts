/**
 * El escenario de simulación y su corrida.
 *
 * ## Los mismos motores, no una copia
 *
 * La tentación al escribir un sandbox es darle su propia lógica: más simple, más
 * rápida, sin las validaciones que molestan durante una demostración. Un sandbox
 * así no prueba nada — muestra cómo se comportaría un sistema que no existe.
 *
 * Acá se importan `@aai/accounting-engine` y `@aai/tax-engine` tal cual los usa
 * la aplicación. Si el Diario rechaza un asiento en producción, lo rechaza acá
 * con el mismo mensaje y el mismo artículo citado. Si un día alguien afloja un
 * control, el escenario lo va a dejar pasar — y eso es exactamente lo que un
 * sandbox tiene que reflejar.
 *
 * ## Por qué `simular` pide una prueba de aislamiento y no un booleano
 *
 * La firma recibe un `Aislamiento` con `aislado: true`. Ese tipo no se puede
 * construir desde afuera de `aislamiento.ts`: sale de `verificarAislamiento` o no
 * sale. No hay forma de llamar a `simular` sin haber pasado por el candado, y no
 * porque alguien se acuerde de llamarlo primero.
 *
 * ## El sello viaja con el dato, no con la pantalla
 *
 * `SELLO_DE_SIMULACION` está en el resultado y en el resumen, no solamente en la
 * interfaz que lo muestra. Un resultado de simulación copiado a un mail, pegado
 * en un ticket o exportado a un CSV sigue diciendo qué es. La advertencia que
 * vive únicamente en el encabezado de la pantalla desaparece en el primer
 * copiar-y-pegar.
 */

import type { Currency } from '@aai/shared';
import type {
  AsientoDelLibro,
  BalanceDeSumasYSaldos,
  CuentaParaElMayor,
  LibroDiario,
  LibroMayor,
} from '@aai/accounting-engine';
import {
  balanceDesdeMayor,
  construirLibroDiario,
  construirLibroMayor,
} from '@aai/accounting-engine';
import type {
  AlicuotaRelevada,
  ComprobanteIva,
  EvaluacionCreditoFiscal,
} from '@aai/tax-engine';
import { evaluarCreditoFiscal } from '@aai/tax-engine';
import type { CalendarDate } from '@aai/shared';
import type { Aislamiento } from './aislamiento.js';

/**
 * Lo que acompaña a todo lo que sale de acá.
 *
 * Es el mismo texto que usa el ambiente mock de OCR y el de ARCA. Que sea uno
 * solo importa: dos redacciones distintas de la misma advertencia hacen que quien
 * lee la segunda dude de si significa lo mismo.
 */
export const SELLO_DE_SIMULACION = 'SIMULACIÓN — sin valor probatorio';

export interface EscenarioDeSimulacion {
  readonly nombre: string;
  readonly companyId: string;
  readonly fiscalYearId: string;
  readonly moneda: Currency;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
  readonly cuentas: readonly CuentaParaElMayor[];
  /**
   * Las alícuotas que el escenario declara.
   *
   * Puede venir vacío a propósito: probar qué hace el sistema **sin** catálogo es
   * uno de los casos que un contador querría ver antes de confiarle nada.
   */
  readonly alicuotas: readonly AlicuotaRelevada[];
  readonly comprobantes: readonly ComprobanteIva[];
  readonly asientos: readonly AsientoDelLibro[];
}

export type PasoDeSimulacion = 'IVA' | 'DIARIO' | 'MAYOR' | 'BALANCE';

export interface ResultadoDePaso {
  readonly paso: PasoDeSimulacion;
  readonly titulo: string;
  /**
   * `false` cuando el paso encontró algo, no cuando el simulador falló.
   *
   * Un escenario que termina con `ok: false` en Diario es un escenario que
   * funcionó: mostró que el control ve lo que tiene que ver.
   */
  readonly sinObservaciones: boolean;
  readonly observaciones: readonly string[];
}

export interface ResultadoDeSimulacion {
  readonly sello: string;
  readonly escenario: string;
  readonly base: string;
  readonly pasos: readonly ResultadoDePaso[];
  readonly creditos: readonly EvaluacionCreditoFiscal[];
  readonly diario: LibroDiario;
  readonly mayor: LibroMayor;
  readonly balance: BalanceDeSumasYSaldos;
  readonly resumen: string;
}

/** El aislamiento ya probado. No se puede fabricar sin `verificarAislamiento`. */
type AislamientoProbado = Extract<Aislamiento, { aislado: true }>;

export function simular(
  escenario: EscenarioDeSimulacion,
  aislamiento: AislamientoProbado,
): ResultadoDeSimulacion {
  const creditos = escenario.comprobantes.map((comprobante) =>
    evaluarCreditoFiscal(comprobante, escenario.alicuotas),
  );

  const diario = construirLibroDiario(escenario.asientos, {
    companyId: escenario.companyId,
    fiscalYearId: escenario.fiscalYearId,
    moneda: escenario.moneda,
    desde: escenario.desde,
    hasta: escenario.hasta,
  });

  const mayor = construirLibroMayor(escenario.asientos, {
    companyId: escenario.companyId,
    moneda: escenario.moneda,
    desde: escenario.desde,
    hasta: escenario.hasta,
    cuentas: escenario.cuentas,
  });

  const balance = balanceDesdeMayor(mayor);

  const pasos: ResultadoDePaso[] = [
    pasoDeIva(creditos),
    pasoDeDiario(diario),
    pasoDeMayor(diario, mayor),
    pasoDeBalance(balance),
  ];

  return {
    sello: SELLO_DE_SIMULACION,
    escenario: escenario.nombre,
    base: aislamiento.base,
    pasos,
    creditos,
    diario,
    mayor,
    balance,
    resumen: resumir(escenario, pasos, aislamiento.base),
  };
}

function pasoDeIva(creditos: readonly EvaluacionCreditoFiscal[]): ResultadoDePaso {
  const observaciones = creditos.flatMap((evaluacion) => [
    `${evaluacion.comprobanteId}: ${evaluacion.estado}`,
    ...evaluacion.hallazgos.map(
      (hallazgo) => `  ${hallazgo.bloquea ? '✘' : '·'} ${hallazgo.codigo} — ${hallazgo.mensaje}`,
    ),
  ]);

  return {
    paso: 'IVA',
    titulo: `${creditos.length} comprobante(s) evaluado(s)`,
    // Ningún comprobante llega a "sin observaciones" en sentido pleno: el estado
    // NO_DETERMINABLE es la salida normal y no es un problema. Lo que se mira es
    // si algo bloquea.
    sinObservaciones: creditos.every((e) => e.estado !== 'IMPEDIDO_POR_FORMA'),
    observaciones,
  };
}

function pasoDeDiario(diario: LibroDiario): ResultadoDePaso {
  const fallados = diario.controles.filter((control) => !control.cumple);

  return {
    paso: 'DIARIO',
    titulo: `${diario.asientos} asiento(s) en ${diario.folios.length} folio(s)`,
    sinObservaciones: diario.cumpleFormalidades && diario.excluidos.length === 0,
    observaciones: [
      ...fallados.map((control) => `✘ ${control.codigo} (${control.fundamento}): ${control.detalle}`),
      ...diario.excluidos.map((excluido) => `· excluido ${excluido.id}: ${excluido.motivo}`),
    ],
  };
}

/**
 * El Mayor es una proyección del Diario, y acá se comprueba que lo sea.
 *
 * Si los totales no coinciden, el problema no está en el Mayor: está en que dos
 * componentes que deberían leer el mismo universo están leyendo distinto. Es la
 * clase de discrepancia que en producción se descubre meses después, cuando el
 * balance no cierra y nadie sabe desde cuándo.
 */
function pasoDeMayor(diario: LibroDiario, mayor: LibroMayor): ResultadoDePaso {
  const observaciones: string[] = [];

  if (mayor.totalDebe.amount !== diario.totalDebe.amount) {
    observaciones.push(
      `✘ El Debe del Mayor (${mayor.totalDebe.amount}) no coincide con el del Diario (${diario.totalDebe.amount}).`,
    );
  }
  if (mayor.totalHaber.amount !== diario.totalHaber.amount) {
    observaciones.push(
      `✘ El Haber del Mayor (${mayor.totalHaber.amount}) no coincide con el del Diario (${diario.totalHaber.amount}).`,
    );
  }

  return {
    paso: 'MAYOR',
    titulo: `${mayor.cuentas.length} cuenta(s) con movimientos`,
    sinObservaciones: observaciones.length === 0,
    observaciones,
  };
}

function pasoDeBalance(balance: BalanceDeSumasYSaldos): ResultadoDePaso {
  return {
    paso: 'BALANCE',
    titulo: balance.cuadra ? 'Cuadra' : 'NO cuadra — no habilita estados contables',
    sinObservaciones: balance.cuadra,
    observaciones: balance.verificaciones
      .filter((verificacion) => !verificacion.cumple)
      .map((verificacion) => `✘ ${verificacion.codigo}: ${verificacion.detalle}`),
  };
}

function resumir(
  escenario: EscenarioDeSimulacion,
  pasos: readonly ResultadoDePaso[],
  base: string,
): string {
  const conObservaciones = pasos.filter((paso) => !paso.sinObservaciones);
  const cabecera = `${SELLO_DE_SIMULACION} · escenario "${escenario.nombre}" sobre la base ${base}.`;

  if (escenario.alicuotas.length === 0) {
    return [
      cabecera,
      'El escenario corrió SIN alícuotas declaradas: es el caso que muestra qué hace el sistema',
      'cuando no hay catálogo relevado. No supone 21%.',
      ...conObservaciones.map((paso) => `${paso.paso}: ${paso.observaciones.length} observación(es).`),
    ].join('\n');
  }

  if (conObservaciones.length === 0) {
    return `${cabecera}\nLos cuatro pasos corrieron sin observaciones. Nada de esto es contabilidad: es una prueba.`;
  }

  return [
    cabecera,
    ...conObservaciones.map((paso) => `${paso.paso}: ${paso.observaciones.length} observación(es).`),
    'Un paso con observaciones no es una falla del simulador: es el control mostrando lo que ve.',
  ].join('\n');
}
