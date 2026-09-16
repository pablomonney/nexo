/**
 * Los cuatro mensajes que manda la cobranza.
 *
 * ## Por qué son cuatro y no uno con variables
 *
 * Porque piden cuatro cosas distintas, y un mensaje que no pide nada concreto
 * no se lee. Mandar el mismo texto tres veces —que es lo único que el modelo
 * anterior permitía, con su único `aviso_en_dias`— le enseña al cliente que
 * este remitente repite, y para la cuarta vez, cuando el mensaje sí importa,
 * ya no lo abre.
 *
 *     RECHAZO_INICIAL       rebotó el cobro. Puede ser la tarjeta vencida y el
 *                           cliente no lo sabe. No hay ninguna consecuencia
 *                           todavía y el texto no inventa ninguna.
 *     SUSPENSION_PROXIMA    sigue impaga y faltan N días. El número es el
 *                           mensaje: «pronto» no le dice a nadie cuándo.
 *     ACCESO_DEGRADADO      se apagaron módulos. Es el único que describe algo
 *                           que el cliente ya puede ver en su pantalla, y por
 *                           eso es el que más necesita decir qué **sigue**
 *                           andando.
 *     SUSPENSION_APLICADA   se cortó. Lo único que importa acá es que los datos
 *                           están enteros y que pagar lo revierte.
 *
 * ## El mismo aviso no se manda dos veces
 *
 * Eso no lo cuida este archivo: lo cuida `collection_steps`, con su `UNIQUE
 * (document_id, tipo, numero)`. Cada aviso es un paso numerado del calendario,
 * y un paso ya registrado no se vuelve a ejecutar aunque el ciclo corra cuatro
 * veces en un día.
 *
 * ## Lo que los textos no dicen
 *
 * **No traen importe ni número de factura.** No por prudencia de más: el cuerpo
 * de `email_outbox` lo puede leer el operador de la instalación con
 * `correo:bandeja -- --cuerpo`, y ese permiso existe para poder entregar a mano
 * un token de verificación, no para leer la deuda de una empresa. Lo que hay
 * que mirar está en el sistema, y el mensaje manda ahí.
 *
 * **No amenazan.** Un correo de cobranza que sube el tono no cobra antes; lo
 * que hace es que la persona que lo recibe —casi siempre un administrativo que
 * no decide el pago— deje de reenviárselo a quien sí decide.
 */

import type { Tx } from '@aai/db';
import { encolarSinEnviar, type Mensaje } from '../correo/puerto.js';

/** Cuál de los cuatro. */
export type ClaseDeAviso =
  | 'RECHAZO_INICIAL'
  | 'SUSPENSION_PROXIMA'
  | 'ACCESO_DEGRADADO'
  | 'SUSPENSION_APLICADA';

/**
 * Lo que el texto necesita saber.
 *
 * `diasParaLaSuspension` es `null` cuando no se puede afirmar —no hay política,
 * o el paso no está en un calendario— y entonces el texto **no dice un número**
 * en vez de decir cero. Un correo que diga «te quedan 0 días» sobre alguien que
 * no está por ser suspendido es la peor clase de error de un aviso.
 */
export interface DatosDelAviso {
  readonly empresa: string;
  readonly diasParaLaSuspension: number | null;
  /** Qué módulos quedaron en pausa. Solo lo usa `ACCESO_DEGRADADO`. */
  readonly modulosEnPausa?: readonly string[];
}

/** El pie que llevan los cuatro. Un solo lugar donde cambiarlo. */
const PIE =
  '\n\nPodés ver el detalle y regularizar en la sección Suscripciones de NEXO.\n' +
  'Si ya pagaste, ignorá este mensaje: el aviso se corta solo en cuanto se ' +
  'registra el cobro.\n';

function enCuantosDias(dias: number | null): string {
  if (dias === null) return 'en los próximos días';
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'mañana';
  return `en ${dias} días`;
}

/** El asunto y el cuerpo. Sin efectos: se puede probar sin base y sin proveedor. */
export function textoDelAviso(
  clase: ClaseDeAviso,
  datos: DatosDelAviso,
): { readonly asunto: string; readonly cuerpo: string } {
  switch (clase) {
    case 'RECHAZO_INICIAL':
      return {
        asunto: `NEXO · no pudimos procesar el pago de ${datos.empresa}`,
        cuerpo:
          `Hola,\n\nEl cobro de la suscripción de ${datos.empresa} fue rechazado. ` +
          'Suele ser una tarjeta vencida o un límite, y se resuelve actualizando el medio ' +
          'de pago.\n\nNo cambió nada todavía: el sistema funciona igual que siempre.' +
          PIE,
      };

    case 'SUSPENSION_PROXIMA':
      return {
        asunto: `NEXO · la suscripción de ${datos.empresa} sigue impaga`,
        cuerpo:
          `Hola,\n\nLa factura de ${datos.empresa} sigue sin pagarse. De no registrarse ` +
          `el pago, el acceso se suspende ${enCuantosDias(datos.diasParaLaSuspension)}.\n\n` +
          'Los datos, la contabilidad y el historial se conservan enteros en cualquier ' +
          'caso: una suspensión corta el acceso y no borra nada.' +
          PIE,
      };

    case 'ACCESO_DEGRADADO': {
      const modulos = datos.modulosEnPausa ?? [];
      const lista =
        modulos.length === 0
          ? 'Algunos módulos quedaron en pausa.'
          : `Quedaron en pausa: ${[...modulos].join(', ')}.`;
      return {
        asunto: `NEXO · algunos módulos de ${datos.empresa} quedaron en pausa`,
        cuerpo:
          `Hola,\n\nLa factura de ${datos.empresa} sigue impaga y parte del producto ` +
          `quedó en pausa hasta que se registre el pago.\n\n${lista}\n\n` +
          'Todo lo que tiene un plazo legal sigue disponible: podés emitir comprobantes, ' +
          'registrar asientos, cerrar el período y presentar ante ARCA con normalidad. ' +
          'Nada se borró, y lo que está en pausa vuelve entero al pagar.' +
          PIE,
      };
    }

    case 'SUSPENSION_APLICADA':
      return {
        asunto: `NEXO · se suspendió el acceso de ${datos.empresa}`,
        cuerpo:
          `Hola,\n\nSe suspendió el acceso de ${datos.empresa} por falta de pago.\n\n` +
          'Los datos siguen estando: la contabilidad, los comprobantes y el historial se ' +
          'conservan enteros. Al registrarse el pago el acceso se restablece con todo ' +
          'adentro, sin volver a cargar nada.' +
          PIE,
      };
  }
}

/**
 * A quién se le escribe.
 *
 * **Este es el único lugar que lo decide, y está solo por eso.** Hoy son los
 * administradores vigentes de la empresa, que es lo que hay: no existe todavía
 * un contacto de facturación declarado. El día que exista —una columna, una
 * tabla, un rol nuevo— se cambia esta función y ninguna otra línea del sistema
 * se entera, porque ninguna otra sabe a quién le llegan los avisos.
 *
 * Hasta entonces, lo que se manda tiene que poder leerlo un administrador
 * cualquiera de la empresa, y eso es exactamente lo que explica que los textos
 * de arriba no traigan importes.
 *
 * Se filtra por `status = 'ACTIVE'`: escribirle a una cuenta suspendida o a una
 * que nunca confirmó el alta es mandar un correo que nadie va a leer, y contarlo
 * como un aviso dado.
 */
export async function destinatariosDeCobranza(
  tx: Tx,
  companyId: string,
): Promise<readonly string[]> {
  const { rows } = await tx.query<{ email: string }>(
    `SELECT DISTINCT u.email
       FROM user_company_roles ucr
       JOIN roles r ON r.id = ucr.role_id
       JOIN users u ON u.id = ucr.user_id
      WHERE ucr.company_id = $1
        AND r.code = 'ADMINISTRADOR'
        AND u.status = 'ACTIVE'
        AND ucr.valid_from <= CURRENT_DATE
        AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE)
      ORDER BY u.email`,
    [companyId],
  );
  return rows.map((r) => r.email);
}

/**
 * Los módulos que se apagan con la mora, por su nombre de producto.
 *
 * Sale de `product_features.sobrevive_la_mora` (0125), que es la **única**
 * fuente: una lista escrita acá se desincronizaría del catálogo en cuanto
 * alguien agregue una funcionalidad, y el síntoma sería un correo que le dice
 * al cliente que perdió algo que sigue teniendo —o peor, que no le nombra lo
 * que efectivamente perdió—.
 *
 * Se piden los nombres y no los códigos porque esto va en un correo: `crm` es
 * el identificador interno, y quien lo lee no tiene por qué conocerlo.
 */
export async function modulosEnPausaPorMora(tx: Tx): Promise<readonly string[]> {
  const { rows } = await tx.query<{ nombre: string }>(
    'SELECT nombre FROM product_features WHERE NOT sobrevive_la_mora ORDER BY orden',
  );
  return rows.map((r) => r.nombre);
}

/**
 * Qué pasó al encolar un aviso.
 *
 * `SIN_DESTINATARIOS` no es un fallo del correo: es una empresa sin ningún
 * administrador vigente y activo. Pasa —el único administrador se dio de baja,
 * o la cuenta quedó pendiente de confirmación— y hay que poder distinguirlo de
 * «se encoló», porque lo que hay que arreglar es otra cosa y está en otra
 * pantalla. Colapsarlo en un éxito dejaría a una empresa recorriendo el
 * calendario entero hasta la suspensión sin que nadie le hubiera avisado.
 */
export type ResultadoDeAviso =
  | { readonly estado: 'ENCOLADO'; readonly destinatarios: number }
  | { readonly estado: 'SIN_DESTINATARIOS' };

/**
 * Deja el aviso en la bandeja. **No lo manda**: eso lo hace `correo:bandeja`.
 *
 * El motivo está escrito entero en `encolarSinEnviar`, y el que decide es este:
 * el aviso viaja en la misma transacción que el cambio de estado que describe,
 * así que un ciclo que se revierte no deja atrás un correo que afirma algo que
 * no pasó.
 */
export async function encolarAvisoDeCobranza(
  tx: Tx,
  companyId: string,
  clase: ClaseDeAviso,
  datos: DatosDelAviso,
): Promise<ResultadoDeAviso> {
  const destinatarios = await destinatariosDeCobranza(tx, companyId);
  if (destinatarios.length === 0) return { estado: 'SIN_DESTINATARIOS' };

  const { asunto, cuerpo } = textoDelAviso(clase, datos);
  for (const destinatario of destinatarios) {
    const mensaje: Mensaje = { destinatario, asunto, cuerpo, tipo: 'AVISO_DE_COBRANZA' };
    await encolarSinEnviar(tx, mensaje);
  }
  return { estado: 'ENCOLADO', destinatarios: destinatarios.length };
}
