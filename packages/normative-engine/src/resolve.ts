/**
 * El algoritmo de resolución del §4.
 *
 * ```
 * 1. Candidatas = reglas cuyo ámbito intersecta el contexto.
 * 2. Filtro de vigencia, incluyendo adopción jurisdiccional.
 * 3. Filtro de conocimiento: descartar lo que el sistema no sabía en `asOf`.
 * 4. Exigir fuente V1 con documento archivado.
 * 5. Jerarquía P1 > P2 > P3 > P4.
 * 6. Si quedan >1 de igual prioridad sin derogación DECLARADA → CONFLICTO.
 * 7. Si queda 0 → FUENTE NO ENCONTRADA.
 * 8. Devolver la regla con su cita.
 * ```
 *
 * Los pasos 6 y 7 son el corazón. La única forma de que el motor elija entre dos
 * normas es que exista una relación de derogación o sustitución **cargada desde
 * el texto oficial**. No hay heurística de "la más nueva gana" ni "la más
 * específica gana": ambas son razonables y ambas se equivocan, y cuando se
 * equivocan lo hacen en silencio.
 */

import type { NormativeError } from '@aai/shared';
import { normativeError } from '@aai/shared';
import { aplicabilidad, type ResultadoAplicabilidad } from './applicability.js';
import type {
  CatalogoNormativo,
  Cita,
  ContextoNormativo,
  NormSnapshot,
  NormVersionSnapshot,
  RuleSnapshot,
} from './contracts.js';

export interface ReglaResuelta {
  readonly rule: RuleSnapshot;
  readonly norm: NormSnapshot;
  readonly version: NormVersionSnapshot;
  readonly cita: Cita;
  readonly aplicabilidad: ResultadoAplicabilidad;
}

export interface Descartada {
  readonly ruleKey: string;
  readonly ruleVersion: number;
  readonly motivo: string;
}

export type Resolucion =
  | { readonly estado: 'RESUELTA'; readonly regla: ReglaResuelta; readonly descartadas: readonly Descartada[] }
  | { readonly estado: 'SIN_FUENTE'; readonly error: NormativeError; readonly descartadas: readonly Descartada[] }
  | {
      readonly estado: 'CONFLICTO';
      readonly error: NormativeError;
      readonly candidatas: readonly ReglaResuelta[];
    };

export function resolverRegla(
  ruleKey: string,
  contexto: ContextoNormativo,
  catalogo: CatalogoNormativo,
): Resolucion {
  const descartadas: Descartada[] = [];
  const candidatas: ReglaResuelta[] = [];

  for (const rule of catalogo.rules) {
    if (rule.ruleKey !== ruleKey) continue;

    const descarte = (motivo: string): void => {
      descartadas.push({ ruleKey: rule.ruleKey, ruleVersion: rule.version, motivo });
    };

    // --- 1. Ámbito ---------------------------------------------------------
    if (rule.status !== 'ACTIVE') {
      descarte(`La regla está en estado ${rule.status}`);
      continue;
    }
    if (rule.jurisdiction !== contexto.jurisdiccion && rule.jurisdiction !== 'AR') {
      descarte(`Ámbito ${rule.jurisdiction}, contexto ${contexto.jurisdiccion}`);
      continue;
    }
    if (rule.entityTypes.length > 0 && !rule.entityTypes.includes(contexto.tipoEnte)) {
      descarte(`No alcanza al tipo de ente ${contexto.tipoEnte}`);
      continue;
    }
    if (rule.frameworks.length > 0 && !rule.frameworks.includes(contexto.marco)) {
      descarte(`No alcanza al marco ${contexto.marco}`);
      continue;
    }
    if (contexto.fechaHecho < rule.validFrom) {
      descarte(`La regla rige desde el ${rule.validFrom}`);
      continue;
    }
    if (rule.validTo !== null && contexto.fechaHecho > rule.validTo) {
      descarte(`La regla rigió hasta el ${rule.validTo}`);
      continue;
    }

    const version = catalogo.versions.find((v) => v.id === rule.normVersionId);
    if (version === undefined) {
      descarte('La norma que la funda no está en el catálogo');
      continue;
    }
    const norm = catalogo.norms.find((n) => n.id === version.normId);
    if (norm === undefined) {
      descarte('La norma que la funda no está en el catálogo');
      continue;
    }

    // --- 4. Fuente verificable --------------------------------------------
    // Una cita que no se puede abrir no es una cita. La base ya impide activar
    // una regla así, pero el motor recibe instantáneas y no puede confiar en
    // que la instantánea haya pasado por ese candado.
    if (version.verificationLevel !== 'V1') {
      descarte(`La norma está en nivel ${version.verificationLevel} y se requiere V1`);
      continue;
    }
    if (!version.tieneDocumento) {
      descarte('La norma no tiene documento original archivado');
      continue;
    }

    // --- 2 y 3. Vigencia y conocimiento ------------------------------------
    const aplica = aplicabilidad(norm, version, catalogo.adoptions, contexto);
    if (!aplica.aplica) {
      descarte(aplica.explicacion);
      continue;
    }

    candidatas.push({ rule, norm, version, cita: citarDe(norm, version, aplica), aplicabilidad: aplica });
  }

  // --- 7. Ninguna ----------------------------------------------------------
  if (candidatas.length === 0) {
    // Si alguna se descartó por falta de adopción, ese es el motivo específico
    // y accionable —cargar el acto de adopción—, no un genérico "no hay norma".
    const porAdopcion = descartadas.some((d) => d.motivo.includes('acto de adopción'));
    return {
      estado: 'SIN_FUENTE',
      error: porAdopcion
        ? normativeError(
            'ADOPCION_NO_RELEVADA',
            `No hay acto de adopción cargado para ${contexto.jurisdiccion}. ` +
              `La regla "${ruleKey}" no se puede resolver en esta jurisdicción.`,
            { details: { ruleKey, jurisdiccion: contexto.jurisdiccion } },
          )
        : normativeError(
            'FUENTE_NO_ENCONTRADA',
            `No hay regla relevada para "${ruleKey}" en el contexto consultado.`,
            { details: { ruleKey, descartadas: descartadas.length } },
          ),
      descartadas,
    };
  }

  // --- 5. Jerarquía --------------------------------------------------------
  const nivelMasAlto = Math.min(...candidatas.map((c) => c.norm.hierarchyLevel));
  const porJerarquia = candidatas.filter((c) => c.norm.hierarchyLevel === nivelMasAlto);

  if (porJerarquia.length === 1) {
    return { estado: 'RESUELTA', regla: porJerarquia[0]!, descartadas };
  }

  // --- 6. Empate: solo lo resuelve una relación DECLARADA -------------------
  const sobrevivientes = porJerarquia.filter(
    (candidata) => !fueDerogadaPorOtra(candidata, porJerarquia, catalogo),
  );

  if (sobrevivientes.length === 1) {
    return { estado: 'RESUELTA', regla: sobrevivientes[0]!, descartadas };
  }

  return {
    estado: 'CONFLICTO',
    error: normativeError(
      'CONFLICTO_NORMATIVO',
      `Hay ${sobrevivientes.length} reglas aplicables de igual prioridad para "${ruleKey}" ` +
        'sin relación de derogación declarada entre sus normas. El motor no desempata.',
      { details: { ruleKey, candidatas: sobrevivientes.map((c) => c.rule.id) } },
    ),
    candidatas: sobrevivientes,
  };
}

/**
 * ¿Alguna de las otras candidatas deroga o sustituye a esta?
 *
 * Solo cuenta lo que está en `norm_modifications`, que se carga transcribiendo
 * el articulado. "La más nueva gana" es una heurística razonable que se
 * equivoca en silencio: una norma posterior puede no derogar a la anterior.
 */
function fueDerogadaPorOtra(
  candidata: ReglaResuelta,
  todas: readonly ReglaResuelta[],
  catalogo: CatalogoNormativo,
): boolean {
  return todas.some((otra) => {
    if (otra.rule.id === candidata.rule.id) return false;
    return catalogo.modifications.some(
      (modificacion) =>
        modificacion.modificadoraVersionId === otra.version.id &&
        modificacion.modificadaVersionId === candidata.version.id &&
        (modificacion.tipo === 'DEROGA' || modificacion.tipo === 'SUSTITUYE'),
    );
  });
}

function citarDe(
  norm: NormSnapshot,
  version: NormVersionSnapshot,
  aplica: ResultadoAplicabilidad,
): Cita {
  return {
    organismo: norm.organismo,
    norma: `${norm.tipo} N° ${norm.numero}/${norm.anio} — ${norm.titulo}`,
    articulo: null,
    version: version.version,
    vigenciaDesde: aplica.vigenteDesde,
    adoptadaEn:
      aplica.adopcion === null
        ? null
        : `${aplica.adopcion.adoptingBody} — ${aplica.adopcion.adoptionAct}`,
    nivelVerificacion: version.verificationLevel,
    normVersionId: version.id,
  };
}

/** Resuelve varias reglas de una vez, conservando el resultado de cada una. */
export function resolverVarias(
  ruleKeys: readonly string[],
  contexto: ContextoNormativo,
  catalogo: CatalogoNormativo,
): ReadonlyMap<string, Resolucion> {
  return new Map(ruleKeys.map((clave) => [clave, resolverRegla(clave, contexto, catalogo)]));
}

/**
 * Normas citables en un contexto, para pasarle al agente de clasificación.
 *
 * Es deliberadamente restrictivo: solo entran las normas de reglas que
 * **resolvieron**. Una norma cuya regla quedó en conflicto o cuya adopción no
 * está relevada no se ofrece como cita — sería darle al modelo permiso para
 * fundamentar en algo que el propio motor no pudo resolver.
 */
export function normasCitables(
  ruleKeys: readonly string[],
  contexto: ContextoNormativo,
  catalogo: CatalogoNormativo,
): readonly Cita[] {
  const citas: Cita[] = [];
  for (const resolucion of resolverVarias(ruleKeys, contexto, catalogo).values()) {
    if (resolucion.estado === 'RESUELTA') citas.push(resolucion.regla.cita);
  }
  return citas;
}
