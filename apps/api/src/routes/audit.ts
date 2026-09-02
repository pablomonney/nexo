/**
 * La bitácora, leída.
 *
 * `audit_logs` se escribe desde 35 acciones de ruta y tres triggers de base,
 * está encadenada por hash y es inmutable — y hasta esta fase **no la leía
 * nadie**. `grep -rn "FROM audit_logs" apps/api/src/` no devolvía una sola
 * línea, y el permiso `audit:read` estaba otorgado a tres roles sin que ninguna
 * ruta lo exigiera.
 *
 * Sin esta ruta, la última mitad del trabajo de un contador —«¿qué pasó con
 * esto?»— solo se podía contestar con `psql`.
 *
 * ## Qué devuelve, y por qué eso
 *
 * Las siete preguntas que un profesional tiene que poder contestar sobre un
 * hecho, y la columna que contesta cada una:
 *
 *   quién            `actor_id`
 *   qué clase de quién   `actor_type` — USER, SYSTEM o AI, **como columna propia**
 *   cuándo           `occurred_at`
 *   sobre qué        `object_type` + `object_id`
 *   qué hizo         `action`
 *   por qué          `motivo`
 *   qué había antes  `old_value`
 *   qué quedó        `new_value`
 *
 * `actor_type` va separado a propósito: que un cambio lo haya propuesto un
 * modelo y que lo haya firmado una persona son hechos distintos, y fundirlos en
 * una sola etiqueta es exactamente cómo una sugerencia se convierte en una
 * decisión profesional sin que nadie lo decida (ADR-001).
 *
 * ## Qué NO devuelve
 *
 * `prev_hash` y `hash` no se exponen. Sirven para verificar la cadena, y
 * verificar la cadena no es leerla: mostrarlos invitaría a compararlos a mano y
 * a creer que eso prueba algo. La verificación es un gate, no una columna.
 *
 * ## Sobre los secretos
 *
 * `old_value` y `new_value` son `jsonb` libre, así que lo que se ve acá es lo
 * que cada ruta decidió guardar. Las rutas sensibles ya lo resolvieron en su
 * momento —`arca.ts` audita la huella SHA-256 del certificado y nunca el PEM, y
 * el alta de usuario guarda `created_by` en la fila y no el hash de la
 * contraseña—. Esta ruta no filtra ni recorta: si algo no debe verse, no debe
 * escribirse. Hay un test que lo comprueba sobre el alta de usuario.
 */

import { auditar } from '@aai/audit-engine';
import { withCompany } from '@aai/db';
import { moneyFromDecimalString, parseCalendarDate } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

interface FilaBitacora {
  readonly id: string;
  readonly ocurridoEn: Date;
}

/** Una línea del Diario, como la mira el detector. */
interface FilaParaAuditar {
  readonly entry_id: string;
  readonly fecha: string;
  readonly cargado_el: string;
  readonly importe: string;
  readonly cuenta_codigo: string;
  readonly contraparte_id: string | null;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Los cuatro detectores del Diario, corridos sobre asientos aprobados.
   *
   * ## Por qué esta ruta existe
   *
   * `@aai/audit-engine` estaba escrito, probado con 28 tests y **no lo importaba
   * nadie**: ni la API, ni un script, ni otro paquete. Cuatro detectores
   * determinísticos que nunca corrieron sobre un dato real. Lo encontró el
   * barrido de la auditoría integral, y es la misma clase de hueco que ya
   * apareció con la bitácora y con el Integration Hub: la pieza construida y el
   * camino hasta ella sin recorrer.
   *
   * ## Ninguna anomalía es una acusación
   *
   * Cada hallazgo dice qué se observó y qué habría que mirar, nunca qué
   * significa. Un asiento cargado un domingo a las tres de la mañana es un
   * hecho; que sea un fraude, un ajuste de cierre o un contador con insomnio no
   * lo decide el software. Y no hay orden por «riesgo»: ponerle un número a
   * cada hallazgo sería fundar una prioridad que el sistema no puede fundar.
   *
   * ## El cuarto detector no corre, y se dice
   *
   * `JUSTO_BAJO_UMBRAL` compara contra umbrales que salen de normas que este
   * repositorio no tiene archivadas. Sin ellos no corre, y el `comentario` lo
   * informa en vez de dejar creer que miró y no encontró nada.
   */
  app.get('/audit/anomalias', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'audit:read');
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        // Solo asientos **aprobados**: un borrador todavía se está escribiendo,
        // y marcarlo por atípico sería observar a alguien mientras piensa.
        const lineas = await tx.query<FilaParaAuditar>(
          `SELECT e.id                                  AS entry_id,
                  e.entry_date::text                    AS fecha,
                  e.created_at::text                    AS cargado_el,
                  greatest(l.debit, l.credit)::text     AS importe,
                  a.code                                AS cuenta_codigo,
                  l.party_id                            AS contraparte_id
             FROM journal_entry_lines l
             JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
             JOIN accounts a ON a.id = l.account_id AND a.company_id = l.company_id
            WHERE e.company_id = $1
              AND e.status = 'APROBADO'
              AND ($2::date IS NULL OR e.entry_date >= $2)
              AND ($3::date IS NULL OR e.entry_date <= $3)
            ORDER BY e.entry_date, e.id, l.line_no`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        // El historial de cada contraparte se arma sobre **todo** lo aprobado,
        // no sobre el período consultado: comparar marzo contra marzo diría que
        // todo es normal en un mes con tres asientos.
        const historial = await tx.query<{ party_id: string; importes: string[] }>(
          `SELECT l.party_id,
                  array_agg(greatest(l.debit, l.credit)::text) AS importes
             FROM journal_entry_lines l
             JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
            WHERE e.company_id = $1 AND e.status = 'APROBADO' AND l.party_id IS NOT NULL
            GROUP BY l.party_id`,
          [tenant.companyId],
        );

        const historicos = new Map<string, readonly bigint[]>(
          historial.rows.map((f) => [
            f.party_id,
            f.importes.map((i) => moneyFromDecimalString(i, 'ARS').amount),
          ]),
        );

        const asientos = lineas.rows.map((f) => ({
          entryId: f.entry_id,
          fecha: parseCalendarDate(f.fecha.slice(0, 10)),
          cargadoEl: f.cargado_el,
          importe: moneyFromDecimalString(f.importe, 'ARS'),
          cuentaCodigo: f.cuenta_codigo,
          contraparteId: f.contraparte_id,
        }));

        // Sin umbrales archivados el tercer detector no corre. No se le pasa una
        // lista de ejemplo: un umbral inventado convierte un control en ruido
        // con forma de control.
        const resultado = auditar({ asientos, historicosPorContraparte: historicos });

        return {
          anomalias: resultado.anomalias,
          asientosRevisados: resultado.asientosRevisados,
          asientosConHallazgo: resultado.asientosConHallazgo,
          comentario: resultado.comentario,
          alcance:
            'Cuatro detectores determinísticos sobre los asientos **aprobados**: importe ' +
            'atípico contra el historial de la misma contraparte (mediana y MAD, no media ' +
            'y desvío), importe redondo, importe justo bajo un umbral declarado, y asiento ' +
            'cargado mucho después de su fecha. ' +
            'Ninguna anomalía es una acusación: cada una dice qué se observó y qué habría ' +
            'que mirar, y no vienen ordenadas por riesgo porque ordenarlas exigiría un ' +
            'número que el software no puede fundar.',
        };
      },
    );
  });

  app.get('/audit', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'audit:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        objectType: z.string().max(64).optional(),
        objectId: z.string().max(64).optional(),
        actorType: z.enum(['USER', 'SYSTEM', 'AI']).optional(),
        action: z.string().max(64).optional(),
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    // La empresa sale de `requireCompany` y la filtra RLS. No hay parámetro de
    // empresa: no existe forma de pedir la bitácora de otra.
    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query<FilaBitacora>(
          `SELECT id,
                  actor_type  AS "actorType",
                  actor_id    AS "actor",
                  action      AS "accion",
                  object_type AS "objetoTipo",
                  object_id   AS "objetoId",
                  old_value   AS "antes",
                  new_value   AS "despues",
                  motivo,
                  occurred_at AS "ocurridoEn"
             FROM audit_logs
            WHERE company_id = $1
              AND ($2::text IS NULL OR object_type = $2)
              AND ($3::text IS NULL OR object_id = $3)
              AND ($4::text IS NULL OR actor_type = $4)
              AND ($5::text IS NULL OR action = $5)
              AND ($6::date IS NULL OR occurred_at >= $6::date)
              AND ($7::date IS NULL OR occurred_at < ($7::date + 1))
              -- Keyset descendente: lo último primero, que es como se lee una
              -- bitácora. El id desempata y hace el orden total.
              AND ($8::timestamptz IS NULL
                   OR (occurred_at, id) < ($8::timestamptz, $9::uuid))
            ORDER BY occurred_at DESC, id DESC
            LIMIT $10`,
          [
            tenant.companyId,
            query.objectType ?? null,
            query.objectId ?? null,
            query.actorType ?? null,
            query.action ?? null,
            query.desde ?? null,
            query.hasta ?? null,
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(result.rows, query.limite, (fila) => ({
          fecha: fila.ocurridoEn,
          id: fila.id,
        }));
        return { eventos: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });
}
