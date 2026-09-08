/**
 * El puerto de correo. **No hay proveedor conectado.**
 *
 * Misma forma que resolvió el proveedor de modelo y el gestor de secretos: la
 * estructura de este lado, el vendor del otro lado de la interfaz. Cuando haya
 * proveedor se escribe un adaptador que implemente `ProveedorDeCorreo` y no
 * cambia una línea de quien lo usa.
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

export type ResultadoDeEnvio =
  | { readonly estado: 'ENVIADO'; readonly proveedor: string; readonly referencia: string }
  | { readonly estado: 'SIN_PROVEEDOR'; readonly detalle: string }
  | { readonly estado: 'FALLIDO'; readonly detalle: string };

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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1,
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
    ],
  );

  return resultado;
}
