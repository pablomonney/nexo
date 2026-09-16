/**
 * Los estados de una suscripción y de un cobro, y qué puede seguir a qué.
 *
 * La máquina está acá y no en un `CHECK` porque un `CHECK` puede decir qué
 * valores son válidos y no **qué transición** lo es. Que el estado sea uno de
 * cuatro lo dice la base; que de CANCELADA no se vuelva, lo dice esto.
 *
 * Las dos cosas hacen falta: sin el `CHECK`, un `UPDATE` a mano escribe
 * cualquier texto; sin esto, escribe un estado válido en un momento imposible.
 */

/** Los cinco estados de la 0124, tal como los declara el `CHECK`. */
export type EstadoDeSuscripcion = 'PRUEBA' | 'ACTIVA' | 'MOROSA' | 'SUSPENDIDA' | 'CANCELADA';

/**
 * Qué puede seguir a cada estado.
 *
 * `CANCELADA` no lleva a ningún lado, y es a propósito: reactivar una
 * suscripción cancelada dejaría un período sin cobertura en el medio que ningún
 * documento explica. La forma de volver es una suscripción nueva, que arranca
 * su propia vigencia y su propia numeración.
 *
 * `SUSPENDIDA → ACTIVA` sí existe: la suspensión por falta de pago se levanta
 * pagando, y ese es el caso normal, no la excepción.
 */
const SIGUIENTES: Readonly<Record<EstadoDeSuscripcion, readonly EstadoDeSuscripcion[]>> = {
  // `PRUEBA → SUSPENDIDA` es la prueba que se vence sin convertirse. No es
  // `CANCELADA`, y la diferencia importa: cancelar es una decisión del cliente,
  // y de CANCELADA no se vuelve. Quien dejó vencer una prueba no decidió nada
  // —se le acabó el tiempo— y va a poder contratar mañana sin empezar de cero.
  //
  // `PRUEBA → MOROSA` **no existe**: una prueba no genera deuda. Lo que le pasa
  // a una prueba que se acaba es que se vence, y eso ya tiene nombre.
  PRUEBA: ['ACTIVA', 'SUSPENDIDA', 'CANCELADA'],

  // `ACTIVA → SUSPENDIDA` sigue existiendo al lado de `ACTIVA → MOROSA`, y no
  // es una duplicación: la mora la decide el calendario de cobranza, y la
  // suspensión directa la decide una persona —o la pasarela, cuando el cliente
  // cancela el medio de pago del otro lado—. Obligar a pasar por MOROSA para
  // cortar le pondría un escalón de cobranza a una baja que no tiene nada que
  // ver con una deuda.
  ACTIVA: ['MOROSA', 'SUSPENDIDA', 'CANCELADA'],

  // Las tres salidas de la mora, y ninguna vuelve a PRUEBA: quien ya contrató
  // no puede volver a probar el producto gratis, y una prueba después de una
  // deuda sería exactamente eso.
  //
  //   ACTIVA       pagó. Es la salida esperada y la que hace que la mora valga
  //                la pena: se recupera todo sin haber perdido nada.
  //   SUSPENDIDA   no pagó y se acabó la gracia.
  //   CANCELADA    se dio de baja debiendo. La deuda emitida no desaparece —los
  //                documentos quedan— pero la suscripción se termina.
  MOROSA: ['ACTIVA', 'SUSPENDIDA', 'CANCELADA'],

  // `SUSPENDIDA → MOROSA` **no existe**, y es la única de las cuatro ausencias
  // que puede sorprender. Degradar a alguien que ya está cortado no le devuelve
  // nada: sería mover hacia atrás un estado que solo se levanta pagando, y el
  // camino de vuelta ya está —`SUSPENDIDA → ACTIVA`, con la deuda saldada—.
  SUSPENDIDA: ['ACTIVA', 'CANCELADA'],

  CANCELADA: [],
};

export function puedeTransicionar(
  desde: EstadoDeSuscripcion,
  hacia: EstadoDeSuscripcion,
): boolean {
  return SIGUIENTES[desde].includes(hacia);
}

/**
 * Estados de un documento de cobro.
 *
 * `INCOBRABLE` no es `ANULADO`. Anular dice «esto no debió emitirse»; declarar
 * incobrable dice «se emitió bien y no se va a cobrar», que es un hecho
 * económico distinto y con otro tratamiento contable. Confundirlos borra la
 * deuda en vez de reconocer la pérdida.
 */
export type EstadoDeDocumento = 'BORRADOR' | 'EMITIDO' | 'PAGADO' | 'ANULADO' | 'INCOBRABLE';

const SIGUIENTES_DOC: Readonly<Record<EstadoDeDocumento, readonly EstadoDeDocumento[]>> = {
  BORRADOR: ['EMITIDO', 'ANULADO'],
  EMITIDO: ['PAGADO', 'ANULADO', 'INCOBRABLE'],
  // Un cobro que se revierte no vuelve a EMITIDO: se emite una nota de crédito.
  // Volver atrás dejaría el pago cobrado apuntando a un documento impago.
  PAGADO: [],
  ANULADO: [],
  INCOBRABLE: ['PAGADO'],
};

export function puedeTransicionarDocumento(
  desde: EstadoDeDocumento,
  hacia: EstadoDeDocumento,
): boolean {
  return SIGUIENTES_DOC[desde].includes(hacia);
}

/**
 * Estados de un intento de pago, tal como los reporta una pasarela.
 *
 * Son los del §16 del pliego comercial. `CONTRACARGO` es terminal desde el
 * punto de vista del intento: la disputa es otro proceso, con su propia
 * evidencia, y modelarla como un estado más de este intento haría que el
 * historial de un cobro dependiera de cómo terminó un juicio.
 */
export type EstadoDePago =
  | 'PENDIENTE'
  | 'AUTORIZADO'
  | 'PAGADO'
  | 'FALLIDO'
  | 'REEMBOLSADO'
  | 'CONTRACARGO';

const SIGUIENTES_PAGO: Readonly<Record<EstadoDePago, readonly EstadoDePago[]>> = {
  PENDIENTE: ['AUTORIZADO', 'PAGADO', 'FALLIDO'],
  AUTORIZADO: ['PAGADO', 'FALLIDO'],
  PAGADO: ['REEMBOLSADO', 'CONTRACARGO'],
  FALLIDO: [],
  REEMBOLSADO: [],
  CONTRACARGO: [],
};

export function puedeTransicionarPago(desde: EstadoDePago, hacia: EstadoDePago): boolean {
  return SIGUIENTES_PAGO[desde].includes(hacia);
}

/**
 * Un webhook repetido no es un error.
 *
 * Las pasarelas reenvían: el mismo evento puede llegar dos veces, o llegar
 * desordenado. Reprocesar un evento que deja el estado donde ya estaba tiene
 * que ser inofensivo, y por eso esto se pregunta antes de rechazar una
 * transición. Sin esta distinción, el segundo `PAGADO` de un cobro correcto
 * quedaría registrado como fallo de integración y alguien lo investigaría.
 */
export function esRepeticion(actual: EstadoDePago, entrante: EstadoDePago): boolean {
  return actual === entrante;
}

/**
 * Un evento que llega tarde y describe un estado ya superado.
 *
 * Ejemplo real: el `AUTORIZADO` que llega después del `PAGADO`. No es una
 * repetición ni una transición válida — es viejo, y aplicarlo retrocedería el
 * cobro. Se lo registra y no se lo aplica.
 */
export function esAtrasado(actual: EstadoDePago, entrante: EstadoDePago): boolean {
  if (actual === entrante) return false;
  if (puedeTransicionarPago(actual, entrante)) return false;
  return puedeTransicionarPago(entrante, actual);
}
