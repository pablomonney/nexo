/**
 * Vigencia: por qué no es un `WHERE fecha <= now()`.
 *
 * El antipatrón que este archivo existe para impedir:
 *
 * ```sql
 * -- PROHIBIDO en este repositorio
 * SELECT * FROM norms
 *  WHERE fecha_vigencia <= CURRENT_DATE
 *    AND (fecha_derogacion IS NULL OR fecha_derogacion > CURRENT_DATE)
 * ```
 *
 * Recontabilizar 2024 con el derecho de 2026 es exactamente el error que el §6
 * pide evitar. Y hay tres razones más, todas verificadas en fuente oficial:
 *
 * 1. **La vigencia de una norma profesional se ata al inicio del ejercicio**, no
 *    a la fecha del hecho. Una sociedad con cierre en noviembre no empieza a
 *    aplicar la RT 54 el mismo día que una con cierre en diciembre.
 * 2. **La adopción es jurisdiccional.** FACPCE fijó la RT 54 para ejercicios
 *    iniciados desde el 01/07/2024; el CPCECABA la adoptó desde el 01/01/2025.
 *    Los dos hechos son verdaderos y no se contradicen.
 * 3. **La aplicación anticipada a veces se ancla al cierre**, no al inicio
 *    (CPCECABA: ejercicios finalizados desde el 30/09/2024), y **es una opción
 *    del ente**: ser elegible no es haber optado.
 */

import type { CalendarDate } from '@aai/shared';
import type {
  AdoptionSnapshot,
  ContextoNormativo,
  NormSnapshot,
  NormVersionSnapshot,
} from './contracts.js';
import { ORGANISMOS_PROFESIONALES } from './contracts.js';

export type EstadoAplicabilidad =
  | 'APLICA'
  | 'APLICA_POR_OPCION_ANTICIPADA'
  | 'ELEGIBLE_ANTICIPADA_SIN_OPTAR'
  | 'AUN_NO_VIGENTE'
  | 'DEROGADA'
  | 'FUERA_DE_JURISDICCION'
  /** El sistema no conocía esta versión en el `asOf` consultado. */
  | 'NO_CONOCIDA_AL_MOMENTO'
  /** Norma profesional sin acto de adopción cargado para la jurisdicción. */
  | 'ADOPCION_NO_RELEVADA';

export interface ResultadoAplicabilidad {
  readonly estado: EstadoAplicabilidad;
  readonly aplica: boolean;
  readonly explicacion: string;
  /** Fecha desde la que rige para *este* ente, si aplica. */
  readonly vigenteDesde: CalendarDate | null;
  readonly adopcion: AdoptionSnapshot | null;
}

export function esProfesional(norm: NormSnapshot): boolean {
  return (ORGANISMOS_PROFESIONALES as readonly string[]).includes(norm.organismo);
}

export function aplicabilidad(
  norm: NormSnapshot,
  version: NormVersionSnapshot,
  adopciones: readonly AdoptionSnapshot[],
  contexto: ContextoNormativo,
): ResultadoAplicabilidad {
  // --- Eje de tiempo de SISTEMA -------------------------------------------
  // Se resuelve primero: una versión que el sistema no conocía en `asOf` no
  // pudo haber fundado la decisión de entonces, por más vigente que estuviera
  // en el mundo.
  if (version.recordedFrom > contexto.asOf) {
    return no(
      'NO_CONOCIDA_AL_MOMENTO',
      `El sistema incorporó esta versión el ${version.recordedFrom}, después del momento consultado (${contexto.asOf})`,
    );
  }
  if (version.recordedTo !== null && version.recordedTo <= contexto.asOf) {
    return no(
      'NO_CONOCIDA_AL_MOMENTO',
      'Esta versión fue reemplazada en el registro del sistema antes del momento consultado',
    );
  }

  // --- Normas profesionales: manda el acto de adopción ---------------------
  if (esProfesional(norm)) {
    const adopcion = adopciones.find(
      (candidata) =>
        candidata.normVersionId === version.id &&
        candidata.jurisdiction === contexto.jurisdiccion,
    );

    if (adopcion === undefined) {
      // No se cae de vuelta a la fecha de FACPCE. Usar la vigencia del emisor
      // cuando el consejo de la jurisdicción todavía no adoptó sería inventar
      // una vigencia — y es el gap `adopcion_no_caba`, declarado desde FASE 1b.
      return no(
        'ADOPCION_NO_RELEVADA',
        `No está relevado el acto de adopción de esta norma en ${contexto.jurisdiccion}. ` +
          'El motor no supone la fecha del organismo emisor: son hechos jurídicos distintos.',
      );
    }

    return porAdopcion(adopcion, contexto);
  }

  // --- Normas de organismos de control y legislación ----------------------
  if (version.fechaVigencia === null) {
    return no(
      'AUN_NO_VIGENTE',
      'La versión no tiene fecha de vigencia cargada: el motor no la supone',
    );
  }
  if (contexto.fechaHecho < version.fechaVigencia) {
    return no(
      'AUN_NO_VIGENTE',
      `Rige desde el ${version.fechaVigencia} y el hecho es del ${contexto.fechaHecho}`,
    );
  }
  if (version.fechaDerogacion !== null && contexto.fechaHecho >= version.fechaDerogacion) {
    return no(
      'DEROGADA',
      `Derogada desde el ${version.fechaDerogacion} y el hecho es del ${contexto.fechaHecho}`,
    );
  }

  return {
    estado: 'APLICA',
    aplica: true,
    explicacion: `Vigente desde el ${version.fechaVigencia} al momento del hecho`,
    vigenteDesde: version.fechaVigencia,
    adopcion: null,
  };
}

function porAdopcion(
  adopcion: AdoptionSnapshot,
  contexto: ContextoNormativo,
): ResultadoAplicabilidad {
  if (adopcion.validTo !== null && contexto.inicioEjercicio > adopcion.validTo) {
    return { ...no('DEROGADA', `La adopción rigió hasta el ${adopcion.validTo}`), adopcion };
  }

  // La vigencia ordinaria se ancla al INICIO del ejercicio.
  if (contexto.inicioEjercicio >= adopcion.validFrom) {
    return {
      estado: 'APLICA',
      aplica: true,
      explicacion:
        `Adoptada por ${adopcion.adoptingBody} (${adopcion.adoptionAct}) para ejercicios ` +
        `iniciados desde el ${adopcion.validFrom}; este ejercicio inició el ${contexto.inicioEjercicio}`,
      vigenteDesde: adopcion.validFrom,
      adopcion,
    };
  }

  // Aplicación anticipada. El ancla puede ser el cierre y no el inicio.
  if (adopcion.earlyFrom !== null && adopcion.earlyAnchor !== null) {
    const fechaAncla =
      adopcion.earlyAnchor === 'CIERRE_EJERCICIO'
        ? contexto.cierreEjercicio
        : contexto.inicioEjercicio;

    if (fechaAncla >= adopcion.earlyFrom) {
      const anclaTexto =
        adopcion.earlyAnchor === 'CIERRE_EJERCICIO' ? 'finalizados' : 'iniciados';

      if (contexto.optoPorAnticipada === true) {
        return {
          estado: 'APLICA_POR_OPCION_ANTICIPADA',
          aplica: true,
          explicacion:
            `El ente optó por la aplicación anticipada, admitida para ejercicios ${anclaTexto} ` +
            `desde el ${adopcion.earlyFrom}`,
          vigenteDesde: adopcion.earlyFrom,
          adopcion,
        };
      }

      // Elegible no es aplicable. La opción se registra con respaldo
      // documental; deducirla de que las fechas dan sería decidir por el ente.
      return {
        estado: 'ELEGIBLE_ANTICIPADA_SIN_OPTAR',
        aplica: false,
        explicacion:
          `El ente podría aplicarla anticipadamente (ejercicios ${anclaTexto} desde el ` +
          `${adopcion.earlyFrom}), pero no consta que haya optado. La opción se registra, no se infiere.`,
        vigenteDesde: null,
        adopcion,
      };
    }
  }

  return {
    ...no(
      'AUN_NO_VIGENTE',
      `Adoptada para ejercicios iniciados desde el ${adopcion.validFrom}; ` +
        `este ejercicio inició el ${contexto.inicioEjercicio}`,
    ),
    adopcion,
  };
}

function no(estado: EstadoAplicabilidad, explicacion: string): ResultadoAplicabilidad {
  return { estado, aplica: false, explicacion, vigenteDesde: null, adopcion: null };
}
