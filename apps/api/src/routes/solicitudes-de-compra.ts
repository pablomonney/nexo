/**
 * Solicitudes de compra.
 *
 * ## Pedir no es comprar
 *
 * Una solicitud dice **qué** se necesita y **cuánto**, y no dice a quién
 * comprarlo ni a cuánto: eso lo dice el proveedor después. Por eso no hay
 * precios en el cuerpo de ningún endpoint de este archivo. Si el que pide
 * escribiera el precio, ese número viajaría hasta la orden de compra sin que
 * nadie lo haya cotizado.
 *
 * ## La orden de compra se cita, no se genera
 *
 * Aprobada la solicitud, alguien arma la orden por el camino de siempre —con su
 * proveedor y sus precios— y después la solicitud la cita con `convertir`. La
 * base verifica que el documento citado sea de compras y sea un pedido, así que
 * «convertida» no es una palabra suelta.
 *
 * ## No hay endpoint que escriba el estado
 *
 * `enviar`, `aprobar`, `rechazar`, `convertir` y `anular` registran cada uno su
 * acto. Un `PATCH { status }` dejaría marcar «aprobada» sin que nadie la haya
 * mirado.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');

const renglon = z.object({
  // Opcional: se puede pedir algo que todavía no está en el maestro.
  productoId: z.string().uuid().nullish(),
  descripcion: z.string().min(2).max(500),
  cantidad,
  unidad: z.string().min(1).max(20).default('UNIDAD'),
  observaciones: z.string().max(500).nullish(),
});

const COLUMNAS = `
  purchase_request_id AS id, numero, fecha::text, status AS estado,
  justificacion, necesaria_para::text AS "necesariaPara",
  cost_center_id AS "centroDeCostoId", centro_de_costo AS "centroDeCosto",
  commercial_document_id AS "ordenDeCompraId", orden_numero AS "ordenNumero",
  proveedor, enviada_at AS "enviadaEn", resuelta_at AS "resueltaEn",
  resuelta_por AS "resueltaPor", motivo_rechazo AS "motivoRechazo",
  motivo_anulacion AS "motivoAnulacion", created_by AS "solicitadaPor",
  renglones, unidades::text, dias_esperando AS "diasEsperando", situacion`;

export async function solicitudDeCompraRoutes(app: FastifyInstance): Promise<void> {
  app.get('/purchase-requests', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'purchase_request:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        estado: z
          .enum(['BORRADOR', 'ENVIADA', 'APROBADA', 'RECHAZADA', 'CONVERTIDA', 'ANULADA'])
          .optional(),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT ${COLUMNAS}
             FROM purchase_request_status
            WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)
            ORDER BY numero DESC`,
          [tenant.companyId, query.estado ?? null],
        );

        return {
          solicitudes: r.rows,
          alcance:
            'Una solicitud no tiene importes: dice qué se necesita y cuánto. Los días de ' +
            'espera se cuentan y no se llaman atraso — no hay plazo declarado para ' +
            'responder una solicitud, y ponerle uno por defecto sería inventarlo.',
        };
      },
    );
  });

  app.get('/purchase-requests/:solicitudId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'purchase_request:read');
    const auth = requireAuth(request);
    const { solicitudId } = z
      .object({ solicitudId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const solicitud = await tx.query(
          `SELECT ${COLUMNAS}
             FROM purchase_request_status
            WHERE purchase_request_id = $1 AND company_id = $2`,
          [solicitudId, tenant.companyId],
        );
        if (solicitud.rowCount === 0) throw notFound('Solicitud no encontrada');

        const renglones = await tx.query(
          `SELECT l.id, l.line_no AS "orden", l.product_id AS "productoId",
                  p.code AS "productoCodigo", l.descripcion,
                  l.cantidad::text, l.unidad, l.observaciones
             FROM purchase_request_lines l
             LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
            WHERE l.purchase_request_id = $1 AND l.company_id = $2
            ORDER BY l.line_no`,
          [solicitudId, tenant.companyId],
        );

        return {
          solicitud: solicitud.rows[0],
          renglones: renglones.rows,
          alcance:
            'El producto del maestro es opcional: se puede pedir algo que todavía no existe ' +
            'ahí. La descripción no lo es — sin ella nadie sabe qué comprar.',
        };
      },
    );
  });

  app.post('/purchase-requests', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'purchase_request:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        fecha,
        justificacion: z.string().min(5).max(2000),
        centroDeCostoId: z.string().uuid().nullish(),
        necesariaPara: fecha.nullish(),
        renglones: z.array(renglon).max(200).default([]),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string; numero: string }>(
            `INSERT INTO purchase_requests
               (company_id, fecha, justificacion, cost_center_id, necesaria_para, created_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id, numero::text`,
            [
              tenant.companyId, body.fecha, body.justificacion,
              body.centroDeCostoId ?? null, body.necesariaPara ?? null,
              `user:${auth.user.userId}`,
            ],
          );
          const solicitud = r.rows[0]!;

          await insertarRenglones(tx, tenant.companyId, solicitud.id, body.renglones,
            `user:${auth.user.userId}`);

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ARMAR_SOLICITUD_DE_COMPRA',
            objectType: 'purchase_requests',
            objectId: solicitud.id,
            newValue: { numero: solicitud.numero, renglones: body.renglones.length },
            motivo: 'Borrador. No la ve quien aprueba hasta que se envíe.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return solicitud.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirSolicitud(error);
    }
  });

  /** Reemplaza los renglones del borrador. */
  app.put('/purchase-requests/:solicitudId/renglones', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'purchase_request:write');
    const auth = requireAuth(request);
    const { solicitudId } = z
      .object({ solicitudId: z.string().uuid() })
      .parse(request.params);
    const body = z.object({ renglones: z.array(renglon).max(200) }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT status FROM purchase_requests WHERE id = $1 AND company_id = $2',
            [solicitudId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Solicitud no encontrada');

          await tx.query(
            `DELETE FROM purchase_request_lines
              WHERE purchase_request_id = $1 AND company_id = $2`,
            [solicitudId, tenant.companyId],
          );
          await insertarRenglones(tx, tenant.companyId, solicitudId, body.renglones,
            `user:${auth.user.userId}`);

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'EDITAR_SOLICITUD_DE_COMPRA',
            objectType: 'purchase_requests',
            objectId: solicitudId,
            newValue: { renglones: body.renglones.length },
            motivo: 'Reemplazo completo de los renglones del borrador.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { renglones: body.renglones.length };
        },
      );
    } catch (error) {
      throw traducirSolicitud(error);
    }
  });

  /** La manda a aprobar. Desde acá el que pide ya no la edita. */
  app.post('/purchase-requests/:solicitudId/enviar', async (request) => {
    return cambiarEstado(request, {
      permiso: 'purchase_request:write',
      sql: `UPDATE purchase_requests SET status = 'ENVIADA', enviada_at = now()
             WHERE id = $1 AND company_id = $2 RETURNING numero::text`,
      extra: [],
      accion: 'ENVIAR_SOLICITUD_DE_COMPRA',
      estado: 'ENVIADA',
      motivo: 'La solicitud queda a la espera de una respuesta.',
    });
  });

  app.post('/purchase-requests/:solicitudId/aprobar', async (request) => {
    const auth = requireAuth(request);
    return cambiarEstado(request, {
      permiso: 'purchase_request:approve',
      sql: `UPDATE purchase_requests
               SET status = 'APROBADA', resuelta_at = now(), resuelta_por = $3
             WHERE id = $1 AND company_id = $2 RETURNING numero::text`,
      extra: [`user:${auth.user.userId}`],
      accion: 'APROBAR_SOLICITUD_DE_COMPRA',
      estado: 'APROBADA',
      motivo: 'Aprobada. Falta armar la orden de compra: el proveedor y los precios no salen ' +
        'de la solicitud.',
    });
  });

  app.post('/purchase-requests/:solicitudId/rechazar', async (request) => {
    const auth = requireAuth(request);
    const { motivo } = z
      .object({ motivo: z.string().min(5).max(2000) })
      .parse(request.body);
    return cambiarEstado(request, {
      permiso: 'purchase_request:approve',
      sql: `UPDATE purchase_requests
               SET status = 'RECHAZADA', resuelta_at = now(), resuelta_por = $3,
                   motivo_rechazo = $4
             WHERE id = $1 AND company_id = $2 RETURNING numero::text`,
      extra: [`user:${auth.user.userId}`, motivo],
      accion: 'RECHAZAR_SOLICITUD_DE_COMPRA',
      estado: 'RECHAZADA',
      motivo,
    });
  });

  /**
   * Cita la orden de compra que salió de esta solicitud.
   *
   * No la genera: el proveedor y los precios no están acá, y ponerlos sería
   * inventarlos. La base verifica que el documento citado sea de compras y sea
   * un pedido.
   */
  app.post('/purchase-requests/:solicitudId/convertir', async (request) => {
    const auth = requireAuth(request);
    const { ordenDeCompraId } = z
      .object({ ordenDeCompraId: z.string().uuid() })
      .parse(request.body);
    return cambiarEstado(request, {
      permiso: 'purchase_request:approve',
      sql: `UPDATE purchase_requests
               SET status = 'CONVERTIDA', commercial_document_id = $4,
                   resuelta_at = coalesce(resuelta_at, now()),
                   resuelta_por = coalesce(resuelta_por, $3)
             WHERE id = $1 AND company_id = $2 RETURNING numero::text`,
      extra: [`user:${auth.user.userId}`, ordenDeCompraId],
      accion: 'CONVERTIR_SOLICITUD_DE_COMPRA',
      estado: 'CONVERTIDA',
      motivo: 'La solicitud cita la orden de compra que salió de ella.',
    });
  });

  app.post('/purchase-requests/:solicitudId/anular', async (request) => {
    const { motivo } = z
      .object({ motivo: z.string().min(5).max(2000) })
      .parse(request.body);
    return cambiarEstado(request, {
      permiso: 'purchase_request:write',
      sql: `UPDATE purchase_requests SET status = 'ANULADA', motivo_anulacion = $3
             WHERE id = $1 AND company_id = $2 RETURNING numero::text`,
      extra: [motivo],
      accion: 'ANULAR_SOLICITUD_DE_COMPRA',
      estado: 'ANULADA',
      motivo,
    });
  });

  /**
   * El cuerpo compartido de los cinco cambios de estado.
   *
   * Vive acá y no en cinco copias porque lo único que los distingue es el SQL y
   * lo que queda escrito en la bitácora. La regla de qué estado puede seguir a
   * cuál vive en la base, no en este archivo.
   */
  async function cambiarEstado(
    request: FastifyRequest,
    opciones: {
      permiso: string;
      sql: string;
      extra: unknown[];
      accion: string;
      estado: string;
      motivo: string;
    },
  ): Promise<{ estado: string }> {
    const tenant = await requireCompany(request);
    requirePermission(tenant, opciones.permiso);
    const auth = requireAuth(request);
    const { solicitudId } = z
      .object({ solicitudId: z.string().uuid() })
      .parse(request.params);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query(opciones.sql, [
            solicitudId, tenant.companyId, ...opciones.extra,
          ]);
          if (r.rowCount === 0) throw notFound('Solicitud no encontrada');

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: opciones.accion,
            objectType: 'purchase_requests',
            objectId: solicitudId,
            newValue: { estado: opciones.estado },
            motivo: opciones.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { estado: opciones.estado };
        },
      );
    } catch (error) {
      throw traducirSolicitud(error);
    }
  }
}

async function insertarRenglones(
  tx: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  companyId: string,
  solicitudId: string,
  renglones: z.infer<typeof renglon>[],
  actor: string,
): Promise<void> {
  let orden = 0;
  for (const linea of renglones) {
    orden += 1;
    await tx.query(
      `INSERT INTO purchase_request_lines
         (company_id, purchase_request_id, line_no, product_id, descripcion,
          cantidad, unidad, observaciones, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        companyId, solicitudId, orden, linea.productoId ?? null, linea.descripcion,
        linea.cantidad, linea.unidad, linea.observaciones ?? null, actor,
      ],
    );
  }
}

/** Del candado de la base al error del dominio. */
function traducirSolicitud(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  const porCodigo: ReadonlyArray<readonly [string, string, string]> = [
    [
      'E_SOL_NO_EDITABLE',
      'SOLICITUD_NO_EDITABLE',
      'La solicitud ya salió del borrador: desde que se envía, no se edita.',
    ],
    [
      'E_SOL_SIN_RENGLONES',
      'SOLICITUD_SIN_RENGLONES',
      'No se manda a aprobar una solicitud que no pide nada.',
    ],
    [
      'E_SOL_SIN_ORDEN',
      'SIN_ORDEN_DE_COMPRA',
      'Convertir una solicitud es citar la orden de compra que salió de ella.',
    ],
    [
      'E_SOL_ORDEN_INVALIDA',
      'ORDEN_INVALIDA',
      'El documento citado no es una orden de compra: tiene que ser un pedido de compras.',
    ],
    [
      'E_SOL_ORDEN_ANULADA',
      'ORDEN_ANULADA',
      'La orden de compra citada está anulada.',
    ],
    [
      'E_SOL_TRANSICION',
      'TRANSICION_INVALIDA',
      'Ese estado no puede seguir al anterior.',
    ],
    [
      'E_SOL_NO_SE_BORRA',
      'SOLICITUD_NO_SE_BORRA',
      'Una solicitud que salió del borrador se anula con motivo, no se borra.',
    ],
    [
      'E_SOL_SIN_SOLICITUD',
      'SOLICITUD_INEXISTENTE',
      'El renglón no pertenece a ninguna solicitud.',
    ],
  ];

  for (const [marca, code, texto] of porCodigo) {
    if (mensaje.includes(marca)) return unprocessable(code, texto, { detalle: mensaje });
  }
  if (fallo.code === '23503') {
    return notFound('El producto, el centro de costo o la orden no existen en esta empresa');
  }
  return error;
}
