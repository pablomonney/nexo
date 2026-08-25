/**
 * Sistema de confianza y disparadores duros (§13, AI_ARCHITECTURE.md §5).
 *
 * La idea central, y la que más cuesta sostener cuando alguien pide "que
 * apruebe solo lo obvio": **la confianza que declara el modelo es una señal
 * entre varias, no la decisión.**
 *
 * Los disparadores duros no se le preguntan al modelo. Se calculan de hechos:
 * qué dijo ARCA, si el proveedor es nuevo, si el importe se sale del historial,
 * si el período está por cerrar. Un modelo seguro de sí mismo sobre una factura
 * de un proveedor que apareció ayer sigue siendo un caso para una persona.
 *
 * Y algo que no es un detalle: **🟢 ALTA no significa "se contabiliza".**
 * Significa "se propone en lote para que un profesional lo apruebe". No existe
 * en este archivo, ni en ningún otro, un camino de una propuesta a un asiento
 * sin aprobación humana.
 */

import type { ConfidenceBand, HardBlockReason, Triage } from './contracts.js';
import type { ContextoClasificacion, CuentaDelPlan } from './contexto.js';

export interface EntradaTriage {
  readonly contexto: ContextoClasificacion;
  readonly cuentaElegida: CuentaDelPlan | null;
  readonly confianzaModelo: number;
}

export function evaluarTriage(entrada: EntradaTriage): Triage {
  const { contexto, cuentaElegida, confianzaModelo } = entrada;
  const { hechos, politica } = contexto;
  const bloqueos: HardBlockReason[] = [];

  if (hechos.estadoNormativo === 'FUENTE_NO_ENCONTRADA') bloqueos.push('FUENTE_NO_ENCONTRADA');
  if (hechos.estadoNormativo === 'CONFLICTO_NORMATIVO') bloqueos.push('CONFLICTO_NORMATIVO');
  if (hechos.estadoNormativo === 'NO_CONSULTADO') bloqueos.push('MOTOR_NORMATIVO_NO_DISPONIBLE');

  if (!hechos.proveedorConocido) bloqueos.push('PROVEEDOR_NUEVO');
  if (hechos.proveedorApocrifo === true) bloqueos.push('PROVEEDOR_APOCRIFO');

  // `FAIL` y `NO_VERIFICABLE` bloquean los dos. Colapsar "ARCA dijo que no" con
  // "no pude preguntarle a ARCA" convierte una caída del organismo en
  // comprobantes aprobados en silencio (R-14).
  if (hechos.selloFiscal === 'FAIL' || hechos.selloFiscal === 'NO_VERIFICABLE') {
    bloqueos.push('CONSTATACION_FISCAL_FALLIDA');
  }

  if (hechos.monedaExtranjeraSinCotizacion) bloqueos.push('FX_SIN_FUENTE');
  if (hechos.periodoProximoACierre) bloqueos.push('PERIODO_PROXIMO_A_CIERRE');
  if (cuentaElegida !== null && !cuentaElegida.usadaAntes) bloqueos.push('CUENTA_NUNCA_USADA');

  if (esImporteAtipico(hechos.totalMenor, hechos.historicoImportes)) {
    bloqueos.push('IMPORTE_ATIPICO');
  }

  return { band: banda(confianzaModelo, bloqueos, politica), hardBlocks: bloqueos };
}

function banda(
  confianza: number,
  bloqueos: readonly HardBlockReason[],
  politica: { autoThreshold: number; reviewThreshold: number },
): ConfidenceBand {
  if (bloqueos.length > 0) return 'BAJA';
  if (confianza >= politica.autoThreshold) return 'ALTA';
  if (confianza >= politica.reviewThreshold) return 'MEDIA';
  return 'BAJA';
}

// ---------------------------------------------------------------------------
// Detección de importes atípicos
// ---------------------------------------------------------------------------

/** Mínimo de observaciones para que el historial signifique algo. */
export const MUESTRAS_MINIMAS = 8;

/**
 * Cuántas desviaciones absolutas medianas se toleran.
 *
 * Alto a propósito. Este disparador manda el comprobante a revisión humana, y un
 * umbral sensible haría que la mitad de las facturas de un proveedor con
 * importes variables terminen en la bandeja — que es la forma de que el contador
 * deje de mirar la bandeja.
 */
export const K_DESVIACIONES = 6n;

/**
 * ¿El importe se sale del historial de esa contraparte?
 *
 * Mediana y desviación absoluta mediana, no media y desvío estándar: la MAD no
 * se deja arrastrar por un único valor extremo, y en contabilidad los valores
 * extremos son justamente lo que se busca detectar. Si la media se corriera con
 * el outlier, el outlier dejaría de parecer uno.
 *
 * Todo el cálculo es con `bigint`. Un estadístico sobre importes tampoco puede
 * pasar por punto flotante.
 */
export function esImporteAtipico(
  totalMenor: string | null,
  historico: readonly string[],
): boolean {
  if (totalMenor === null) return false;
  if (historico.length < MUESTRAS_MINIMAS) return false;

  let importe: bigint;
  let muestras: bigint[];
  try {
    importe = abs(BigInt(totalMenor));
    muestras = historico.map((valor) => abs(BigInt(valor)));
  } catch {
    return false;
  }

  const mediana = medianaDe(muestras);
  const desviaciones = muestras.map((valor) => abs(valor - mediana)).sort(comparar);
  const mad = medianaDe(desviaciones);
  const distancia = abs(importe - mediana);

  if (mad === 0n) {
    // Todos los importes históricos son iguales —un abono fijo—. Ahí cualquier
    // desvío es información, pero se exige que sea grande para no marcar un
    // ajuste de centavos.
    return distancia * 2n > mediana;
  }

  return distancia > K_DESVIACIONES * mad;
}

function medianaDe(valores: readonly bigint[]): bigint {
  const ordenados = [...valores].sort(comparar);
  const medio = Math.floor(ordenados.length / 2);
  if (ordenados.length % 2 === 1) return ordenados[medio]!;
  // Promedio entero de los dos centrales: división entera, sin flotante. El
  // sesgo de medio centavo es irrelevante para un umbral de detección.
  return (ordenados[medio - 1]! + ordenados[medio]!) / 2n;
}

function comparar(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function abs(valor: bigint): bigint {
  return valor < 0n ? -valor : valor;
}

/** Texto para el contador. La UI no muestra el código del disparador a secas. */
export const EXPLICACION_BLOQUEO: Record<HardBlockReason, string> = {
  FUENTE_NO_ENCONTRADA: 'No hay norma relevada para este caso.',
  CONFLICTO_NORMATIVO: 'Hay más de una norma aplicable sin derogación declarada.',
  MOTOR_NORMATIVO_NO_DISPONIBLE:
    'No se consultó al motor normativo para este caso: falta el marco contable registrado del ' +
    'ente, o el ejercicio que contiene la fecha. Sin eje temporal toda resolución es una suposición.',
  CITA_NO_RESOLUBLE: 'La propuesta citó una norma que no está en el archivo del sistema.',
  PROVEEDOR_NUEVO: 'Es la primera operación registrada con este proveedor.',
  PROVEEDOR_APOCRIFO: 'El emisor figura en la base de facturas apócrifas.',
  CONSTATACION_FISCAL_FALLIDA: 'El comprobante no pudo constatarse en ARCA, o ARCA lo rechazó.',
  IMPORTE_ATIPICO: 'El importe se aparta del historial de operaciones con este proveedor.',
  CUENTA_NUNCA_USADA: 'La empresa nunca imputó a esta cuenta.',
  PERIODO_PROXIMO_A_CIERRE: 'El período está por cerrarse.',
  FX_SIN_FUENTE: 'Hay moneda extranjera sin cotización de fuente declarada.',
};
