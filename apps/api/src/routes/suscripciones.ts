/**
 * Suscripciones del propio NEXO.
 *
 * ## Sin precios y sin datos de tarjeta
 *
 * No hay ningún importe acá: el precio de cada plan es una decisión comercial
 * que no está tomada, y devolver un número de ejemplo haría que un tablero
 * mostrara facturación inventada. Y no hay medio de pago: cobrar es tarea de un
 * proveedor externo, y lo único que este sistema podría guardar alguna vez es
 * un identificador opaco suyo.
 *
 * ## El límite avisa, no bloquea
 *
 * Exceder el plan no impide registrar una factura ni cerrar un ejercicio. Un
 * sistema contable que se niega a asentar un hecho por una cuestión comercial
 * deja los libros incompletos, y eso no se arregla pagando después: el hecho ya
 * pasó y quedó sin asentar.
 *
 * ## Lo que no se declaró no limita
 *
 * Un tope ausente es «nadie lo escribió», no «ilimitado». El uso se informa
 * igual, y no se lo llama exceso — la misma disciplina de los umbrales de
 * análisis (0058).
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

/** Un recurso medido, con su uso y su tope declarado (o la falta de él). */
interface Recurso {
  readonly recurso: string;
  readonly uso: number;
  readonly tope: number | null;
  readonly estado: 'DENTRO_DEL_TOPE' | 'EXCEDIDO' | 'SIN_TOPE_DECLARADO';
}

function medir(recurso: string, uso: number, tope: number | null): Recurso {
  // Tres estados, no dos: «sin tope declarado» no es lo mismo que «dentro del
  // tope», y confundirlos haría que un plan sin definir pareciera cumplido.
  if (tope === null) return { recurso, uso, tope: null, estado: 'SIN_TOPE_DECLARADO' };
  return { recurso, uso, tope, estado: uso > tope ? 'EXCEDIDO' : 'DENTRO_DEL_TOPE' };
}

export async function suscripcionRoutes(app: FastifyInstance): Promise<void> {
  /** El catálogo, sin precios. */
  app.get('/subscription-plans', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT p.id, p.code AS codigo, p.name AS nombre, p.descripcion, p.orden, p.status,
                  coalesce(
                    (SELECT json_agg(json_build_object('recurso', l.recurso, 'tope', l.tope)
                                     ORDER BY l.recurso)
                       FROM plan_limits l WHERE l.plan_id = p.id),
                    '[]'::json)                     AS topes
             FROM subscription_plans p
            ORDER BY p.orden`,
        );

        return {
          planes: r.rows,
          alcance:
            'Sin precios: el precio de cada plan es una decisión comercial que **no está ' +
            'tomada**, y devolver un número de ejemplo haría que un tablero mostrara ' +
            'facturación inventada. Un plan sin topes no es «ilimitado»: es un plan cuyos ' +
            'topes nadie declaró todavía.',
        };
      },
    );
  });

  /** El plan de esta empresa y su uso. */
  app.get('/subscription', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{
          subscription_id: string | null;
          plan_codigo: string | null;
          plan_nombre: string | null;
          estado: string | null;
          vigencia_desde: string | null;
          vigencia_hasta: string | null;
          motivo: string | null;
          usuarios: number;
          comprobantes_mes: number;
          documentos_mes: number;
          integraciones: number;
          tope_usuarios: number | null;
          tope_comprobantes_mes: number | null;
          tope_documentos_mes: number | null;
          tope_integraciones: number | null;
        }>(
          `SELECT subscription_id, plan_codigo, plan_nombre, estado,
                  vigencia_desde::text, vigencia_hasta::text, motivo,
                  usuarios, comprobantes_mes, documentos_mes, integraciones,
                  tope_usuarios, tope_comprobantes_mes, tope_documentos_mes,
                  tope_integraciones
             FROM subscription_status WHERE company_id = $1`,
          [tenant.companyId],
        );
        if (r.rowCount === 0) throw notFound('Empresa no encontrada');
        const f = r.rows[0]!;

        const recursos: Recurso[] = [
          medir('USUARIOS', f.usuarios, f.tope_usuarios),
          medir('COMPROBANTES_MES', f.comprobantes_mes, f.tope_comprobantes_mes),
          medir('DOCUMENTOS_MES', f.documentos_mes, f.tope_documentos_mes),
          medir('INTEGRACIONES', f.integraciones, f.tope_integraciones),
        ];

        const historial = await tx.query(
          `SELECT s.id, p.code AS "planCodigo", s.estado,
                  s.vigencia_desde::text AS "vigenciaDesde",
                  s.vigencia_hasta::text AS "vigenciaHasta",
                  s.motivo, s.created_by AS "declaradoPor"
             FROM company_subscriptions s
             JOIN subscription_plans p ON p.id = s.plan_id
            WHERE s.company_id = $1
            ORDER BY s.vigencia_desde DESC`,
          [tenant.companyId],
        );

        return {
          plan:
            f.subscription_id === null
              ? null
              : {
                  id: f.subscription_id,
                  codigo: f.plan_codigo,
                  nombre: f.plan_nombre,
                  estado: f.estado,
                  vigenciaDesde: f.vigencia_desde,
                  vigenciaHasta: f.vigencia_hasta,
                  motivo: f.motivo,
                },
          recursos,
          historial: historial.rows,
          alcance:
            'Exceder un tope **no bloquea nada**: un sistema contable que se niega a ' +
            'registrar un hecho por una cuestión comercial deja los libros incompletos, y ' +
            'eso no se arregla pagando — el hecho ya pasó y quedó sin asentar. ' +
            '`SIN_TOPE_DECLARADO` no es «ilimitado»: es que nadie escribió el tope, así ' +
            'que el uso se informa y no se lo llama exceso.',
        };
      },
    );
  });

  /**
   * Declarar el plan de la empresa, con su vigencia.
   *
   * No hay `PATCH`: cambiar de plan es un hecho con fecha, así que se registra
   * uno nuevo y el anterior se cierra. Así el histórico dice qué plan regía
   * cuando se hizo cada cosa.
   */
  app.post('/subscription', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        plan: z.string().min(1).max(40),
        estado: z.enum(['PRUEBA', 'ACTIVA']).default('ACTIVA'),
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
        // Identificador opaco del proveedor de pagos. Nunca datos de tarjeta.
        referenciaExterna: z.string().max(200).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const plan = await tx.query<{ id: string }>(
            `SELECT id FROM subscription_plans
              WHERE code = $1 AND status = 'DISPONIBLE'`,
            [body.plan],
          );
          if (plan.rowCount === 0) throw notFound(`No existe el plan ${body.plan}`);

          const r = await tx.query<{ id: string }>(
            `INSERT INTO company_subscriptions
               (company_id, plan_id, estado, vigencia_desde, vigencia_hasta,
                referencia_externa, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, plan.rows[0]!.id, body.estado, body.vigenciaDesde,
              body.vigenciaHasta ?? null, body.referenciaExterna ?? null,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_PLAN',
            objectType: 'company_subscriptions',
            objectId: r.rows[0]!.id,
            newValue: {
              plan: body.plan,
              estado: body.estado,
              vigenciaDesde: body.vigenciaDesde,
            },
            motivo: 'Se declara el plan de la empresa y desde cuándo rige',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirSuscripcion(error);
    }
  });

  /** Suspender o cancelar. Los dos con motivo, y sin tocar ningún dato del cliente. */
  app.post('/subscription/:subscriptionId/estado', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:write');
    const auth = requireAuth(request);
    const { subscriptionId } = z
      .object({ subscriptionId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        estado: z.enum(['SUSPENDIDA', 'CANCELADA', 'ACTIVA']),
        motivo: z.string().min(3).max(500),
        vigenciaHasta: fecha.nullish(),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ estado: string }>(
            'SELECT estado FROM company_subscriptions WHERE id = $1 AND company_id = $2',
            [subscriptionId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Suscripción no encontrada');
          if (antes.rows[0]!.estado === 'CANCELADA') {
            throw conflict('Una suscripción cancelada no vuelve: se declara una nueva.');
          }

          await tx.query(
            `UPDATE company_subscriptions
                SET estado = $3, motivo = $4,
                    vigencia_hasta = coalesce($5::date, vigencia_hasta)
              WHERE id = $1 AND company_id = $2`,
            [
              subscriptionId, tenant.companyId, body.estado, body.motivo,
              body.vigenciaHasta ?? null,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CAMBIAR_ESTADO_DE_PLAN',
            objectType: 'company_subscriptions',
            objectId: subscriptionId,
            oldValue: { estado: antes.rows[0]!.estado },
            newValue: { estado: body.estado },
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            subscriptionId,
            estado: body.estado,
            alcance:
              'Cambiar el estado del plan **no toca ni un dato del cliente**: sus ' +
              'comprobantes, sus asientos y sus documentos siguen donde estaban, y siguen ' +
              'pudiendo registrarse. Cortar el servicio es una decisión de producto con ' +
              'consecuencias sobre la conservación de esa documentación, y no se toma acá.',
          };
        },
      );
    } catch (error) {
      throw traducirSuscripcion(error);
    }
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirSuscripcion(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_SUB_SUPERPUESTA')) {
    return conflict(
      'Esa empresa ya tiene una suscripción vigente en esas fechas. Con dos, el tope ' +
        'aplicable saldría por orden de carga, que es azar disfrazado de regla: cerrá la ' +
        'anterior y declará la nueva desde el día siguiente.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('cs_baja_con_motivo')) {
    return conflict('Suspender o cancelar exige decir por qué');
  }
  if (fallo.code === '23503') {
    return notFound('El plan o la suscripción no existen');
  }
  return error;
}
