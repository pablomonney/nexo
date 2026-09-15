/**
 * Conectar una suscripción de NEXO con la pasarela.
 *
 * Es el eslabón que faltaba. El adaptador sabía crear el `preapproval` desde
 * B2.5.5 y **no lo llamaba nadie**: el puerto y el adaptador estaban completos,
 * el mapeo de planes estaba, el webhook estaba, y entre «la empresa acordó un
 * precio» y «Mercado Pago le debita» no había ninguna línea de código.
 *
 * ## Qué hace, en una frase
 *
 * Le pide a la pasarela una suscripción contra el plan externo que corresponde,
 * guarda la referencia que devuelve, y entrega la URL donde el cliente autoriza
 * su medio de pago. **NEXO no toca la tarjeta**: esa URL es del proveedor, y lo
 * único que vuelve de ahí es un identificador opaco.
 *
 * ## Por qué esto sí puede vivir en una petición HTTP y crear el plan no
 *
 * `declarar-plan-de-pasarela.mjs` argumenta —bien— que crear un *plan* del lado
 * del proveedor no puede pasar en una petición: el reintento de cualquier pedido
 * crearía un segundo plan, y a partir de ahí habría dos precios vivos para lo
 * mismo. Suscribir es distinto en los dos extremos de ese argumento:
 *
 *   · **Ocurre por cliente y a pedido del cliente.** Un plan se crea una vez en
 *     la vida del producto; una suscripción se crea cada vez que alguien
 *     contrata. Mandarla a un comando del operador significa que nadie puede
 *     contratar sin que una persona corra algo a mano.
 *   · **El duplicado se puede impedir de verdad.** La referencia de NEXO que
 *     viaja es el `id` de la suscripción, que ya existe y es estable, así que la
 *     clave de idempotencia del proveedor es la misma en cada reintento. Y de
 *     este lado la fila se bloquea antes de mirar, así que dos pedidos
 *     simultáneos no pueden ver los dos que falta conectar.
 *
 * ## La transacción se queda abierta mientras se llama al proveedor
 *
 * Es el costo de bloquear la fila, y se paga a conciencia. La alternativa
 * —llamar primero y bloquear después— deja una ventana en la que dos pedidos
 * crean dos `preapproval` para la misma empresa, y eso es dos débitos mensuales
 * al mismo cliente. El límite está acotado: la llamada tiene `timeoutMs` y el
 * volumen de esta ruta es una petición por empresa en toda su vida.
 *
 * ## Si el proveedor crea la suscripción y la escritura de acá falla
 *
 * Queda un `preapproval` huérfano del otro lado, en estado `pending` — o sea, sin
 * medio de pago autorizado y sin cobrar nada. El reintento manda la **misma**
 * `x-idempotency-key`, así que Mercado Pago devuelve el que ya creó en vez de
 * crear otro. No es una garantía absoluta y no se la presenta como tal: es la
 * razón por la que el estado `pending` importa, porque un huérfano en ese estado
 * no le cobra a nadie.
 *
 * ## Las tres columnas se escriben juntas, y no por prolijidad
 *
 * `cs_pasarela_completa` (0118) exige que `referencia_externa`, `proveedor_pago`
 * y `ambiente_pago` estén las tres o ninguna. Este módulo es el único lugar del
 * sistema que las escribe, y las escribe en un solo `UPDATE`. Ver
 * `routes/suscripciones.ts`: la ruta que antes aceptaba una referencia suelta
 * dejó de aceptarla, porque una referencia sin dueño ni ambiente apunta a un
 * recurso que nadie puede consultar.
 */

import type { Tx } from '@aai/db';
import { recordAudit } from '@aai/db';
import { config } from '../config.js';
import { crearProveedorDePagos } from './fabrica.js';
import type {
  EstadoExternoDeSuscripcion,
  ProveedorDePagos,
  SuscripcionExterna,
} from './puerto.js';

export interface OpcionesDeConexion {
  /** Se inyecta en los tests. En producción sale de la configuración. */
  readonly proveedor?: ProveedorDePagos;
  readonly ambienteConfigurado?: string;
  readonly urlDeRetorno?: string | null;
}

export type MotivoDeNoConexion =
  | 'SIN_PASARELA'
  | 'SIN_URL_DE_RETORNO'
  | 'SUSCRIPCION_INEXISTENTE'
  | 'SIN_CONDICIONES_ACORDADAS'
  | 'ESTADO_NO_CONTRATABLE'
  | 'SIN_PLAN_EN_LA_PASARELA'
  | 'LA_PASARELA_RECHAZO';

export type ResultadoDeConexion =
  | {
      readonly estado: 'CONECTADA';
      readonly referenciaExterna: string;
      readonly proveedor: string;
      readonly ambiente: string;
      /** A dónde mandar al cliente para que autorice. */
      readonly urlDeAutorizacion: string | null;
      readonly estadoEnLaPasarela: string;
    }
  | {
      readonly estado: 'YA_ESTABA';
      readonly referenciaExterna: string;
      readonly proveedor: string;
      readonly ambiente: string;
      readonly urlDeAutorizacion: string | null;
      readonly estadoEnLaPasarela: string | null;
      readonly detalle: string;
    }
  | { readonly estado: 'NO_SE_PUDO'; readonly motivo: MotivoDeNoConexion; readonly detalle: string };

interface FilaDeSuscripcion {
  readonly id: string;
  readonly plan_id: string;
  readonly plan_code: string;
  readonly estado: string;
  readonly periodicidad: string | null;
  readonly moneda: string | null;
  readonly importe_acordado: string | null;
  readonly referencia_externa: string | null;
  readonly proveedor_pago: string | null;
  readonly ambiente_pago: string | null;
}

/**
 * Conecta la suscripción vigente de una empresa con la pasarela.
 *
 * `correoDelPagador` es el de quien está contratando. El proveedor lo exige para
 * identificar al pagador de su lado; **no es la clave** —eso es
 * `external_reference`, que lleva el `id` de la suscripción— y por eso que la
 * persona cambie de correo después no rompe nada.
 */
export async function conectarConLaPasarela(
  tx: Tx,
  entrada: {
    readonly companyId: string;
    readonly correoDelPagador: string;
    readonly actorId: string;
  },
  opciones: OpcionesDeConexion = {},
): Promise<ResultadoDeConexion> {
  const proveedor = opciones.proveedor ?? crearProveedorDePagos();
  const ambiente = opciones.ambienteConfigurado ?? config.pagos.ambiente;
  const urlDeRetorno =
    opciones.urlDeRetorno === undefined ? config.pagos.backUrl : opciones.urlDeRetorno;

  if (proveedor.id === 'ninguno') {
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'SIN_PASARELA',
      detalle:
        'Esta instalación no tiene pasarela de pago conectada. El ciclo emite los cargos y ' +
        'la cobranza se registra a mano: contratar no falla, se paga por transferencia.',
    };
  }

  if (urlDeRetorno === null || urlDeRetorno === '') {
    // Se comprueba antes de llamar. El proveedor la exige, así que sin ella la
    // llamada saldría y volvería con un 400 que se leería como «la pasarela
    // rechazó la suscripción» — cuando lo que falta es una variable de acá.
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'SIN_URL_DE_RETORNO',
      detalle:
        'Falta PAYMENTS_BACK_URL: es a dónde vuelve el navegador después de que el cliente ' +
        'autoriza el medio de pago, y sin eso la pasarela no crea la suscripción.',
    };
  }

  /**
   * `FOR UPDATE` sobre la fila, y el resto de la función corre con ese candado.
   *
   * Sin él, dos pedidos simultáneos leen las dos `referencia_externa IS NULL`,
   * las dos llaman al proveedor y la empresa termina con dos suscripciones
   * cobrando. El índice único no la salva: `referencia_externa` no lo tiene, ni
   * puede tenerlo, porque dos instalaciones pueden compartir cuenta.
   */
  const fila = await tx.query<FilaDeSuscripcion>(
    `SELECT s.id, s.plan_id, p.code AS plan_code, s.estado, s.periodicidad, s.moneda,
            s.importe_acordado::text AS importe_acordado,
            s.referencia_externa, s.proveedor_pago, s.ambiente_pago
       FROM company_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.company_id = $1 AND s.estado <> 'CANCELADA'
      ORDER BY s.vigencia_desde DESC
      LIMIT 1
        FOR UPDATE OF s`,
    [entrada.companyId],
  );
  const s = fila.rows[0];

  if (s === undefined) {
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'SUSCRIPCION_INEXISTENTE',
      detalle:
        'Esta empresa no tiene una suscripción vigente que conectar. Una suscripción ' +
        'cancelada no se reconecta: se declara una nueva.',
    };
  }

  // Ya conectada. No se vuelve a llamar al proveedor: crear un segundo
  // `preapproval` le cobraría dos veces a la misma empresa. Se consulta el
  // estado y se devuelve lo que hay, que es lo que quien llama necesita para
  // saber si falta autorizar.
  if (s.referencia_externa !== null) {
    const consulta = await proveedor.consultarSuscripcion(s.referencia_externa);
    return {
      estado: 'YA_ESTABA',
      referenciaExterna: s.referencia_externa,
      proveedor: s.proveedor_pago ?? proveedor.id,
      ambiente: s.ambiente_pago ?? ambiente,
      // `init_point` solo viene al crearla: una consulta posterior no lo trae, y
      // eso no es un fallo. Si el cliente perdió la pestaña, la autorización se
      // retoma desde el panel del proveedor.
      urlDeAutorizacion: consulta.ok ? (consulta.valor.urlDeAutorizacion ?? null) : null,
      estadoEnLaPasarela: consulta.ok ? consulta.valor.estado : null,
      detalle: consulta.ok
        ? `La suscripción ya estaba conectada y la pasarela la reporta ${consulta.valor.estado}.`
        : `La suscripción ya estaba conectada. No se pudo consultar su estado ` +
          `(${consulta.fallo.codigo}): ${consulta.fallo.detalle}`,
    };
  }

  if (s.estado !== 'ACTIVA') {
    // PRUEBA no se conecta: una prueba no tiene precio acordado, así que no hay
    // importe con el que suscribir. El camino es convertirla primero.
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'ESTADO_NO_CONTRATABLE',
      detalle:
        `La suscripción está ${s.estado}. Para conectarla a la pasarela tiene que estar ` +
        'ACTIVA, es decir con plan, periodicidad, moneda e importe acordados: eso es lo que ' +
        'hace la conversión de la prueba.',
    };
  }

  if (s.periodicidad === null || s.moneda === null || s.importe_acordado === null) {
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'SIN_CONDICIONES_ACORDADAS',
      detalle:
        'La suscripción no tiene periodicidad, moneda e importe acordados. Sin las tres no ' +
        'hay con qué suscribir: el importe que cobra la pasarela sale de ahí.',
    };
  }

  const mapa = await tx.query<{ referencia_externa: string }>(
    `SELECT referencia_externa
       FROM payment_plan_map
      WHERE plan_id = $1 AND proveedor = $2 AND ambiente = $3
        AND periodicidad = $4 AND moneda = $5`,
    [s.plan_id, proveedor.id, ambiente, s.periodicidad, s.moneda],
  );
  const planExterno = mapa.rows[0];

  if (planExterno === undefined) {
    // No se crea el plan acá, y es el argumento de `declarar-plan-de-pasarela`:
    // un plan del lado del proveedor define lo que se le va a cobrar a todo el
    // mundo, y no se crea en el medio de una petición HTTP.
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'SIN_PLAN_EN_LA_PASARELA',
      detalle:
        `El plan ${s.plan_code} no tiene un plan creado en ${proveedor.id} (${ambiente}) para ` +
        `${s.periodicidad} ${s.moneda}. Lo declara el operador con: ` +
        `npm run pagos:plan -- ${s.plan_code} ${s.periodicidad} ${s.moneda} "<motivo>"`,
    };
  }

  // A centavos con aritmética de enteros. El importe viene como texto decimal
  // desde `numeric(18,2)` y nunca pasa por punto flotante: es la misma regla que
  // el resto del sistema y la que comprueba `check:no-float`.
  const [entera, decimales] = s.importe_acordado.split('.');
  const centavos = BigInt(entera ?? '0') * 100n + BigInt((decimales ?? '').padEnd(2, '0'));

  const salida = await proveedor.crearSuscripcion({
    referenciaNexo: s.id,
    planExternoId: planExterno.referencia_externa,
    correoDelPagador: entrada.correoDelPagador,
    importeCentavos: centavos,
    moneda: s.moneda,
    urlDeRetorno,
  });

  if (!salida.ok) {
    // No se escribe nada. Guardar una referencia de una suscripción que no se
    // creó dejaría a la empresa marcada como conectada contra un recurso
    // inexistente, y el próximo intento no volvería a crearla porque creería que
    // ya está.
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'LA_PASARELA_RECHAZO',
      detalle: `La pasarela rechazó la suscripción (${salida.fallo.codigo}): ${salida.fallo.detalle}`,
    };
  }

  await guardarReferencia(tx, s.id, salida.valor, proveedor.id, ambiente);

  await recordAudit(tx, entrada.companyId, {
    actorType: 'USER',
    actorId: entrada.actorId,
    action: 'CONECTAR_PASARELA',
    objectType: 'company_subscription',
    objectId: s.id,
    motivo:
      'Se creó la suscripción del lado de la pasarela. El cliente todavía tiene que ' +
      'autorizar su medio de pago.',
    newValue: {
      proveedor: proveedor.id,
      ambiente,
      referencia: salida.valor.id,
      estadoEnLaPasarela: salida.valor.estado,
    },
  });

  return {
    estado: 'CONECTADA',
    referenciaExterna: salida.valor.id,
    proveedor: proveedor.id,
    ambiente,
    urlDeAutorizacion: salida.valor.urlDeAutorizacion ?? null,
    estadoEnLaPasarela: salida.valor.estado,
  };
}

// ── Sincronizar el estado con la pasarela ───────────────────────────────────

/**
 * El estado externo que le corresponde a cada estado comercial de NEXO.
 *
 * Es el mapa inverso de `consecuenciaDeSuscripcion`, y por eso vive acá y no en
 * el motor puro: aquel traduce lo que **informa** la pasarela; este decide qué
 * **pedirle**. No son la misma función invertida —`CANCELADA` de la pasarela se
 * traduce a `SUSPENDIDA` en NEXO, y sin embargo cancelar en NEXO pide cancelar
 * allá— y escribir uno en términos del otro haría que una asimetría deliberada
 * pareciera un error.
 */
const LO_QUE_SE_LE_PIDE: Readonly<
  Record<'ACTIVA' | 'SUSPENDIDA' | 'CANCELADA', EstadoExternoDeSuscripcion>
> = {
  ACTIVA: 'AUTORIZADA',
  SUSPENDIDA: 'PAUSADA',
  CANCELADA: 'CANCELADA',
};

export type MotivoDeNoSincronizacion =
  | 'OTRA_CUENTA'
  | 'NO_SE_PUDO_CONSULTAR'
  | 'LA_PASARELA_RECHAZO'
  | 'NO_SE_PUEDE_REACTIVAR';

export type ResultadoDeSincronizacion =
  | { readonly estado: 'SIN_PASARELA'; readonly detalle: string }
  | { readonly estado: 'YA_ESTABA'; readonly externo: string; readonly detalle: string }
  | { readonly estado: 'SINCRONIZADA'; readonly externo: string; readonly detalle: string }
  | {
      readonly estado: 'NO_SE_PUDO';
      readonly motivo: MotivoDeNoSincronizacion;
      readonly detalle: string;
    };

/**
 * Lleva la suscripción de la pasarela al estado que le corresponde.
 *
 * ## El invariante que esta función existe para sostener
 *
 * **Ninguna suscripción puede quedar cancelada o suspendida en NEXO mientras
 * Mercado Pago le sigue debitando al cliente.** Hasta acá era posible y no
 * costaba nada provocarlo: `POST /subscription/:id/estado` escribía el estado
 * en la base y no le avisaba a nadie. `pausarSuscripcion`, `reactivarSuscripcion`
 * y `cancelarSuscripcion` estaban implementadas en el adaptador desde B2.5.5 y
 * **no las llamaba nadie**.
 *
 * El resultado habría sido un cliente que se da de baja, ve «CANCELADA» en la
 * consola, y sigue viendo el débito en su resumen todos los meses. Eso no es un
 * defecto de software: es plata ajena.
 *
 * ## Por eso se le pide a la pasarela ANTES de escribir en NEXO
 *
 * El orden no es estético. Si primero se escribiera el estado y después fallara
 * la llamada, quedaría exactamente el estado que esto viene a impedir —y
 * quedaría en silencio, porque el cliente ya vería su baja hecha—. Al revés, un
 * fallo deja todo como estaba y se puede reintentar: es recuperable.
 *
 * La consecuencia es que **una pasarela caída impide cancelar**, y hay que
 * decirlo con todas las letras porque suena mal. Es la opción correcta: entre
 * «no pudimos darte de baja, probá de nuevo» y «te dimos de baja y te seguimos
 * cobrando», la primera es un inconveniente y la segunda es un cargo indebido.
 *
 * ## Se consulta antes de pedir, y eso la hace idempotente
 *
 * Reintentar una cancelación sobre algo ya cancelado devolvería un 4xx del
 * proveedor que se leería como «no se pudo cancelar». Preguntando primero, ese
 * caso sale por `YA_ESTABA`, que es un éxito.
 *
 * ## Lo que deliberadamente NO sincroniza
 *
 * **La suspensión por falta de pago** (`avanzarCobranza`) no pausa la pasarela,
 * y es la decisión menos obvia de este módulo. Pausarla cortaría los reintentos
 * de la propia pasarela, que son justamente lo que puede cobrar la deuda: se
 * suspendería el servicio *y* se apagaría la única vía de recuperarlo. Ahí NEXO
 * suspende el acceso y deja que la pasarela siga intentando; cuando el cobro
 * entra, el webhook reactiva.
 *
 * **El vencimiento de una prueba** tampoco, y por un motivo más simple: una
 * prueba no se puede conectar a ninguna pasarela —`conectarConLaPasarela` exige
 * `ACTIVA`— así que no hay nada del otro lado que pausar.
 */
export async function sincronizarEstadoConLaPasarela(
  tx: Tx,
  entrada: {
    readonly subscriptionId: string;
    readonly hacia: 'ACTIVA' | 'SUSPENDIDA' | 'CANCELADA';
  },
  opciones: OpcionesDeConexion = {},
): Promise<ResultadoDeSincronizacion> {
  const proveedor = opciones.proveedor ?? crearProveedorDePagos();
  const ambiente = opciones.ambienteConfigurado ?? config.pagos.ambiente;

  const fila = await tx.query<{
    referencia_externa: string | null;
    proveedor_pago: string | null;
    ambiente_pago: string | null;
  }>(
    `SELECT referencia_externa, proveedor_pago, ambiente_pago
       FROM company_subscriptions WHERE id = $1`,
    [entrada.subscriptionId],
  );
  const s = fila.rows[0];

  if (s === undefined || s.referencia_externa === null) {
    // Lo normal hoy: sin pasarela conectada no hay nada que sincronizar, y el
    // cambio de estado en NEXO no le debe nada a nadie.
    return {
      estado: 'SIN_PASARELA',
      detalle:
        'La suscripción no está conectada a ninguna pasarela: no hay débitos que detener. ' +
        'El cambio de estado solo afecta a NEXO.',
    };
  }

  if (s.proveedor_pago !== proveedor.id || s.ambiente_pago !== ambiente) {
    // Y acá no se sigue. La referencia pertenece a otra cuenta, así que desde
    // esta instalación **no se puede** detener ese débito. Escribir el estado
    // igual sería afirmar una baja que no ocurrió.
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'OTRA_CUENTA',
      detalle:
        `La suscripción está conectada a "${s.proveedor_pago}" en el ambiente ` +
        `"${s.ambiente_pago}", y esta instalación corre "${proveedor.id}" en "${ambiente}". ` +
        'Desde acá no se puede detener ese débito, así que tampoco se cambia el estado: ' +
        'lo tiene que resolver quien administra la instalación.',
    };
  }

  const consulta = await proveedor.consultarSuscripcion(s.referencia_externa);

  if (!consulta.ok) {
    if (consulta.fallo.codigo === 'NO_ENCONTRADO') {
      // La suscripción no existe del otro lado: nada puede debitar. Es el único
      // fallo que no impide seguir, y por eso se lo distingue del resto.
      return {
        estado: 'YA_ESTABA',
        externo: 'inexistente',
        detalle:
          `La pasarela no conoce la suscripción ${s.referencia_externa}: no hay ningún ` +
          'débito que detener. Se sigue con el cambio de estado.',
      };
    }
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'NO_SE_PUDO_CONSULTAR',
      detalle:
        `No se pudo consultar la suscripción en la pasarela (${consulta.fallo.codigo}): ` +
        `${consulta.fallo.detalle}. No se cambió el estado: dejarlo cambiado sin confirmar ` +
        'que la pasarela dejó de cobrar es exactamente lo que no puede pasar.',
    };
  }

  const actual = consulta.valor.estado;
  const objetivo = LO_QUE_SE_LE_PIDE[entrada.hacia];

  if (actual === objetivo) {
    return {
      estado: 'YA_ESTABA',
      externo: actual,
      detalle: `La pasarela ya tenía la suscripción en ${actual}. No se le pidió nada.`,
    };
  }

  if (actual === 'CANCELADA') {
    if (entrada.hacia === 'CANCELADA') {
      // No debería llegar acá —`actual === objetivo` lo atrapa— pero si el
      // vocabulario externo creciera, este caso tiene que seguir siendo un
      // éxito y no un intento de cancelar lo cancelado.
      return {
        estado: 'YA_ESTABA',
        externo: actual,
        detalle: 'La pasarela ya tenía la suscripción cancelada.',
      };
    }
    // Cancelada del otro lado es terminal también del otro lado: Mercado Pago
    // no reactiva un `preapproval` cancelado. Reactivar en NEXO dejaría a la
    // empresa con servicio y sin forma de cobrarle, que es el mismo error del
    // otro signo.
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'NO_SE_PUEDE_REACTIVAR',
      detalle:
        'La suscripción está CANCELADA en la pasarela y de ahí no vuelve: reactivarla en ' +
        'NEXO dejaría a la empresa con el servicio y sin medio de cobro. Hay que conectar ' +
        'una suscripción nueva.',
    };
  }

  const salida =
    entrada.hacia === 'CANCELADA'
      ? await proveedor.cancelarSuscripcion(s.referencia_externa)
      : entrada.hacia === 'SUSPENDIDA'
        ? await proveedor.pausarSuscripcion(s.referencia_externa)
        : await proveedor.reactivarSuscripcion(s.referencia_externa);

  if (!salida.ok) {
    return {
      estado: 'NO_SE_PUDO',
      motivo: 'LA_PASARELA_RECHAZO',
      detalle:
        `La pasarela rechazó el cambio a ${objetivo} (${salida.fallo.codigo}): ` +
        `${salida.fallo.detalle}. No se cambió el estado en NEXO.`,
    };
  }

  return {
    estado: 'SINCRONIZADA',
    externo: salida.valor.estado,
    detalle: `La pasarela pasó la suscripción de ${actual} a ${salida.valor.estado}.`,
  };
}

/**
 * Las tres columnas, en un solo `UPDATE` y con la condición puesta.
 *
 * `referencia_externa IS NULL` en el `WHERE` no es redundante con el
 * `FOR UPDATE`: el candado protege dentro de esta transacción y esto protege de
 * cualquier otro camino que alguna vez escriba la columna. Un `UPDATE` que no
 * afecta ninguna fila es preferible a uno que pisa una referencia viva, porque
 * pisarla dejaría un `preapproval` cobrando sin que NEXO sepa que existe.
 */
async function guardarReferencia(
  tx: Tx,
  subscriptionId: string,
  externa: SuscripcionExterna,
  proveedorId: string,
  ambiente: string,
): Promise<void> {
  await tx.query(
    `UPDATE company_subscriptions
        SET referencia_externa = $2, proveedor_pago = $3, ambiente_pago = $4
      WHERE id = $1 AND referencia_externa IS NULL`,
    [subscriptionId, externa.id, proveedorId, ambiente],
  );
}
