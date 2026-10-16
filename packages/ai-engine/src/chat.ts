/**
 * El asistente conversacional: el puerto hacia un modelo y el bucle de un turno.
 *
 * `providers.ts` y `providers-http.ts` hablan en **una sola vuelta con salida estructurada** (clasificar, redactar una
 * respuesta con cifras que ya están en el contexto). Una conversación es otra cosa: varios turnos, texto libre y
 * herramientas que el modelo pide y la aplicación ejecuta. Esta forma no cabe en `LLMProvider.complete`, así que tiene su
 * propio puerto. Lo que NO cambia es lo que garantiza el paquete (`AI_ARCHITECTURE.md` §1): nada de acá puede escribir en la
 * contabilidad.
 *
 * ## Qué es una herramienta, y por qué el modelo no puede hacer más que lo que una herramienta hace
 *
 * El modelo no recibe una conexión a nada: recibe una **lista de herramientas** con nombre, descripción y esquema de
 * entrada, y puede **pedir** que se ejecute una. Quién la ejecuta es la aplicación —con los permisos del usuario que está
 * hablando, sobre la empresa activa— y lo que vuelve es un texto que el modelo lee. Eso hace que el límite de lo que el
 * asistente puede hacer sea exactamente la lista que se le pasa, y se pueda leer, probar y recortar sin tocar el modelo.
 *
 * Este paquete **no importa la base ni ningún proveedor**: las herramientas llegan como funciones y el proveedor como una
 * implementación del puerto. Por eso no puede escribir en la contabilidad aunque quisiera (regla `adr-001`).
 *
 * ## El bucle
 *
 * ```
 * mensaje del usuario → modelo → ¿pidió herramientas? ── sí → se ejecutan → vuelven al modelo ─┐
 *                                      │                                                       │
 *                                      no → texto final → control de cifras ── ok → respuesta  │
 *                                                              └ falla → UNA corrección → modelo ┘
 * ```
 *
 * Con un tope de iteraciones: un modelo que no termina nunca no puede dejar una petición colgada ni gastar sin límite.
 */

/** Un pedazo del contenido de un mensaje, sin la forma de ningún proveedor. */
export type BloqueDeChat =
  | { readonly tipo: 'texto'; readonly texto: string }
  /**
   * Un archivo que la persona adjuntó en ESTE mensaje: una foto o un PDF, en base64. Viaja al proveedor sólo en el turno que
   * lo trae; no se persiste y no vuelve en los turnos siguientes (el historial es texto).
   */
  | { readonly tipo: 'adjunto'; readonly clase: 'imagen' | 'documento'; readonly mediaType: string; readonly base64: string }
  | { readonly tipo: 'herramienta'; readonly id: string; readonly nombre: string; readonly entrada: unknown }
  | { readonly tipo: 'resultado'; readonly id: string; readonly contenido: string; readonly esError: boolean };

export interface MensajeDeChat {
  readonly rol: 'usuario' | 'asistente';
  readonly bloques: readonly BloqueDeChat[];
  /**
   * El contenido tal como lo devolvió el proveedor, **sin tocar**. El adaptador lo reenvía idéntico dentro de un mismo turno
   * (algunos modelos exigen que sus bloques de razonamiento vuelvan intactos junto a una llamada a herramienta). No sale de
   * este paquete y nunca se persiste.
   */
  readonly crudo?: unknown;
}

/** Lo que el modelo ve de una herramienta. */
export interface DefinicionDeHerramienta {
  readonly nombre: string;
  readonly descripcion: string;
  /** JSON Schema de la entrada (`type: 'object'`, `additionalProperties: false`). */
  readonly esquema: Record<string, unknown>;
}

export interface ResultadoDeHerramienta {
  /** Lo que lee el modelo: texto (por lo general JSON). Nunca un secreto, nunca más de lo que la persona puede ver. */
  readonly contenido: string;
  /** El mismo resultado, estructurado, para mostrarlo a la persona y para el control de cifras. */
  readonly datos?: unknown;
  /** Si es un error de la herramienta (no del modelo). El modelo lo lee y puede explicarlo o abstenerse. */
  readonly esError?: boolean;
  /** Una propuesta de alta que **una persona** puede aplicar. La herramienta no la aplica: no hay forma de que lo haga. */
  readonly propuesta?: unknown;
}

export interface HerramientaDeChat extends DefinicionDeHerramienta {
  /** Valida su propia entrada (el modelo escribe JSON; JSON no es de fiar) y devuelve el resultado. */
  readonly ejecutar: (entrada: unknown) => Promise<ResultadoDeHerramienta>;
}

export interface PedidoDeChat {
  readonly system: string;
  readonly mensajes: readonly MensajeDeChat[];
  readonly herramientas: readonly DefinicionDeHerramienta[];
  readonly maxTokens: number;
}

export type RazonDeCorte = 'fin' | 'herramienta' | 'maxTokens' | 'rechazo' | 'otra';

export interface RespuestaDeChat {
  readonly bloques: readonly BloqueDeChat[];
  readonly crudo?: unknown;
  readonly razonDeCorte: RazonDeCorte;
  /** `null` si el proveedor no lo informa: cero sería una afirmación. */
  readonly uso: { readonly entrada: number; readonly salida: number } | null;
  readonly modeloId: string;
}

export interface ProveedorDeChat {
  readonly id: string;
  conversar(pedido: PedidoDeChat): Promise<RespuestaDeChat>;
}

/** Qué se consultó en un turno. Es el contexto contra el que se verifican las cifras de la respuesta. */
export interface LlamadaEjecutada {
  readonly nombre: string;
  readonly entrada: unknown;
  readonly resultado: ResultadoDeHerramienta;
}

export interface VeredictoDeTexto {
  readonly ok: boolean;
  /** Qué estaba mal, en palabras que el modelo pueda usar para corregirse. */
  readonly motivo?: string;
}

export interface OpcionesDeTurno {
  readonly proveedor: ProveedorDeChat;
  readonly system: string;
  /** La conversación hasta acá, en texto. */
  readonly historial: readonly MensajeDeChat[];
  readonly mensajeDelUsuario: string;
  /** Archivos que la persona adjuntó a ESTE mensaje (fotos, PDF). Viajan en este turno y no vuelven en el historial. */
  readonly adjuntos?: readonly Extract<BloqueDeChat, { tipo: 'adjunto' }>[];
  readonly herramientas: readonly HerramientaDeChat[];
  /** Tope de vueltas modelo→herramientas→modelo. Por defecto 5. */
  readonly maxIteraciones?: number;
  readonly maxTokens?: number;
  /**
   * El control del texto final (en la aplicación: que cada cifra esté en lo consultado). Si falla, el modelo recibe UNA
   * corrección; si falla de nuevo, el turno termina `RECHAZADA` y el texto **no** se le muestra a la persona.
   */
  readonly revisarTexto?: (texto: string, llamadas: readonly LlamadaEjecutada[]) => VeredictoDeTexto;
}

export type EstadoDelTurno =
  /** Hay un texto final y pasó el control. */
  | 'RESPONDIDA'
  /** El texto final no pasó el control ni después de la corrección. */
  | 'RECHAZADA'
  /** El modelo cortó por `max_tokens`: el texto está incompleto y no se muestra como respuesta. */
  | 'TRUNCADA'
  /** El modelo se negó (política de seguridad del proveedor). */
  | 'RECHAZO_DEL_PROVEEDOR'
  /** No llegó a un texto final dentro del tope de iteraciones. */
  | 'SIN_CONCLUSION';

export interface ResultadoDelTurno {
  readonly estado: EstadoDelTurno;
  /** El texto que el modelo dejó (aunque haya sido rechazado: queda para el registro, no para la pantalla). */
  readonly texto: string;
  readonly llamadas: readonly LlamadaEjecutada[];
  readonly uso: { readonly entrada: number; readonly salida: number } | null;
  readonly modeloId: string;
  readonly iteraciones: number;
  /** Los rechazos del control (vacío si no hubo). */
  readonly motivosDeRechazo: readonly string[];
}

const textoDe = (bloques: readonly BloqueDeChat[]): string =>
  bloques
    .filter((b): b is Extract<BloqueDeChat, { tipo: 'texto' }> => b.tipo === 'texto')
    .map((b) => b.texto)
    .join('')
    .trim();

function sumar(
  a: { readonly entrada: number; readonly salida: number } | null,
  b: { readonly entrada: number; readonly salida: number } | null,
): { readonly entrada: number; readonly salida: number } | null {
  if (a === null) return b;
  if (b === null) return a;
  return { entrada: a.entrada + b.entrada, salida: a.salida + b.salida };
}

/**
 * Un turno de la conversación: del mensaje de la persona a la respuesta final.
 *
 * No lanza por lo que haga el modelo (una herramienta que no existe, una entrada mal formada, un texto con cifras
 * inventadas): lo convierte en un estado. Sí propaga lo que falle el **proveedor** (red, credencial, límite), que decide
 * quien llama.
 */
export async function conducirTurno(opciones: OpcionesDeTurno): Promise<ResultadoDelTurno> {
  const maxIteraciones = opciones.maxIteraciones ?? 5;
  const maxTokens = opciones.maxTokens ?? 1024;
  const definiciones: DefinicionDeHerramienta[] = opciones.herramientas.map(({ nombre, descripcion, esquema }) => ({
    nombre,
    descripcion,
    esquema,
  }));

  const mensajes: MensajeDeChat[] = [
    ...opciones.historial,
    // Los archivos van ANTES del texto: el proveedor lee mejor «imagen, después pregunta».
    { rol: 'usuario', bloques: [...(opciones.adjuntos ?? []), { tipo: 'texto', texto: opciones.mensajeDelUsuario }] },
  ];
  const llamadas: LlamadaEjecutada[] = [];
  const motivos: string[] = [];
  let uso: { readonly entrada: number; readonly salida: number } | null = null;
  let modeloId = '';
  let corregido = false;
  let ultimoTexto = '';

  for (let iteracion = 1; iteracion <= maxIteraciones; iteracion += 1) {
    const respuesta = await opciones.proveedor.conversar({ system: opciones.system, mensajes, herramientas: definiciones, maxTokens });
    uso = sumar(uso, respuesta.uso);
    modeloId = respuesta.modeloId;
    mensajes.push({ rol: 'asistente', bloques: respuesta.bloques, ...(respuesta.crudo === undefined ? {} : { crudo: respuesta.crudo }) });

    if (respuesta.razonDeCorte === 'rechazo') {
      return { estado: 'RECHAZO_DEL_PROVEEDOR', texto: '', llamadas, uso, modeloId, iteraciones: iteracion, motivosDeRechazo: [] };
    }

    const pedidos = respuesta.bloques.filter((b): b is Extract<BloqueDeChat, { tipo: 'herramienta' }> => b.tipo === 'herramienta');

    if (pedidos.length === 0) {
      ultimoTexto = textoDe(respuesta.bloques);
      if (respuesta.razonDeCorte === 'maxTokens') {
        return { estado: 'TRUNCADA', texto: ultimoTexto, llamadas, uso, modeloId, iteraciones: iteracion, motivosDeRechazo: [] };
      }
      const veredicto = opciones.revisarTexto?.(ultimoTexto, llamadas) ?? { ok: true };
      if (veredicto.ok) {
        // Si hubo que corregir una vez, queda dicho: es lo que mide cuánto se equivoca el modelo aunque la persona no lo vea.
        return { estado: 'RESPONDIDA', texto: ultimoTexto, llamadas, uso, modeloId, iteraciones: iteracion, motivosDeRechazo: motivos };
      }
      motivos.push(veredicto.motivo ?? 'el control del texto no pasó');
      if (corregido) {
        return { estado: 'RECHAZADA', texto: ultimoTexto, llamadas, uso, modeloId, iteraciones: iteracion, motivosDeRechazo: motivos };
      }
      // UNA corrección: el motivo vuelve al modelo como un mensaje de la persona-sistema, no como una herramienta.
      corregido = true;
      mensajes.push({
        rol: 'usuario',
        bloques: [
          {
            tipo: 'texto',
            texto:
              `Tu respuesta anterior no se puede mostrar: ${veredicto.motivo ?? 'no pasó el control de cifras'}. ` +
              'Escribila de nuevo usando SOLAMENTE cifras que aparezcan en los resultados de las herramientas o en lo que ' +
              'escribió la persona, o decí que no tenés ese dato. No agregues cifras nuevas.',
          },
        ],
      });
      continue;
    }

    // El modelo pidió herramientas: se ejecutan acá, con lo que la aplicación decidió ofrecer. Una que no está en la lista
    // no existe, aunque el modelo la nombre.
    const resultados: BloqueDeChat[] = [];
    for (const pedido of pedidos) {
      const herramienta = opciones.herramientas.find((h) => h.nombre === pedido.nombre);
      let resultado: ResultadoDeHerramienta;
      if (herramienta === undefined) {
        resultado = { contenido: JSON.stringify({ error: `La herramienta «${pedido.nombre}» no existe.` }), esError: true };
      } else {
        try {
          resultado = await herramienta.ejecutar(pedido.entrada);
        } catch {
          // Sin el mensaje del error: puede traer SQL, rutas o datos que el modelo no tiene por qué leer.
          resultado = { contenido: JSON.stringify({ error: 'La herramienta falló. Decile a la persona que no pudiste consultarlo.' }), esError: true };
        }
      }
      llamadas.push({ nombre: pedido.nombre, entrada: pedido.entrada, resultado });
      resultados.push({ tipo: 'resultado', id: pedido.id, contenido: resultado.contenido, esError: resultado.esError === true });
    }
    mensajes.push({ rol: 'usuario', bloques: resultados });
  }

  return { estado: 'SIN_CONCLUSION', texto: ultimoTexto, llamadas, uso, modeloId, iteraciones: maxIteraciones, motivosDeRechazo: motivos };
}
