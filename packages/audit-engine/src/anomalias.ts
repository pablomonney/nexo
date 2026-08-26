/**
 * Detección de anomalías sobre el Diario.
 *
 * Cuatro detectores, todos determinísticos, todos explicables ante un tercero.
 *
 * ## La regla que gobierna el archivo: una anomalía no es una acusación
 *
 * Cada hallazgo dice **qué se observó** y **qué habría que mirar**, nunca qué
 * significa. Un asiento cargado un domingo a las tres de la mañana es un hecho;
 * que sea un fraude, un ajuste de cierre o un contador con insomnio no lo decide
 * el software.
 *
 * La diferencia no es de tono. Un sistema que dice "posible fraude" produce dos
 * efectos y ninguno bueno: quien lo lee deja de mirar los que no marcó, y el
 * marcado queda con una etiqueta que nadie escribió a conciencia.
 *
 * ## Mediana y MAD, no media y desvío
 *
 * Igual que en FASE 4. La media se deja arrastrar por un único valor extremo — y
 * si el extremo es justamente la anomalía, la media se mueve hacia ella y deja de
 * detectarla. La mediana no se mueve.
 */

import type { CalendarDate, Money } from '@aai/shared';

/**
 * Un código por detector, ni uno más.
 *
 * La primera versión declaraba también `FUERA_DE_HORARIO` y
 * `SECUENCIA_DE_IMPORTES`, que sonaban bien y no tenían detector detrás. Un enum
 * con códigos que nadie emite hace creer que el sistema mira cosas que no mira —
 * y quien lee la lista deja de buscarlas por su cuenta.
 */
export type CodigoAnomalia =
  | 'IMPORTE_ATIPICO'
  | 'IMPORTE_REDONDO'
  | 'JUSTO_BAJO_UMBRAL'
  | 'ASIENTO_TARDIO';

export interface Anomalia {
  readonly codigo: CodigoAnomalia;
  readonly entryId: string;
  /** Qué se observó. Un hecho, verificable. */
  readonly observado: string;
  /** Qué habría que mirar. Una pregunta, no una conclusión. */
  readonly queMirar: string;
}

export interface AsientoParaAuditar {
  readonly entryId: string;
  readonly fecha: CalendarDate;
  /** Cuándo se cargó. Puede ser muy posterior a la fecha contable. */
  readonly cargadoEl: string;
  readonly importe: Money;
  readonly cuentaCodigo: string;
  readonly contraparteId: string | null;
}

/**
 * Mínimo de muestras para hablar de atípico.
 *
 * Con menos de ocho operaciones de una contraparte, la mediana no dice nada: la
 * novena operación de un proveedor nuevo siempre se vería atípica. Es el mismo
 * umbral que usa el motor de clasificación.
 */
export const MUESTRAS_MINIMAS = 8;

/** Cuántas MAD de distancia hacen que un importe sea atípico. */
export const K_DESVIACIONES = 6n;

/**
 * Importes muy por fuera del historial de la misma contraparte.
 *
 * Se compara contra el historial **de esa contraparte**, no contra el del
 * ejercicio: un pago de doscientos mil pesos es normal para el alquiler y
 * llamativo para la librería.
 */
export function importesAtipicos(
  asientos: readonly AsientoParaAuditar[],
  historicos: ReadonlyMap<string, readonly bigint[]>,
): Anomalia[] {
  const hallazgos: Anomalia[] = [];

  for (const asiento of asientos) {
    if (asiento.contraparteId === null) continue;
    const historia = historicos.get(asiento.contraparteId) ?? [];
    if (historia.length < MUESTRAS_MINIMAS) continue;

    const mediana = medianaDe(historia);
    const desviacion = madDe(historia, mediana);
    // Con MAD cero —todos los importes iguales— cualquier diferencia es infinita
    // en desviaciones. Se exige que además difiera del valor repetido.
    const distancia = abs(asiento.importe.amount - mediana);
    const atipico =
      desviacion === 0n ? distancia > 0n : distancia > K_DESVIACIONES * desviacion;

    if (!atipico) continue;

    hallazgos.push({
      codigo: 'IMPORTE_ATIPICO',
      entryId: asiento.entryId,
      observado: `El importe ${asiento.importe.amount} se aparta ${distancia} de la mediana ${mediana} de las ${historia.length} operaciones previas con esta contraparte (MAD ${desviacion}).`,
      queMirar:
        'Confirmar contra el comprobante que el importe sea el facturado. Puede ser una operación legítimamente distinta —una compra anual, un ajuste— o un error de tipeo en el importe.',
    });
  }

  return hallazgos;
}

/**
 * Importes exactamente redondos y grandes.
 *
 * Un importe terminado en muchos ceros no tiene nada de malo: los alquileres, los
 * honorarios y los aportes son redondos. Lo que se observa es que **una factura de
 * compra** con IVA discriminado rara vez lo sea, porque el IVA rompe la redondez.
 *
 * Por eso el detector no dice "sospechoso": dice que el importe es redondo y que
 * eso, en un comprobante con IVA, merece una mirada.
 */
export function importesRedondos(
  asientos: readonly AsientoParaAuditar[],
  minimo = 10_000_00n,
): Anomalia[] {
  return asientos
    .filter((asiento) => asiento.importe.amount >= minimo && asiento.importe.amount % 100_000n === 0n)
    .map((asiento) => ({
      codigo: 'IMPORTE_REDONDO' as const,
      entryId: asiento.entryId,
      observado: `El importe ${asiento.importe.amount} es exactamente redondo (múltiplo de 1.000,00).`,
      queMirar:
        'En un comprobante con IVA discriminado la redondez es infrecuente, porque el impuesto la rompe. Verificar contra el comprobante que el total sea el facturado y no un importe cargado a mano.',
    }));
}

/**
 * Importes que quedan justo por debajo de un umbral.
 *
 * El patrón clásico: operaciones consistentemente unos pesos por debajo del
 * monto que dispara una obligación —un régimen de información, una retención, una
 * autorización interna—.
 *
 * El detector **no sabe** cuál es el umbral aplicable: los umbrales salen de
 * normas que este repositorio no tiene archivadas. Recibe los que le pasen y no
 * inventa ninguno; sin umbrales configurados, no reporta nada.
 */
export function justoBajoUmbral(
  asientos: readonly AsientoParaAuditar[],
  umbrales: readonly { readonly nombre: string; readonly monto: bigint }[],
  margen = 5_000_00n,
): Anomalia[] {
  const hallazgos: Anomalia[] = [];

  for (const asiento of asientos) {
    for (const umbral of umbrales) {
      const diferencia = umbral.monto - asiento.importe.amount;
      if (diferencia <= 0n || diferencia > margen) continue;

      hallazgos.push({
        codigo: 'JUSTO_BAJO_UMBRAL',
        entryId: asiento.entryId,
        observado: `El importe ${asiento.importe.amount} queda ${diferencia} por debajo del umbral "${umbral.nombre}" (${umbral.monto}).`,
        queMirar:
          'Un caso aislado no dice nada. Lo que se mira es si el mismo proveedor o la misma cuenta repiten el patrón: eso ya no es casualidad y merece explicación.',
      });
    }
  }

  return hallazgos;
}

/**
 * Asientos cargados muy después de su fecha contable.
 *
 * No es una irregularidad —la carga siempre va atrás de los hechos— pero un
 * asiento con fecha de marzo cargado en septiembre no se revisó en su momento, y
 * eso cambia qué tan confiable es el período que ya se dio por cerrado.
 */
export function asientosTardios(
  asientos: readonly AsientoParaAuditar[],
  diasDeGracia = 60,
): Anomalia[] {
  const MS_POR_DIA = 86_400_000;

  return asientos
    .map((asiento) => {
      const contable = Date.UTC(
        Number(asiento.fecha.slice(0, 4)),
        Number(asiento.fecha.slice(5, 7)) - 1,
        Number(asiento.fecha.slice(8, 10)),
      );
      const cargado = new Date(asiento.cargadoEl).getTime();
      const dias = Math.floor((cargado - contable) / MS_POR_DIA);
      return { asiento, dias };
    })
    .filter(({ dias }) => dias > diasDeGracia)
    .map(({ asiento, dias }) => ({
      codigo: 'ASIENTO_TARDIO' as const,
      entryId: asiento.entryId,
      observado: `Fecha contable ${asiento.fecha}, cargado ${dias} días después.`,
      queMirar:
        'El asiento no estuvo a la vista cuando se revisó su período. Verificar que el período no se haya dado por cerrado sin él, y que el comprobante respalde la fecha contable.',
    }));
}

/**
 * Junta todos los detectores.
 *
 * Devuelve los hallazgos **sin priorizar y sin puntaje**. La tentación es
 * ordenarlos por "riesgo", y para eso habría que ponerle un número a cada uno —
 * un número que el software no puede fundar. Un hallazgo es o no es; cuál mirar
 * primero lo decide quien audita.
 */
export interface EntradaDeAuditoria {
  readonly asientos: readonly AsientoParaAuditar[];
  readonly historicosPorContraparte: ReadonlyMap<string, readonly bigint[]>;
  readonly umbrales?: readonly { readonly nombre: string; readonly monto: bigint }[];
}

export interface ResultadoDeAuditoria {
  readonly anomalias: readonly Anomalia[];
  readonly asientosRevisados: number;
  readonly asientosConHallazgo: number;
  readonly comentario: string;
}

export function auditar(entrada: EntradaDeAuditoria): ResultadoDeAuditoria {
  const anomalias = [
    ...importesAtipicos(entrada.asientos, entrada.historicosPorContraparte),
    ...importesRedondos(entrada.asientos),
    ...justoBajoUmbral(entrada.asientos, entrada.umbrales ?? []),
    ...asientosTardios(entrada.asientos),
  ];

  const conHallazgo = new Set(anomalias.map((anomalia) => anomalia.entryId)).size;

  return {
    anomalias,
    asientosRevisados: entrada.asientos.length,
    asientosConHallazgo: conHallazgo,
    comentario:
      (entrada.umbrales ?? []).length === 0
        ? 'El detector de importes justo bajo umbral no corrió: no hay umbrales configurados. Los umbrales salen de normas que este repositorio no tiene archivadas, y el motor no inventa ninguno.'
        : `${anomalias.length} observación(es) sobre ${entrada.asientos.length} asientos. Ninguna es una conclusión: cada una dice qué se observó y qué mirar.`,
  };
}

// ---------------------------------------------------------------------------
// Estadística en enteros
// ---------------------------------------------------------------------------

export function medianaDe(valores: readonly bigint[]): bigint {
  if (valores.length === 0) return 0n;
  const ordenados = [...valores].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medio = Math.floor(ordenados.length / 2);
  if (ordenados.length % 2 === 1) return ordenados[medio] ?? 0n;
  // Media de los dos centrales, en enteros y truncando. La alternativa —devolver
  // el de la izquierda— sesga la mediana hacia abajo en conjuntos pares.
  return ((ordenados[medio - 1] ?? 0n) + (ordenados[medio] ?? 0n)) / 2n;
}

/** Desviación absoluta mediana: la mediana de las distancias a la mediana. */
export function madDe(valores: readonly bigint[], mediana: bigint): bigint {
  return medianaDe(valores.map((valor) => abs(valor - mediana)));
}

function abs(valor: bigint): bigint {
  return valor < 0n ? -valor : valor;
}
