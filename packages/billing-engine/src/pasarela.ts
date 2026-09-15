/**
 * De lo que dice una pasarela a lo que significa para NEXO.
 *
 * ## Por qué la traducción vive acá y no en el adaptador
 *
 * Porque **no es transporte, es una decisión comercial.** Que una suscripción
 * pausada del lado del proveedor deje o no de dar acceso es una regla del
 * negocio de NEXO, no un detalle de la API de nadie. Ponerla en el adaptador
 * haría que cambiar de proveedor obligara a re-decidirla.
 *
 * Y siendo puro se puede ejercitar entero: los estados que en producción
 * aparecen una vez cada mil cobros se prueban acá sin cuenta y sin red.
 *
 * ## La regla que ordena todas las demás
 *
 * **La pasarela informa; NEXO decide.** Un `cancelled` del proveedor no cancela
 * la suscripción de NEXO por sí solo: dice que el medio de pago dejó de estar
 * autorizado. Qué hace NEXO con eso —suspender, avisar, esperar— lo gobierna la
 * política de cobranza, que ya existe y no se toca.
 */

import type { EstadoDePago, EstadoDeSuscripcion } from './estados.js';

/** El estado de una suscripción según el proveedor, ya normalizado. */
export type EstadoExternoDeSuscripcion = 'PENDIENTE' | 'AUTORIZADA' | 'PAUSADA' | 'CANCELADA';

/**
 * Qué le toca a NEXO cuando el proveedor informa un estado de suscripción.
 *
 * Nótese que **no siempre hay transición**. `PENDIENTE` es el caso claro: la
 * suscripción se creó y el pagador todavía no autorizó el medio de pago. Mover
 * el estado comercial ahí sería darle acceso a alguien que no completó el alta,
 * o quitárselo a alguien que está a mitad del trámite.
 */
export type ConsecuenciaComercial =
  /** No cambia nada en el estado comercial. Se registra y se sigue. */
  | { readonly tipo: 'SIN_CAMBIO'; readonly motivo: string }
  /** Corresponde llevar la suscripción a este estado, si la transición vale. */
  | { readonly tipo: 'TRANSICION'; readonly hacia: EstadoDeSuscripcion; readonly motivo: string };

export function consecuenciaDeSuscripcion(
  externo: EstadoExternoDeSuscripcion,
): ConsecuenciaComercial {
  switch (externo) {
    case 'PENDIENTE':
      return {
        tipo: 'SIN_CAMBIO',
        motivo:
          'La suscripción existe en la pasarela y el pagador todavía no autorizó el medio de ' +
          'pago. No es ni un alta ni una baja: es un trámite a mitad de camino.',
      };

    case 'AUTORIZADA':
      return {
        tipo: 'TRANSICION',
        hacia: 'ACTIVA',
        motivo: 'La pasarela autorizó el medio de pago: hay con qué cobrar los períodos.',
      };

    case 'PAUSADA':
      // Pausada NO es cancelada, y la diferencia es la que hace que se pueda
      // volver: `SUSPENDIDA → ACTIVA` existe en la máquina de estados,
      // `CANCELADA → ACTIVA` no.
      return {
        tipo: 'TRANSICION',
        hacia: 'SUSPENDIDA',
        motivo:
          'La pasarela dejó de cobrar. Se suspende, que conserva los datos y se levanta ' +
          'reactivando: cancelar sería una decisión del cliente y de ahí no se vuelve.',
      };

    case 'CANCELADA':
      // Y acá está la decisión que más importa de este archivo.
      //
      // La tentación es mapear `cancelled` a `CANCELADA`. Es incorrecta: que el
      // medio de pago deje de estar autorizado —una tarjeta vencida, un cliente
      // que la dio de baja en la app del banco— no es que el cliente haya
      // decidido irse de NEXO. `NEXO_BILLING.md` §9 es explícito: cancelar es
      // una decisión de la empresa cliente, no una consecuencia automática de
      // no haber pagado, y de `CANCELADA` no se vuelve.
      //
      // Así que se suspende. Si el cliente efectivamente se quiere ir, alguien
      // lo cancela a mano y queda registrado quién.
      return {
        tipo: 'TRANSICION',
        hacia: 'SUSPENDIDA',
        motivo:
          'La pasarela ya no tiene autorización para cobrar. Se SUSPENDE y no se cancela: ' +
          'cancelar es una decisión del cliente, no la consecuencia de una tarjeta vencida, ' +
          'y de CANCELADA no se vuelve.',
      };
  }
}

/**
 * Los estados de un cobro tal como los informan las pasarelas.
 *
 * Se normalizan en el adaptador; acá se traducen al vocabulario del motor.
 */
export type EstadoExternoDePago =
  | 'APROBADO'
  | 'AUTORIZADO'
  | 'PENDIENTE'
  | 'EN_PROCESO'
  | 'RECHAZADO'
  | 'CANCELADO'
  | 'DEVUELTO'
  | 'CONTRACARGO';

export function estadoDePagoDesde(externo: EstadoExternoDePago): EstadoDePago {
  switch (externo) {
    case 'APROBADO':
      return 'PAGADO';
    case 'AUTORIZADO':
      // Autorizado no es cobrado: la plata está retenida y todavía no
      // acreditada. `payment_intents` distingue los dos, y por eso hay una
      // transición `AUTORIZADO → PAGADO`.
      return 'AUTORIZADO';
    case 'PENDIENTE':
    case 'EN_PROCESO':
      return 'PENDIENTE';
    case 'RECHAZADO':
    case 'CANCELADO':
      // Un cobro cancelado antes de acreditarse es, para el billing, lo mismo
      // que uno rechazado: no entró la plata. Lo que los distingue —quién lo
      // canceló— queda en el detalle del evento.
      return 'FALLIDO';
    case 'DEVUELTO':
      return 'REEMBOLSADO';
    case 'CONTRACARGO':
      return 'CONTRACARGO';
  }
}

/**
 * ¿Este fallo del proveedor amerita volver a intentarlo solo?
 *
 * El criterio es el mismo que en la emisión fiscal, y por el mismo motivo: no
 * se reintenta lo que pudo haber pasado. Un timeout después de mandar un cobro
 * puede haber cobrado, y reintentarlo cobraría dos veces.
 *
 * La política de cobranza —cuántas veces, con cuánta espera— **no vive acá**:
 * vive en `collection_policies`, que ya existe. Esto solo dice si el fallo es de
 * los que pueden salir distinto.
 */
export type CodigoDeFalloDePago =
  | 'TIMEOUT'
  | 'CREDENCIAL_RECHAZADA'
  | 'NO_ENCONTRADO'
  | 'CONFLICTO'
  | 'LIMITE_DE_TASA'
  | 'PEDIDO_INVALIDO'
  | 'PROVEEDOR_CAIDO'
  | 'RESPUESTA_ILEGIBLE'
  | 'RED'
  | 'SIN_PASARELA';

export function reintentable(codigo: CodigoDeFalloDePago): boolean {
  // `RED` sí: la conexión no llegó a abrirse, así que el cobro no salió.
  // `TIMEOUT` no: se transmitió y no se sabe qué pasó.
  return codigo === 'LIMITE_DE_TASA' || codigo === 'PROVEEDOR_CAIDO' || codigo === 'RED';
}

/**
 * Lo mismo, pero para una llamada que **cambia algo del otro lado**.
 *
 * Es más estricto, y la diferencia es exactamente `PROVEEDOR_CAIDO`.
 *
 * Un 500 al consultar una suscripción no hizo nada: se vuelve a preguntar y a lo
 * sumo se pierde un segundo. Un 500 al *crear* una suscripción es ambiguo —el
 * error pudo ocurrir después de haberla creado, mientras el proveedor armaba la
 * respuesta— y repetirlo deja dos suscripciones cobrándole a la misma empresa.
 *
 * Los dos que quedan son los que sí se pueden afirmar:
 *
 *     LIMITE_DE_TASA  429 se rechaza **antes** de procesar. No pasó nada.
 *     RED             la conexión no se abrió. El pedido no salió.
 *
 * `TIMEOUT` no está en ninguna de las dos listas, por el mismo motivo de
 * siempre: no dice que no haya pasado, dice que no se sabe.
 */
export function reintentableEnEscritura(codigo: CodigoDeFalloDePago): boolean {
  return codigo === 'LIMITE_DE_TASA' || codigo === 'RED';
}

/**
 * ¿El fallo lo arregla quien administra la instalación, o es del cobro?
 *
 * Sirve para no mandar a revisar una tarjeta cuando lo que caducó es el token
 * de la cuenta de NEXO.
 */
export function esProblemaDeConfiguracion(codigo: CodigoDeFalloDePago): boolean {
  return codigo === 'CREDENCIAL_RECHAZADA' || codigo === 'SIN_PASARELA';
}
