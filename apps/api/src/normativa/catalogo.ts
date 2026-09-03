/**
 * El catálogo normativo, cargado desde la base.
 *
 * Vivía dentro de `routes/predictions.ts` y salió de ahí cuando la ruta que
 * muestra qué normativa gobierna a la empresa pasó a necesitar exactamente lo
 * mismo. Dos armados del mismo catálogo serían dos respuestas posibles a «qué
 * reglas rigen», que es justo lo que el motor normativo existe para no tener.
 */

import type { Tx } from '@aai/db';
import type { CatalogoNormativo, DocumentoArchivado } from '@aai/normative-engine';
import { parseCalendarDate, type CalendarDate } from '@aai/shared';

/** De `date` de PostgreSQL a la fecha del motor, sin pasar por `Date`. */
function aFecha(valor: Date | string): CalendarDate {
  return parseCalendarDate(
    typeof valor === 'string' ? valor.slice(0, 10) : valor.toISOString().slice(0, 10),
  );
}

/**
 * El documento original de cada norma citada, si está archivado.
 *
 * Es lo que separa una cita de una referencia: el `sha256` del archivo que se
 * descargó del organismo. Sin él la cita no se puede abrir, y una cita que no
 * se puede abrir no funda una regla activa (NORMATIVE_ENGINE.md §6).
 */
export async function documentosArchivados(
  tx: Tx,
  normVersionIds: readonly string[],
): Promise<Map<string, DocumentoArchivado>> {
  if (normVersionIds.length === 0) return new Map();

  const r = await tx.query<{
    norm_version_id: string;
    url_oficial: string;
    storage_key: string;
    sha256: string;
    fecha_descarga: string;
  }>(
    `SELECT DISTINCT ON (norm_version_id)
            norm_version_id, url_oficial, storage_key, sha256, fecha_descarga::text
       FROM norm_documents
      WHERE norm_version_id = ANY($1)
      ORDER BY norm_version_id, fecha_descarga DESC`,
    [normVersionIds],
  );

  return new Map(
    r.rows.map((fila) => [
      fila.norm_version_id,
      {
        urlOficial: fila.url_oficial,
        archivo: fila.storage_key,
        sha256: fila.sha256,
        fechaDescarga: fila.fecha_descarga,
      },
    ]),
  );
}

export async function cargarCatalogo(tx: Tx): Promise<CatalogoNormativo> {
  const norms = await tx.query(
    `SELECT id, organismo, tipo, numero, anio, titulo, jurisdiccion,
            hierarchy_level, estado FROM norms`,
  );
  const versions = await tx.query(
    `SELECT v.id, v.norm_id, v.version, v.fecha_emision, v.fecha_vigencia, v.fecha_derogacion,
            v.recorded_from, v.recorded_to, v.verification_level,
            EXISTS (SELECT 1 FROM norm_documents d WHERE d.norm_version_id = v.id) AS tiene_documento
       FROM norm_versions v`,
  );
  const adoptions = await tx.query(
    `SELECT norm_version_id, jurisdiction, adopting_body, adoption_act,
            valid_from, valid_to, early_from, early_anchor FROM norm_adoptions`,
  );
  const rules = await tx.query(
    `SELECT id, rule_key, version, norm_version_id, domain, valid_from, valid_to,
            jurisdiction, entity_types, frameworks, priority, conditions, action, status
       FROM accounting_rules WHERE status = 'ACTIVE'`,
  );
  const modifications = await tx.query(
    'SELECT modificadora_version_id, modificada_version_id, tipo FROM norm_modifications',
  );

  return {
    norms: norms.rows.map((f) => ({
      id: f['id'] as string,
      organismo: f['organismo'] as string,
      tipo: f['tipo'] as string,
      numero: f['numero'] as string,
      anio: f['anio'] as number,
      titulo: f['titulo'] as string,
      jurisdiccion: f['jurisdiccion'] as string,
      hierarchyLevel: f['hierarchy_level'] as 1 | 2 | 3 | 4,
      estado: f['estado'] as 'VIGENTE' | 'DEROGADA' | 'SUSTITUIDA',
    })),
    versions: versions.rows.map((f) => ({
      id: f['id'] as string,
      normId: f['norm_id'] as string,
      version: f['version'] as number,
      fechaEmision: aFecha(f['fecha_emision'] as Date),
      fechaVigencia: f['fecha_vigencia'] === null ? null : aFecha(f['fecha_vigencia'] as Date),
      fechaDerogacion: f['fecha_derogacion'] === null ? null : aFecha(f['fecha_derogacion'] as Date),
      recordedFrom: (f['recorded_from'] as Date).toISOString(),
      recordedTo: f['recorded_to'] === null ? null : (f['recorded_to'] as Date).toISOString(),
      verificationLevel: f['verification_level'] as 'V1' | 'V2' | 'V3' | 'V4',
      tieneDocumento: f['tiene_documento'] as boolean,
    })),
    adoptions: adoptions.rows.map((f) => ({
      normVersionId: f['norm_version_id'] as string,
      jurisdiction: f['jurisdiction'] as string,
      adoptingBody: f['adopting_body'] as string,
      adoptionAct: f['adoption_act'] as string,
      validFrom: aFecha(f['valid_from'] as Date),
      validTo: f['valid_to'] === null ? null : aFecha(f['valid_to'] as Date),
      earlyFrom: f['early_from'] === null ? null : aFecha(f['early_from'] as Date),
      earlyAnchor: f['early_anchor'] as 'INICIO_EJERCICIO' | 'CIERRE_EJERCICIO' | null,
    })),
    rules: rules.rows.map((f) => ({
      id: f['id'] as string,
      ruleKey: f['rule_key'] as string,
      version: f['version'] as number,
      normVersionId: f['norm_version_id'] as string,
      domain: f['domain'] as 'accounting' | 'tax' | 'disclosure',
      validFrom: aFecha(f['valid_from'] as Date),
      validTo: f['valid_to'] === null ? null : aFecha(f['valid_to'] as Date),
      jurisdiction: f['jurisdiction'] as string,
      entityTypes: f['entity_types'] as string[],
      frameworks: f['frameworks'] as string[],
      priority: f['priority'] as number,
      conditions: f['conditions'],
      action: f['action'],
      status: f['status'] as 'DRAFT' | 'IN_REVIEW' | 'ACTIVE' | 'SUPERSEDED',
    })),
    modifications: modifications.rows.map((f) => ({
      modificadoraVersionId: f['modificadora_version_id'] as string,
      modificadaVersionId: f['modificada_version_id'] as string,
      tipo: f['tipo'] as 'SUSTITUYE' | 'INCORPORA' | 'DEROGA' | 'RATIFICA',
    })),
  };
}
