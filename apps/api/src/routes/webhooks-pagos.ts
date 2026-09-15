/**
 * Por dónde entra una notificación de la pasarela de pagos.
 *
 * ## Es la única ruta pública que escribe algo, y por eso hace tan poco
 *
 * No puede pedir autenticación: quien llama es un servidor de Mercado Pago, que
 * no tiene sesión en NEXO. Lo que la protege no es un token de usuario sino la
 * **firma** de la propia notificación, y la consecuencia de eso ordena todo el
 * archivo: **nada se escribe antes de verificarla**.
 *
 * Y lo que se escribe cuando verifica es una fila en una bandeja. Nada más.
 *
 *     pasarela → esta ruta → payment_webhook_inbox
 *                            ↓ (después, y en otro proceso)
 *                            se le pregunta a la pasarela qué pasó
 *                            ↓
 *                            procesarEventoDePago
 *
 * ## Por qué no aplica el cobro acá mismo
 *
 * Por dos motivos que apuntan en la misma dirección, y el segundo es el que
 * decide.
 *
 * El primero es de permisos: `aai_app` tiene `SELECT` y nada más sobre
 * `payment_intents`, y sobre `payment_events` no tiene ni eso. Ese candado es lo
 * que impide que el administrador de una empresa cliente se marque un cargo como
 * pagado, y **abrirlo para que el webhook funcione lo abriría para toda la
 * API**.
 *
 * El segundo es que **una notificación no es un hecho**. Dice «pasó algo con el
 * pago N», y el cuerpo lo escribió alguien de afuera. Lo que mueve un cobro en
 * NEXO tiene que ser la respuesta de la pasarela a una pregunta que hizo NEXO
 * con su propia credencial — no un JSON que llegó por la puerta. Aunque la firma
 * cierre, del payload se usa **una sola cosa**: qué recurso hay que ir a
 * consultar.
 *
 * Esto es lo mismo que ya decidió `pagos/puerto.ts` cuando puso `consultarPago`
 * entre las operaciones: «un webhook no se cree solo».
 *
 * ## Los tres desenlaces, y por qué no son dos
 *
 *     200  la firma cierra. Queda la fila. Un reenvío también contesta 200 y no
 *          duplica nada: lo impide un índice único.
 *     401  vino firmada y la firma **no** cierra. Esto es un intento de
 *          suplantación y no se guarda: guardarlo convertiría el control en el
 *          propio vector de inundación.
 *     503  no hay con qué verificar —la instalación no tiene secreto de firma—.
 *          **No es 401.** Un 401 le diría a la pasarela «tu firma está mal» y a
 *          quien lea el log «alguien te está atacando», y las dos cosas serían
 *          falsas: lo que falta es configuración de este lado. Además un 5xx
 *          hace que la pasarela reintente, que es lo correcto — las
 *          notificaciones de esas horas no se pierden, llegan cuando se
 *          configure el secreto.
 *
 * ## Sin límite de intentos, a propósito
 *
 * `RUTAS_LIMITADAS` no la incluye. El límite existe para rutas donde un intento
 * cuesta poco y probar mil sale gratis; acá probar mil sale gratis **y no sirve
 * de nada**, porque sin el secreto ninguna pasa de la verificación y ninguna
 * escribe una fila. Lo que sí haría el límite es descartar notificaciones
 * legítimas: llegan todas desde unas pocas direcciones del proveedor, así que
 * una ráfaga real se vería igual que un ataque.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withoutCompany } from '@aai/db';
import { config } from '../config.js';
import { badRequest, unauthorized } from '../http/errors.js';
import { crearProveedorDePagos } from '../pagos/fabrica.js';
import type { PasarelaInyectada } from '../pagos/inyeccion.js';

/**
 * Lo que se lee del cuerpo. Todo lo demás se ignora.
 *
 * `passthrough` no está: el esquema define lo que se mira, y lo que el proveedor
 * mande de más no entra a ninguna variable. Es la diferencia entre leer un
 * campo y adoptar un documento ajeno.
 */
const cuerpoDeNotificacion = z.object({
  /**
   * El identificador de la **notificación**. Mercado Pago lo repite en cada
   * reenvío del mismo aviso, que es lo que lo hace servir como clave de
   * idempotencia.
   *
   * Llega como número en unos casos y como texto en otros; se normaliza a texto
   * porque la columna es texto.
   */
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  data: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
});

/**
 * Mercado Pago también manda estos dos por query string. Está documentado y no
 * es una suposición: se aceptan como respaldo, nunca por encima del cuerpo.
 */
const consulta = z.object({
  type: z.string().min(1).optional(),
  'data.id': z.union([z.string(), z.number()]).optional(),
});

const comoTexto = (v: string | number): string => (typeof v === 'string' ? v : String(v));

/**
 * La forma de inyectar una pasarela, compartida con las rutas de suscripción.
 *
 * Era un tipo propio de este archivo hasta que una segunda ruta necesitó lo
 * mismo. Dos declaraciones de la misma cosa se separan: la de allá llamaba
 * `ambienteConfigurado` a lo que acá era `ambiente`, y `buildServer` terminaba
 * traduciendo entre las dos. El nombre viejo se conserva para no romper a quien
 * lo importa.
 */
export type OpcionesDeWebhook = PasarelaInyectada;

export function webhooksDePagoRoutes(opciones: OpcionesDeWebhook = {}) {
  return async function registrar(app: FastifyInstance): Promise<void> {
    app.post('/webhooks/pagos', async (request, reply) => {
      const cuerpo = cuerpoDeNotificacion.safeParse(request.body ?? {});
      const query = consulta.safeParse(request.query ?? {});

      if (!cuerpo.success) {
        throw badRequest('La notificación no tiene la forma esperada.');
      }

      const recursoId =
        cuerpo.data.data?.id !== undefined
          ? comoTexto(cuerpo.data.data.id)
          : query.success && query.data['data.id'] !== undefined
            ? comoTexto(query.data['data.id'])
            : null;

      const tipo =
        cuerpo.data.type ?? (query.success ? query.data.type : undefined) ?? null;

      if (recursoId === null || tipo === null) {
        // Sin saber de qué recurso habla no hay nada que consultar después, y
        // guardar la fila igual dejaría trabajo que nadie puede resolver.
        throw badRequest('La notificación no dice sobre qué recurso avisa.');
      }

      const proveedor = opciones.proveedor ?? crearProveedorDePagos();
      const ambiente = opciones.ambiente ?? config.pagos.ambiente;

      const firma = await proveedor.verificarFirma({
        cabeceras: request.headers as Record<string, string | undefined>,
        // Mercado Pago no firma el cuerpo —su manifiesto se arma con el id del
        // recurso, el `x-request-id` y el sello de tiempo— así que esto no se
        // usa hoy. Va igual porque el puerto lo declara y otra pasarela sí lo
        // necesitaría, y porque omitirlo obligaría a cambiar la interfaz el día
        // que haga falta.
        cuerpoCrudo: JSON.stringify(request.body ?? {}),
        recursoId,
      });

      if (firma === null) {
        // Ver el encabezado: no es 401 y no es 200.
        return reply.code(503).send({
          error: 'SIN_VERIFICACION',
          message:
            'La instalación no tiene con qué verificar la firma de las notificaciones. ' +
            'No se procesó nada. Configurá PAYMENTS_WEBHOOK_SECRET.',
        });
      }

      if (!firma) {
        throw unauthorized('La firma de la notificación no es válida.');
      }

      /**
       * La clave de idempotencia.
       *
       * Normalmente es el `id` de la notificación. Cuando no viene, se arma con
       * el sello de tiempo de la firma —que es distinto en cada notificación y
       * **ya fue verificado**, así que no lo elige quien llama— más el recurso.
       *
       * La alternativa fácil, usar solo `tipo:recurso`, colapsaría todos los
       * avisos sobre el mismo pago en una fila: el segundo se descartaría por el
       * índice único y una actualización posterior se perdería en silencio.
       */
      const eventoExterno =
        cuerpo.data.id !== undefined
          ? comoTexto(cuerpo.data.id)
          : `${tipo}:${recursoId}:${selloDeLaFirma(request.headers['x-signature'])}`;

      await withoutCompany('system:webhook-pagos', async (tx) => {
        // `ON CONFLICT DO NOTHING` **sin destino explícito**, y no es una
        // preferencia de estilo: nombrar el índice
        // —`ON CONFLICT (proveedor, evento_externo)`— exige privilegio `SELECT`
        // sobre la tabla, porque PostgreSQL tiene que inspeccionar ese índice.
        // Y `SELECT` es justamente lo que esta tabla no concede (0119): poder
        // leer la bandeja sería poder enumerar los identificadores de cobro de
        // todas las empresas.
        //
        // Sin destino, se ignora cualquier conflicto de unicidad. Acá eso es lo
        // mismo: el único índice único de la tabla es ese, y la clave primaria
        // es un `uuidv7()` nuevo en cada inserción.
        await tx.query(
          `INSERT INTO payment_webhook_inbox
             (proveedor, ambiente, evento_externo, tipo, accion, recurso_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
          [proveedor.id, ambiente, eventoExterno, tipo, cuerpo.data.action ?? null, recursoId],
        );
      });

      // Siempre 200, también cuando la fila ya estaba. Una pasarela deja de
      // reenviar cuando recibe un 2xx, y contestar un error por un reenvío
      // —que es comportamiento normal y esperado— la haría reintentar para
      // siempre algo que ya está resuelto.
      return reply.code(200).send({ recibido: true });
    });
  };
}

/**
 * El `ts` de la cabecera de firma, que ya pasó la verificación.
 *
 * Se vuelve a extraer acá en vez de devolverlo desde `verificarFirma` para no
 * ensanchar el puerto con un dato que solo sirve en este caso de borde. Si no
 * estuviera —no puede pasar: sin `ts` la firma no verifica— queda una cadena
 * vacía, que produce una clave repetida y una fila descartada por el índice
 * único. Es el peor caso y sigue sin corromper nada.
 */
function selloDeLaFirma(cabecera: string | string[] | undefined): string {
  const texto = Array.isArray(cabecera) ? cabecera[0] : cabecera;
  if (texto === undefined) return '';
  for (const trozo of texto.split(',')) {
    const [clave, valor] = trozo.split('=');
    if (clave?.trim() === 'ts' && valor !== undefined) return valor.trim();
  }
  return '';
}
