/**
 * Lo que hace el operador con las notificaciones que dejó el webhook.
 *
 * ## Dónde está el corte
 *
 * La ruta pública guardó una fila y no aplicó nada. Acá se aplica, y la
 * diferencia que importa es de dónde sale la información:
 *
 *     la ruta   leyó un JSON que mandó alguien de afuera
 *     esto      le pregunta a la pasarela, con la credencial de NEXO
 *
 * De la fila se usa **un solo campo**: `recurso_id`, que dice qué preguntar.
 * Nada de lo que el remitente escribió en el cuerpo llega a mover un cobro.
 *
 * ## Por qué corre como operador y no dentro de la API
 *
 * Porque escribe en `payment_intents` y en `payment_events`, y `aai_app` no
 * puede —tiene `SELECT` sobre la primera y nada sobre la segunda (0096, S-29)—.
 * Ese candado es lo que impide que un cliente se marque un cargo como pagado, y
 * abrirlo para esto lo abriría para toda la API.
 *
 * ## El primer cobro de una suscripción no tiene intento previo
 *
 * Es la consecuencia menos obvia de cobrar con `preapproval`, y hay que decirla
 * porque cambia el diseño: **NEXO no inicia el cobro**. Autoriza el medio de
 * pago una vez y después Mercado Pago debita solo, cada mes, sin avisar antes.
 * Así que cuando llega la notificación de un pago no existe ningún
 * `payment_intent` con esa referencia — lo habría creado quien inició el cobro,
 * y nadie de este lado lo inició.
 *
 * `procesarEventoDePago` contestaría `DESCONOCIDO` para siempre y ningún cobro
 * se registraría nunca. Por eso, cuando el pago se puede **atribuir** a un
 * documento emitido, se crea el intento antes de aplicarle el evento. Atribuir
 * quiere decir: la pasarela dice de qué suscripción salió, esa suscripción es
 * de NEXO, y tiene un documento emitido esperando cobro.
 *
 * Lo que no se puede atribuir no se inventa: queda `SIN_EFECTO` con el motivo, y
 * el evento igual se registra. Un cobro que entró y que NEXO no supo a qué
 * imputar es exactamente la clase de cosa que tiene que quedar escrita.
 *
 * ## El primer cobro llega antes que el documento
 *
 * Mercado Pago debita en el momento en que el cliente autoriza, y el documento
 * lo emite el ciclo diario, horas después. Si eso se leyera como «no se puede
 * atribuir», el primer cobro de **cada** cliente quedaría sin imputar para
 * siempre. Por eso, cuando la suscripción es de NEXO y sigue viva pero todavía
 * no tiene documento, la fila queda `EN_ESPERA`: sigue `PENDIENTE` en la base y
 * se vuelve a mirar cada hora, hasta `PLAZO_DE_ESPERA_HORAS` desde que llegó. Si
 * para entonces no apareció el documento, ya no es demora del ciclo: queda
 * `SIN_EFECTO` como cualquier cobro que no se pudo atribuir.
 *
 * ## El importe del intento es el de NEXO, no el de la pasarela
 *
 * `PagoExterno` no trae importe **a propósito** (ver `mercadopago.ts`): leerlo
 * obligaría a convertir un número JSON a centavos, o sea a multiplicar un
 * `double` por cien. El intento se crea con el importe del documento, que salió
 * de `plan_prices` en centavos y nunca fue flotante.
 *
 * Que los dos importes coincidan es otra pregunta, y tiene su propia respuesta:
 * `work_queue_pasarela` (0118) compara lo acordado con lo que el plan externo
 * declara y lo pone en la bandeja de trabajo cuando difieren.
 */

import type { Tx } from '@aai/db';
import { consecuenciaDeSuscripcion, puedeTransicionar } from '@aai/billing-engine';
import type { EstadoDeSuscripcion } from '@aai/billing-engine';
import { hoyEnZonaDeNegocio } from '@aai/shared';
import {
  procesarEventoDePago,
  saldarDocumento,
  type ResultadoDeEvento,
} from '../billing/ciclo.js';
import { anotarProximoCobro } from './suscripcion.js';
import type { ProveedorDePagos } from './puerto.js';

/**
 * Los tipos de notificación que se saben tratar.
 *
 * Mapa cerrado y sin `default`, por el mismo motivo que los estados en el
 * adaptador: un tipo que la pasarela agregue mañana tiene que salir por
 * «no sé qué es esto» y quedar registrado, no ser tratado como el más parecido.
 */
const QUE_ES: Readonly<Record<string, 'PAGO' | 'SUSCRIPCION' | 'IGNORAR'>> = {
  payment: 'PAGO',
  // El débito automático de una suscripción. Se trata como un pago, pero su id
  // NO es el de un pago: se consulta como «pago autorizado» y de ahí sale el
  // pago que lo respalda (`consultarPagoAutorizado`).
  subscription_authorized_payment: 'PAGO',
  subscription_preapproval: 'SUSCRIPCION',
  // Un cambio en el catálogo de planes del proveedor. No afecta a ninguna
  // empresa por sí solo: lo que se le cobra a cada una sale del mapeo, que lo
  // declara una persona.
  subscription_preapproval_plan: 'IGNORAR',
};

/**
 * `EN_ESPERA` no es un estado de la base: la fila sigue `PENDIENTE` y se vuelve
 * a mirar. Ver «El primer cobro llega antes que el documento».
 */
export type DesenlaceDeFila = 'APLICADO' | 'SIN_EFECTO' | 'FALLIDO' | 'EN_ESPERA';

/**
 * Cuánto se espera el documento de un cobro que llegó primero. El ciclo emite
 * una vez por día; tres días cubren un ciclo que no corrió sin dejar que un
 * cobro de verdad huérfano se reintente para siempre.
 */
export const PLAZO_DE_ESPERA_HORAS = 72;

/** Cada cuánto se vuelve a mirar una fila en espera. */
const REINTENTO_DE_ESPERA = '1 hour';

export interface FilaDeBandeja {
  readonly id: string;
  readonly proveedor: string;
  readonly ambiente: string;
  readonly evento_externo: string;
  readonly tipo: string;
  readonly accion: string | null;
  readonly recurso_id: string;
  readonly recibido_el: Date;
}

export interface ResultadoDeFila {
  readonly id: string;
  readonly desenlace: DesenlaceDeFila;
  readonly detalle: string;
}

/**
 * Aplica una fila de la bandeja.
 *
 * No la marca: quien llama decide si confirma. Separarlo es lo que permite
 * correrlo en modo ensayo.
 */
export async function aplicarFila(
  tx: Tx,
  fila: FilaDeBandeja,
  proveedor: ProveedorDePagos,
  ambienteConfigurado: string,
): Promise<ResultadoDeFila> {
  const dicho = (desenlace: DesenlaceDeFila, detalle: string): ResultadoDeFila => ({
    id: fila.id,
    desenlace,
    detalle,
  });

  if (fila.ambiente !== ambienteConfigurado) {
    // No se consulta. Preguntar por un recurso de la otra cuenta da 404, y ese
    // 404 se leería como «ese cobro no existe» — que es lo contrario de lo que
    // pasa.
    //
    // Queda `FALLIDO`, o sea que no se reintenta sola. Es deliberado: que
    // lleguen notificaciones de otro ambiente significa que la instalación
    // cambió de cuenta o que dos instalaciones comparten una, y ninguna de las
    // dos se arregla esperando. Tiene que mirarlo una persona.
    return dicho(
      'FALLIDO',
      `La notificación llegó al ambiente "${fila.ambiente}" y la instalación corre en ` +
        `"${ambienteConfigurado}". No se consultó: la referencia pertenece a otra cuenta.`,
    );
  }

  if (fila.proveedor !== proveedor.id) {
    return dicho(
      'FALLIDO',
      `La notificación es de "${fila.proveedor}" y la pasarela configurada es ` +
        `"${proveedor.id}". No se consultó.`,
    );
  }

  const que = QUE_ES[fila.tipo];

  if (que === undefined) {
    return dicho(
      'SIN_EFECTO',
      `Tipo de notificación no reconocido: "${fila.tipo}". No se interpretó nada. ` +
        'Queda registrada por si hace falta mirarla.',
    );
  }

  if (que === 'IGNORAR') {
    return dicho(
      'SIN_EFECTO',
      `"${fila.tipo}" habla del catálogo de planes del proveedor y no de ninguna empresa. ` +
        'Lo que se le cobra a cada una sale del mapeo declarado.',
    );
  }

  return que === 'PAGO'
    ? aplicarPago(tx, fila, proveedor, dicho)
    : aplicarSuscripcion(tx, fila, proveedor, dicho);
}

type Dicho = (desenlace: DesenlaceDeFila, detalle: string) => ResultadoDeFila;

async function aplicarPago(
  tx: Tx,
  fila: FilaDeBandeja,
  proveedor: ProveedorDePagos,
  dicho: Dicho,
): Promise<ResultadoDeFila> {
  // El débito de una suscripción no es un pago: su id es el de un «pago autorizado».
  const consulta =
    fila.tipo === 'subscription_authorized_payment' && proveedor.consultarPagoAutorizado
      ? await proveedor.consultarPagoAutorizado(fila.recurso_id)
      : await proveedor.consultarPago(fila.recurso_id);
  if (!consulta.ok) {
    return dicho(
      'FALLIDO',
      `No se pudo consultar el pago (${consulta.fallo.codigo}): ${consulta.fallo.detalle}`,
    );
  }
  if (consulta.valor === null) {
    // No es FALLIDO: no se movió plata, y un FALLIDO por mes y por cliente
    // haría que la tarea saliera con error sin que haya nada que mirar.
    return dicho(
      'SIN_EFECTO',
      `El débito ${fila.recurso_id} está agendado y todavía no se cobró. El cobro llega en su ` +
        'propio aviso.',
    );
  }
  const pago = consulta.valor;

  // ¿Hay ya un intento con esta referencia? Si lo hay, esto es una
  // actualización de un cobro conocido y no hay nada que crear.
  const existente = await tx.query<{ id: string }>(
    'SELECT id FROM payment_intents WHERE proveedor = $1 AND referencia_externa = $2',
    [proveedor.id, pago.id],
  );

  if (existente.rows[0] === undefined) {
    const creado = await crearIntentoParaElPago(tx, proveedor.id, pago, fila.recibido_el);
    if (creado !== null) return dicho(creado.desenlace, creado.detalle);
  }

  const salida = await procesarEventoDePago(tx, {
    proveedor: proveedor.id,
    eventoExterno: fila.evento_externo,
    tipo: fila.accion ?? fila.tipo,
    estadoInformado: pago.estado,
    referenciaExterna: pago.id,
    // Por qué lo rechazó, en las palabras del proveedor. La base lo exige para
    // guardar un `FALLIDO` y hasta B2.5.6 no se lo pasaba nadie: el primer
    // rechazo rompía esta transacción y con ella todo el drenaje.
    detalleDelFallo: pago.detalleDelFallo ?? null,
  });

  // Los cinco desenlaces se conservan tal cual en el detalle. Colapsarlos
  // borraría la diferencia entre «se aplicó» y «llegó tarde y no se aplicó»,
  // que es justamente lo que alguien va a querer saber dentro de seis meses.
  const traduccion: Readonly<Record<ResultadoDeEvento, DesenlaceDeFila>> = {
    APLICADO: 'APLICADO',
    REPETIDO: 'SIN_EFECTO',
    ATRASADO: 'SIN_EFECTO',
    DESCONOCIDO: 'SIN_EFECTO',
    CONFLICTO: 'SIN_EFECTO',
  };

  // Un intento PAGADO salda su documento, por el mismo paso que el registro a
  // mano. Se mira el estado del intento y no solo si este evento se aplicó: así
  // un aviso repetido termina de saldar un documento que una versión anterior
  // dejó EMITIDO con el intento ya PAGADO.
  const saldado = await saldarSiEstaPagado(tx, proveedor.id, salida.intentId);

  return dicho(
    saldado === null ? traduccion[salida.resultado] : 'APLICADO',
    `El pago ${pago.id} está ${pago.estado} según la pasarela. ` +
      `procesarEventoDePago: ${salida.resultado}.` +
      (saldado === null
        ? ''
        : ` El documento quedó PAGADO${saldado.reactivada ? ' y la suscripción volvió a ACTIVA' : ''}.`),
  );
}

async function saldarSiEstaPagado(
  tx: Tx,
  proveedor: string,
  intentId: string | null,
): Promise<{ readonly reactivada: boolean } | null> {
  if (intentId === null) return null;
  const intento = await tx.query<{ estado: string; document_id: string | null }>(
    'SELECT estado, document_id FROM payment_intents WHERE id = $1',
    [intentId],
  );
  const i = intento.rows[0];
  if (i === undefined || i.estado !== 'PAGADO' || i.document_id === null) return null;
  return saldarDocumento(tx, {
    documentId: i.document_id,
    proveedor,
    actorId: 'system:pagos-bandeja',
    pagadoEl: hoyEnZonaDeNegocio(),
  });
}

/**
 * Crea el intento que la pasarela nunca pidió, si el pago se puede atribuir.
 *
 * Devuelve `null` cuando lo creó, o el desenlace y su motivo cuando no se pudo.
 * El motivo es lo que va a leer quien mire la bandeja, así que dice qué falta y
 * no solo que falló.
 */
async function crearIntentoParaElPago(
  tx: Tx,
  proveedor: string,
  pago: { readonly id: string; readonly suscripcionExternaId?: string | null },
  recibidoEl: Date,
): Promise<{ readonly desenlace: DesenlaceDeFila; readonly detalle: string } | null> {
  if (pago.suscripcionExternaId === null || pago.suscripcionExternaId === undefined) {
    return {
      desenlace: 'SIN_EFECTO',
      detalle:
        `El pago ${pago.id} no dice de qué suscripción salió: no se puede atribuir a ningún ` +
        'documento. Se registró el evento y no se creó ningún intento.',
    };
  }

  // El documento emitido más viejo de esa suscripción. El más viejo y no el más
  // nuevo: la pasarela cobra en orden, y aplicar un cobro contra el documento
  // más reciente dejaría el más antiguo impago para siempre mientras la deuda
  // total daba cero.
  const doc = await tx.query<{
    id: string;
    company_id: string;
    moneda: string;
    importe: string;
  }>(
    // `importe_total` y no `importe`: el cargo incluye los impuestos, que están
    // además desglosados en su propia columna. Imputar un cobro contra el neto
    // dejaría la diferencia como saldo impago para siempre.
    `SELECT d.id, d.company_id, d.moneda, d.importe_total::text AS importe
       FROM billing_documents d
       JOIN company_subscriptions s ON s.id = d.subscription_id
      WHERE s.referencia_externa = $1
        AND s.proveedor_pago = $2
        AND d.estado = 'EMITIDO'
      ORDER BY d.created_at
      LIMIT 1`,
    [pago.suscripcionExternaId, proveedor],
  );

  const d = doc.rows[0];
  if (d === undefined) {
    // ¿Es el primer cobro, que llegó antes que el documento? Solo si la
    // suscripción es de NEXO y no está cancelada: de una cancelada no va a salir
    // ningún documento, y de una ajena tampoco.
    const viva = await tx.query(
      `SELECT 1 FROM company_subscriptions
        WHERE referencia_externa = $1 AND proveedor_pago = $2 AND estado <> 'CANCELADA'`,
      [pago.suscripcionExternaId, proveedor],
    );
    const horas = (Date.now() - recibidoEl.getTime()) / 3_600_000;
    if ((viva.rowCount ?? 0) > 0 && horas < PLAZO_DE_ESPERA_HORAS) {
      return {
        desenlace: 'EN_ESPERA',
        detalle:
          `El pago ${pago.id} corresponde a la suscripción ${pago.suscripcionExternaId}, que ` +
          'todavía no tiene documento emitido: la pasarela cobra al autorizar y el ciclo ' +
          `emite después. Se vuelve a mirar cada hora hasta ${PLAZO_DE_ESPERA_HORAS} h ` +
          'desde que llegó.',
      };
    }
    return {
      desenlace: 'SIN_EFECTO',
      detalle:
        `El pago ${pago.id} corresponde a la suscripción ${pago.suscripcionExternaId}, que no ` +
        'tiene ningún documento emitido esperando cobro. Se registró el evento y no se creó ' +
        'ningún intento: imputarlo a un documento que no existe sería inventar la deuda que ' +
        'cancela.',
    };
  }

  await tx.query(
    `INSERT INTO payment_intents
       (company_id, document_id, proveedor, referencia_externa, moneda, importe,
        idempotency_key, estado)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, 'PENDIENTE')`,
    [
      d.company_id,
      d.id,
      proveedor,
      pago.id,
      d.moneda,
      // El importe del documento, no el de la pasarela. Ver el encabezado.
      d.importe,
      // La referencia del pago **es** la clave de idempotencia natural: el mismo
      // pago no puede generar dos intentos, y el UNIQUE de la 0096 lo garantiza
      // aunque dos corridas del proceso se pisen.
      `${proveedor}:${pago.id}`,
    ],
  );

  return null;
}

async function aplicarSuscripcion(
  tx: Tx,
  fila: FilaDeBandeja,
  proveedor: ProveedorDePagos,
  dicho: Dicho,
): Promise<ResultadoDeFila> {
  const consulta = await proveedor.consultarSuscripcion(fila.recurso_id);
  if (!consulta.ok) {
    return dicho(
      'FALLIDO',
      `No se pudo consultar la suscripción (${consulta.fallo.codigo}): ${consulta.fallo.detalle}`,
    );
  }

  const sub = await tx.query<{ id: string; company_id: string; estado: EstadoDeSuscripcion }>(
    `SELECT id, company_id, estado FROM company_subscriptions
      WHERE referencia_externa = $1 AND proveedor_pago = $2`,
    [consulta.valor.id, proveedor.id],
  );
  const s = sub.rows[0];

  // Cada notificación es una oportunidad de saber cuándo va a cobrar el
  // proveedor, y se aprovecha aunque el aviso no mueva ningún estado. Sin esto
  // la fecha se anotaría solo al conectar, y la divergencia de calendario
  // —que aparece **después**, cuando los dos relojes avanzan por separado— no
  // se vería nunca.
  if (s !== undefined) {
    await anotarProximoCobro(tx, s.id, consulta.valor.proximoCobro);
  }

  if (s === undefined) {
    return dicho(
      'SIN_EFECTO',
      `La pasarela informa la suscripción ${consulta.valor.id}, que no está vinculada a ` +
        'ninguna empresa de NEXO. Puede ser de otra instalación sobre la misma cuenta.',
    );
  }

  const consecuencia = consecuenciaDeSuscripcion(consulta.valor.estado);

  if (consecuencia.tipo === 'SIN_CAMBIO') {
    return dicho('SIN_EFECTO', consecuencia.motivo);
  }

  if (s.estado === consecuencia.hacia) {
    return dicho('SIN_EFECTO', `La suscripción ya estaba ${s.estado}.`);
  }

  if (!puedeTransicionar(s.estado, consecuencia.hacia)) {
    // La máquina de estados manda sobre la pasarela. El caso real es una
    // suscripción ya CANCELADA en NEXO —una decisión que tomó el cliente— sobre
    // la que la pasarela sigue mandando avisos: de CANCELADA no se vuelve, y
    // que un webhook la reactivara le devolvería el servicio a alguien que se dio
    // de baja.
    return dicho(
      'SIN_EFECTO',
      `La pasarela informa ${consulta.valor.estado} y la suscripción está ${s.estado}: ` +
        `de ${s.estado} no se pasa a ${consecuencia.hacia}. No se aplicó.`,
    );
  }

  if (consecuencia.hacia === 'ACTIVA' && (s.estado === 'MOROSA' || s.estado === 'SUSPENDIDA')) {
    // Que la pasarela tenga autorización para cobrar no quiere decir que se
    // haya cobrado. Con la tarjeta rechazada, Mercado Pago sigue `authorized` y
    // reintenta, y avisa cambios de la suscripción por otros motivos: si cada
    // aviso reactivara, la mora y la suspensión se levantarían solas con la
    // deuda abierta. La regla es la de `saldarDocumento`: se vuelve a ACTIVA
    // cuando no queda nada emitido sin pagar.
    const deuda = await tx.query(
      `SELECT 1 FROM billing_documents WHERE subscription_id = $1 AND estado = 'EMITIDO' LIMIT 1`,
      [s.id],
    );
    if ((deuda.rowCount ?? 0) > 0) {
      return dicho(
        'SIN_EFECTO',
        `La pasarela informa ${consulta.valor.estado} y la suscripción está ${s.estado} con ` +
          'deuda emitida sin pagar. Tener con qué cobrar no es haber cobrado: se reactiva ' +
          'cuando entre el cobro.',
      );
    }
  }

  // `motivo` es obligatorio para SUSPENDIDA y CANCELADA (`cs_baja_con_motivo`,
  // 0073). No es burocracia: sin él, la pantalla del cliente diría que su
  // servicio está suspendido y no por qué. Al volver a ACTIVA se limpian las
  // marcas de la baja, como en `saldarDocumento`.
  await tx.query(
    `UPDATE company_subscriptions
        SET estado = $1,
            motivo = CASE WHEN $1 = 'ACTIVA' THEN NULL ELSE $2 END,
            suspendida_el = CASE WHEN $1 = 'SUSPENDIDA' THEN $5::date
                                 WHEN $1 = 'ACTIVA' THEN NULL
                                 ELSE suspendida_el END,
            morosa_desde = CASE WHEN $1 = 'ACTIVA' THEN NULL ELSE morosa_desde END
      WHERE id = $3 AND estado = $4`,
    [consecuencia.hacia, consecuencia.motivo.slice(0, 500), s.id, s.estado, hoyEnZonaDeNegocio()],
  );

  return dicho(
    'APLICADO',
    `La suscripción pasó de ${s.estado} a ${consecuencia.hacia}. ${consecuencia.motivo}`,
  );
}

/**
 * Drena la bandeja entera.
 *
 * Cada fila se marca con lo que le pasó **en la misma transacción** en la que se
 * aplicó. Si el proceso muere a la mitad, lo aplicado queda aplicado y lo
 * pendiente sigue pendiente: no hay estado intermedio donde un cobro se haya
 * registrado y la fila siga diciendo que falta.
 */
export async function drenarBandeja(
  tx: Tx,
  proveedor: ProveedorDePagos,
  ambienteConfigurado: string,
  limite = 200,
): Promise<ResultadoDeFila[]> {
  const { rows } = await tx.query<FilaDeBandeja>(
    // `procesado_el` en una fila PENDIENTE quiere decir que está en espera: se
    // vuelve a mirar cuando pasó el intervalo, no en cada corrida.
    `SELECT id, proveedor, ambiente, evento_externo, tipo, accion, recurso_id, recibido_el
       FROM payment_webhook_inbox
      WHERE estado = 'PENDIENTE'
        AND (procesado_el IS NULL OR procesado_el < now() - $2::interval)
      ORDER BY recibido_el
      LIMIT $1`,
    [limite, REINTENTO_DE_ESPERA],
  );

  const hechos: ResultadoDeFila[] = [];

  for (const fila of rows) {
    const resultado = await aplicarFila(tx, fila, proveedor, ambienteConfigurado);

    await tx.query(
      `UPDATE payment_webhook_inbox
          SET estado = $1, detalle = $2, procesado_el = now(), intentos = intentos + 1
        WHERE id = $3`,
      [
        resultado.desenlace === 'EN_ESPERA' ? 'PENDIENTE' : resultado.desenlace,
        resultado.detalle,
        fila.id,
      ],
    );

    hechos.push(resultado);
  }

  return hechos;
}
