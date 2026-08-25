/**
 * Aprendizaje por empresa (§14) — y su límite.
 *
 * Qué aprende: la correlación `(proveedor | concepto) → cuenta`, a partir de
 * decisiones **aprobadas** por el contador.
 *
 * Qué no puede tocar, y no por una regla sino porque no existe el código que lo
 * haga: `accounting_rules`, `tax_rules`, `norm_versions`. El aprendizaje mueve
 * la **sugerencia** y la **confianza**; la norma es inmune.
 *
 * Si cien veces el contador clasificó mal, el sistema va a aprender a sugerir
 * mal. Nunca va a decir que la norma dice otra cosa. La diferencia importa: lo
 * primero es un error del estudio que se corrige revisando; lo segundo sería el
 * sistema fabricando derecho.
 *
 * El aprendizaje es **por empresa**. No se comparte entre clientes del estudio:
 * la contabilidad de cada uno es secreto profesional.
 *
 * ## Una preferencia no es un argumento
 *
 * Una sugerencia que sale de acá no tiene fundamento normativo — tiene
 * frecuencia. Por eso nunca llega a 🟢: la Validation Layer la marca `SIN_CITAS`
 * y la acota a revisión individual. "Lo hiciste 50 veces" explica por qué se
 * sugiere, no por qué corresponde.
 */

import type { HechosDelComprobante, PreferenciaAprendida } from './contexto.js';

// ---------------------------------------------------------------------------
// Señal
// ---------------------------------------------------------------------------

/**
 * Clave con la que se acumula el aprendizaje.
 *
 * El CUIT gana sobre el concepto cuando está: es estable, no depende de cómo el
 * proveedor redacte el detalle este mes. El concepto es el recurso cuando no hay
 * emisor identificado —tickets, gastos menores—.
 */
export function signalDe(hechos: HechosDelComprobante): string | null {
  if (hechos.cuitEmisor !== null && hechos.cuitEmisor.length > 0) {
    return `proveedor:${hechos.cuitEmisor}`;
  }
  if (hechos.descripcion !== null && hechos.descripcion.trim().length > 0) {
    const normalizado = normalizar(hechos.descripcion);
    if (normalizado.length > 0) return `concepto:${normalizado}`;
  }
  return null;
}

/** Palabras sin contenido discriminante: agrupan señales que no son la misma. */
const VACIAS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'a', 'en', 'por', 'para', 'con',
  'servicio', 'servicios', 'factura', 'comprobante', 'sa', 'srl', 'mes',
]);

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((palabra) => palabra.length > 2 && !VACIAS.has(palabra))
    // Seis palabras alcanzan para distinguir un concepto y evitan que un número
    // de período convierta cada factura del mismo servicio en una señal nueva.
    .slice(0, 6)
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Sugerencia determinística
// ---------------------------------------------------------------------------

export interface SugerenciaPorPreferencia {
  readonly cuentaId: string;
  readonly cuentaCodigo: string;
  readonly confianza: number;
  readonly razon: string;
  readonly signal: string;
}

/** Confirmaciones a partir de las cuales la preferencia deja de crecer. */
export const CONFIRMACIONES_PARA_TECHO = 8;

/**
 * Techo de una preferencia.
 *
 * Deliberadamente por debajo del `autoThreshold` por defecto (0.9): una
 * correlación estadística sobre la propia historia de la empresa es una buena
 * pista y no es una fundamentación. Subirlo es una decisión de política por
 * empresa, tomada por una persona, no un valor por defecto (§52).
 */
export const TECHO_PREFERENCIA = 0.85;

/** Meses después de los cuales una preferencia empieza a perder peso. */
export const MESES_FRESCURA = 18;

/**
 * Sugiere a partir de lo que la empresa ya aprobó, sin consultar ningún modelo.
 *
 * Es lo que hace que el modo sin IA externa (§8) sea útil y no solo vacío: un
 * estudio que no quiere mandar los documentos de sus clientes a un tercero sigue
 * teniendo sugerencias, construidas exclusivamente con su propia historia.
 */
export function sugerirPorPreferencia(
  hechos: HechosDelComprobante,
  preferencias: readonly PreferenciaAprendida[],
  ahora: Date = new Date(),
): SugerenciaPorPreferencia | null {
  const signal = signalDe(hechos);
  if (signal === null) return null;

  // Una señal puede tener varias cuentas candidatas —el contador cambió de
  // criterio, o hay dos usos legítimos del mismo proveedor—. Gana la más
  // confirmada. Elegir acá y no depender del orden en que llegan las filas evita
  // que la sugerencia dependa de un `ORDER BY` en un handler.
  const preferencia = preferencias
    .filter((candidata) => candidata.signal === signal && candidata.vecesConfirmada >= 1)
    .sort((a, b) => b.vecesConfirmada - a.vecesConfirmada)[0];
  if (preferencia === undefined) return null;

  const base =
    0.5 + 0.05 * Math.min(preferencia.vecesConfirmada, CONFIRMACIONES_PARA_TECHO);
  const confianza = Math.min(base * frescura(preferencia.ultimaConfirmacion, ahora), TECHO_PREFERENCIA);

  return {
    cuentaId: preferencia.cuentaId,
    cuentaCodigo: preferencia.cuentaCodigo,
    confianza: Math.round(confianza * 10_000) / 10_000,
    razon:
      `Esta empresa imputó a ${preferencia.cuentaCodigo} en ${preferencia.vecesConfirmada} ` +
      `oportunidad(es) anteriores para la misma señal (${signal}). Es una correlación con el ` +
      'historial, no un fundamento normativo.',
    signal,
  };
}

/**
 * Factor de frescura.
 *
 * Una preferencia de hace tres años puede reflejar un plan de cuentas que ya se
 * reestructuró. No se descarta —sigue siendo información— pero pesa menos.
 */
function frescura(ultimaConfirmacion: string | null, ahora: Date): number {
  if (ultimaConfirmacion === null) return 1;
  const desde = Date.parse(ultimaConfirmacion);
  if (!Number.isFinite(desde)) return 1;

  const meses = (ahora.getTime() - desde) / (1000 * 60 * 60 * 24 * 30.44);
  if (meses <= MESES_FRESCURA) return 1;
  // Decaimiento suave, con piso: nunca borra la preferencia, solo la relativiza.
  return Math.max(0.6, 1 - (meses - MESES_FRESCURA) / 60);
}

// ---------------------------------------------------------------------------
// Actualización tras la revisión humana
// ---------------------------------------------------------------------------

export type DecisionRevision = 'APROBADA' | 'MODIFICADA' | 'RECHAZADA';

/**
 * Cambio a aplicar sobre `classification_preferences`.
 *
 * Nótese el tipo de retorno: `signal`, `cuentaId` y un delta. No hay forma de
 * que de acá salga una regla, una norma o un asiento — no porque esté prohibido,
 * sino porque este es el único tipo que la función puede devolver.
 */
export interface CambioPreferencia {
  readonly signal: string;
  readonly cuentaId: string;
  readonly delta: number;
  readonly confirmar: boolean;
}

export interface EntradaRevision {
  readonly hechos: HechosDelComprobante;
  readonly decision: DecisionRevision;
  /** Cuenta que había propuesto el sistema. */
  readonly cuentaPropuestaId: string;
  /** Cuenta que dejó el contador, cuando modificó. */
  readonly cuentaFinalId?: string;
}

export function cambiosPorRevision(entrada: EntradaRevision): readonly CambioPreferencia[] {
  const signal = signalDe(entrada.hechos);
  if (signal === null) return [];

  if (entrada.decision === 'APROBADA') {
    return [{ signal, cuentaId: entrada.cuentaPropuestaId, delta: 1, confirmar: true }];
  }

  if (entrada.decision === 'RECHAZADA') {
    // Se resta, no se borra. Que el contador haya rechazado una vez no invalida
    // veinte aprobaciones anteriores; que rechace veinte veces, sí.
    return [{ signal, cuentaId: entrada.cuentaPropuestaId, delta: -1, confirmar: false }];
  }

  const cambios: CambioPreferencia[] = [
    { signal, cuentaId: entrada.cuentaPropuestaId, delta: -1, confirmar: false },
  ];
  if (entrada.cuentaFinalId !== undefined && entrada.cuentaFinalId !== entrada.cuentaPropuestaId) {
    // La corrección del contador es la señal más valiosa que existe: es la
    // respuesta correcta, dicha por quien firma.
    cambios.push({ signal, cuentaId: entrada.cuentaFinalId, delta: 2, confirmar: true });
  }
  return cambios;
}
