/**
 * Proveedores de modelo.
 *
 * `LLMProvider` (definido en `index.ts`) es la única superficie por la que sale
 * información hacia afuera. Cambiar de proveedor tiene que ser cambiar una
 * variable de entorno y una implementación de esta interfaz; si exige tocar
 * lógica contable, el diseño está roto (§28).
 *
 * Acá viven dos implementaciones que no hablan con nadie. El adaptador de un
 * proveedor real es un archivo aparte, y su ausencia no impide desarrollar ni
 * operar el sistema.
 */

import type { LLMProvider, Message } from './contracts.js';

/**
 * Sin IA externa. **Es un modo de operación, no un placeholder.**
 *
 * El §8 de AI_ARCHITECTURE.md lo exige: una organización tiene que poder
 * deshabilitar por completo el envío a un tercero y que el sistema siga
 * funcionando. Los documentos de un estudio son secreto profesional, y para
 * muchos clientes ese envío es una conversación que no quieren tener.
 *
 * En este modo no hay sugerencias del modelo. Sí hay sugerencias
 * determinísticas a partir de lo que la propia empresa ya aprobó — ver
 * `aprendizaje.ts`—, que no requieren mandar nada a ningún lado.
 */
export class NullLLMProvider implements LLMProvider {
  readonly id = 'none';

  async complete(): Promise<{ output: unknown; modelId: string; latencyMs: number }> {
    throw new ProveedorDeshabilitado();
  }
}

export class ProveedorDeshabilitado extends Error {
  constructor() {
    super('No hay proveedor de IA configurado. El sistema opera en modo determinístico.');
    this.name = 'ProveedorDeshabilitado';
  }
}

export interface RespuestaSimulada {
  readonly output: unknown;
  readonly modelId?: string;
}

export interface OpcionesMock {
  /** Respuestas en orden. Se consumen una por llamada. */
  readonly respuestas: readonly RespuestaSimulada[];
  /** Si se agotan las respuestas: repetir la última o fallar. */
  readonly alAgotarse?: 'REPETIR' | 'FALLAR';
}

/**
 * Proveedor simulado, determinístico.
 *
 * Guarda cada pedido para que los tests puedan afirmar sobre **lo que se
 * mandó**, no solo sobre lo que volvió. Buena parte de los controles de este
 * módulo son sobre el pedido: que el schema lleve el enum de cuentas reales, que
 * `temperature` sea 0, que las citas permitidas estén acotadas al contexto.
 */
export class MockLLMProvider implements LLMProvider {
  readonly id = 'mock';

  readonly pedidos: {
    system: string;
    messages: readonly Message[];
    schema: Record<string, unknown>;
    temperature: number;
  }[] = [];

  #indice = 0;
  readonly #opciones: OpcionesMock;

  constructor(opciones: OpcionesMock) {
    this.#opciones = opciones;
  }

  async complete(request: {
    system: string;
    messages: readonly Message[];
    schema: Record<string, unknown>;
    temperature: 0;
    maxTokens: number;
  }): Promise<{ output: unknown; modelId: string; latencyMs: number }> {
    this.pedidos.push({
      system: request.system,
      messages: request.messages,
      schema: request.schema,
      temperature: request.temperature,
    });

    const respuesta = this.#opciones.respuestas[this.#indice];
    if (respuesta === undefined) {
      const ultima = this.#opciones.respuestas[this.#opciones.respuestas.length - 1];
      if (this.#opciones.alAgotarse === 'REPETIR' && ultima !== undefined) {
        return { output: ultima.output, modelId: ultima.modelId ?? 'mock-1', latencyMs: 1 };
      }
      throw new Error('El mock se quedó sin respuestas');
    }

    this.#indice += 1;
    return { output: respuesta.output, modelId: respuesta.modelId ?? 'mock-1', latencyMs: 1 };
  }
}
