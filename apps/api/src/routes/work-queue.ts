/**
 * La bandeja de trabajo: qué requiere atención humana en esta empresa.
 *
 * Es una **lectura sobre la vista `work_queue`** (migración 0045), que a su vez
 * es una proyección de estados que ya existen. No hay tabla de tareas, no hay un
 * segundo estado paralelo al del dominio, y no hay forma de sacar un ítem de la
 * bandeja sin resolverlo: desaparece cuando el hecho cambia, no cuando alguien
 * lo marca. El diseño y sus motivos están en `docs/OPERACION.md` §D.
 *
 * ## Autorización: el filtro de ramas ES la autorización
 *
 * No hay un permiso «ver la bandeja». La bandeja es una unión de veinte
 * proyecciones sobre entidades distintas, y cada una tiene su permiso de lectura
 * desde antes de que esta ruta existiera. Se arma la lista de entidades que el
 * usuario puede leer y se consulta **solo** por esas.
 *
 * Un CARGADOR ve sus documentos pendientes y no ve asientos sin aprobar. Un
 * usuario sin ningún permiso de lectura recibe una bandeja vacía, que es la
 * respuesta correcta y no un 403: no hay nada que ocultarle porque no hay nada.
 *
 * Pedir un permiso general de bandeja habría sido peor de las dos maneras
 * posibles: uno amplio deja ver lo que el rol no puede leer por su ruta propia,
 * y uno estrecho —`report:read`, por caso— deja al CARGADOR sin ver sus propios
 * documentos.
 *
 * ## La bandeja no resuelve: dirige
 *
 * No tiene acciones propias. Cada ítem trae `trazaRef`, que es la ruta existente
 * donde se abre el objeto, y esa ruta revalida empresa y permiso por su cuenta.
 * Nada se resuelve «desde la bandeja» sin pasar por el camino que ya existía.
 *
 * ## `disponibilidad` (FASE 4)
 *
 * Un ítem puede aparecer y no ser resoluble. El caso que motivó la columna: un
 * asiento en BORRADOR cuyo período se cerró después — `assert_period_open`
 * impide aprobarlo, con razón, y la bandeja lo listaba mudo.
 *
 *   ACCIONABLE            hay un camino productivo hoy
 *   INFORMATIVO           nadie de adentro puede resolverlo (falta una fuente)
 *   BLOQUEADO_POR_ESTADO  hay acción, pero el estado del período la impide
 *
 * La consola la usa para no ofrecer un botón que terminaría en 422. La columna
 * se deriva en la vista (migración 0046): no hay un estado nuevo que mantener.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, type RequestTenant } from '../http/context.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

/**
 * Qué permiso hace falta para ver cada rama.
 *
 * No se inventa ninguno: son los mismos que ya exigen las rutas que muestran
 * esas entidades de a una. Si mañana aparece una entidad sin entrada acá, no se
 * lista — el mapa es la lista blanca, no un filtro sobre todo lo demás.
 */
const PERMISO_POR_ENTIDAD: Readonly<Record<string, string>> = {
  documents: 'document:read',
  document_extractions: 'document:read',
  document_duplicates: 'document:read',
  tax_transactions: 'journal_entry:read',
  tax_affectations: 'journal_entry:read',
  accounting_decisions: 'journal_entry:read',
  journal_entries: 'journal_entry:read',
  ai_predictions: 'prediction:read',
  notes: 'statement:read',
  vat_books: 'vat_book:read',
  bank_reconciliations: 'bank:read',
  accounting_closures: 'period:read',
  periods: 'period:read',
  // El balance que no cuadra se cuelga del ejercicio. Va con `report:read`
  // porque lo que hay que mirar para resolverlo es el balance de sumas y saldos.
  fiscal_years: 'report:read',
  // El ciclo comercial (0051). Quien puede leer presupuestos y pedidos ve los
  // que esperan facturación; quien no, no los ve — y su bandeja es más corta,
  // que es la respuesta correcta y no un 403.
  commercial_documents: 'commercial:read',
  // Stock (0054). Las ramas cuelgan del producto: quien no puede leer el
  // maestro no ve avisos sobre existencias que no puede consultar.
  products: 'product:read',
  // Bienes de uso (0055). La amortización pendiente cuelga del bien.
  fixed_assets: 'asset:read',
};

const CATEGORIAS = [
  'BLOQUEADO',
  'REQUIERE_REVISION',
  'REQUIERE_DECLARACION',
  'REQUIERE_EVIDENCIA',
  'REQUIERE_CORRECCION',
  'REQUIERE_FUENTE_EXTERNA',
  'REQUIERE_APROBACION',
] as const;

const ENTIDADES = Object.keys(PERMISO_POR_ENTIDAD) as [string, ...string[]];

interface FilaBandeja {
  readonly itemId: string;
  readonly creadoEn: Date;
}

/** Las entidades que este usuario puede leer, en orden estable. */
function entidadesVisibles(tenant: RequestTenant): string[] {
  return Object.entries(PERMISO_POR_ENTIDAD)
    .filter(([, permiso]) => tenant.permissions.has(permiso))
    .map(([entidad]) => entidad)
    .sort();
}

export async function workQueueRoutes(app: FastifyInstance): Promise<void> {
  app.get('/work-queue', async (request) => {
    const tenant = await requireCompany(request);
    const auth = requireAuth(request);

    const query = z
      .object({
        categoria: z.enum(CATEGORIAS).optional(),
        entidad: z.enum(ENTIDADES).optional(),
        bloquea: z.enum(['si', 'no']).optional(),
        disponibilidad: z
          .enum(['ACCIONABLE', 'INFORMATIVO', 'BLOQUEADO_POR_ESTADO'])
          .optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const permitidas = entidadesVisibles(tenant);

    // Sin una sola entidad legible no hace falta consultar. Devolver la forma
    // completa —y no un 403— mantiene el contrato: bandeja vacía es una
    // respuesta válida y la consola no necesita un camino especial.
    if (permitidas.length === 0) {
      return { items: [], cursor: null, limite: query.limite, resumen: {} };
    }

    const entidades = query.entidad === undefined ? permitidas : [query.entidad];
    // Un filtro por una entidad que el usuario no puede leer no es un error: es
    // una bandeja vacía. Distinguirlos convertiría la ruta en un oráculo de
    // permisos ajenos.
    const alcance = entidades.filter((entidad) => permitidas.includes(entidad));
    if (alcance.length === 0) {
      return { items: [], cursor: null, limite: query.limite, resumen: {} };
    }

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));
    const bloquea = query.bloquea === undefined ? null : query.bloquea === 'si';

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const filtros = `
             WHERE company_id = $1
               AND entidad = ANY ($2::text[])
               AND ($3::text IS NULL OR categoria = $3)
               AND ($4::bool IS NULL OR bloquea = $4)
               AND ($5::text IS NULL OR disponibilidad = $5)`;

        const items = await tx.query<FilaBandeja>(
          `SELECT item_id AS "itemId", rama, categoria, entidad, entity_id AS "entityId",
                  estado, motivo, bloquea, evidencia_faltante AS "evidenciaFaltante",
                  origen, disponibilidad, creado_en AS "creadoEn",
                  actualizado_en AS "actualizadoEn",
                  fecha_limite::text AS "fechaLimite", traza_ref AS "trazaRef"
             FROM work_queue
             ${filtros}
               -- Keyset descendente sobre (creado_en, item_id). item_id es el
               -- hash de la clave natural del ítem: el mismo documento puede
               -- aparecer en dos ramas y entity_id solo no daría un orden total.
               AND ($6::timestamptz IS NULL
                    OR (creado_en, item_id) < ($6::timestamptz, $7::uuid))
             ORDER BY creado_en DESC, item_id DESC
             LIMIT $8`,
          [
            tenant.companyId,
            alcance,
            query.categoria ?? null,
            bloquea,
            query.disponibilidad ?? null,
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        // El resumen cuenta sobre el mismo alcance y los mismos filtros, sin
        // cursor: es «cuánto hay», no «cuánto queda en esta página».
        const resumen = await tx.query<{ categoria: string; n: string }>(
          `SELECT categoria, count(*)::text AS n
             FROM work_queue
             ${filtros}
             GROUP BY categoria
             ORDER BY categoria`,
          [tenant.companyId, alcance, query.categoria ?? null, bloquea, query.disponibilidad ?? null],
        );

        const pagina = armarPagina(items.rows, query.limite, (fila) => ({
          fecha: fila.creadoEn,
          id: fila.itemId,
        }));

        return {
          items: pagina.items,
          cursor: pagina.cursor,
          limite: pagina.limite,
          resumen: Object.fromEntries(resumen.rows.map((fila) => [fila.categoria, Number(fila.n)])),
        };
      },
    );
  });
}
