/**
 * De dónde sale un número (S-20 · data lineage).
 *
 * Cada respuesta de NEXO Intelligence dice con qué vista la contestó
 * —`analytics_operaciones_mensuales`, `party_aging`, `cogs_por_mes`—. Eso
 * contesta «de dónde salió» **un** escalón. La pregunta que hace falta para que
 * la IA no dependa de números irrastreables es la cadena entera:
 *
 *     margen → analytics_margen_por_producto → stock_valuation
 *            → stock_movements → …
 *
 * ## De dónde sale este linaje
 *
 * De PostgreSQL. `pg_rewrite` y `pg_depend` saben exactamente qué lee cada
 * vista porque es como el motor la ejecuta: no hay un mapa declarado que alguien
 * tenga que mantener al día, y por lo tanto no hay forma de que el mapa y la
 * realidad se separen. Es la misma regla que gobierna el resto del sistema
 * —derivar en vez de guardar— aplicada a la metadata.
 *
 * Un mapa escrito a mano habría sido más lindo de leer y habría envejecido con
 * la primera vista que alguien cambiara.
 *
 * ## Qué no dice
 *
 * No dice **qué filas** produjeron un total: eso lo contesta la evidencia de
 * cada respuesta, que trae el importe con su vista. Este endpoint contesta la
 * otra mitad: sobre qué está construida esa vista, hasta llegar a las tablas
 * donde los hechos se escribieron.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound } from '../http/errors.js';

/** Un nombre de relación, sin esquema y sin nada que no sea un identificador. */
const NOMBRE = /^[a-z_][a-z0-9_]{0,62}$/u;

export async function linajeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { relacion: string } }>('/lineage/:relacion', async (request) => {
    const tenant = await requireCompany(request);
    // Es metadata sobre cómo se construye un número, no el número: el mismo
    // permiso que ver un reporte.
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const { relacion } = z
      .object({ relacion: z.string().regex(NOMBRE, 'Nombre de relación inválido') })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        // El `regclass` se resuelve **acá** y no dentro del recursivo: si el
        // nombre no existe, PostgreSQL lanza 42P01 y el mensaje traería el
        // nombre pedido. Preguntarlo antes deja contestar 404 sin ese rebote.
        const existe = await tx.query<{ oid: string; relkind: string }>(
          `SELECT c.oid::text, c.relkind
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'v', 'm')`,
          [relacion],
        );
        if (existe.rowCount === 0) {
          throw notFound(`No existe la tabla o vista ${relacion} en el esquema público`);
        }

        const arbol = await tx.query<{ nombre: string; nivel: number; tipo: string }>(
          `WITH RECURSIVE arbol AS (
             SELECT $1::oid AS relacion, 0 AS nivel
             UNION
             SELECT d.refobjid, a.nivel + 1
               FROM arbol a
               JOIN pg_rewrite r ON r.ev_class = a.relacion
               JOIN pg_depend d
                 ON d.objid = r.oid
                AND d.classid = 'pg_rewrite'::regclass
                AND d.refclassid = 'pg_class'::regclass
                AND d.refobjid <> a.relacion
              -- Tope de profundidad: la recursión sobre un grafo con ciclos no
              -- termina, y una vista que se lee a sí misma es posible de armar.
              WHERE a.nivel < 8
           )
           SELECT DISTINCT c.relname AS nombre, min(a.nivel) AS nivel, c.relkind AS tipo
             FROM arbol a
             JOIN pg_class c ON c.oid = a.relacion
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
            GROUP BY c.relname, c.relkind
            ORDER BY 2, 1`,
          [existe.rows[0]!.oid],
        );

        const nodos = arbol.rows.map((fila) => ({
          nombre: fila.nombre,
          nivel: fila.nivel,
          tipo: fila.tipo === 'r' ? ('TABLA' as const) : ('VISTA' as const),
        }));

        return {
          relacion,
          tipo: existe.rows[0]!.relkind === 'r' ? 'TABLA' : 'VISTA',
          // Las hojas son donde el hecho se escribió. Un número cuyo linaje no
          // llega a ninguna tabla no viene de ningún lado.
          tablas: nodos.filter((n) => n.tipo === 'TABLA').map((n) => n.nombre),
          vistas: nodos.filter((n) => n.tipo === 'VISTA' && n.nombre !== relacion),
          alcance:
            'El linaje sale del catálogo de PostgreSQL (`pg_rewrite`, `pg_depend`), que es como ' +
            'el motor ejecuta la vista: no hay un mapa declarado que pueda quedar desactualizado. ' +
            'Dice sobre qué está construido este número, no qué filas lo produjeron — eso lo ' +
            'trae la evidencia de cada respuesta.',
        };
      },
    );
  });
}
