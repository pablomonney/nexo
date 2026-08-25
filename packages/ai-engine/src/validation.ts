/**
 * Validation Layer — la única puerta.
 *
 * ```
 * AGENTE → PROPUESTA → [ VALIDATION LAYER ] → revisión humana → motor contable
 * ```
 *
 * Todo lo que un modelo produce pasa por acá antes de existir para el resto del
 * sistema. No hay un camino alternativo: `ai-engine` no puede importar el motor
 * contable ni un cliente de base, y eso lo verifica el lint de arquitectura en
 * CI (ADR-001).
 *
 * Esta capa hace cuatro cosas, y ninguna es "revisar que la respuesta tenga
 * sentido":
 *
 * 1. **Valida contra el schema.** Lo que no valida se descarta. No se completa
 *    lo que falta ni se interpreta con buena voluntad.
 * 2. **Resuelve la cuenta contra el plan real** de esa empresa, y verifica que
 *    sea imputable. El modelo devolvió un código; el id lo pone esta capa.
 * 3. **Resuelve cada cita** contra el conjunto que se le pasó en el contexto.
 *    Una cita que no resuelve es una alucinación detectada, se registra como tal
 *    y tumba la propuesta entera.
 * 4. **Aplica el triage** con los disparadores duros, que se calculan de hechos
 *    y no se le preguntan al modelo.
 *
 * Una aclaración que conviene tener a mano cuando alguien pida "que apruebe solo
 * lo obvio": `ADMITIDA` no significa contabilizada. Significa que la propuesta
 * es apta para que la mire una persona.
 */

import type { NormativeSourceRef, Triage } from './contracts.js';
import type { ContextoClasificacion } from './contexto.js';
import { evaluarTriage } from './confianza.js';
import { validarContraSchema, type ErrorSchema } from './schema.js';

export type MotivoRechazo =
  | 'SCHEMA_INVALIDO'
  | 'CUENTA_FUERA_DEL_PLAN'
  | 'CUENTA_NO_IMPUTABLE'
  | 'CITA_NO_RESOLUBLE'
  | 'CONFIANZA_FUERA_DE_RANGO'
  | 'PROVEEDOR_NO_DISPONIBLE';

/** Advertencias que no tumban la propuesta pero acotan su banda. */
export type Advertencia = 'CITA_NO_V1' | 'SIN_CITAS';

export interface SalidaClasificacion {
  readonly cuentaId: string;
  readonly cuentaCodigo: string;
  readonly cuentaNombre: string;
  readonly tratamiento: string;
}

export interface PropuestaValidada {
  readonly output: SalidaClasificacion;
  readonly confidence: number;
  readonly reason: string;
  readonly normativeSources: readonly NormativeSourceRef[];
  readonly triage: Triage;
  readonly advertencias: readonly Advertencia[];
}

export type Veredicto =
  | { readonly estado: 'ADMITIDA'; readonly propuesta: PropuestaValidada }
  /** El modelo dijo que no sabe. Es una salida legítima y barata. */
  | { readonly estado: 'ABSTENCION'; readonly detalle: string }
  | {
      readonly estado: 'RECHAZADA';
      readonly motivo: MotivoRechazo;
      readonly detalle: string;
      /**
       * `true` cuando el modelo afirmó algo que no existe: una cuenta fuera del
       * plan, una cita que no resuelve. Alimenta la métrica de deriva, que es
       * distinta de la tasa de error de formato.
       */
      readonly esAlucinacion: boolean;
    };

export function validarSalida(
  bruto: unknown,
  schema: Record<string, unknown>,
  contexto: ContextoClasificacion,
): Veredicto {
  const errores = validarContraSchema(bruto, schema);
  if (errores.length > 0) {
    return {
      estado: 'RECHAZADA',
      motivo: 'SCHEMA_INVALIDO',
      detalle: describir(errores),
      // Un enum violado sí es una invención: el modelo escribió un valor que le
      // dijimos explícitamente que no existía.
      esAlucinacion: errores.some((error) => error.mensaje.includes('no está entre los valores')),
    };
  }

  const salida = bruto as {
    cuentaCodigo: string;
    tratamiento: string;
    confianza: number;
    razon: string;
    citas?: { normVersionId: string; articulo?: string }[];
    abstencion?: boolean;
  };

  if (salida.abstencion === true) {
    return { estado: 'ABSTENCION', detalle: salida.razon };
  }

  // --- La cuenta se resuelve contra el plan real ---------------------------
  const cuenta = contexto.cuentas.find((candidata) => candidata.codigo === salida.cuentaCodigo);
  if (cuenta === undefined) {
    // El schema tenía el enum y aun así devolvió otra cosa. Pasa, y es
    // exactamente por esto que la validación no confía en el schema.
    return {
      estado: 'RECHAZADA',
      motivo: 'CUENTA_FUERA_DEL_PLAN',
      detalle: `La cuenta "${salida.cuentaCodigo}" no existe en el plan de esta empresa`,
      esAlucinacion: true,
    };
  }

  if (!cuenta.imputable) {
    return {
      estado: 'RECHAZADA',
      motivo: 'CUENTA_NO_IMPUTABLE',
      detalle: `${cuenta.codigo} ${cuenta.nombre} es una cuenta de agrupación: no admite imputación directa`,
      // No es una invención: la cuenta existe. Es un error de criterio.
      esAlucinacion: false,
    };
  }

  if (!Number.isFinite(salida.confianza) || salida.confianza < 0 || salida.confianza > 1) {
    return {
      estado: 'RECHAZADA',
      motivo: 'CONFIANZA_FUERA_DE_RANGO',
      detalle: `Confianza informada: ${String(salida.confianza)}`,
      esAlucinacion: false,
    };
  }

  // --- Cada cita resuelve contra lo que se le pasó -------------------------
  const citas = salida.citas ?? [];
  const advertencias: Advertencia[] = [];

  for (const cita of citas) {
    const norma = contexto.normas.find((n) => n.normVersionId === cita.normVersionId);
    if (norma === undefined) {
      return {
        estado: 'RECHAZADA',
        motivo: 'CITA_NO_RESOLUBLE',
        detalle: `Citó la norma "${cita.normVersionId}", que no está en el contexto de la consulta`,
        esAlucinacion: true,
      };
    }
    if (norma.verificationLevel !== 'V1' && !advertencias.includes('CITA_NO_V1')) {
      // No tumba la propuesta —la norma existe y está archivada— pero una
      // fundamentación que no llega a V1 no puede presentarse como firme.
      advertencias.push('CITA_NO_V1');
    }
  }

  if (citas.length === 0) advertencias.push('SIN_CITAS');

  const triage = evaluarTriage({
    contexto,
    cuentaElegida: cuenta,
    confianzaModelo: salida.confianza,
  });

  return {
    estado: 'ADMITIDA',
    propuesta: {
      output: {
        cuentaId: cuenta.id,
        cuentaCodigo: cuenta.codigo,
        cuentaNombre: cuenta.nombre,
        tratamiento: salida.tratamiento,
      },
      confidence: salida.confianza,
      reason: salida.razon,
      normativeSources: citas.map((cita) => ({
        normVersionId: cita.normVersionId,
        ...(cita.articulo !== undefined ? { articulo: cita.articulo } : {}),
      })),
      triage: acotarPorAdvertencias(triage, advertencias),
      advertencias,
    },
  };
}

/**
 * Una propuesta con fundamentación débil no llega a la banda de aprobación en
 * lote, por más confianza que declare el modelo.
 *
 * Sin citas o con citas que no son `V1`, lo máximo es 🟡: revisión individual.
 * Es la diferencia entre "el sistema cree esto" y "el sistema puede mostrarte de
 * dónde lo saca".
 */
function acotarPorAdvertencias(triage: Triage, advertencias: readonly Advertencia[]): Triage {
  if (advertencias.length === 0 || triage.band !== 'ALTA') return triage;
  return { band: 'MEDIA', hardBlocks: triage.hardBlocks };
}

function describir(errores: readonly ErrorSchema[]): string {
  return errores.map((error) => `${error.path}: ${error.mensaje}`).join(' · ');
}

/**
 * ¿La propuesta puede ir al lote de aprobación?
 *
 * Sigue necesitando que una persona apriete el botón. Lo que cambia entre 🟢 y
 * 🟡 es si se puede aprobar en tanda o hay que abrir cada una.
 */
export function admiteAprobacionEnLote(propuesta: PropuestaValidada): boolean {
  return propuesta.triage.band === 'ALTA' && propuesta.triage.hardBlocks.length === 0;
}
