/**
 * Puestos propios de cada empresa, y agregar o quitar funciones a cada persona — sólo el dueño del estudio (migración 0145).
 *
 *   GET  /permisos                                  los permisos, por módulo, con su etiqueta y los reservados marcados
 *   GET  /puestos-propios                           los puestos propios de la empresa, con sus funciones y sus personas
 *   POST /puestos-propios                           crear un puesto propio
 *   PUT  /puestos-propios/:id                       cambiar su nombre, su explicación y sus funciones
 *   POST /puestos-propios/:id/archivar              archivarlo
 *   POST /puestos-propios/:id/personas              dárselo a una persona
 *   POST /puestos-propios/:id/personas/quitar       sacárselo
 *   GET  /personas/:userId/permisos                 lo que puede hacer una persona: base, ajustes y resultado
 *   POST /personas/:userId/ajustes                  agregarle o quitarle funciones
 *
 * ## Dónde está el control
 *
 * **No está acá.** Está en la base: cada escritura es una función `SECURITY DEFINER` que comprueba que quien llama es el dueño del estudio
 * (`exigir_dueno_del_estudio`), que lo que se da existe y no es reservado, que no se junta armar con aprobar, y deja la constancia en la
 * bitácora en la misma transacción. Esta ruta agrega lo de siempre (sesión, empresa en contexto) y traduce el rechazo: 403 si no es el dueño,
 * 400 si lo que se pidió no vale.
 *
 * Las escrituras piden además `user:manage` (la primera barrera, la de siempre); la que decide es la base. Las lecturas piden `user:read`.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, forbidden } from '../http/errors.js';
import { paraMostrar, permisoSensible } from '../puestos/catalogo-de-permisos.js';

const codigoDePermiso = z.string().regex(/^[a-z_]{2,40}:[a-z_]{2,40}$/u, 'Código de función inválido');
const listaDePermisos = z.array(codigoDePermiso).max(150);
const motivo = z.string().trim().min(10, 'Escribí el motivo (10 caracteres o más)').max(500);
const idDe = z.object({ id: z.string().uuid() });

/** Traduce lo que levanta la base: 42501 → 403, check_violation → 400, nombre repetido → 409. */
function traducir(error: unknown): never {
  const e = error as { code?: string; message?: string; constraint?: string };
  if (e.code === '42501') throw forbidden(e.message ?? 'No autorizado');
  if (e.code === '23514') throw badRequest(e.message ?? 'Dato inválido');
  if (e.code === '23505' && e.constraint === 'puestos_propios_nombre_vivo') throw conflict('Ya hay un puesto con ese nombre en esta empresa.');
  throw error;
}

export async function puestosPropiosRoutes(app: FastifyInstance): Promise<void> {
  const contexto = async (request: Parameters<typeof requireCompany>[0]) => {
    const tenant = await requireCompany(request);
    const auth = requireAuth(request);
    return { tenant, actor: auth.user.userId, ctx: { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` } };
  };

  app.get('/permisos', async (request) => {
    const { tenant, ctx } = await contexto(request);
    requirePermission(tenant, 'user:read');
    return withCompany(ctx, async (tx) => {
      const r = await tx.query<{ code: string; description: string; reservado: string | null }>(
        `SELECT p.code, p.description, rs.motivo AS reservado
           FROM permissions p LEFT JOIN permisos_reservados rs ON rs.permission_id = p.id
          ORDER BY p.code`,
      );
      const porModulo = new Map<string, Array<ReturnType<typeof paraMostrar> & { reservado: string | null; sensible: boolean }>>();
      for (const f of r.rows) {
        // `sensible`: quien lo tenga entra con segundo factor (mueve plata, aprueba o toca la contabilidad). La consola lo avisa al armar el puesto.
        const p = { ...paraMostrar(f.code, f.description), reservado: f.reservado, sensible: permisoSensible(f.code) };
        const lista = porModulo.get(p.modulo) ?? [];
        lista.push(p);
        porModulo.set(p.modulo, lista);
      }
      return {
        modulos: [...porModulo.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([modulo, permisos]) => ({ modulo, permisos })),
        alcance:
          'Las funciones marcadas como reservadas sólo las dan los roles de Contador y Administrador: ningún puesto propio ni ajuste puede darlas. ' +
          'Quien arma no aprueba: un puesto no puede juntar armar y aprobar pagos, compras ni decisiones.',
      };
    });
  });

  app.get('/puestos-propios', async (request) => {
    const { tenant, ctx } = await contexto(request);
    requirePermission(tenant, 'user:read');
    return withCompany(ctx, async (tx) => {
      const r = await tx.query(
        `SELECT pp.id, pp.nombre, pp.descripcion, pp.creado_el AS "creadoEl",
                coalesce((SELECT json_agg(p.code ORDER BY p.code)
                            FROM puesto_propio_permisos x JOIN permissions p ON p.id = x.permission_id
                           WHERE x.puesto_id = pp.id), '[]'::json) AS permisos,
                coalesce((SELECT json_agg(json_build_object('userId', u.id, 'nombre', u.full_name) ORDER BY u.full_name)
                            FROM asignaciones_de_puesto_propio a JOIN users u ON u.id = a.user_id
                           WHERE a.puesto_id = pp.id AND (a.valid_to IS NULL OR a.valid_to >= CURRENT_DATE)), '[]'::json) AS personas
           FROM puestos_propios pp
          WHERE pp.archivado_el IS NULL
          ORDER BY pp.nombre`,
      );
      return { puestos: r.rows };
    });
  });

  app.post('/puestos-propios', async (request, reply) => {
    const { tenant, actor, ctx } = await contexto(request);
    requirePermission(tenant, 'user:manage');
    const body = z
      .object({ nombre: z.string().trim().min(3).max(80), descripcion: z.string().trim().min(10).max(500), permisos: listaDePermisos })
      .parse(request.body);
    try {
      const id = await withCompany(ctx, async (tx) => {
        const r = await tx.query<{ id: string }>('SELECT crear_puesto_propio($1, $2, $3, $4, $5) AS id', [
          actor, ctx.companyId, body.nombre, body.descripcion, body.permisos,
        ]);
        return r.rows[0]!.id;
      });
      reply.code(201);
      return { id };
    } catch (error) {
      return traducir(error);
    }
  });

  app.put('/puestos-propios/:id', async (request) => {
    const { tenant, actor, ctx } = await contexto(request);
    requirePermission(tenant, 'user:manage');
    const { id } = idDe.parse(request.params);
    const body = z
      .object({ nombre: z.string().trim().min(3).max(80), descripcion: z.string().trim().min(10).max(500), permisos: listaDePermisos, motivo })
      .parse(request.body);
    try {
      await withCompany(ctx, (tx) =>
        tx.query('SELECT cambiar_puesto_propio($1, $2, $3, $4, $5, $6, $7)', [
          actor, ctx.companyId, id, body.nombre, body.descripcion, body.permisos, body.motivo,
        ]),
      );
      return { ok: true };
    } catch (error) {
      return traducir(error);
    }
  });

  app.post('/puestos-propios/:id/archivar', async (request) => {
    const { tenant, actor, ctx } = await contexto(request);
    requirePermission(tenant, 'user:manage');
    const { id } = idDe.parse(request.params);
    const body = z.object({ motivo }).parse(request.body);
    try {
      await withCompany(ctx, (tx) => tx.query('SELECT archivar_puesto_propio($1, $2, $3, $4)', [actor, ctx.companyId, id, body.motivo]));
      return { ok: true };
    } catch (error) {
      return traducir(error);
    }
  });

  app.post('/puestos-propios/:id/personas', async (request) => {
    const { tenant, actor, ctx } = await contexto(request);
    requirePermission(tenant, 'user:manage');
    const { id } = idDe.parse(request.params);
    const body = z.object({ userId: z.string().uuid(), motivo }).parse(request.body);
    try {
      await withCompany(ctx, (tx) => tx.query('SELECT dar_puesto_propio($1, $2, $3, $4, $5)', [actor, ctx.companyId, body.userId, id, body.motivo]));
      return { ok: true };
    } catch (error) {
      return traducir(error);
    }
  });

  app.post('/puestos-propios/:id/personas/quitar', async (request) => {
    const { tenant, actor, ctx } = await contexto(request);
    requirePermission(tenant, 'user:manage');
    const { id } = idDe.parse(request.params);
    const body = z.object({ userId: z.string().uuid(), motivo }).parse(request.body);
    try {
      await withCompany(ctx, (tx) => tx.query('SELECT quitar_puesto_propio($1, $2, $3, $4, $5)', [actor, ctx.companyId, body.userId, id, body.motivo]));
      return { ok: true };
    } catch (error) {
      return traducir(error);
    }
  });

  app.get('/personas/:userId/permisos', async (request) => {
    const { tenant, ctx } = await contexto(request);
    requirePermission(tenant, 'user:read');
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    return withCompany(ctx, async (tx) => {
      const col = async (sql: string): Promise<string[]> => (await tx.query<{ code: string }>(sql, [userId, ctx.companyId])).rows.map((f) => f.code);
      const base = await col('SELECT code FROM permisos_base_de_persona($1, $2) ORDER BY code');
      const efectivos = await col('SELECT code FROM user_permissions($1, $2) ORDER BY code');
      const ajustes = await tx.query<{ code: string; efecto: string; motivo: string }>(
        `SELECT p.code, a.efecto, a.motivo FROM ajustes_de_permisos a JOIN permissions p ON p.id = a.permission_id
          WHERE a.user_id = $1 AND a.company_id = $2 ORDER BY p.code`,
        [userId, ctx.companyId],
      );
      const roles = await col(
        `SELECT r.code FROM user_company_roles ucr JOIN roles r ON r.id = ucr.role_id
          WHERE ucr.user_id = $1 AND ucr.company_id = $2 AND ucr.valid_from <= CURRENT_DATE AND (ucr.valid_to IS NULL OR ucr.valid_to >= CURRENT_DATE) ORDER BY r.code`,
      );
      const propios = await tx.query<{ id: string; nombre: string }>(
        `SELECT pp.id, pp.nombre FROM asignaciones_de_puesto_propio a JOIN puestos_propios pp ON pp.id = a.puesto_id AND pp.archivado_el IS NULL
          WHERE a.user_id = $1 AND a.company_id = $2 ORDER BY pp.nombre`,
        [userId, ctx.companyId],
      );
      return {
        roles,
        puestosPropios: propios.rows,
        base,
        agrega: ajustes.rows.filter((a) => a.efecto === 'AGREGA'),
        quita: ajustes.rows.filter((a) => a.efecto === 'QUITA'),
        efectivos,
      };
    });
  });

  app.post('/personas/:userId/ajustes', async (request) => {
    const { tenant, actor, ctx } = await contexto(request);
    requirePermission(tenant, 'user:manage');
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const body = z.object({ agrega: listaDePermisos, quita: listaDePermisos, motivo }).parse(request.body);
    try {
      await withCompany(ctx, (tx) =>
        tx.query('SELECT ajustar_permisos_de_persona($1, $2, $3, $4, $5, $6)', [actor, ctx.companyId, userId, body.agrega, body.quita, body.motivo]),
      );
      return { ok: true };
    } catch (error) {
      return traducir(error);
    }
  });
}
