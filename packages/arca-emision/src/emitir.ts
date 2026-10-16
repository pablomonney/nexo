/**
 * El caso de uso **emitir**, y el de **reconciliar** lo que quedó en duda — con todo lo de afuera detrás de puertos.
 *
 * Es el paso E4 de `docs/EMISION_DE_FACTURAS_PLAN.md`. Une las piezas que ya existían (la máquina de estados de la intención
 * fiscal, la numeración, el cliente WSFEv1, el armado del comprobante y el reconciliador) en el único recorrido por el que se
 * puede pedir un CAE:
 *
 *     BORRADOR ──reserva número──▶ LISTA ──persiste──▶ EMITIENDO ──llama a ARCA──▶ AUTORIZADA | RECHAZADA | DESCONOCIDA
 *                                                                                           │
 *                                         (de la duda sólo se sale averiguando) ◀───────────┘  RECONCILIANDO
 *
 * ## Las reglas que este archivo hace cumplir
 *
 * 1. **De la duda no se sale emitiendo.** Una intención en EMITIENDO, DESCONOCIDA o RECONCILIANDO **nunca** llama a
 *    `FECAESolicitar`: `emitirIntencion` se niega y devuelve `EN_DUDA`. La base también lo impide (el trigger de 0117), pero la
 *    primera línea de defensa es no pedirlo.
 * 2. **Se persiste EMITIENDO *antes* de llamar.** Si el proceso muere a mitad de camino, la intención queda EMITIENDO, que es
 *    «puede haber salido»: `recuperarHuerfanas` la pasa a DESCONOCIDA y la reconciliación averigua qué pasó. Lo contrario
 *    —llamar y después anotar— deja una factura autorizada que nadie sabe que existe.
 * 3. **Todo fallo posterior a EMITIENDO es duda, no error.** Un timeout, un 5xx, una respuesta ilegible, un resultado parcial:
 *    DESCONOCIDA. Sólo una respuesta inequívoca de ARCA (`A` con CAE, o `R`) cierra la intención. (Que el pedido «no salió» se
 *    descubre **antes**, con `FEDummy` y `FECompUltimoAutorizado`, que no tocan la intención.)
 * 4. **AUTORIZADA exige evidencia** (CAE, vencimiento y que el número autorizado sea el reservado: `verificarEvidencia`). Si
 *    ARCA dice «autorizado» y la evidencia no sirve, es duda.
 * 5. **La numeración sigue a ARCA.** El número reservado es *el siguiente al último autorizado* (ver la migración 0138): ARCA no
 *    tolera huecos (error 10016, medido el 2026-10-16) y un rechazo no consume número. Una sola emisión en curso por punto de
 *    venta y tipo.
 * 6. **Lo que se arma tiene que ser lo que se declaró.** El tipo y el punto de venta del comprobante armado tienen que coincidir
 *    con los de la intención; si no, no se emite (la letra se deduce del receptor y no puede cambiar a espaldas de la intención).
 *
 * ## Por qué no habla con la base ni con ARCA directamente
 *
 * Este paquete no puede conocer la base (y la aplicación no puede importarlo todavía: `la-emision-no-llega-a-la-aplicacion`).
 * Todo lo de afuera entra por `RepositorioDeEmision` y `TransporteDeEmision`, que las pruebas reemplazan por simulados y que la
 * habilitación (E8) conectará a la base y a WSFEv1.
 */

import { verificarEvidencia, type EstadoDeEmision, type EvidenciaDeAutorizacion } from '@aai/tax-engine';
import type { ResultadoDeArmado, Problema } from './armado.js';
import type { Autenticacion, CabeceraLote, DetalleComprobante, RespuestaLote } from './contracts.js';
import type { PedidoDeReconciliacionWsfe, ResultadoDeReconciliacionWsfe } from './reconciliador-wsfev1.js';
import type { ClienteWsfev1 } from './wsfev1.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Los puertos
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** La intención tal como está guardada. */
export interface IntencionGuardada {
  readonly id: string;
  readonly estado: EstadoDeEmision;
  readonly ambiente: 'homologacion' | 'produccion';
  readonly puntoVenta: number;
  readonly cbteTipo: number;
  readonly cbteNumero: number | null;
  readonly cae: string | null;
  /** `AAAA-MM-DD`. */
  readonly caeVencimiento: string | null;
  /** En una nota de crédito o de débito: la intención del comprobante que corrige (el caso de uso la usa para armar `CbtesAsoc`). */
  readonly asociadaA?: string | null;
}

export type CodigoDeErrorDeEmision =
  | 'CARRIL_OCUPADO'
  | 'ULTIMO_INCONSISTENTE'
  | 'INTENCION_INEXISTENTE'
  | 'TRANSICION_NO_PERMITIDA';

/**
 * El código de un `ErrorDeEmision`, reconocido **por nombre y no por clase**: el repositorio real vive en la aplicación, que no puede
 * importar este paquete (`la-emision-no-llega-a-la-aplicacion`) y por lo tanto define su propia clase con el mismo nombre.
 */
export function codigoDeErrorDeEmision(e: unknown): CodigoDeErrorDeEmision | null {
  if (!(e instanceof Error) || e.name !== 'ErrorDeEmision') return null;
  const codigo = (e as { codigo?: unknown }).codigo;
  return typeof codigo === 'string' ? (codigo as CodigoDeErrorDeEmision) : null;
}

/** Lo que el repositorio le dice al caso de uso cuando la base se niega por una razón que el caso de uso sabe interpretar. */
export class ErrorDeEmision extends Error {
  constructor(
    readonly codigo: CodigoDeErrorDeEmision,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorDeEmision';
  }
}

/**
 * Persistencia de la intención. Cada método es **una transición** y la base las valida de todos modos; el repositorio no decide.
 */
export interface RepositorioDeEmision {
  cargar(id: string): Promise<IntencionGuardada | null>;
  /** BORRADOR → LISTA con **el siguiente al último autorizado por ARCA**. Lanza `ErrorDeEmision` (`CARRIL_OCUPADO`, `ULTIMO_INCONSISTENTE`). */
  reservarNumeroCorrelativo(id: string, ultimoAutorizadoPorArca: number): Promise<number>;
  /** LISTA → EMITIENDO, y suma una llamada. Se hace **antes** de llamar. */
  marcarEmitiendo(id: string): Promise<void>;
  /** EMITIENDO | RECONCILIANDO → AUTORIZADA, con la evidencia. */
  marcarAutorizada(id: string, evidencia: EvidenciaDeAutorizacion): Promise<void>;
  /** EMITIENDO | RECONCILIANDO → RECHAZADA, con el motivo (obligatorio) y el código de ARCA si lo hubo. */
  marcarRechazada(id: string, codigo: string | null, motivo: string): Promise<void>;
  /** EMITIENDO | RECONCILIANDO → DESCONOCIDA. */
  marcarDesconocida(id: string, motivo: string): Promise<void>;
  /** DESCONOCIDA → RECONCILIANDO. */
  marcarReconciliando(id: string): Promise<void>;
  /** Las que hay que averiguar: las DESCONOCIDA y las EMITIENDO que llevan más de `segundosEmitiendo` sin moverse. */
  listarParaReconciliar(segundosEmitiendo: number): Promise<readonly IntencionGuardada[]>;
}

/** Lo que se le pide a ARCA. */
export interface TransporteDeEmision {
  /** `FEDummy`: ¿el servicio contesta y está sano? No toca nada. */
  estaVivo(): Promise<boolean>;
  /** `FECompUltimoAutorizado`. */
  ultimoAutorizado(puntoVenta: number, cbteTipo: number): Promise<number>;
  /** `FECAESolicitar`, un comprobante. **Es la llamada que no se deshace.** */
  solicitarCae(cabecera: CabeceraLote, detalle: DetalleComprobante): Promise<RespuestaLote>;
}

/** Quien averigua qué pasó con una emisión en duda (el `ReconciliadorWsfev1` lo implementa). */
export interface ReconciliadorDeEmision {
  reconciliar(pedido: PedidoDeReconciliacionWsfe): Promise<ResultadoDeReconciliacionWsfe>;
}

/** El transporte real, sobre el cliente WSFEv1 y un proveedor de ticket (la caché compartida: el WSAA da uno solo por CUIT). */
export class TransporteWsfev1 implements TransporteDeEmision {
  constructor(
    private readonly cliente: ClienteWsfev1,
    private readonly autenticar: () => Promise<Autenticacion>,
  ) {}

  async estaVivo(): Promise<boolean> {
    const d = await this.cliente.dummy();
    return [d.appServer, d.dbServer, d.authServer].every((s) => s === 'OK');
  }

  async ultimoAutorizado(puntoVenta: number, cbteTipo: number): Promise<number> {
    return this.cliente.ultimoAutorizado(await this.autenticar(), puntoVenta, cbteTipo);
  }

  async solicitarCae(cabecera: CabeceraLote, detalle: DetalleComprobante): Promise<RespuestaLote> {
    return this.cliente.solicitarCae(await this.autenticar(), cabecera, [detalle]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Emitir
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MotivoDeNoEmision =
  /** La intención ya está en duda (EMITIENDO, DESCONOCIDA, RECONCILIANDO): se reconcilia, no se emite. */
  | 'EN_DUDA'
  /** RECHAZADA o ANULADA: es terminal para esta intención. */
  | 'ESTADO_NO_EMITIBLE'
  /** No se pudo armar el comprobante. */
  | 'NO_ARMABLE'
  /** El comprobante armado no es el que la intención declaró (tipo o punto de venta). */
  | 'NO_ES_LA_INTENCION'
  /** ARCA no contestó antes de salir el pedido: nada se envió, nada cambió. */
  | 'SERVICIO_NO_DISPONIBLE'
  /** Hay otra emisión sin resolver en el mismo punto de venta y tipo. */
  | 'CARRIL_OCUPADO'
  /** El número reservado ya no es el siguiente al último autorizado: algo avanzó o no cierra. */
  | 'NUMERO_DESFASADO'
  /** ARCA y la base no cuentan lo mismo sobre lo ya autorizado. */
  | 'NUMERACION_INCONSISTENTE';

export type ResultadoDeEmitir =
  | { readonly estado: 'AUTORIZADA'; readonly cae: string; readonly caeVencimiento: string; readonly cbteNumero: number; readonly yaEstaba: boolean }
  | { readonly estado: 'RECHAZADA'; readonly codigo: string | null; readonly motivo: string }
  /** Quedó en duda: hay que reconciliar. `caeSinGuardar` sólo existe si ARCA autorizó y no se pudo escribir (se registra y se recupera). */
  | { readonly estado: 'DESCONOCIDA'; readonly motivo: string; readonly caeSinGuardar?: string }
  | { readonly estado: 'NO_SE_EMITIO'; readonly motivo: MotivoDeNoEmision; readonly detalle: string; readonly problemas?: readonly Problema[] };

export interface DependenciasDeEmitir {
  readonly repo: RepositorioDeEmision;
  readonly transporte: TransporteDeEmision;
}

const noSeEmitio = (motivo: MotivoDeNoEmision, detalle: string, problemas?: readonly Problema[]): ResultadoDeEmitir => ({
  estado: 'NO_SE_EMITIO',
  motivo,
  detalle,
  ...(problemas === undefined ? {} : { problemas }),
});

/** Texto de los errores y observaciones de ARCA, acotado: son mensajes públicos del servicio, no datos nuestros. */
function textoDeRechazo(r: RespuestaLote): { codigo: string | null; motivo: string } {
  const partes: string[] = [];
  let codigo: string | null = null;
  for (const e of r.errores) {
    codigo ??= String(e.Code);
    partes.push(`[${e.Code}] ${e.Msg}`);
  }
  for (const c of r.comprobantes) {
    for (const o of c.Observaciones) {
      codigo ??= String(o.Code);
      partes.push(`[${o.Code}] ${o.Msg}`);
    }
  }
  const motivo = partes.length === 0 ? 'ARCA rechazó el comprobante sin dar motivo.' : partes.join(' · ');
  return { codigo, motivo: motivo.slice(0, 500) };
}

/** ¿El comprobante armado es el que la intención declaró? (la letra se deduce del receptor: no puede cambiar a espaldas de la intención) */
function noEsLaIntencion(
  intencion: IntencionGuardada,
  armado: { readonly cabecera: CabeceraLote; readonly detalle: DetalleComprobante },
  numero: number,
): string | null {
  const { cabecera, detalle } = armado;
  if (cabecera.CbteTipo === intencion.cbteTipo && cabecera.PtoVta === intencion.puntoVenta && detalle.CbteDesde === numero) return null;
  return (
    `La intención declara el tipo ${intencion.cbteTipo} en el punto de venta ${intencion.puntoVenta} (número ${numero}) y el comprobante armado ` +
    `es el tipo ${cabecera.CbteTipo}, punto de venta ${cabecera.PtoVta}, número ${detalle.CbteDesde}.`
  );
}

const mensajeDe = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Pide el CAE de una intención. **Es el único camino.**
 *
 * `armar` recibe el número reservado y devuelve el comprobante (típicamente `armarComprobante` con los datos del documento
 * comercial). Se llama primero con el número que le tocaría —para no reservar nada si no se puede armar— y otra vez con el
 * reservado.
 */
export async function emitirIntencion(
  deps: DependenciasDeEmitir,
  id: string,
  armar: (numero: number) => ResultadoDeArmado,
): Promise<ResultadoDeEmitir> {
  const { repo, transporte } = deps;
  const intencion = await repo.cargar(id);
  if (intencion === null) throw new ErrorDeEmision('INTENCION_INEXISTENTE', `No existe la intención fiscal ${id}.`);

  // 1 · El estado decide si siquiera se puede intentar.
  switch (intencion.estado) {
    case 'AUTORIZADA':
      return {
        estado: 'AUTORIZADA',
        cae: intencion.cae ?? '',
        caeVencimiento: intencion.caeVencimiento ?? '',
        cbteNumero: intencion.cbteNumero ?? 0,
        yaEstaba: true,
      };
    case 'EMITIENDO':
    case 'DESCONOCIDA':
    case 'RECONCILIANDO':
      return noSeEmitio(
        'EN_DUDA',
        'Esta emisión quedó sin saber si ARCA la autorizó. No se vuelve a pedir un CAE: se reconcilia contra el organismo.',
      );
    case 'RECHAZADA':
    case 'ANULADA':
      return noSeEmitio(
        'ESTADO_NO_EMITIBLE',
        `La intención está ${intencion.estado}: es terminal. Para volver a emitir se declara una intención nueva.`,
      );
    case 'BORRADOR':
    case 'LISTA':
      break;
  }

  // 2 · Antes de tocar la intención: ¿ARCA está? Nada de esto cambia el estado.
  let ultimo: number;
  try {
    if (!(await transporte.estaVivo())) return noSeEmitio('SERVICIO_NO_DISPONIBLE', 'ARCA informa que el servicio no está sano en este momento.');
    ultimo = await transporte.ultimoAutorizado(intencion.puntoVenta, intencion.cbteTipo);
  } catch (e) {
    return noSeEmitio('SERVICIO_NO_DISPONIBLE', `No se pudo consultar a ARCA antes de emitir (${mensajeDe(e)}). No se envió nada.`);
  }

  // 3 · El número.
  let numero: number;
  if (intencion.estado === 'BORRADOR') {
    // Se comprueba que el comprobante se puede armar ANTES de reservar: un número reservado que no se va a emitir traba el punto de venta.
    const prueba = armar(ultimo + 1);
    if (!prueba.ok) return noSeEmitio('NO_ARMABLE', 'No se pudo armar el comprobante. No se reservó ningún número.', prueba.problemas);
    const distinto = noEsLaIntencion(intencion, prueba.comprobante, ultimo + 1);
    if (distinto !== null) return noSeEmitio('NO_ES_LA_INTENCION', distinto);
    try {
      numero = await repo.reservarNumeroCorrelativo(id, ultimo);
    } catch (e) {
      const codigo = codigoDeErrorDeEmision(e);
      if (codigo === 'CARRIL_OCUPADO') return noSeEmitio('CARRIL_OCUPADO', mensajeDe(e));
      if (codigo === 'ULTIMO_INCONSISTENTE') return noSeEmitio('NUMERACION_INCONSISTENTE', mensajeDe(e));
      throw e;
    }
  } else {
    // LISTA: ya tenía número (se reservó y no llegó a salir). Sigue valiendo sólo si todavía es el siguiente al último autorizado.
    numero = intencion.cbteNumero ?? 0;
    if (numero !== ultimo + 1) {
      return noSeEmitio(
        'NUMERO_DESFASADO',
        `La intención tiene reservado el ${numero} y ARCA dice que el último autorizado es el ${ultimo}: ya no es el siguiente. ` +
          'Se anula esta intención y se declara una nueva (si el número ya está autorizado, se reconcilia primero).',
      );
    }
  }

  // 4 · El comprobante, con el número definitivo, y que sea el que se declaró.
  const armado = armar(numero);
  if (!armado.ok) {
    return noSeEmitio(
      'NO_ARMABLE',
      'No se pudo armar el comprobante. La intención queda LISTA con su número reservado: se corrigen los datos y se vuelve a emitir, o se anula.',
      armado.problemas,
    );
  }
  const { cabecera, detalle } = armado.comprobante;
  const distinto = noEsLaIntencion(intencion, armado.comprobante, numero);
  if (distinto !== null) return noSeEmitio('NO_ES_LA_INTENCION', distinto);

  // 5 · A partir de acá puede haber salido. Se persiste ANTES de llamar.
  await repo.marcarEmitiendo(id);

  // 6 · La llamada que no se deshace.
  let respuesta: RespuestaLote;
  try {
    respuesta = await transporte.solicitarCae(cabecera, detalle);
  } catch (e) {
    const motivo = `La llamada a ARCA terminó sin respuesta (${mensajeDe(e)}). Puede haber llegado: se reconcilia, no se reintenta.`;
    await repo.marcarDesconocida(id, motivo);
    return { estado: 'DESCONOCIDA', motivo };
  }

  // 7 · Sólo una respuesta inequívoca cierra la intención.
  const c = respuesta.comprobantes[0];
  if (respuesta.Resultado === 'A' && c !== undefined && c.Resultado === 'A' && c.CAE !== null && c.CAEFchVto !== null) {
    const evidencia: EvidenciaDeAutorizacion = { cae: c.CAE, caeVencimiento: c.CAEFchVto, numeroAutorizado: c.CbteDesde };
    const v = verificarEvidencia(evidencia, numero);
    if (!v.valida) {
      const motivo = `ARCA contestó «autorizado» pero la evidencia no sirve (${v.motivo}). Se reconcilia.`;
      await repo.marcarDesconocida(id, motivo);
      return { estado: 'DESCONOCIDA', motivo, caeSinGuardar: c.CAE };
    }
    try {
      await repo.marcarAutorizada(id, evidencia);
    } catch (e) {
      // ARCA autorizó y no pudimos escribirlo. El CAE no se pierde: se devuelve, y la intención queda EMITIENDO →
      // `recuperarHuerfanas` la pasa a DESCONOCIDA y la reconciliación trae la evidencia con FECompConsultar.
      return { estado: 'DESCONOCIDA', motivo: `ARCA autorizó pero no se pudo guardar (${mensajeDe(e)}).`, caeSinGuardar: c.CAE };
    }
    return { estado: 'AUTORIZADA', cae: c.CAE, caeVencimiento: c.CAEFchVto, cbteNumero: numero, yaEstaba: false };
  }

  if (respuesta.Resultado === 'R' || c?.Resultado === 'R') {
    const { codigo, motivo } = textoDeRechazo(respuesta);
    await repo.marcarRechazada(id, codigo, motivo);
    return { estado: 'RECHAZADA', codigo, motivo };
  }

  // Parcial, vacía, ilegible, con errores sin resultado: no se sabe.
  const motivo =
    `ARCA contestó algo que no se puede interpretar como autorización ni como rechazo (Resultado «${respuesta.Resultado}»` +
    `${respuesta.errores.length > 0 ? `, error ${respuesta.errores[0]!.Code}` : ''}). Se reconcilia.`;
  await repo.marcarDesconocida(id, motivo);
  return { estado: 'DESCONOCIDA', motivo };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Reconciliar
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ResultadoDeReconciliar =
  | { readonly estado: 'AUTORIZADA'; readonly cae: string; readonly caeVencimiento: string; readonly cbteNumero: number }
  | { readonly estado: 'RECHAZADA'; readonly motivo: string }
  /** Sigue sin saberse (ARCA no contestó, o existe y no se pudo traer el CAE): se vuelve a intentar más tarde. */
  | { readonly estado: 'SIGUE_EN_DUDA'; readonly motivo: string }
  | { readonly estado: 'NADA_QUE_RECONCILIAR'; readonly actual: EstadoDeEmision };

/**
 * Averigua qué pasó con una intención DESCONOCIDA. **Nunca emite.**
 *
 * `NO_AUTORIZADO` sólo sale de «el último autorizado es exactamente el anterior al reservado» (lo garantiza el reconciliador):
 * una red caída o una credencial vencida jamás lo producen, porque habilitarían a facturar de nuevo algo que quizá existe.
 */
export async function reconciliarIntencion(
  deps: { readonly repo: RepositorioDeEmision; readonly reconciliador: ReconciliadorDeEmision },
  id: string,
): Promise<ResultadoDeReconciliar> {
  const { repo, reconciliador } = deps;
  const i = await repo.cargar(id);
  if (i === null) throw new ErrorDeEmision('INTENCION_INEXISTENTE', `No existe la intención fiscal ${id}.`);
  if (i.estado !== 'DESCONOCIDA') return { estado: 'NADA_QUE_RECONCILIAR', actual: i.estado };
  if (i.cbteNumero === null) {
    return { estado: 'SIGUE_EN_DUDA', motivo: 'La intención en duda no tiene número reservado: no hay qué averiguar.' };
  }

  await repo.marcarReconciliando(id);
  let r: ResultadoDeReconciliacionWsfe;
  try {
    r = await reconciliador.reconciliar({ puntoVenta: i.puntoVenta, cbteTipo: i.cbteTipo, numeroReservado: i.cbteNumero });
  } catch (e) {
    const motivo = `La reconciliación falló (${mensajeDe(e)}): la duda sigue.`;
    await repo.marcarDesconocida(id, motivo);
    return { estado: 'SIGUE_EN_DUDA', motivo };
  }

  switch (r.estado) {
    case 'AUTORIZADO': {
      const v = verificarEvidencia(r.evidencia, i.cbteNumero);
      if (!v.valida) {
        const motivo = `ARCA dice que existe pero la evidencia no sirve (${v.motivo}): la duda sigue.`;
        await repo.marcarDesconocida(id, motivo);
        return { estado: 'SIGUE_EN_DUDA', motivo };
      }
      await repo.marcarAutorizada(id, r.evidencia);
      return { estado: 'AUTORIZADA', cae: r.evidencia.cae, caeVencimiento: r.evidencia.caeVencimiento, cbteNumero: i.cbteNumero };
    }
    case 'NO_AUTORIZADO': {
      const motivo = `Reconciliado contra ARCA: nunca lo autorizó. ${r.detalle}`.slice(0, 500);
      await repo.marcarRechazada(id, null, motivo);
      return { estado: 'RECHAZADA', motivo };
    }
    case 'EXISTE_SIN_EVIDENCIA':
    case 'SIN_RESPUESTA': {
      await repo.marcarDesconocida(id, r.detalle.slice(0, 500));
      return { estado: 'SIGUE_EN_DUDA', motivo: r.detalle };
    }
  }
}

export interface ResumenDeReconciliacion {
  readonly revisadas: number;
  readonly autorizadas: number;
  readonly rechazadas: number;
  readonly siguenEnDuda: number;
  /** Intenciones que llevaban demasiado en EMITIENDO y se pasaron a DESCONOCIDA para poder averiguarlas. */
  readonly huerfanasRecuperadas: number;
}

/**
 * Una pasada del reconciliador periódico (el temporizador lo arma quien habilite la emisión, E8).
 *
 * Primero recupera las **huérfanas**: una intención EMITIENDO que lleva más de `segundosEmitiendo` sin moverse es un proceso que
 * murió a mitad de camino; se la pasa a DESCONOCIDA (puede haber salido). El plazo tiene que superar con holgura el timeout
 * de la llamada a ARCA: si no, se le mete la mano a una emisión que todavía está en vuelo.
 */
export async function reconciliarPendientes(
  deps: { readonly repo: RepositorioDeEmision; readonly reconciliador: ReconciliadorDeEmision },
  opciones: { readonly segundosEmitiendo?: number } = {},
): Promise<ResumenDeReconciliacion> {
  const segundos = opciones.segundosEmitiendo ?? 300;
  const pendientes = await deps.repo.listarParaReconciliar(segundos);
  let autorizadas = 0;
  let rechazadas = 0;
  let siguenEnDuda = 0;
  let huerfanasRecuperadas = 0;

  for (const p of pendientes) {
    if (p.estado === 'EMITIENDO') {
      await deps.repo.marcarDesconocida(p.id, `Quedó en EMITIENDO más de ${segundos} segundos: el proceso se cortó a mitad de camino. Se averigua contra ARCA.`);
      huerfanasRecuperadas += 1;
    }
    const r = await reconciliarIntencion(deps, p.id);
    if (r.estado === 'AUTORIZADA') autorizadas += 1;
    else if (r.estado === 'RECHAZADA') rechazadas += 1;
    else siguenEnDuda += 1;
  }
  return { revisadas: pendientes.length, autorizadas, rechazadas, siguenEnDuda, huerfanasRecuperadas };
}
