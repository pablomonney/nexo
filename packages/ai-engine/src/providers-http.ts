/**
 * El transporte hacia un proveedor de modelo.
 *
 * `providers.ts` tiene los dos proveedores que no hablan con nadie —el
 * deshabilitado y el simulado—. Este archivo tiene el que sí habla: HTTP, con
 * timeout, con reintentos donde corresponde, y con la clave fuera de todo lo
 * que se pueda leer después.
 *
 * ## Dónde queda el vendor, y por qué no está acá
 *
 * Un adaptador escrito contra la API de un proveedor concreto ata el sistema a
 * ese proveedor: cambiar de uno a otro pasa a ser reescribir el transporte, con
 * su timeout, sus reintentos y su manejo de errores. Y esas tres cosas son
 * iguales para todos.
 *
 * Así que se parten en dos:
 *
 *     HttpLLMProvider   transporte: timeout, reintentos, errores, uso, secreto
 *     DialectoHttp      forma del pedido y de la respuesta de UN proveedor
 *
 * El dialecto son dos funciones puras: armar el cuerpo y leer la respuesta.
 * Conectar un proveedor nuevo es escribir esas dos funciones —unas veinte
 * líneas— y no tocar nada de lo de arriba.
 *
 * **Este paquete no trae ningún dialecto de un proveedor real**, y no es un
 * olvido: hacerlo exigiría una credencial para ejercitarlo, y un adaptador que
 * nadie pudo correr nunca es una integración declarada, no una integración. El
 * único que viene es `DIALECTO_NEXO`, que es el contrato propio —documentado
 * abajo— y el que usan los tests.
 *
 * ## El contrato propio
 *
 * ```
 * POST <baseUrl>
 * Authorization: Bearer <apiKey>
 * { "model", "system", "messages": [{role, content}],
 *   "schema", "temperature", "max_tokens" }
 *
 * 200 → { "output": {...},
 *         "model": "…",
 *         "usage": { "input_tokens": n, "output_tokens": n } }
 * ```
 *
 * `usage` es opcional: un proveedor que no lo informe deja el uso en `null`, y
 * el costo también. Cero sería una afirmación.
 */

import { redactarTexto, taparValor } from '@aai/secrets';
import type { LLMProvider, Message, UsoDelModelo } from './contracts.js';

/**
 * Por qué falló una llamada al proveedor.
 *
 * Son códigos y no textos porque quien decide qué hacer con el fallo —
 * reintentar, caer a lo determinístico, avisar— tiene que poder distinguirlos
 * sin leer prosa. Y porque la prosa de un proveedor puede traer adentro cosas
 * que no queremos guardar.
 */
export type CodigoDeFalloDelProveedor =
  /** No contestó a tiempo. */
  | 'TIMEOUT'
  /** 429: hay cupo del proveedor y se agotó. */
  | 'LIMITE_DE_TASA'
  /** 5xx: el proveedor está caído o con problemas. */
  | 'PROVEEDOR_CAIDO'
  /** 401 o 403: la credencial no sirve. **Nunca** incluye la credencial. */
  | 'CREDENCIAL_RECHAZADA'
  /** 4xx que no es de credencial: el pedido está mal armado. Es nuestro. */
  | 'PEDIDO_INVALIDO'
  /** Contestó, pero lo que vino no tiene la forma acordada. */
  | 'RESPUESTA_ILEGIBLE'
  /** No se pudo llegar: DNS, conexión rechazada, cable. */
  | 'RED';

export class ErrorDeProveedor extends Error {
  readonly codigo: CodigoDeFalloDelProveedor;
  /** Cuántas veces se intentó, contando la primera. */
  readonly intentos: number;
  readonly status?: number;

  constructor(
    codigo: CodigoDeFalloDelProveedor,
    detalle: string,
    intentos: number,
    status?: number,
  ) {
    super(`${codigo}: ${detalle}`);
    this.name = 'ErrorDeProveedor';
    this.codigo = codigo;
    this.intentos = intentos;
    if (status !== undefined) this.status = status;
  }
}

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

export interface PedidoAlModelo {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly schema: Record<string, unknown>;
  readonly temperature: 0;
  readonly maxTokens: number;
  readonly modelId: string;
}

export interface RespuestaDelDialecto {
  readonly output: unknown;
  readonly modelId: string;
  readonly uso: UsoDelModelo | null;
}

/**
 * La forma del pedido y de la respuesta de un proveedor.
 *
 * Dos funciones puras. Lo que no está acá —timeout, reintentos, secreto— es
 * igual para todos y vive en el transporte.
 */
export interface DialectoHttp {
  readonly id: string;
  cuerpo(pedido: PedidoAlModelo): unknown;
  /** Devuelve `null` si la respuesta no tiene la forma esperada. */
  leer(json: unknown): RespuestaDelDialecto | null;
}

/** El contrato propio, documentado en el encabezado. */
export const DIALECTO_NEXO: DialectoHttp = {
  id: 'nexo',

  cuerpo(pedido) {
    return {
      model: pedido.modelId,
      system: pedido.system,
      messages: pedido.messages,
      schema: pedido.schema,
      temperature: pedido.temperature,
      max_tokens: pedido.maxTokens,
    };
  },

  leer(json) {
    if (json === null || typeof json !== 'object') return null;
    const cuerpo = json as Record<string, unknown>;
    if (!('output' in cuerpo)) return null;

    const modelo = cuerpo['model'];
    const uso = cuerpo['usage'];
    return {
      output: cuerpo['output'],
      modelId: typeof modelo === 'string' && modelo !== '' ? modelo : 'desconocido',
      uso: leerUso(uso),
    };
  },
};

/**
 * El uso, si vino completo.
 *
 * Parcial no sirve: con solo los tokens de entrada, el costo saldría a la mitad
 * y se vería igual que uno completo. O están los dos o no hay uso.
 */
function leerUso(valor: unknown): UsoDelModelo | null {
  if (valor === null || typeof valor !== 'object') return null;
  const uso = valor as Record<string, unknown>;
  const entrada = uso['input_tokens'];
  const salida = uso['output_tokens'];
  if (!Number.isInteger(entrada) || !Number.isInteger(salida)) return null;
  if ((entrada as number) < 0 || (salida as number) < 0) return null;
  return {
    tokensDeEntrada: entrada as number,
    tokensDeSalida: salida as number,
    tokensTotales: (entrada as number) + (salida as number),
  };
}

export interface OpcionesHttp {
  readonly baseUrl: string;
  /**
   * Cómo conseguir la credencial, **en el momento de usarla**.
   *
   * Es una función y no una cadena a propósito. Un adaptador que recibe la
   * clave en el constructor la tiene en memoria del proceso mientras el objeto
   * viva, y ese objeto puede vivir tanto como el servidor. Pedirla por llamada
   * la deja en memoria el tiempo de la llamada y nada más.
   *
   * Y es lo que permite que la credencial venga de un gestor de secretos sin
   * que este archivo sepa que existe: la función la resuelve quien la arma.
   */
  readonly apiKey: () => Promise<string>;
  readonly modelId: string;
  /** El nombre con el que este proveedor queda registrado en `ai_predictions`. */
  readonly providerId: string;
  readonly timeoutMs: number;
  /** Reintentos **además** del primer intento. 0 = un solo intento. */
  readonly maxRetries: number;
  readonly dialecto?: DialectoHttp;
  readonly fetch?: FetchLike;
  /** Espera entre reintentos. Se inyecta para que los tests no duerman. */
  readonly esperar?: (ms: number) => Promise<void>;
}

/**
 * Proveedor sobre HTTP.
 *
 * Sigue el precedente de `packages/arca/src/soap/soap-client.ts`: `fetch`
 * inyectable, `AbortController` con timeout, y el fallo traducido a un estado
 * que el dominio entiende en vez de una excepción cruda.
 */
export class HttpLLMProvider implements LLMProvider {
  readonly id: string;

  readonly #opciones: OpcionesHttp;
  readonly #fetch: FetchLike;
  readonly #dialecto: DialectoHttp;
  readonly #esperar: (ms: number) => Promise<void>;

  constructor(opciones: OpcionesHttp) {
    this.#opciones = opciones;
    this.id = opciones.providerId;
    this.#fetch = opciones.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#dialecto = opciones.dialecto ?? DIALECTO_NEXO;
    this.#esperar = opciones.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async complete(request: {
    readonly system: string;
    readonly messages: readonly Message[];
    readonly schema: Record<string, unknown>;
    readonly temperature: 0;
    readonly maxTokens: number;
  }): Promise<{ output: unknown; modelId: string; latencyMs: number; uso?: UsoDelModelo | null }> {
    const cuerpo = JSON.stringify(
      this.#dialecto.cuerpo({ ...request, modelId: this.#opciones.modelId }),
    );

    const comenzo = Date.now();
    let ultimo: ErrorDeProveedor | null = null;

    for (let intento = 1; intento <= this.#opciones.maxRetries + 1; intento += 1) {
      try {
        const leida = await this.#unIntento(cuerpo, intento);
        return { ...leida, latencyMs: Date.now() - comenzo };
      } catch (error) {
        if (!(error instanceof ErrorDeProveedor)) throw error;
        ultimo = error;

        // Reintentar lo que puede salir distinto la próxima vez, y nada más.
        // Un 400 mal armado sale igual mil veces; un 401 con la credencial
        // equivocada también. Reintentarlos gasta tiempo y, con un 429 de por
        // medio, empeora el problema que se está tratando de resolver.
        const vaAReintentar =
          reintentable(error.codigo) && intento <= this.#opciones.maxRetries;
        if (!vaAReintentar) break;

        // Backoff exponencial con techo. Sin techo, el quinto reintento de una
        // caída larga espera más que el timeout de la petición entera.
        await this.#esperar(Math.min(200 * 2 ** (intento - 1), 4_000));
      }
    }

    throw new ErrorDeProveedor(
      ultimo!.codigo,
      ultimo!.message,
      ultimo!.intentos,
      ultimo!.status,
    );
  }

  async #unIntento(cuerpo: string, intento: number): Promise<RespuestaDelDialecto> {
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), this.#opciones.timeoutMs);

    // Se pide acá y no en el constructor: la credencial vive el tiempo de la
    // llamada. Si el gestor de secretos no la tiene, el error es suyo y sube
    // tal cual — este adaptador no lo traduce a «el proveedor está caído»,
    // porque no es lo mismo y llevan a acciones opuestas.
    const credencial = await this.#opciones.apiKey();

    let respuesta;
    try {
      respuesta = await this.#fetch(this.#opciones.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // La única vez que la credencial aparece. No se guarda en ningún
          // campo del objeto, no se loguea, y no viaja en ningún error.
          authorization: `Bearer ${credencial}`,
        },
        body: cuerpo,
        signal: controlador.signal,
      });
    } catch (error) {
      const nombre = (error as { name?: string }).name;
      if (nombre === 'AbortError') {
        throw new ErrorDeProveedor(
          'TIMEOUT',
          `no contestó en ${this.#opciones.timeoutMs} ms`,
          intento,
        );
      }

      // El mensaje de un error de red trae la URL completa, y hay proveedores
      // que aceptan la clave en la query: sin limpiarlo, esa URL termina en la
      // bitácora. La versión anterior lo descartaba entero, que era seguro y
      // dejaba sin diagnóstico —«no se pudo llegar» no dice si fue DNS, si fue
      // la conexión o si fue el certificado—.
      //
      // Se limpia dos veces y por dos motivos distintos: `taparValor` saca la
      // credencial concreta esté donde esté, y `redactarTexto` saca cualquier
      // parámetro que **parezca** un secreto en cualquier URL del mensaje,
      // incluida una de un proveedor cuyo nombre de parámetro no conocemos.
      const crudo = (error as { message?: string }).message ?? 'sin detalle';
      throw new ErrorDeProveedor('RED', redactarTexto(taparValor(crudo, credencial)), intento);
    } finally {
      clearTimeout(reloj);
    }

    if (!respuesta.ok) throw this.#error(respuesta.status, intento);

    const texto = await respuesta.text();
    let json: unknown;
    try {
      json = JSON.parse(texto);
    } catch {
      throw new ErrorDeProveedor('RESPUESTA_ILEGIBLE', 'la respuesta no es JSON', intento, 200);
    }

    const leida = this.#dialecto.leer(json);
    if (leida === null) {
      throw new ErrorDeProveedor(
        'RESPUESTA_ILEGIBLE',
        `la respuesta no tiene la forma del dialecto ${this.#dialecto.id}`,
        intento,
        200,
      );
    }
    return leida;
  }

  /**
   * Del código HTTP al código de dominio.
   *
   * El cuerpo de la respuesta **no se lee acá**: un proveedor que devuelve el
   * pedido completo en el mensaje de error devolvería también la cabecera de
   * autorización, y ese texto termina guardado.
   */
  #error(status: number, intento: number): ErrorDeProveedor {
    if (status === 429) {
      return new ErrorDeProveedor('LIMITE_DE_TASA', 'el proveedor pidió esperar', intento, status);
    }
    if (status === 401 || status === 403) {
      return new ErrorDeProveedor(
        'CREDENCIAL_RECHAZADA',
        'el proveedor rechazó la credencial',
        intento,
        status,
      );
    }
    if (status >= 500) {
      return new ErrorDeProveedor('PROVEEDOR_CAIDO', `HTTP ${status}`, intento, status);
    }
    return new ErrorDeProveedor('PEDIDO_INVALIDO', `HTTP ${status}`, intento, status);
  }
}

/** Qué vale la pena reintentar. */
export function reintentable(codigo: CodigoDeFalloDelProveedor): boolean {
  return codigo === 'LIMITE_DE_TASA' || codigo === 'PROVEEDOR_CAIDO' || codigo === 'RED'
    || codigo === 'TIMEOUT';
}
