/**
 * El respondedor, con proveedor.
 *
 * `answering.ts` tiene las reglas —qué se acepta, qué se rechaza y por qué—.
 * Este archivo es lo que faltaba para usarlas: arma el pedido, lo manda, y pasa
 * la salida por esas reglas antes de devolverla.
 *
 * ## Tres candados, no una instrucción
 *
 * 1. **El schema no tiene dónde poner un importe nuevo.** Las cifras vienen en
 *    el contexto, ya calculadas y formateadas.
 * 2. **Las etiquetas y las normas son un `enum`.** El modelo no puede decir que
 *    usó un dato que nadie le pasó.
 * 3. **El control de cifras rechaza la respuesta entera** si aparece un numeral
 *    que no estaba en el contexto.
 *
 * Cualquiera de los tres solo no alcanza. El primero se puede esquivar
 * escribiendo el número en la prosa; el segundo no mira la prosa; el tercero es
 * el que la mira. Juntos no dejan camino.
 *
 * ## Sin proveedor no hay respuesta redactada, y está bien
 *
 * `ProveedorDeshabilitado` no es un error que haya que atrapar más arriba: es la
 * respuesta correcta cuando la empresa decidió no mandar nada afuera. El que
 * llama recibe `SIN_PROVEEDOR` y muestra la cifra igual, que la calculó el
 * motor determinístico.
 */

import type { LLMProvider } from './contracts.js';
import {
  validarRespuesta,
  type ContextoDeRespuesta,
  type RechazoRespuesta,
  type RespuestaPropuesta,
} from './answering.js';
import { ANSWERING_V1, type PromptVersion } from './prompts/registry.js';
import { ProveedorDeshabilitado } from './providers.js';
import { construirSchemaRespuesta } from './schema.js';

export interface OpcionesRespondedor {
  readonly provider: LLMProvider;
  readonly prompt?: PromptVersion;
  readonly maxTokens?: number;
}

export type ResultadoDelRespondedor =
  | {
      readonly estado: 'RESPONDIDA';
      readonly respuesta: RespuestaPropuesta;
      readonly advertencia: string;
      readonly modelId: string;
      readonly promptHash: string;
    }
  | {
      readonly estado: 'RECHAZADA';
      readonly rechazos: readonly RechazoRespuesta[];
      readonly texto: string;
      readonly modelId: string;
      readonly promptHash: string;
    }
  | {
      readonly estado: 'SIN_PROVEEDOR';
      readonly motivo: string;
      readonly promptHash: string;
    };

export class AnsweringAgent {
  readonly #opciones: OpcionesRespondedor;

  constructor(opciones: OpcionesRespondedor) {
    this.#opciones = opciones;
  }

  async responder(contexto: ContextoDeRespuesta): Promise<ResultadoDelRespondedor> {
    const prompt = this.#opciones.prompt ?? ANSWERING_V1;
    const schema = construirSchemaRespuesta({
      etiquetas: contexto.datos.map((dato) => dato.etiqueta),
      citasPermitidas: contexto.normas.map((norma) => norma.id),
    });

    let salida;
    try {
      salida = await this.#opciones.provider.complete({
        system: prompt.texto,
        messages: [{ role: 'user', content: mensaje(contexto) }],
        schema,
        temperature: 0,
        maxTokens: this.#opciones.maxTokens ?? 800,
      });
    } catch (error) {
      if (error instanceof ProveedorDeshabilitado) {
        return { estado: 'SIN_PROVEEDOR', motivo: error.message, promptHash: prompt.hash };
      }
      throw error;
    }

    const propuesta = leer(salida.output);
    if (propuesta === null) {
      return {
        estado: 'RECHAZADA',
        rechazos: [
          {
            codigo: 'RESPUESTA_VACIA',
            detalle: 'La salida del modelo no tiene la forma del schema que se le pidió.',
            esAlucinacion: false,
          },
        ],
        texto: '',
        modelId: salida.modelId,
        promptHash: prompt.hash,
      };
    }

    const veredicto = validarRespuesta(propuesta, contexto);
    if (!veredicto.ok) {
      return {
        estado: 'RECHAZADA',
        rechazos: veredicto.rechazos,
        // El texto rechazado se devuelve para poder guardarlo: es el insumo de
        // la métrica de alucinación. No se muestra al usuario.
        texto: propuesta.texto,
        modelId: salida.modelId,
        promptHash: prompt.hash,
      };
    }

    return {
      estado: 'RESPONDIDA',
      respuesta: veredicto.respuesta,
      advertencia: veredicto.advertencia,
      modelId: salida.modelId,
      promptHash: prompt.hash,
    };
  }
}

/**
 * El mensaje que ve el modelo.
 *
 * Los datos van con su etiqueta y su origen. El origen no es decoración: es lo
 * que le permite decir «según la cuenta corriente» en vez de afirmarlo desde
 * ningún lado.
 */
function mensaje(contexto: ContextoDeRespuesta): string {
  const datos = contexto.datos
    .map((dato) => `- ${dato.etiqueta}: ${dato.valor}  (${dato.origen})`)
    .join('\n');
  const normas =
    contexto.normas.length === 0
      ? 'Ninguna. No cites normativa.'
      : contexto.normas.map((n) => `- ${n.id}: ${n.etiqueta}`).join('\n');

  return [
    `PREGUNTA: ${contexto.pregunta}`,
    contexto.periodo === null ? '' : `PERÍODO: ${contexto.periodo}`,
    '',
    'DATOS DEL SISTEMA:',
    datos === '' ? '(ninguno)' : datos,
    '',
    'NORMAS CITABLES:',
    normas,
  ]
    .filter((parte) => parte !== '')
    .join('\n');
}

/** Lee la salida del proveedor sin confiar en su forma. */
function leer(salida: unknown): RespuestaPropuesta | null {
  if (typeof salida !== 'object' || salida === null) return null;
  const bruto = salida as Record<string, unknown>;

  if (typeof bruto.texto !== 'string') return null;
  if (typeof bruto.abstencion !== 'boolean') return null;

  const lista = (valor: unknown): string[] =>
    Array.isArray(valor) ? valor.filter((x): x is string => typeof x === 'string') : [];

  return {
    texto: bruto.texto,
    datosUsados: lista(bruto.datosUsados),
    normasCitadas: lista(bruto.normasCitadas),
    abstencion: bruto.abstencion,
  };
}
