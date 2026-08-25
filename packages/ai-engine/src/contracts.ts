/**
 * ai-engine — agentes detrás de una interfaz agnóstica de proveedor.
 *
 * ADR-001, verificado por `npm run lint:arch`: este paquete NO PUEDE importar
 * `@aai/accounting-engine`, `@aai/tax-engine` ni un cliente de base de datos.
 * Un agente produce una `Proposal`; quien decide si eso se convierte en un
 * asiento es la Validation Layer, y quien lo aprueba es una persona.
 *
 * Este archivo solo define. `index.ts` solo reexporta: un barril que además
 * define crea un ciclo en cuanto un módulo importa sus tipos de él.
 */

export type AgentName =
  | 'DOCUMENT'
  | 'CLASSIFICATION'
  | 'TAX'
  | 'NORMATIVE_RESEARCH'
  | 'RECONCILIATION'
  | 'FINANCIAL_ANALYSIS'
  | 'NOTES'
  | 'AUDIT';

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * §28 del pliego: el sistema es agnóstico del proveedor de IA. Toda la lógica
 * contable vive en los paquetes de dominio, nunca en el prompt. Cambiar de
 * proveedor debe ser cambiar una variable de entorno y una implementación de
 * este adaptador; si exige tocar lógica contable, el diseño está roto.
 */
export interface LLMProvider {
  readonly id: string;
  complete(request: {
    readonly system: string;
    readonly messages: readonly Message[];
    /** Salida estructurada obligatoria: lo que no valida contra el schema se descarta. */
    readonly schema: Record<string, unknown>;
    readonly temperature: 0;
    readonly maxTokens: number;
  }): Promise<{ readonly output: unknown; readonly modelId: string; readonly latencyMs: number }>;
}

/** Cita normativa devuelta por un agente. Se resuelve contra `norm_versions`. */
export interface NormativeSourceRef {
  readonly normVersionId: string;
  readonly articulo?: string;
}

/**
 * Lo único que un agente puede producir. No es un asiento: es una propuesta.
 * La diferencia no es semántica — es que no existe ruta de código desde acá
 * hacia el motor contable.
 */
export interface Proposal<T> {
  readonly agent: AgentName;
  readonly output: T;
  readonly confidence: number;
  readonly reason: string;
  readonly normativeSources: readonly NormativeSourceRef[];
  readonly modelProvider: string;
  readonly modelId: string;
  readonly promptHash: string;
}

/** Disparadores duros: fuerzan revisión profesional sin importar el score del modelo. */
export type HardBlockReason =
  | 'FUENTE_NO_ENCONTRADA'
  | 'CONFLICTO_NORMATIVO'
  /** El motor normativo todavía no existe: no se preguntó, así que no se puede fundar. */
  | 'MOTOR_NORMATIVO_NO_DISPONIBLE'
  | 'CITA_NO_RESOLUBLE'
  | 'PROVEEDOR_NUEVO'
  | 'PROVEEDOR_APOCRIFO'
  | 'CONSTATACION_FISCAL_FALLIDA'
  | 'IMPORTE_ATIPICO'
  | 'CUENTA_NUNCA_USADA'
  | 'PERIODO_PROXIMO_A_CIERRE'
  | 'FX_SIN_FUENTE';

export type ConfidenceBand = 'ALTA' | 'MEDIA' | 'BAJA';

export interface Triage {
  readonly band: ConfidenceBand;
  readonly hardBlocks: readonly HardBlockReason[];
}
