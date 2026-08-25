/**
 * El contexto que recibe el agente.
 *
 * Todo lo que el agente sabe llega por acá. No consulta la base, no llama a
 * ARCA, no lee el archivo normativo: recibe hechos ya resueltos por quien sí
 * tiene permiso de hacerlo. Esa asimetría es lo que permite verificar ADR-001 en
 * el grafo de dependencias en vez de confiar en que nadie escriba la llamada.
 *
 * Consecuencia práctica: **el conjunto de normas citables es el que viene acá**.
 * Un modelo puede "saber" que existe la RT 54; si no está en `normas`, no puede
 * citarla, porque el enum del schema no la incluye y la Validation Layer la
 * rechaza.
 */

export interface CuentaDelPlan {
  readonly id: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: string;
  /** Una cuenta de agrupación no admite imputación directa. */
  readonly imputable: boolean;
  /** Si la empresa ya la usó alguna vez. Una cuenta nueva es un disparador duro. */
  readonly usadaAntes: boolean;
}

export interface NormaDisponible {
  readonly normVersionId: string;
  readonly etiqueta: string;
  readonly resumen: string;
  readonly verificationLevel: 'V1' | 'V2' | 'V3' | 'V4';
}

export type ResultadoSelloFiscal = 'OK' | 'WARN' | 'FAIL' | 'NO_VERIFICABLE';

export interface HechosDelComprobante {
  readonly cuitEmisor: string | null;
  readonly razonSocialEmisor: string | null;
  readonly descripcion: string | null;
  /** Importe total en unidades menores, como texto. Nunca un `number`. */
  readonly totalMenor: string | null;
  readonly moneda: string | null;
  readonly fecha: string | null;
  /** Resultado de la constatación en ARCA, si se hizo. */
  readonly selloFiscal: ResultadoSelloFiscal | null;
  /** `true` si la empresa ya operó antes con este CUIT. */
  readonly proveedorConocido: boolean;
  /** `null` cuando no se pudo consultar: no es lo mismo que "no es apócrifo". */
  readonly proveedorApocrifo: boolean | null;
  readonly monedaExtranjeraSinCotizacion: boolean;
  readonly periodoProximoACierre: boolean;
  /** Importes históricos de esa contraparte, en unidades menores. */
  readonly historicoImportes: readonly string[];
  /** Hallazgos del motor documental que bloquean. */
  readonly hallazgosBloqueantes: readonly string[];
  /**
   * Respuesta del motor normativo para este caso.
   *
   * `NO_CONSULTADO` no es lo mismo que `FUENTE_NO_ENCONTRADA`: el motor
   * normativo puede no haber sido consultado —falta el marco del ente, o el
   * ejercicio que contiene la fecha—, y entonces el sistema no preguntó. Decir
   * "no hay norma" cuando en realidad nadie buscó sería afirmar de más — y es
   * justamente el tipo de afirmación que el §30 prohíbe.
   */
  readonly estadoNormativo:
    | 'RESUELTO'
    | 'FUENTE_NO_ENCONTRADA'
    | 'CONFLICTO_NORMATIVO'
    | 'NO_CONSULTADO';
}

/** Lo que la empresa ya aprobó para señales parecidas (§14). */
export interface PreferenciaAprendida {
  readonly signal: string;
  readonly cuentaId: string;
  readonly cuentaCodigo: string;
  readonly vecesConfirmada: number;
  readonly ultimaConfirmacion: string | null;
}

export interface PoliticaConfianza {
  /** Por encima de esto, la propuesta va al lote de aprobación. */
  readonly autoThreshold: number;
  /** Por debajo de esto, queda bloqueada. */
  readonly reviewThreshold: number;
}

export const POLITICA_POR_DEFECTO: PoliticaConfianza = {
  // Conservadores a propósito. Una política laxa por defecto convierte el
  // "requiere aprobación" en un botón que se aprieta sin mirar.
  autoThreshold: 0.9,
  reviewThreshold: 0.6,
};

export interface ContextoClasificacion {
  readonly companyId: string;
  readonly documentId: string;
  readonly hechos: HechosDelComprobante;
  readonly cuentas: readonly CuentaDelPlan[];
  readonly normas: readonly NormaDisponible[];
  readonly preferencias: readonly PreferenciaAprendida[];
  readonly politica: PoliticaConfianza;
  /** Tratamientos admitidos. Vienen del dominio, no del prompt. */
  readonly tratamientos: readonly string[];
}

export const TRATAMIENTOS_POR_DEFECTO = [
  'GASTO_DEL_EJERCICIO',
  'ACTIVO',
  'PASIVO',
  'ANTICIPO',
  'REGULARIZACION',
  'NO_DETERMINADO',
] as const;
