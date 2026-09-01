/**
 * Recepción de mercadería y conciliación de compras (§19, §20).
 *
 * Registra el hecho intermedio que faltaba entre la orden y la factura: **qué
 * llegó**. Con las tres piezas se puede hacer el control que necesita cualquier
 * empresa que compra:
 *
 * ```
 * ORDEN DE COMPRA  ¿qué pedí?
 *      ↓
 * RECEPCIÓN        ¿qué llegó?
 *      ↓
 * FACTURA          ¿qué me cobraron?
 * ```
 *
 * Cuando las tres cantidades no coinciden hay algo que resolver antes de pagar,
 * y la bandeja lo dice. La comparación no mira estados: mira hechos.
 *
 * ## Todavía no es stock
 *
 * Una recepción no mueve existencias porque no hay depósitos ni movimientos de
 * stock. Cuando ese módulo exista, esta va a ser su fuente — y por eso se
 * guarda la cantidad recibida, que es el dato que va a necesitar. Llamarle
 * stock a esto ahora sería dar por cierta una existencia que nadie contó.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflictoTipado, notFound, unprocessable } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD');

const SELECT_RECEPCION = `
  r.id, r.number AS numero, r.commercial_document_id AS "ordenId",
  o.number AS "ordenNumero", r.party_id AS "proveedorId",
  p.razon_social AS "proveedor", r.received_at::text AS "fecha",
  r.remito_numero AS "remito", r.notes AS notas, r.status,
  r.motivo_anulacion AS "motivoAnulacion", r.created_at AS "creadoEn"`;

const DESDE_RECEPCION = `
  FROM goods_receipts r
  JOIN parties p ON p.id = r.party_id AND p.company_id = r.company_id
  LEFT JOIN commercial_documents o
         ON o.id = r.commercial_document_id AND o.company_id = r.company_id`;

export async function recepcionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/goods-receipts', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        status: z.enum(['BORRADOR', 'CONFIRMADA', 'ANULADA']).optional(),
        proveedorId: z.string().uuid().optional(),
        ordenId: z.string().uuid().optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ fecha: string; id: string }>(
          `SELECT ${SELECT_RECEPCION} ${DESDE_RECEPCION}
            WHERE r.company_id = $1
              AND ($2::text IS NULL OR r.status = $2)
              AND ($3::uuid IS NULL OR r.party_id = $3::uuid)
              AND ($4::uuid IS NULL OR r.commercial_document_id = $4::uuid)
              AND ($5::date IS NULL OR (r.received_at, r.id) < ($5::date, $6::uuid))
            ORDER BY r.received_at DESC, r.id DESC
            LIMIT $7`,
          [
            tenant.companyId,
            query.status ?? null,
            query.proveedorId ?? null,
            query.ordenId ?? null,
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(r.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));
        return { recepciones: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });

  app.get('/goods-receipts/:receiptId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:read');
    const auth = requireAuth(request);
    const { receiptId } = z.object({ receiptId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const cabecera = await tx.query(
          `SELECT ${SELECT_RECEPCION} ${DESDE_RECEPCION}
            WHERE r.id = $1 AND r.company_id = $2`,
          [receiptId, tenant.companyId],
        );
        if (cabecera.rowCount === 0) throw notFound('Recepción no encontrada');

        const renglones = await tx.query(
          `SELECT l.id, l.line_no AS linea, l.product_id AS "productoId",
                  p.code AS "productoCodigo", l.descripcion, l.cantidad::text,
                  l.unidad, l.observaciones
             FROM goods_receipt_lines l
             LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
            WHERE l.receipt_id = $1 AND l.company_id = $2
            ORDER BY l.line_no`,
          [receiptId, tenant.companyId],
        );

        return { recepcion: cabecera.rows[0], renglones: renglones.rows };
      },
    );
  });

  app.post('/goods-receipts', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        // La orden es opcional: llega mercadería sin orden previa, y obligar a
        // inventar una para poder registrar lo que ya está en el depósito
        // invertiría la prioridad.
        ordenId: z.string().uuid().nullish(),
        proveedorId: z.string().uuid(),
        fecha,
        remito: z.string().max(60).nullish(),
        notas: z.string().max(2000).nullish(),
      })
      .parse(request.body);

    try {
      const creada = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          if (body.ordenId !== null && body.ordenId !== undefined) {
            const orden = await tx.query<{ direction: string; party_id: string }>(
              'SELECT direction, party_id FROM commercial_documents WHERE id = $1 AND company_id = $2',
              [body.ordenId, tenant.companyId],
            );
            if (orden.rowCount === 0) throw notFound('La orden de compra no existe en esta empresa');
            if (orden.rows[0]!.direction !== 'COMPRAS') {
              throw badRequest('Ese documento es de ventas: no se recibe mercadería contra él');
            }
            // El proveedor de la recepción tiene que ser el de la orden. Sin
            // esto se podría recibir de un tercero contra la orden de otro, y
            // la conciliación compararía cantidades de proveedores distintos.
            if (orden.rows[0]!.party_id !== body.proveedorId) {
              throw unprocessable(
                'PROVEEDOR_NO_COINCIDE',
                'El proveedor de la recepción no es el de la orden de compra.',
              );
            }
          }

          const numero = await tx.query<{ next_commercial_number: number }>(
            "SELECT next_commercial_number($1, 'COMPRAS', 'RECEPCION')",
            [tenant.companyId],
          );

          const r = await tx.query<{ id: string; number: number }>(
            `INSERT INTO goods_receipts
               (company_id, number, commercial_document_id, party_id, received_at,
                remito_numero, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id, number`,
            [
              tenant.companyId, numero.rows[0]!.next_commercial_number,
              body.ordenId ?? null, body.proveedorId, body.fecha,
              body.remito ?? null, body.notas ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_RECEPCION',
            objectType: 'goods_receipts',
            objectId: r.rows[0]!.id,
            newValue: {
              numero: r.rows[0]!.number,
              proveedorId: body.proveedorId,
              ordenId: body.ordenId ?? null,
              remito: body.remito ?? null,
            },
            motivo: 'Alta de recepción de mercadería',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!;
        },
      );

      reply.code(201);
      return { id: creada.id, numero: creada.number };
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw notFound('El proveedor no existe en esta empresa');
      }
      throw error;
    }
  });

  app.put('/goods-receipts/:receiptId/lines', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:write');
    const auth = requireAuth(request);
    const { receiptId } = z.object({ receiptId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        renglones: z
          .array(
            z.object({
              productoId: z.string().uuid().nullish(),
              descripcion: z.string().min(1).max(500),
              cantidad,
              unidad: z.string().min(1).max(30).default('UNIDAD'),
              // Texto libre: una lista cerrada de motivos obligaría a elegir el
              // menos malo, y se pierde el detalle que sirve para el reclamo.
              observaciones: z.string().max(500).nullish(),
            }),
          )
          .max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM goods_receipts WHERE id = $1 AND company_id = $2',
            [receiptId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Recepción no encontrada');

          await tx.query(
            'DELETE FROM goods_receipt_lines WHERE receipt_id = $1 AND company_id = $2',
            [receiptId, tenant.companyId],
          );

          let linea = 0;
          for (const r of body.renglones) {
            linea += 1;
            await tx.query(
              `INSERT INTO goods_receipt_lines
                 (company_id, receipt_id, line_no, product_id, descripcion,
                  cantidad, unidad, observaciones)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                tenant.companyId, receiptId, linea, r.productoId ?? null,
                r.descripcion, r.cantidad, r.unidad, r.observaciones ?? null,
              ],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DETALLAR_RECEPCION',
            objectType: 'goods_receipts',
            objectId: receiptId,
            newValue: { renglones: body.renglones.length },
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { receiptId, renglones: body.renglones.length };
        },
      );
    } catch (error) {
      throw traducirRecepcion(error);
    }
  });

  app.post('/goods-receipts/:receiptId/confirm', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:write');
    const auth = requireAuth(request);
    const { receiptId } = z.object({ receiptId: z.string().uuid() }).parse(request.params);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ status: string }>(
            'SELECT status FROM goods_receipts WHERE id = $1 AND company_id = $2',
            [receiptId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Recepción no encontrada');

          await tx.query(
            "UPDATE goods_receipts SET status = 'CONFIRMADA' WHERE id = $1 AND company_id = $2",
            [receiptId, tenant.companyId],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CONFIRMAR_RECEPCION',
            objectType: 'goods_receipts',
            objectId: receiptId,
            oldValue: { status: antes.rows[0]!.status },
            newValue: { status: 'CONFIRMADA' },
            motivo: 'Se confirma lo que llegó al depósito',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { receiptId, status: 'CONFIRMADA' };
        },
      );
    } catch (error) {
      throw traducirRecepcion(error);
    }
  });

  app.post('/goods-receipts/:receiptId/cancel', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:write');
    const auth = requireAuth(request);
    const { receiptId } = z.object({ receiptId: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(3).max(500) }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ status: string }>(
            'SELECT status FROM goods_receipts WHERE id = $1 AND company_id = $2',
            [receiptId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Recepción no encontrada');

          await tx.query(
            `UPDATE goods_receipts SET status = 'ANULADA', motivo_anulacion = $3
              WHERE id = $1 AND company_id = $2`,
            [receiptId, tenant.companyId, body.motivo],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ANULAR_RECEPCION',
            objectType: 'goods_receipts',
            objectId: receiptId,
            oldValue: { status: antes.rows[0]!.status },
            newValue: { status: 'ANULADA' },
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { receiptId, status: 'ANULADA' };
        },
      );
    } catch (error) {
      throw traducirRecepcion(error);
    }
  });

  /**
   * La conciliación de tres puntas de una orden de compra.
   *
   * Todo derivado: no hay ninguna columna que mantener al día, y por eso no
   * puede quedar desactualizada. Una fila con `coincide: false` es trabajo.
   */
  app.get('/commercial-documents/:documentId/match', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'receipt:read');
    requirePermission(tenant, 'commercial:read');
    const auth = requireAuth(request);
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const orden = await tx.query<{ direction: string; number: number; status: string }>(
          'SELECT direction, number, status FROM commercial_documents WHERE id = $1 AND company_id = $2',
          [documentId, tenant.companyId],
        );
        if (orden.rowCount === 0) throw notFound('Documento comercial no encontrado');
        if (orden.rows[0]!.direction !== 'COMPRAS') {
          throw badRequest(
            'La conciliación de tres puntas es del circuito de compras. Un documento de ' +
              'ventas no tiene recepción de mercadería.',
          );
        }

        const filas = await tx.query(
          `SELECT item, product_id AS "productoId", pedido::text, recibido::text,
                  facturado::text, pendiente_de_recibir::text AS "pendienteDeRecibir",
                  recibido_sin_facturar::text AS "recibidoSinFacturar", coincide
             FROM purchase_match
            WHERE order_id = $1 AND company_id = $2
            ORDER BY item`,
          [documentId, tenant.companyId],
        );

        const difieren = filas.rows.filter((f) => (f as { coincide: boolean }).coincide === false);

        return {
          orden: orden.rows[0],
          items: filas.rows,
          coinciden: difieren.length === 0,
          alcance:
            'Compara cantidades, no importes. Que las cantidades coincidan no dice que el ' +
            'precio facturado sea el pactado: eso se mira en el detalle del comprobante.',
        };
      },
    );
  });
}

/** Del error de la base al error del dominio, sin reenviar el mensaje interno. */
function traducirRecepcion(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';
  if (mensaje.includes('no se edita')) {
    return conflictoTipado(
      'RECEPCION_CONFIRMADA',
      'La recepción ya se confirmó: lo que se afirmó que llegó no se edita. ' +
        'Anulala con motivo y registrá la correcta.',
    );
  }
  if (mensaje.includes('Transición inválida')) {
    return conflictoTipado('TRANSICION_INVALIDA', mensaje.split('CONTEXT')[0]!.trim());
  }
  if (mensaje.includes('sin renglones')) {
    return unprocessable(
      'RECEPCION_SIN_RENGLONES',
      'No se confirma una recepción sin renglones: no habría llegado nada.',
    );
  }
  if (fallo.code === '23503') return notFound('Alguno de los productos no existe en esta empresa');
  return error;
}
