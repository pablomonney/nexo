/**
 * normative-engine — resolución de qué norma regía un hecho.
 *
 * La pregunta que este paquete responde:
 *
 * > Dado un hecho ocurrido el `D`, para un ente de tipo `T`, en jurisdicción
 * > `J`, con marco `F` — ¿qué reglas eran aplicables y de qué texto exacto
 * > surgen?
 *
 * Y las dos respuestas que **también son válidas**, y que este motor devuelve
 * sin pedir disculpas:
 *
 * - `FUENTE_NO_ENCONTRADA` — no hay norma relevada para el caso.
 * - `CONFLICTO_NORMATIVO` — hay más de una regla aplicable de igual prioridad.
 *
 * El motor **no desempata, no interpola y no infiere**. La única forma de que
 * elija entre dos normas es que exista una relación de derogación o sustitución
 * cargada desde el texto oficial.
 *
 * Este archivo solo define. `index.ts` solo reexporta.
 */

import type { CalendarDate } from '@aai/shared';

/** Jerarquía del §3 del pliego. 1 es la más alta. */
export type HierarchyLevel = 1 | 2 | 3 | 4;

export type VerificationLevel = 'V1' | 'V2' | 'V3' | 'V4';

/** Organismos cuya normativa requiere acto de adopción jurisdiccional. */
export const ORGANISMOS_PROFESIONALES = ['FACPCE', 'CPCE_CABA', 'CPCE_PROVINCIAL'] as const;

export interface NormSnapshot {
  readonly id: string;
  readonly organismo: string;
  readonly tipo: string;
  readonly numero: string;
  readonly anio: number;
  readonly titulo: string;
  readonly jurisdiccion: string;
  readonly hierarchyLevel: HierarchyLevel;
  readonly estado: 'VIGENTE' | 'DEROGADA' | 'SUSTITUIDA';
}

export interface NormVersionSnapshot {
  readonly id: string;
  readonly normId: string;
  readonly version: number;
  readonly fechaEmision: CalendarDate;
  readonly fechaVigencia: CalendarDate | null;
  readonly fechaDerogacion: CalendarDate | null;
  /** Eje de tiempo de SISTEMA: cuándo el sistema supo de esta versión. */
  readonly recordedFrom: string;
  readonly recordedTo: string | null;
  readonly verificationLevel: VerificationLevel;
  /** `true` si hay documento original archivado con hash. */
  readonly tieneDocumento: boolean;
}

/**
 * Acto por el cual un consejo profesional adopta una norma en su jurisdicción.
 *
 * Existe porque FACPCE fijó la vigencia de la RT 54 para ejercicios iniciados
 * desde el 01/07/2024 y el CPCECABA la adoptó desde el 01/01/2025. No es una
 * contradicción: son dos hechos jurídicos distintos y los dos son verdaderos.
 */
export interface AdoptionSnapshot {
  readonly normVersionId: string;
  readonly jurisdiction: string;
  readonly adoptingBody: string;
  readonly adoptionAct: string;
  readonly validFrom: CalendarDate;
  readonly validTo: CalendarDate | null;
  /** Aplicación anticipada: es una **opción del ente**, no algo automático. */
  readonly earlyFrom: CalendarDate | null;
  readonly earlyAnchor: 'INICIO_EJERCICIO' | 'CIERRE_EJERCICIO' | null;
}

export interface RuleSnapshot {
  readonly id: string;
  readonly ruleKey: string;
  readonly version: number;
  readonly normVersionId: string;
  readonly domain: 'accounting' | 'tax' | 'disclosure';
  readonly validFrom: CalendarDate;
  readonly validTo: CalendarDate | null;
  readonly jurisdiction: string;
  readonly entityTypes: readonly string[];
  readonly frameworks: readonly string[];
  readonly priority: number;
  readonly conditions: unknown;
  readonly action: unknown;
  readonly status: 'DRAFT' | 'IN_REVIEW' | 'ACTIVE' | 'SUPERSEDED';
}

/** Relación declarada entre versiones de normas. Nunca inferida. */
export interface ModificationSnapshot {
  readonly modificadoraVersionId: string;
  readonly modificadaVersionId: string;
  readonly tipo: 'SUSTITUYE' | 'INCORPORA' | 'DEROGA' | 'RATIFICA';
}

/**
 * El contexto del hecho. Cinco variables, no una.
 *
 * `fechaHecho` no alcanza: la vigencia de una norma profesional se ata al
 * **inicio del ejercicio**, y la aplicación anticipada a veces al **cierre**.
 */
export interface ContextoNormativo {
  readonly fechaHecho: CalendarDate;
  readonly inicioEjercicio: CalendarDate;
  readonly cierreEjercicio: CalendarDate;
  readonly jurisdiccion: string;
  readonly tipoEnte: string;
  readonly marco: string;
  /**
   * Momento del eje de SISTEMA desde el que se mira.
   *
   * Con `asOf` en el pasado se reproduce la decisión de entonces con el
   * conocimiento de entonces. Sin este eje no se puede responder *"¿por qué el
   * sistema clasificó así en marzo, si hoy la regla dice otra cosa?"*.
   */
  readonly asOf: string;
  /**
   * Si el ente optó por aplicación anticipada.
   *
   * Ser elegible y haber optado son cosas distintas: la opción se **registra**
   * con respaldo documental, no se infiere de que las fechas den.
   */
  readonly optoPorAnticipada?: boolean;
}

/** Todo lo que el motor necesita, ya resuelto. No consulta nada por su cuenta. */
export interface CatalogoNormativo {
  readonly norms: readonly NormSnapshot[];
  readonly versions: readonly NormVersionSnapshot[];
  readonly adoptions: readonly AdoptionSnapshot[];
  readonly rules: readonly RuleSnapshot[];
  readonly modifications: readonly ModificationSnapshot[];
}

export interface Cita {
  readonly organismo: string;
  readonly norma: string;
  readonly articulo: string | null;
  readonly version: number;
  readonly vigenciaDesde: CalendarDate | null;
  readonly adoptadaEn: string | null;
  readonly nivelVerificacion: VerificationLevel;
  readonly normVersionId: string;
}
