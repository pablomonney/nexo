/**
 * El puerto de correo.
 *
 * Misma forma que resolvió el proveedor de modelo y el gestor de secretos: la
 * estructura de este lado, el vendor del otro lado de la interfaz.
 *
 * **La promesa se cumplió y conviene dejarlo escrito.** Este encabezado decía
 * «no hay proveedor conectado» y que el día que lo hubiera se escribiría un
 * adaptador «y no cambia una línea de quien lo usa». En B2.5.1 se conectó
 * Resend: el adaptador es `resend.ts`, la elección vive en `fabrica.ts`, y de
 * este archivo **no cambió el contrato** — solo se agregó `intentos`, que se
 * explica abajo.
 *
 * Cuál proveedor se usa lo decide `EMAIL_PROVIDER`, y `none` sigue siendo el
 * valor por defecto y un modo de operación legítimo.
 *
 * ## Encolar no es enviar, y el estado lo dice
 *
 *     PENDIENTE      encolado, todavía no se intentó
 *     SIN_PROVEEDOR  se intentó y no hay a quién pedirle que lo mande
 *     ENVIADO        un proveedor lo aceptó, con su referencia
 *     FALLIDO        un proveedor lo rechazó, con el motivo
 *
 * `SIN_PROVEEDOR` es distinto de `FALLIDO` a propósito. El primero es una
 * condición del despliegue —falta contratar algo— y el segundo un problema del
 * mensaje o del destinatario. Confundirlos haría que alguien buscara el error en
 * la dirección de correo cuando lo que falta es una cuenta de proveedor.
 *
 * ## Lo que se encola queda escrito, y por eso no se puede leer desde acá
 *
 * El cuerpo de un mensaje de verificación **contiene el token**. `aai_app` tiene
 * `INSERT` sobre `email_outbox` y **no tiene `SELECT`** (0103): este módulo
 * escribe y no lee, y no es una disciplina — es un privilegio que no está.
 *
 * La consecuencia es que mientras no haya proveedor, un alta autoservicio no se
 * completa sola: el operador lee la bandeja con `npm run correo:bandeja` y hace
 * llegar el mensaje. No es un flujo comercial; es el que existe.
 */

import type { Tx } from '@aai/db';

export type TipoDeMensaje =
  | 'VERIFICACION_DE_ALTA'
  | 'RECUPERACION'
  | 'AVISO_DE_COBRANZA'
  | 'AVISO';

/**
 * Un mensaje a encolar.
 *
 * **No lleva empresa.** La 0103 le había puesto `company_id` a la tabla pensando
 * en el aviso de cobranza y la 0104 se la sacó: nadie la leía, y una columna
 * `company_id` obliga a poner RLS —es un invariante del sistema entero— que
 * habría roto el alta, que corre sin empresa en contexto. El día que un aviso
 * necesite alcance por empresa se agrega con su política, y ahí va a valer para
 * algo.
 */
export interface Mensaje {
  readonly destinatario: string;
  readonly asunto: string;
  readonly cuerpo: string;
  readonly tipo: TipoDeMensaje;
}

/**
 * Qué pasó al intentar mandarlo.
 *
 * `intentos` es **opcional y aditivo**, y es lo único que este contrato ganó al
 * conectar un proveedor real. El motivo: `encolar` escribía `intentos: 1` fijo,
 * que era cierto mientras el único proveedor no reintentaba nada. Un adaptador
 * que reintenta un 429 hace que esa columna mienta, y `email_outbox.intentos`
 * existe para contestar «¿cuántas veces se probó?» — si dijera 1 sobre tres
 * intentos, quien lea la bandeja no vería que el proveedor estuvo caído.
 *
 * Es opcional para que `SinProveedorDeCorreo` —y cualquier adaptador que no
 * reintente— no tenga que declararlo: sin el campo, se asume un intento.
 */
export type ResultadoDeEnvio =
  | {
      readonly estado: 'ENVIADO';
      readonly proveedor: string;
      readonly referencia: string;
      readonly intentos?: number;
    }
  | { readonly estado: 'SIN_PROVEEDOR'; readonly detalle: string }
  | { readonly estado: 'FALLIDO'; readonly detalle: string; readonly intentos?: number };

export interface ProveedorDeCorreo {
  readonly id: string;
  enviar(mensaje: Mensaje): Promise<ResultadoDeEnvio>;
}

/**
 * El que hay hoy: ninguno.
 *
 * No tira. Que no haya proveedor de correo es una condición conocida del
 * despliegue, no un error del código que encola: el alta tiene que poder
 * registrarse igual y decir que el mensaje quedó esperando.
 */
export class SinProveedorDeCorreo implements ProveedorDeCorreo {
  readonly id = 'ninguno';

  async enviar(): Promise<ResultadoDeEnvio> {
    return {
      estado: 'SIN_PROVEEDOR',
      detalle:
        'No hay proveedor de correo configurado. El mensaje quedó en la bandeja de salida: ' +
        'se lee con `npm run correo:bandeja`.',
    };
  }
}

/**
 * Encola un mensaje y deja constancia de qué pasó al intentar mandarlo.
 *
 * Se escribe la fila **siempre**, incluso cuando no hay proveedor. Un mensaje
 * que no se pudo mandar y no quedó registrado es un usuario esperando un correo
 * que nadie sabe que nunca salió.
 */
export async function encolar(
  tx: Tx,
  proveedor: ProveedorDeCorreo,
  mensaje: Mensaje,
): Promise<ResultadoDeEnvio> {
  const resultado = await proveedor.enviar(mensaje);

  await tx.query(
    `INSERT INTO email_outbox
       (destinatario, asunto, cuerpo, tipo, estado, proveedor,
        referencia_externa, detalle, intentos, enviado_el)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $5 = 'ENVIADO' THEN now() END)`,
    [
      mensaje.destinatario,
      mensaje.asunto,
      mensaje.cuerpo,
      mensaje.tipo,
      resultado.estado,
      resultado.estado === 'ENVIADO' ? resultado.proveedor : proveedor.id,
      resultado.estado === 'ENVIADO' ? resultado.referencia : null,
      resultado.estado === 'ENVIADO' ? null : resultado.detalle,
      // Sin el campo se asume uno: es lo que hacía esta consulta con un `1`
      // fijo, y sigue siendo cierto para todo adaptador que no reintente.
      resultado.estado === 'SIN_PROVEEDOR' ? 1 : (resultado.intentos ?? 1),
    ],
  );

  return resultado;
}

/**
 * Deja el mensaje en la bandeja y **no intenta mandarlo**.
 *
 * ## Por qué hace falta una segunda función
 *
 * `encolar` —la de arriba— manda primero y escribe después. Para el alta está
 * bien: hay una persona esperando el correo con la pantalla abierta, y un
 * segundo de latencia a cambio de que el token le llegue ya es un buen
 * negocio.
 *
 * La cobranza no se parece en nada a eso. Corre sola, de noche, adentro de una
 * transacción que además **cambia el estado de la suscripción**, y le escribe a
 * varias empresas por corrida. Mandar desde ahí adentro tiene tres problemas, y
 * el tercero es el que decide:
 *
 *   · un proveedor lento le pone su latencia a una transacción que tiene
 *     abierto un `UPDATE` sobre `company_subscriptions`;
 *   · un proveedor caído convierte «avisar» en «fallar», y el ciclo entero se
 *     va atrás por un correo;
 *   · y al revés —lo grave—: si la transacción se revierte **después** de que
 *     el proveedor aceptó el mensaje, el cliente recibe «tu acceso quedó
 *     degradado» sobre una degradación que no ocurrió. Eso no se puede
 *     deshacer, porque el correo ya está en su bandeja de entrada.
 *
 * Con esta función el mensaje es una fila más de la misma transacción: si el
 * ciclo se revierte, el aviso se revierte con él. Sale después, cuando
 * `correo:bandeja` drene la cola, y para entonces el hecho que describe ya está
 * confirmado.
 *
 * ## `PENDIENTE` no es `SIN_PROVEEDOR`
 *
 * Los cuatro estados de la tabla siguen significando lo mismo y esta función
 * escribe el único que faltaba usar. `PENDIENTE` es «todavía no se intentó» —
 * lo que hay que hacer es drenar la cola—. `SIN_PROVEEDOR` es «se intentó y no
 * hay a quién pedírselo» — lo que hay que hacer es configurar el proveedor—.
 * Escribir `SIN_PROVEEDOR` acá, «porque total puede que no haya», sería afirmar
 * el resultado de un intento que no ocurrió.
 */
export async function encolarSinEnviar(tx: Tx, mensaje: Mensaje): Promise<void> {
  await tx.query(
    `INSERT INTO email_outbox
       (destinatario, asunto, cuerpo, tipo, estado, intentos)
     VALUES ($1, $2, $3, $4, 'PENDIENTE', 0)`,
    [mensaje.destinatario, mensaje.asunto, mensaje.cuerpo, mensaje.tipo],
  );
}
