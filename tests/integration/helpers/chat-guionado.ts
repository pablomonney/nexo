/**
 * Un proveedor de chat de mentira para las pruebas: contesta lo que se le guionó y registra cada pedido recibido.
 *
 * Vive acá y no en `@aai/ai-engine`: es un doble de prueba, y un paquete que exporta algo que sólo usan los tests es el
 * defecto que S-16 persigue.
 */

import type { PedidoDeChat, ProveedorDeChat, RespuestaDeChat } from '@aai/ai-engine';

/** Registra cada pedido recibido: así una prueba afirma qué le llegó al modelo (herramientas, mensajes) sin hablar con nadie. */
export class ProveedorDeChatGuionado implements ProveedorDeChat {
  readonly id = 'guionado';
  readonly pedidos: PedidoDeChat[] = [];
  private posicion = 0;

  constructor(private readonly guion: readonly (RespuestaDeChat | ((pedido: PedidoDeChat) => RespuestaDeChat))[]) {}

  async conversar(pedido: PedidoDeChat): Promise<RespuestaDeChat> {
    // Una copia: el bucle sigue agregando mensajes al mismo arreglo después de la llamada, y una prueba que mira el pedido
    // tiene que ver lo que se mandó, no lo que vino después.
    this.pedidos.push({ ...pedido, mensajes: [...pedido.mensajes] });
    const paso = this.guion[Math.min(this.posicion, this.guion.length - 1)];
    this.posicion += 1;
    if (paso === undefined) throw new Error('El guion del proveedor de chat está vacío.');
    return typeof paso === 'function' ? paso(pedido) : paso;
  }
}

/** Atajos para armar el guion. */
export const dicho = (texto: string, uso: RespuestaDeChat['uso'] = { entrada: 10, salida: 5 }): RespuestaDeChat => ({
  bloques: [{ tipo: 'texto', texto }],
  razonDeCorte: 'fin',
  uso,
  modeloId: 'guionado',
});

export const pidiendo = (
  nombre: string,
  entrada: unknown,
  id = `llamada-${nombre}`,
  uso: RespuestaDeChat['uso'] = { entrada: 10, salida: 5 },
): RespuestaDeChat => ({
  bloques: [{ tipo: 'herramienta', id, nombre, entrada }],
  razonDeCorte: 'herramienta',
  uso,
  modeloId: 'guionado',
});
