/**
 * Máquina de estados de un período (§36).
 *
 * ```
 * ABIERTO ──bloquear──► BLOQUEADO ──cerrar──► CERRADO
 *    ▲                                            │
 *    └──────── reapertura con doble firma ────────┘
 * ```
 *
 * `BLOQUEADO` no es un `CERRADO` suave: significa "solo los ajustes de cierre".
 * La distinción existe porque el cierre lleva días y durante esos días hay que
 * poder asentar los ajustes sin que entre operación corriente.
 *
 * La reapertura exige **dos personas distintas**. No es burocracia: reabrir un
 * período cerrado cambia números ya informados, y que una sola persona pueda
 * hacerlo convierte el cierre en una formalidad.
 */

export type EstadoPeriodo = 'ABIERTO' | 'BLOQUEADO' | 'CERRADO';
export type TransicionPeriodo = 'BLOQUEAR' | 'CERRAR' | 'REABRIR';

export interface SolicitudTransicion {
  readonly desde: EstadoPeriodo;
  readonly transicion: TransicionPeriodo;
  readonly actorId: string;
  /** Segunda firma. Solo la reapertura la exige. */
  readonly refrendadoPor?: string;
  readonly motivo?: string;
}

export type ResultadoTransicion =
  | { readonly ok: true; readonly hacia: EstadoPeriodo }
  | { readonly ok: false; readonly motivo: string };

export function transicionar(solicitud: SolicitudTransicion): ResultadoTransicion {
  const { desde, transicion, actorId, refrendadoPor, motivo } = solicitud;

  if (transicion === 'BLOQUEAR') {
    if (desde !== 'ABIERTO') {
      return { ok: false, motivo: `Un período ${desde} no se puede bloquear` };
    }
    return { ok: true, hacia: 'BLOQUEADO' };
  }

  if (transicion === 'CERRAR') {
    if (desde === 'CERRADO') return { ok: false, motivo: 'El período ya está cerrado' };
    // Se admite cerrar directo desde ABIERTO: no todos los cierres necesitan la
    // etapa de bloqueo, y forzarla sería trámite sin contenido.
    return { ok: true, hacia: 'CERRADO' };
  }

  if (desde !== 'CERRADO') {
    return { ok: false, motivo: `Solo se reabre un período cerrado, y este está ${desde}` };
  }
  if (motivo === undefined || motivo.trim().length < 3) {
    return { ok: false, motivo: 'La reapertura exige un motivo' };
  }
  if (refrendadoPor === undefined || refrendadoPor.trim().length === 0) {
    return { ok: false, motivo: 'La reapertura exige una segunda firma' };
  }
  if (refrendadoPor === actorId) {
    return {
      ok: false,
      motivo: 'La segunda firma tiene que ser de otra persona: es separación de funciones, no un trámite',
    };
  }
  return { ok: true, hacia: 'ABIERTO' };
}

// ---------------------------------------------------------------------------
// Checklist de cierre
// ---------------------------------------------------------------------------

/**
 * Cada ítem es una consulta determinística cuyo resultado se archiva en
 * `accounting_closures.checklist`.
 *
 * Función pura: recibe los conteos ya resueltos y decide. Quien los cuenta es la
 * capa de datos; acá vive el criterio de qué impide cerrar y qué solo advierte.
 */
export interface HechosDelCierre {
  readonly asientosEnBorrador: number;
  readonly asientosPropuestosSinAprobar: number;
  readonly comprobantesSinAsiento: number;
  readonly documentosConHallazgoBloqueante: number;
  readonly duplicadosSinResolver: number;
  readonly propuestasDeIaSinRevisar: number;
  readonly bancosSinConciliar: number;
  readonly diferenciaSumasYSaldosEnMenor: string;
}

export interface ItemChecklist {
  readonly codigo: string;
  readonly descripcion: string;
  readonly cumple: boolean;
  readonly bloquea: boolean;
  readonly detalle: string;
}

export function evaluarChecklist(hechos: HechosDelCierre): readonly ItemChecklist[] {
  const item = (
    codigo: string,
    descripcion: string,
    cantidad: number,
    bloquea: boolean,
    singular: string,
  ): ItemChecklist => ({
    codigo,
    descripcion,
    cumple: cantidad === 0,
    bloquea,
    detalle: cantidad === 0 ? 'Sin pendientes' : `${cantidad} ${singular}`,
  });

  const diferencia = (() => {
    try {
      return BigInt(hechos.diferenciaSumasYSaldosEnMenor);
    } catch {
      return 1n;
    }
  })();

  return [
    // El único que no admite discusión: si el balance no cuadra, no hay cierre.
    // El resto son pendientes; este es un síntoma de que el libro está roto.
    {
      codigo: 'BALANCE_CUADRA',
      descripcion: 'El balance de sumas y saldos cierra',
      cumple: diferencia === 0n,
      bloquea: true,
      detalle:
        diferencia === 0n
          ? 'Debe = Haber'
          : `Diferencia de ${hechos.diferenciaSumasYSaldosEnMenor} en unidades menores`,
    },
    item('SIN_BORRADORES', 'No quedan asientos en borrador', hechos.asientosEnBorrador, true, 'en borrador'),
    item(
      'SIN_PROPUESTOS',
      'No quedan asientos propuestos sin aprobar',
      hechos.asientosPropuestosSinAprobar,
      true,
      'sin aprobar',
    ),
    item(
      'SIN_PROPUESTAS_IA',
      'No quedan propuestas de clasificación sin revisar',
      hechos.propuestasDeIaSinRevisar,
      true,
      'sin revisar',
    ),
    item(
      'COMPROBANTES_IMPUTADOS',
      'Todos los comprobantes tienen asiento',
      hechos.comprobantesSinAsiento,
      false,
      'sin asiento',
    ),
    item(
      'SIN_HALLAZGOS',
      'No hay documentos con hallazgos que bloqueen',
      hechos.documentosConHallazgoBloqueante,
      false,
      'con hallazgos',
    ),
    item(
      'DUPLICADOS_RESUELTOS',
      'No hay duplicados sin resolver',
      hechos.duplicadosSinResolver,
      false,
      'sin resolver',
    ),
    item('BANCOS_CONCILIADOS', 'Las cuentas bancarias están conciliadas', hechos.bancosSinConciliar, false, 'sin conciliar'),
  ];
}

export function puedeCerrar(checklist: readonly ItemChecklist[]): boolean {
  return !checklist.some((item) => item.bloquea && !item.cumple);
}
