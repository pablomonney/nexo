/**
 * El adaptador de Resend. El primer proveedor de correo real de NEXO.
 *
 * ## Qué se siguió, y de dónde
 *
 * No hay arquitectura nueva acá. Este archivo es `HttpLLMProvider`
 * (`packages/ai-engine/src/providers-http.ts`) aplicado al correo, con las
 * mismas cuatro decisiones que ya estaban tomadas:
 *
 *   · `fetch` **inyectable** (`FetchLike`), como el cliente SOAP de ARCA. Es lo
 *     que permite probar el adaptador entero sin una cuenta y sin red.
 *   · `AbortController` con timeout. No existe un envío sin límite.
 *   · La credencial se pide **por llamada**, no en el constructor: este objeto
 *     puede vivir tanto como el proceso; el secreto vive el tiempo del envío.
 *   · Todo mensaje de error pasa por `taparValor` y `redactarTexto` antes de
 *     salir del módulo.
 *
 * **Sin dependencias nuevas.** Node trae `fetch` desde la 18 y este repositorio
 * pide 20.11; agregar un cliente HTTP para hacer un `POST` con una cabecera
 * sería incorporar una librería por comodidad.
 *
 * ## Qué se reintenta, y por qué el timeout NO
 *
 * Un reintento de una llamada a un modelo produce, como mucho, una respuesta
 * de más que se descarta. Un reintento de un envío produce **un correo de más
 * en la casilla de alguien**, y eso no se descarta.
 *
 *     429, 5xx      se reintenta. El pedido no llegó a valer: no hay mensaje.
 *     red/DNS       se reintenta. La conexión no se abrió: no hay mensaje.
 *     TIMEOUT       **NO se reintenta.** Un timeout no dice que Resend haya
 *                   rechazado el mensaje: dice que no contestó a tiempo. Puede
 *                   haberlo aceptado y estar tardando en decirlo, y en ese caso
 *                   reintentar manda el mismo aviso de cobranza dos veces.
 *     4xx           no se reintenta. Sale igual mil veces.
 *
 * Es la diferencia entre «no llegó a pasar nada» y «no sé si pasó». Lo segundo
 * se informa como fallo y queda en la bandeja con su motivo, que es lo que
 * permite que una persona decida — y una persona puede mirar la casilla, que es
 * algo que este código no puede hacer.
 *
 * ## Lo que nunca sale de acá
 *
 * La clave, y **el cuerpo del mensaje**. Un cuerpo de verificación contiene el
 * token de alta: si apareciera en un log de error, cualquiera con acceso al log
 * podría activar esa cuenta. Por eso ningún detalle que este módulo construya
 * incluye `mensaje.cuerpo`, ni siquiera recortado — «los primeros 40
 * caracteres» del cuerpo de recuperación siguen siendo suficientes para nada,
 * hasta el día que el token quede entre los primeros 40.
 *
 * El destinatario y el asunto sí viajan en los detalles: hacen falta para
 * diagnosticar y son lo que ya está en `email_outbox` en columnas propias.
 */

import { redactarTexto, taparValor } from '@aai/secrets';
import type { Mensaje, ProveedorDeCorreo, ResultadoDeEnvio } from './puerto.js';

/**
 * El extremo de la API de Resend.
 *
 * Constante del módulo y no variable de entorno: no es una decisión del
 * despliegue —hay un solo Resend— y una variable de más es una variable que
 * alguien puede apuntar a otro lado sin que nadie se entere. Los tests no la
 * necesitan porque inyectan `fetch`.
 */
export const URL_DE_RESEND = 'https://api.resend.com/emails';

/** Lo que este módulo necesita de `fetch`. Se inyecta para poder probarlo. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OpcionesDeResend {
  /** La credencial, resuelta por llamada. Nunca un valor guardado. */
  readonly apiKey: () => Promise<string>;
  /** Remitente. Tiene que ser de un dominio verificado en la cuenta de Resend. */
  readonly from: string;
  readonly timeoutMs: number;
  /** Reintentos **además** del primero. 0 = un solo intento. */
  readonly maxRetries: number;
  readonly fetch?: FetchLike;
  /** Espera entre reintentos. Se inyecta para que los tests no duerman. */
  readonly esperar?: (ms: number) => Promise<void>;
  readonly url?: string;
}

/** Por qué falló un envío. Códigos y no prosa: quien decide necesita distinguir. */
type CodigoDeFallo =
  | 'TIMEOUT'
  | 'LIMITE_DE_TASA'
  | 'PROVEEDOR_CAIDO'
  | 'CREDENCIAL_RECHAZADA'
  | 'MENSAJE_RECHAZADO'
  | 'RESPUESTA_ILEGIBLE'
  | 'RED';

interface Fallo {
  readonly codigo: CodigoDeFallo;
  readonly detalle: string;
  readonly status?: number;
}

/**
 * Lo que se vuelve a intentar.
 *
 * `TIMEOUT` **no está**, y es la única diferencia con el criterio del proveedor
 * de modelo. El motivo está arriba, en el encabezado.
 */
function reintentable(codigo: CodigoDeFallo): boolean {
  return codigo === 'LIMITE_DE_TASA' || codigo === 'PROVEEDOR_CAIDO' || codigo === 'RED';
}

/**
 * Cómo se lee un fallo de Resend según su código HTTP.
 *
 * La distinción que importa es entre **problema del despliegue** —la clave no
 * sirve— y **problema del mensaje** —la dirección no existe, el remitente no
 * está verificado—. Llevan a acciones opuestas: la primera la arregla quien
 * administra la instalación, la segunda quien se registró.
 */
function porStatus(status: number): CodigoDeFallo {
  if (status === 401 || status === 403) return 'CREDENCIAL_RECHAZADA';
  if (status === 429) return 'LIMITE_DE_TASA';
  if (status >= 500) return 'PROVEEDOR_CAIDO';
  return 'MENSAJE_RECHAZADO';
}

/**
 * El mensaje de error que Resend devuelve, si viene con la forma esperada.
 *
 * Se lee `message` y **nada más**. Volcar el cuerpo entero del error metería en
 * la bandeja lo que el proveedor haya decidido devolver —que en varios
 * proveedores incluye el pedido completo, con la cabecera de autorización
 * adentro— y acá el pedido incluye el cuerpo del mensaje, que lleva el token.
 */
function mensajeDeError(texto: string): string | null {
  try {
    const json: unknown = JSON.parse(texto);
    if (typeof json === 'object' && json !== null && 'message' in json) {
      const m = (json as { message: unknown }).message;
      if (typeof m === 'string' && m.length > 0) return m.slice(0, 300);
    }
  } catch {
    /* No es JSON: no se inventa una lectura. */
  }
  return null;
}

/** El identificador que devuelve Resend cuando acepta el mensaje. */
function idDeLaRespuesta(texto: string): string | null {
  try {
    const json: unknown = JSON.parse(texto);
    if (typeof json === 'object' && json !== null && 'id' in json) {
      const id = (json as { id: unknown }).id;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  } catch {
    /* cae en null */
  }
  return null;
}

export class ProveedorDeResend implements ProveedorDeCorreo {
  /**
   * La identidad que queda en `email_outbox.proveedor`.
   *
   * Es el nombre del proveedor y no el del adaptador: la columna existe para
   * contestar «¿quién dijo que aceptó esto?», y esa respuesta tiene que seguir
   * siendo cierta el día que el adaptador se reescriba.
   */
  readonly id = 'resend';

  readonly #opciones: OpcionesDeResend;
  readonly #fetch: FetchLike;
  readonly #esperar: (ms: number) => Promise<void>;
  readonly #url: string;

  constructor(opciones: OpcionesDeResend) {
    this.#opciones = opciones;
    this.#fetch = opciones.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#esperar = opciones.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#url = opciones.url ?? URL_DE_RESEND;
  }

  async enviar(mensaje: Mensaje): Promise<ResultadoDeEnvio> {
    // `text` y no `html`: los cuatro mensajes que NEXO manda son texto plano, y
    // mandarlos como HTML obligaría a escapar un token dentro de un documento,
    // que es una forma de romperlo en silencio.
    const cuerpo = JSON.stringify({
      from: this.#opciones.from,
      to: [mensaje.destinatario],
      subject: mensaje.asunto,
      text: mensaje.cuerpo,
    });

    let ultimo: Fallo | null = null;
    let hechos = 0;

    for (let intento = 1; intento <= this.#opciones.maxRetries + 1; intento += 1) {
      hechos = intento;
      const salida = await this.#unIntento(cuerpo);

      if ('referencia' in salida) {
        return {
          estado: 'ENVIADO',
          proveedor: this.id,
          referencia: salida.referencia,
          intentos: hechos,
        };
      }

      ultimo = salida;
      if (!reintentable(salida.codigo) || intento > this.#opciones.maxRetries) break;

      // Backoff exponencial con techo, igual que el proveedor de modelo: sin
      // techo, el tercer reintento de una caída larga espera más que el timeout
      // del envío entero.
      await this.#esperar(Math.min(200 * 2 ** (intento - 1), 4_000));
    }

    const fallo = ultimo!;
    return {
      estado: 'FALLIDO',
      // El código va adelante para que la bandeja se pueda leer de un vistazo y
      // para que quien la mire sepa si tiene que revisar la configuración o la
      // dirección.
      detalle: `${fallo.codigo}: ${fallo.detalle}`,
      // Contado, no deducido. `intentos` es una columna de trazabilidad: si
      // dijera «3» sobre un fallo que se intentó una sola vez, el que lea la
      // bandeja buscaría una caída del proveedor que nunca ocurrió.
      intentos: hechos,
    };
  }

  /** Un intento. Devuelve la referencia si salió, o el fallo si no. */
  async #unIntento(cuerpo: string): Promise<{ referencia: string } | Fallo> {
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), this.#opciones.timeoutMs);

    // La credencial se pide acá, no en el constructor. Si el gestor de secretos
    // no la tiene, el error es **suyo** y no se traduce a «el proveedor está
    // caído»: no es lo mismo y llevan a acciones opuestas.
    let credencial: string;
    try {
      credencial = await this.#opciones.apiKey();
    } catch (error) {
      clearTimeout(reloj);
      const crudo = (error as { message?: string }).message ?? 'sin detalle';
      return {
        codigo: 'CREDENCIAL_RECHAZADA',
        detalle: `no se pudo resolver la credencial: ${redactarTexto(crudo)}`,
      };
    }

    let respuesta;
    try {
      respuesta = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // La única vez que la credencial aparece. No se guarda en ningún
          // campo del objeto, no se loguea y no viaja en ningún error.
          authorization: `Bearer ${credencial}`,
        },
        body: cuerpo,
        signal: controlador.signal,
      });
    } catch (error) {
      const nombre = (error as { name?: string }).name;
      if (nombre === 'AbortError') {
        return {
          codigo: 'TIMEOUT',
          detalle:
            `no contestó en ${this.#opciones.timeoutMs} ms. No se reintenta: un timeout no ` +
            'dice que el mensaje haya sido rechazado, y reintentarlo podría mandarlo dos veces',
        };
      }

      // Doble limpieza, por dos motivos distintos: `taparValor` saca la
      // credencial concreta esté donde esté, y `redactarTexto` saca cualquier
      // parámetro que parezca un secreto en cualquier URL del mensaje.
      const crudo = (error as { message?: string }).message ?? 'sin detalle';
      return { codigo: 'RED', detalle: redactarTexto(taparValor(crudo, credencial)) };
    } finally {
      clearTimeout(reloj);
    }

    const texto = await respuesta.text().catch(() => '');

    if (!respuesta.ok) {
      const delProveedor = mensajeDeError(texto);
      return {
        codigo: porStatus(respuesta.status),
        detalle:
          `Resend contestó ${respuesta.status}` +
          (delProveedor === null
            ? ''
            : `: ${redactarTexto(taparValor(delProveedor, credencial))}`),
        status: respuesta.status,
      };
    }

    const id = idDeLaRespuesta(texto);
    if (id === null) {
      // Aceptó y no dijo cuál. Se informa como fallo **a propósito**: sin
      // referencia no hay forma de rastrear el mensaje después, y decir
      // `ENVIADO` con la referencia vacía sería afirmar más de lo que se sabe.
      // El `CHECK` de la 0103 tampoco lo aceptaría sin proveedor.
      return {
        codigo: 'RESPUESTA_ILEGIBLE',
        detalle: 'Resend aceptó el mensaje y no devolvió un id: no se puede rastrear el envío',
        status: respuesta.status,
      };
    }

    return { referencia: id };
  }
}
