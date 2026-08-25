/**
 * Accounting Classification Agent.
 *
 * Recibe un contexto ya resuelto, le pide una propuesta al modelo y la pasa por
 * la Validation Layer. No consulta la base, no llama a ARCA, no lee el archivo
 * normativo: todo eso ya pasó antes de llegar acá.
 *
 * Tres comportamientos que vale la pena conocer antes de tocar este archivo:
 *
 * **Sin proveedor de IA el agente sigue sirviendo.** Cae a la sugerencia
 * determinística construida con la propia historia de la empresa. Un estudio que
 * no quiere mandar los documentos de sus clientes a un tercero no se queda sin
 * sistema, se queda sin modelo (§8).
 *
 * **Doble pasada antes de bloquear.** Si la primera respuesta viene con
 * confianza baja, se vuelve a preguntar con el contexto ampliado antes de mandar
 * el comprobante a la cola de revisión. Es más barato que el minuto de contador
 * que ahorra.
 *
 * **La abstención del modelo no es un error.** Es una salida prevista y la
 * respuesta correcta cuando ninguna cuenta del plan encaja.
 */

import { createHash } from 'node:crypto';
import type { AgentName, LLMProvider, Message, Proposal } from './contracts.js';
import type { ContextoClasificacion } from './contexto.js';
import { TRATAMIENTOS_POR_DEFECTO } from './contexto.js';
import { CLASSIFICATION_V1, type PromptVersion } from './prompts/registry.js';
import { ProveedorDeshabilitado } from './providers.js';
import { construirSchemaClasificacion } from './schema.js';
import { sugerirPorPreferencia } from './aprendizaje.js';
import { validarSalida, type PropuestaValidada, type Veredicto } from './validation.js';
import { evaluarTriage } from './confianza.js';

const AGENTE: AgentName = 'CLASSIFICATION';

export interface OpcionesAgente {
  readonly provider: LLMProvider;
  readonly prompt?: PromptVersion;
  readonly maxTokens?: number;
  readonly ahora?: () => Date;
  /** Desactiva la segunda pasada. Útil para medir la primera respuesta cruda. */
  readonly sinSegundaPasada?: boolean;
}

export interface PropuestaClasificacion
  extends Proposal<PropuestaValidada['output']>,
    Pick<PropuestaValidada, 'triage' | 'advertencias'> {
  readonly inputRef: string;
  readonly pasadas: number;
  readonly latencyMs: number;
}

export type MotivoSinSugerencia =
  | 'SIN_CUENTAS_IMPUTABLES'
  | 'IA_DESHABILITADA'
  | 'ABSTENCION'
  | 'PROPUESTA_RECHAZADA';

export type ResultadoClasificacion =
  | { readonly estado: 'PROPUESTA'; readonly propuesta: PropuestaClasificacion }
  | {
      readonly estado: 'SIN_SUGERENCIA';
      readonly motivo: MotivoSinSugerencia;
      readonly detalle: string;
      /** Presente cuando hubo una salida del modelo que la validación tumbó. */
      readonly rechazo?: Extract<Veredicto, { estado: 'RECHAZADA' }>;
    };

export class ClassificationAgent {
  readonly #opciones: OpcionesAgente;

  constructor(opciones: OpcionesAgente) {
    this.#opciones = opciones;
  }

  async clasificar(contexto: ContextoClasificacion): Promise<ResultadoClasificacion> {
    const imputables = contexto.cuentas.filter((cuenta) => cuenta.imputable);
    if (imputables.length === 0) {
      return {
        estado: 'SIN_SUGERENCIA',
        motivo: 'SIN_CUENTAS_IMPUTABLES',
        detalle: 'El plan de cuentas de la empresa no tiene ninguna cuenta imputable.',
      };
    }

    const prompt = this.#opciones.prompt ?? CLASSIFICATION_V1;
    const schema = construirSchemaClasificacion({
      cuentas: imputables.map((cuenta) => ({ codigo: cuenta.codigo, nombre: cuenta.nombre })),
      citasPermitidas: contexto.normas.map((norma) => norma.normVersionId),
      tratamientos:
        contexto.tratamientos.length > 0 ? contexto.tratamientos : [...TRATAMIENTOS_POR_DEFECTO],
    });

    let latencyMs = 0;
    let modelId = this.#opciones.provider.id;
    let pasadas = 0;
    let veredicto: Veredicto | null = null;

    for (const ampliado of [false, true]) {
      if (ampliado && this.#opciones.sinSegundaPasada === true) break;

      let respuesta;
      try {
        respuesta = await this.#opciones.provider.complete({
          system: prompt.texto,
          messages: mensajes(contexto, ampliado),
          schema,
          temperature: 0,
          maxTokens: this.#opciones.maxTokens ?? 1200,
        });
      } catch (error) {
        if (error instanceof ProveedorDeshabilitado) {
          return this.#caerAPreferencia(contexto, 'IA_DESHABILITADA', error.message);
        }
        throw error;
      }

      pasadas += 1;
      latencyMs += respuesta.latencyMs;
      modelId = respuesta.modelId;
      veredicto = validarSalida(respuesta.output, schema, contexto);

      // Solo se repregunta cuando la duda es del modelo. Si la propuesta fue
      // rechazada por inventar algo, o si el bloqueo viene de un hecho —un
      // proveedor nuevo, ARCA caída—, una segunda pasada no lo va a cambiar:
      // sería gastar una llamada para llegar al mismo lugar.
      const conviene =
        veredicto.estado === 'ADMITIDA' &&
        veredicto.propuesta.triage.hardBlocks.length === 0 &&
        veredicto.propuesta.confidence < contexto.politica.reviewThreshold;
      if (!conviene) break;
    }

    if (veredicto === null) {
      return this.#caerAPreferencia(contexto, 'IA_DESHABILITADA', 'No hubo respuesta del modelo.');
    }

    if (veredicto.estado === 'ABSTENCION') {
      // El modelo dijo que no sabe. Puede que la empresa sí.
      return this.#caerAPreferencia(contexto, 'ABSTENCION', veredicto.detalle);
    }

    if (veredicto.estado === 'RECHAZADA') {
      return {
        estado: 'SIN_SUGERENCIA',
        motivo: 'PROPUESTA_RECHAZADA',
        detalle: veredicto.detalle,
        rechazo: veredicto,
      };
    }

    return {
      estado: 'PROPUESTA',
      propuesta: {
        agent: AGENTE,
        output: veredicto.propuesta.output,
        confidence: veredicto.propuesta.confidence,
        reason: veredicto.propuesta.reason,
        normativeSources: veredicto.propuesta.normativeSources,
        triage: veredicto.propuesta.triage,
        advertencias: veredicto.propuesta.advertencias,
        modelProvider: this.#opciones.provider.id,
        modelId,
        promptHash: prompt.hash,
        inputRef: contexto.documentId,
        pasadas,
        latencyMs,
      },
    };
  }

  /**
   * Sugerencia construida solo con la historia de la empresa.
   *
   * No lleva citas —una frecuencia no es un fundamento— así que la Validation
   * Layer la marca `SIN_CITAS` y nunca llega a la banda de aprobación en lote.
   */
  #caerAPreferencia(
    contexto: ContextoClasificacion,
    motivo: MotivoSinSugerencia,
    detalle: string,
  ): ResultadoClasificacion {
    const sugerencia = sugerirPorPreferencia(
      contexto.hechos,
      contexto.preferencias,
      this.#opciones.ahora?.() ?? new Date(),
    );
    if (sugerencia === null) {
      return { estado: 'SIN_SUGERENCIA', motivo, detalle };
    }

    const cuenta = contexto.cuentas.find(
      (candidata) => candidata.id === sugerencia.cuentaId && candidata.imputable,
    );
    if (cuenta === undefined) {
      // La preferencia apunta a una cuenta que ya no está o dejó de ser
      // imputable. Se descarta en silencio: el plan de cuentas manda.
      return { estado: 'SIN_SUGERENCIA', motivo, detalle };
    }

    const triage = evaluarTriage({
      contexto,
      cuentaElegida: cuenta,
      confianzaModelo: sugerencia.confianza,
    });

    return {
      estado: 'PROPUESTA',
      propuesta: {
        agent: AGENTE,
        output: {
          cuentaId: cuenta.id,
          cuentaCodigo: cuenta.codigo,
          cuentaNombre: cuenta.nombre,
          tratamiento: 'NO_DETERMINADO',
        },
        confidence: sugerencia.confianza,
        reason: sugerencia.razon,
        normativeSources: [],
        // Sin fundamentación no se aprueba en lote, por más veces que se haya
        // repetido. Es la misma regla que aplica a una propuesta del modelo.
        triage: triage.band === 'ALTA' ? { band: 'MEDIA', hardBlocks: triage.hardBlocks } : triage,
        advertencias: ['SIN_CITAS'],
        modelProvider: 'DETERMINISTIC',
        modelId: 'preferences',
        promptHash: PROMPT_HASH_DETERMINISTICO,
        inputRef: contexto.documentId,
        pasadas: 0,
        latencyMs: 0,
      },
    };
  }
}

/**
 * Hash reservado para las sugerencias que no pasaron por ningún modelo.
 *
 * `ai_predictions.prompt_hash` es obligatorio y referencia a `prompt_versions`.
 * Antes que inventar un hash o dejar el campo mintiendo, se registra un
 * "prompt" explícito que dice que no hubo prompt.
 */
export const PROMPT_DETERMINISTICO = {
  name: 'deterministic-preferences',
  version: 'v1',
  texto:
    'Sugerencia construida sin modelo de lenguaje, a partir de las decisiones que la propia ' +
    'empresa ya aprobó. Sin fundamentación normativa.',
} as const;

export const PROMPT_HASH_DETERMINISTICO = createHash('sha256')
  .update(PROMPT_DETERMINISTICO.texto, 'utf8')
  .digest('hex');

// ---------------------------------------------------------------------------
// Serialización del contexto
// ---------------------------------------------------------------------------

function mensajes(contexto: ContextoClasificacion, ampliado: boolean): readonly Message[] {
  const salida: Message[] = [{ role: 'user', content: describirContexto(contexto) }];
  if (ampliado) {
    salida.push({ role: 'user', content: contextoAmpliado(contexto) });
  }
  return salida;
}

function describirContexto(contexto: ContextoClasificacion): string {
  const { hechos } = contexto;
  const partes: (string | null)[] = [
    '## Comprobante',
    linea('Emisor', hechos.razonSocialEmisor),
    linea('CUIT', hechos.cuitEmisor),
    linea('Fecha', hechos.fecha),
    linea('Concepto', hechos.descripcion),
    linea('Total (unidades menores)', hechos.totalMenor),
    linea('Moneda', hechos.moneda),
    linea('Constatación ARCA', hechos.selloFiscal),
    `- Proveedor conocido por la empresa: ${hechos.proveedorConocido ? 'sí' : 'no'}`,
    '',
    '## Cuentas disponibles',
    ...contexto.cuentas
      .filter((cuenta) => cuenta.imputable)
      .map(
        (cuenta) =>
          `- ${cuenta.codigo} — ${cuenta.nombre} (${cuenta.tipo}${cuenta.usadaAntes ? '' : ', nunca usada por esta empresa'})`,
      ),
  ];

  if (contexto.normas.length > 0) {
    partes.push(
      '',
      '## Normas en contexto (son las únicas citables)',
      ...contexto.normas.map(
        (norma) => `- ${norma.normVersionId} — ${norma.etiqueta}: ${norma.resumen}`,
      ),
    );
  } else {
    partes.push(
      '',
      '## Normas en contexto',
      'No hay ninguna. No cites normas: dejá el arreglo de citas vacío.',
    );
  }

  return partes.filter((parte): parte is string => parte !== null).join('\n');
}

/**
 * Contexto de la segunda pasada.
 *
 * Se agrega lo que la empresa hizo antes con señales parecidas. No se le dice al
 * modelo qué responder: se le da el dato que probablemente le faltaba.
 */
function contextoAmpliado(contexto: ContextoClasificacion): string {
  if (contexto.preferencias.length === 0) {
    return [
      'Tu respuesta anterior vino con confianza baja y no hay historial de esta empresa para',
      'esta señal. Si con lo que tenés no alcanza, marcá "abstencion": true. Es una respuesta',
      'válida y preferible a una imputación dudosa.',
    ].join('\n');
  }

  return [
    'Tu respuesta anterior vino con confianza baja. Este es el historial de decisiones que',
    'esta empresa ya aprobó. Es una correlación, no un fundamento normativo: úsalo como',
    'contexto, no como respuesta.',
    '',
    ...contexto.preferencias
      .slice(0, 20)
      .map(
        (preferencia) =>
          `- ${preferencia.signal} → ${preferencia.cuentaCodigo} (${preferencia.vecesConfirmada} vez/veces)`,
      ),
    '',
    'Si con esto seguís sin poder decidir, marcá "abstencion": true.',
  ].join('\n');
}

function linea(etiqueta: string, valor: string | null): string | null {
  return valor === null || valor.length === 0 ? null : `- ${etiqueta}: ${valor}`;
}
