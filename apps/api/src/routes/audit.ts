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

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

interface FilaBitacora {
  readonly id: string;
  readonly ocurridoEn: Date;
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
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
