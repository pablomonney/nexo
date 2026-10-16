/**
 * El asistente contra Claude: el adaptador del puerto de chat para la API de Anthropic.
 *
 * Es el ÚNICO archivo del sistema que conoce a un proveedor de modelo concreto. `@aai/ai-engine` define el puerto
 * (`ProveedorDeChat`) y el bucle del turno sin saber quién contesta; acá se traduce a la API de mensajes de Claude con el SDK
 * oficial. Cambiar de proveedor es escribir otro archivo como éste, no tocar el bucle, las herramientas ni la pantalla.
 *
 * ## Qué se manda (y qué NO)
 *
 * Se manda lo mínimo y lo documentado: `model`, `max_tokens`, `system`, `messages`, `tools` y `output_config.effort`.
 *
 *   · **No se manda `temperature` ni `top_p` ni `top_k`.** Claude Haiku 5.5 rechaza con 400 cualquier valor distinto del por
 *     defecto, y el proveedor genérico del repositorio manda `temperature: 0` (por eso no sirve para este modelo).
 *   · **No se manda `thinking`:** el modelo razona por su cuenta (adaptativo), que es lo que viene por defecto. Dentro de un
 *     turno con herramientas, el contenido de cada respuesta del modelo se reenvía **idéntico** (`crudo`), porque un bloque de
 *     razonamiento tiene que volver intacto junto a su llamada a herramienta. Entre turnos sólo viaja texto.
 *   · **No se fuerza ninguna herramienta (`tool_choice`):** el modelo decide si necesita consultar algo.
 *   · `effort: 'low'`: es un chat con herramientas; más esfuerzo es más costo y más demora sin mejor respuesta. Configurable.
 *
 * ## La credencial
 *
 * Se resuelve **por llamada** (`apiKey()`), no al construir: el objeto puede vivir tanto como el proceso y el secreto vive
 * el tiempo de la llamada. El SDK la pone en el encabezado `x-api-key`; el proceso no la escribe en ningún log.
 *
 * ## Qué se informa cuando falla
 *
 * Un `ErrorDeProveedor` con un código (`TIMEOUT`, `LIMITE_DE_TASA`, `CREDENCIAL_RECHAZADA`…) y **nunca** el mensaje del
 * proveedor: ese texto puede traer el pedido completo, y el pedido lleva datos de la empresa.
 *
 * ## Qué NO está verificado
 *
 * Con una credencial real hay que correr UNA llamada de punta a punta antes de declarar la integración conectada. Las
 * pruebas ejecutan este adaptador contra un servidor HTTP local que habla la forma documentada de la API de mensajes
 * (`tests/unit/chat-claude.test.ts`): prueban la traducción y el manejo de errores, no que la cuenta del cliente ande.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  ErrorDeProveedor,
  type BloqueDeChat,
  type MensajeDeChat,
  type PedidoDeChat,
  type ProveedorDeChat,
  type RazonDeCorte,
  type RespuestaDeChat,
} from '@aai/ai-engine';

export const MODELO_POR_DEFECTO = 'claude-haiku-5-5';

export interface OpcionesDeClaude {
  /** Resuelve la credencial en el momento de cada llamada. */
  readonly apiKey: () => Promise<string>;
  readonly modelo?: string;
  readonly timeoutMs?: number;
  readonly maxReintentos?: number;
  readonly esfuerzo?: 'low' | 'medium' | 'high';
  /** Sólo para pruebas y para un proxy corporativo. Sin él, el endpoint oficial. */
  readonly baseUrl?: string;
  /** Sólo para pruebas. */
  readonly fetch?: typeof fetch;
}

type ContenidoDeMensaje = Anthropic.Messages.MessageParam['content'];

function aBloquesDelSdk(bloques: readonly BloqueDeChat[]): Exclude<ContenidoDeMensaje, string> {
  return bloques.map((b) => {
    switch (b.tipo) {
      case 'texto':
        return { type: 'text' as const, text: b.texto };
      case 'adjunto':
        return b.clase === 'imagen'
          ? {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: b.mediaType as Anthropic.Messages.Base64ImageSource['media_type'], data: b.base64 },
            }
          : {
              type: 'document' as const,
              source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: b.base64 },
            };
      case 'herramienta':
        return { type: 'tool_use' as const, id: b.id, name: b.nombre, input: b.entrada };
      case 'resultado':
        return { type: 'tool_result' as const, tool_use_id: b.id, content: b.contenido, ...(b.esError ? { is_error: true } : {}) };
    }
  });
}

function aMensajesDelSdk(mensajes: readonly MensajeDeChat[]): Anthropic.Messages.MessageParam[] {
  return mensajes.map((m) => ({
    role: m.rol === 'usuario' ? ('user' as const) : ('assistant' as const),
    // El contenido crudo de una respuesta del modelo vuelve tal cual dentro del turno; si no hay (historial en texto), se arma.
    content: m.crudo !== undefined ? (m.crudo as Exclude<ContenidoDeMensaje, string>) : aBloquesDelSdk(m.bloques),
  }));
}

const RAZONES: Readonly<Record<string, RazonDeCorte>> = {
  end_turn: 'fin',
  tool_use: 'herramienta',
  max_tokens: 'maxTokens',
  refusal: 'rechazo',
};

function aCodigoDeFallo(error: unknown): ErrorDeProveedor {
  const intentos = 1;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ErrorDeProveedor('TIMEOUT', 'el proveedor no contestó a tiempo', intentos);
  if (error instanceof Anthropic.APIConnectionError) return new ErrorDeProveedor('RED', 'no se pudo llegar al proveedor', intentos);
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return new ErrorDeProveedor('CREDENCIAL_RECHAZADA', 'el proveedor rechazó la credencial', intentos, status);
    if (status === 429) return new ErrorDeProveedor('LIMITE_DE_TASA', 'el proveedor limitó la tasa de pedidos', intentos, status);
    if (status !== undefined && status >= 500) return new ErrorDeProveedor('PROVEEDOR_CAIDO', 'el proveedor tuvo un problema', intentos, status);
    return new ErrorDeProveedor('PEDIDO_INVALIDO', 'el proveedor rechazó el pedido', intentos, status);
  }
  return new ErrorDeProveedor('RESPUESTA_ILEGIBLE', 'la respuesta del proveedor no se pudo leer', intentos);
}

export class ProveedorDeChatClaude implements ProveedorDeChat {
  readonly id = 'anthropic';

  constructor(private readonly opciones: OpcionesDeClaude) {}

  async conversar(pedido: PedidoDeChat): Promise<RespuestaDeChat> {
    const apiKey = await this.opciones.apiKey();
    const cliente = new Anthropic({
      apiKey,
      timeout: this.opciones.timeoutMs ?? 30_000,
      maxRetries: this.opciones.maxReintentos ?? 2,
      ...(this.opciones.baseUrl === undefined ? {} : { baseURL: this.opciones.baseUrl }),
      ...(this.opciones.fetch === undefined ? {} : { fetch: this.opciones.fetch }),
    });

    const modelo = this.opciones.modelo ?? MODELO_POR_DEFECTO;
    let respuesta: Anthropic.Messages.Message;
    try {
      respuesta = await cliente.messages.create({
        model: modelo,
        max_tokens: pedido.maxTokens,
        system: pedido.system,
        messages: aMensajesDelSdk(pedido.mensajes),
        ...(pedido.herramientas.length === 0
          ? {}
          : {
              tools: pedido.herramientas.map((h) => ({
                name: h.nombre,
                description: h.descripcion,
                input_schema: h.esquema as unknown as Anthropic.Messages.Tool.InputSchema,
              })),
            }),
        output_config: { effort: this.opciones.esfuerzo ?? 'low' },
      });
    } catch (error) {
      throw aCodigoDeFallo(error);
    }

    const bloques: BloqueDeChat[] = [];
    for (const b of respuesta.content) {
      if (b.type === 'text') bloques.push({ tipo: 'texto', texto: b.text });
      else if (b.type === 'tool_use') bloques.push({ tipo: 'herramienta', id: b.id, nombre: b.name, entrada: b.input });
      // Los bloques de razonamiento no son para la persona: viajan en `crudo`, no en `bloques`.
    }

    const u = respuesta.usage;
    return {
      bloques,
      crudo: respuesta.content,
      razonDeCorte: RAZONES[respuesta.stop_reason ?? ''] ?? 'otra',
      uso:
        u === undefined || u === null
          ? null
          : {
              entrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
              salida: u.output_tokens,
            },
      modeloId: respuesta.model ?? modelo,
    };
  }
}
