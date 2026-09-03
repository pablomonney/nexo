/**
 * Qué normativa gobierna a esta empresa (S-21).
 *
 * El motor normativo resuelve reglas cada vez que alguien decide sobre un
 * comprobante, y hasta acá **no había forma de mirarlo de frente**: se veía el
 * resultado —una decisión, una propuesta, un bloqueo— y nunca el estado de la
 * capa. `GET /normative/gaps` decía lo que falta; faltaba decir lo que hay.
 *
 * La diferencia importa porque el estado normal del sistema hoy es «no hay
 * ninguna regla activa», y eso **no es un error**: cargar una regla exige
 * transcribir el articulado que la funda, archivar el documento y que alguien
 * distinto del que la propone la apruebe. Un sistema que no muestra ese estado
 * deja creer que sí hay reglas aplicándose.
 *
 * ## Qué contesta, por regla
 *
 *   - **RESUELTA** — rige, y su cita se puede presentar como aplicada.
 *   - **NO_PRESENTABLE** — el motor la resolvió y su fuente no alcanza: la
 *     norma no es V1 o su documento no está archivado. Se informa con el render
 *     de la cita, que dice exactamente qué falta.
 *   - **CONFLICTO** — dos normas la gobiernan y ninguna gana. No se aplica
 *     ninguna: elegir sería inventar la jerarquía.
 *   - **NO_APLICA** — vigente, pero no para esta empresa en esta fecha
 *     (jurisdicción, tipo de ente, marco contable, adopción sin relevar).
 *
 * No hay estado «probablemente». El motor devuelve uno de esos cuatro o la
 * regla no está en el catálogo.
 */

import { withCompany } from '@aai/db';
import {
  citaHabilitaAplicacion,
  renderizarCita,
  resolverVarias,
  type ContextoNormativo,
} from '@aai/normative-engine';
import { parseCalendarDate, type CalendarDate } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest } from '../http/errors.js';
import { cargarCatalogo, documentosArchivados } from '../normativa/catalogo.js';

export async function normativaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/normative/rules', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'rule:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        /** La fecha del hecho: la vigencia de una norma se evalúa contra ella. */
        fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD'),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const empresa = await tx.query<{
          jurisdiction: string;
          entity_type: string;
          framework: string | null;
          inicio: string | null;
          cierre: string | null;
        }>(
          `SELECT c.jurisdiction, c.entity_type,
                  (SELECT f.framework FROM company_reporting_frameworks f
                    WHERE f.company_id = c.id AND f.valid_from <= $2::date
                      AND (f.valid_to IS NULL OR f.valid_to >= $2::date)
                    ORDER BY f.valid_from DESC LIMIT 1) AS framework,
                  (SELECT y.start_date::text FROM fiscal_years y
                    WHERE y.company_id = c.id AND $2::date BETWEEN y.start_date AND y.end_date)
                    AS inicio,
                  (SELECT y.end_date::text FROM fiscal_years y
                    WHERE y.company_id = c.id AND $2::date BETWEEN y.start_date AND y.end_date)
                    AS cierre
             FROM companies c WHERE c.id = $1`,
          [tenant.companyId, query.fecha],
        );
        const fila = empresa.rows[0];
        if (fila === undefined) throw badRequest('La empresa no existe');

        // Sin ejercicio no hay eje temporal para una norma profesional —se ata
        // al inicio del ejercicio, no al hecho— y sin marco contable declarado
        // no se sabe cuál rige. Las dos ausencias se informan; ninguna se
        // completa con un valor por defecto.
        const faltan: string[] = [];
        if (fila.inicio === null) faltan.push('EJERCICIO_QUE_CONTENGA_LA_FECHA');
        if (fila.framework === null) faltan.push('MARCO_CONTABLE_DECLARADO');

        const catalogo = await cargarCatalogo(tx);
        const claves = [...new Set(catalogo.rules.map((regla) => regla.ruleKey))];

        if (faltan.length > 0 || claves.length === 0) {
          return {
            fecha: query.fecha,
            contexto: {
              jurisdiccion: fila.jurisdiction,
              tipoDeEnte: fila.entity_type,
              marco: fila.framework,
            },
            reglas: [],
            faltaDeclarar: faltan,
            motivo:
              claves.length === 0
                ? 'No hay ninguna regla cargada en el catálogo. No es un error: cargar una ' +
                  'exige transcribir el articulado que la funda, archivar el documento y que ' +
                  'la apruebe alguien distinto del que la propone (§32).'
                : 'Falta declarar algo del contexto de la empresa, y sin eso la resolución ' +
                  'sería una suposición.',
            alcance: ALCANCE,
          };
        }

        const contexto: ContextoNormativo = {
          fechaHecho: parseCalendarDate(query.fecha),
          inicioEjercicio: aFecha(fila.inicio!),
          cierreEjercicio: aFecha(fila.cierre!),
          jurisdiccion: fila.jurisdiction,
          tipoEnte: fila.entity_type,
          marco: fila.framework!,
          asOf: new Date().toISOString(),
        };

        const resoluciones = [...resolverVarias(claves, contexto, catalogo)];
        const documentos = await documentosArchivados(
          tx,
          resoluciones
            .map(([, r]) => (r.estado === 'RESUELTA' ? r.regla.cita.normVersionId : null))
            .filter((id): id is string => id !== null),
        );

        const reglas = resoluciones.map(([clave, resolucion]) => {
          if (resolucion.estado !== 'RESUELTA') {
            return {
              ruleKey: clave,
              // `SIN_FUENTE` del motor es «no hay norma relevada que la funde»;
              // acá se muestra con el código del error, que distingue los
              // cuatro motivos posibles sin que esta ruta los reinterprete.
              estado: resolucion.error.code,
              norma: null,
              nivelVerificacion: null,
              presentable: false,
              // El motor ya explicó por qué no resolvió. Reescribirlo con otras
              // palabras sería una segunda explicación del mismo hecho.
              detalle: resolucion.error.message,
            };
          }

          const cita = resolucion.regla.cita;
          const documento = documentos.get(cita.normVersionId) ?? null;
          const presentable = citaHabilitaAplicacion(cita, documento);

          return {
            ruleKey: clave,
            version: resolucion.regla.rule.version,
            estado: presentable ? 'RESUELTA' : 'NO_PRESENTABLE',
            norma: `${cita.organismo} — ${cita.norma}`,
            nivelVerificacion: cita.nivelVerificacion,
            vigenciaDesde: cita.vigenciaDesde,
            adoptadaEn: cita.adoptadaEn,
            documentoSha256: documento?.sha256 ?? null,
            presentable,
            // Cuando no es presentable, el render dice exactamente qué falta:
            // el nivel de la fuente o el documento archivado.
            detalle: presentable ? null : renderizarCita(cita, documento).lineas.join(' · '),
          };
        });

        return {
          fecha: query.fecha,
          contexto: {
            jurisdiccion: fila.jurisdiction,
            tipoDeEnte: fila.entity_type,
            marco: fila.framework,
          },
          reglas: reglas.sort((a, b) => a.ruleKey.localeCompare(b.ruleKey)),
          faltaDeclarar: faltan,
          motivo: null,
          alcance: ALCANCE,
        };
      },
    );
  });
}

const ALCANCE =
  'Esto es lo que el motor normativo resolvería para esta empresa en esta fecha, con el ' +
  'catálogo cargado hoy. Una regla que no aparece como RESUELTA no se aplica: no hay estado ' +
  'intermedio, y una fuente que no llega a V1 con documento archivado no funda una regla ' +
  'activa (NORMATIVE_ENGINE.md §6).';

/** De `date` de PostgreSQL a la fecha del motor, sin pasar por `Date`. */
function aFecha(valor: string): CalendarDate {
  return parseCalendarDate(valor.slice(0, 10));
}
