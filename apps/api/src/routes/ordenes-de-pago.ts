/**
 * Órdenes de pago.
 *
 * ## Qué es y qué no es
 *
 * Es el documento que va entre la factura del proveedor y el asiento del pago:
 * qué se paga, por cuánto, quién lo aprobó. **No mueve el Mayor.** La plata se
 * sigue moviendo con un asiento imputado, por el camino de siempre, y la orden
 * lo cita.
 *
 * ## No hay endpoint que escriba el estado
 *
 * Hay `aprobar`, `anular` y `pagar`, y cada uno registra el acto que
 * corresponde. Un `PATCH /payment-orders/:id { status }` dejaría escribir
 * «PAGADA» sin que exista el pago, y ahí la orden pasa a ser una afirmación
 * sobre algo que puede no haber ocurrido. Por eso `pagar` exige el asiento, y
 * la base verifica que ese asiento tenga imputación activa sobre cada
 * comprobante de la orden.
 *
 * ## El total no viaja en el cuerpo
 *
 * Se deriva de los renglones. Aceptar un total del cliente sería una segunda
 * verdad sobre la misma suma.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');

const renglon = z.object({
  comprobanteId: z.string().uuid(),
  importe: monto,
});

const COLUMNAS_ORDEN = `
  payment_order_id AS id, numero, fecha::text, status AS estado,
  party_id AS "proveedorId", proveedor,
  entry_id AS "asientoId",
  aprobada_at AS "aprobadaEn", aprobada_por AS "aprobadaPor",
  pagada_at AS "pagadaEn", motivo_anulacion AS "motivoAnulacion",
  observaciones, renglones, total::text,
  renglones_con_sobrecompromiso AS "renglonesConSobrecompromiso",
  imputado_por_el_asiento::text AS "imputadoPorElAsiento",
  situacion`;

export async function ordenDePagoRoutes(app: FastifyInstance): Promise<void> {
  /** Las órdenes, filtrables por estado y proveedor. */
  app.get('/payment-orders', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        estado: z.enum(['BORRADOR', 'APROBADA', 'PAGADA', 'ANULADA']).optional(),
        proveedorId: z.string().uuid().optional(),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT ${COLUMNAS_ORDEN}
             FROM payment_order_status
            WHERE company_id = $1
              AND ($2::text IS NULL OR status = $2)
              AND ($3::uuid IS NULL OR party_id = $3)
            ORDER BY numero DESC`,
          [tenant.companyId, query.estado ?? null, query.proveedorId ?? null],
        );

        return {
          ordenes: r.rows,
          alcance:
            'Una orden aprobada no es plata que salió: los comprobantes que nombra ya están ' +
            'en la proyección de fondos por su pendiente, y sumarlos otra vez sería contarlos ' +
            'dos veces. Lo que la orden agrega es la decisión de pagarlos.',
        };
      },
    );
  });

  /**
   * Qué se le puede pagar a un proveedor.
   *
   * Sale de `invoice_settlement`: el pendiente real, no el total del
   * comprobante. Informa además lo que otras órdenes vivas ya comprometieron,
   * porque cargar dos veces la misma factura en dos órdenes es el descuido más
   * fácil de cometer acá.
   */
  app.get('/payment-orders/pagables', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:read');
    const auth = requireAuth(request);
    const { proveedorId } = z
      .object({ proveedorId: z.string().uuid() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT s.tax_transaction_id AS id, s.cbte_tipo AS "cbteTipo",
                  s.punto_venta AS "puntoVenta", s.cbte_numero::text AS "cbteNumero",
                  s.cbte_fecha::text AS "cbteFecha",
                  s.total::text, s.imputado::text, s.pendiente::text,
                  s.vencimiento_declarado AS "vencimientoDeclarado",
                  s.vencimiento::text, s.dias_de_mora AS "diasDeMora",
                  s.clase,
                  coalesce(c.comprometido, 0)::text AS comprometido
             FROM invoice_settlement s
             LEFT JOIN LATERAL (
                   SELECT sum(l.importe) AS comprometido
                     FROM payment_order_lines l
                     JOIN payment_orders o
                       ON o.id = l.payment_order_id AND o.company_id = l.company_id
                    WHERE l.company_id = s.company_id
                      AND l.tax_transaction_id = s.tax_transaction_id
                      AND o.status IN ('BORRADOR', 'APROBADA')
                 ) c ON true
            WHERE s.company_id = $1 AND s.party_id = $2
              AND s.direction = 'COMPRAS' AND s.pendiente > 0
            ORDER BY coalesce(s.vencimiento, s.cbte_fecha), s.cbte_numero`,
          [tenant.companyId, proveedorId],
        );

        return {
          comprobantes: r.rows,
          alcance:
            'El pendiente descuenta lo ya imputado. «Comprometido» es lo que otras órdenes ' +
            'vivas —borradores incluidos— dicen que van a pagar de ese mismo comprobante: no ' +
            'impide nada, avisa. Un comprobante sin vencimiento declarado se ordena por su ' +
            'fecha, y eso no significa que venza ese día.',
        };
      },
    );
  });

  /** Una orden con sus renglones. */
  app.get('/payment-orders/:ordenId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:read');
    const auth = requireAuth(request);
    const { ordenId } = z.object({ ordenId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const orden = await tx.query(
          `SELECT ${COLUMNAS_ORDEN}
             FROM payment_order_status
            WHERE payment_order_id = $1 AND company_id = $2`,
          [ordenId, tenant.companyId],
        );
        if (orden.rowCount === 0) throw notFound('Orden de pago no encontrada');

        const renglones = await tx.query(
          `SELECT line_id AS id, tax_transaction_id AS "comprobanteId",
                  importe::text, cbte_tipo AS "cbteTipo", punto_venta AS "puntoVenta",
                  cbte_numero::text AS "cbteNumero", cbte_fecha::text AS "cbteFecha",
                  total_comprobante::text AS "totalComprobante",
                  pendiente::text, vencimiento::text,
                  dias_de_mora AS "diasDeMora",
                  comprometido_en_otras::text AS "comprometidoEnOtras",
                  sobrecompromiso
             FROM payment_order_lines_status
            WHERE payment_order_id = $1 AND company_id = $2
            ORDER BY cbte_fecha, cbte_numero`,
          [ordenId, tenant.companyId],
        );

        return {
          orden: orden.rows[0],
          renglones: renglones.rows,
          alcance:
            'El total sale de los renglones; no hay un total guardado que pueda diferir. Si la ' +
            'orden está pagada, «imputado por el asiento» es lo que ese asiento realmente ' +
            'imputó sobre estos comprobantes: un pago parcial se ve como parcial.',
        };
      },
    );
  });

  /** Arma una orden en borrador. Nace con sus renglones o vacía. */
  app.post('/payment-orders', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        proveedorId: z.string().uuid(),
        fecha,
        observaciones: z.string().max(2000).nullish(),
        renglones: z.array(renglon).max(500).default([]),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string; numero: string }>(
            `INSERT INTO payment_orders (company_id, party_id, fecha, observaciones, created_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, numero::text`,
            [
              tenant.companyId,
              body.proveedorId,
              body.fecha,
              body.observaciones ?? null,
              `user:${auth.user.userId}`,
            ],
          );
          const orden = r.rows[0]!;

          for (const linea of body.renglones) {
            await tx.query(
              `INSERT INTO payment_order_lines
                 (company_id, payment_order_id, tax_transaction_id, importe, created_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                tenant.companyId,
                orden.id,
                linea.comprobanteId,
                linea.importe,
                `user:${auth.user.userId}`,
              ],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ARMAR_ORDEN_DE_PAGO',
            objectType: 'payment_orders',
            objectId: orden.id,
            newValue: {
              numero: orden.numero,
              proveedorId: body.proveedorId,
              renglones: body.renglones.length,
            },
            motivo: 'Borrador. No compromete nada ni toca el Mayor hasta que se apruebe.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return orden.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirOrden(error);
    }
  });

  /**
   * Reemplaza los renglones de un borrador.
   *
   * Reemplazo y no alta incremental: la pantalla arma la lista completa y
   * mandarla entera evita que un renglón borrado en el navegador siga vivo en
   * la base. La base rechaza el reemplazo si la orden ya no es borrador.
   */
  app.put('/payment-orders/:ordenId/renglones', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:write');
    const auth = requireAuth(request);
    const { ordenId } = z.object({ ordenId: z.string().uuid() }).parse(request.params);
    const body = z.object({ renglones: z.array(renglon).max(500) }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            `SELECT status FROM payment_orders WHERE id = $1 AND company_id = $2`,
            [ordenId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Orden de pago no encontrada');

          await tx.query(
            `DELETE FROM payment_order_lines
              WHERE payment_order_id = $1 AND company_id = $2`,
            [ordenId, tenant.companyId],
          );

          for (const linea of body.renglones) {
            await tx.query(
              `INSERT INTO payment_order_lines
                 (company_id, payment_order_id, tax_transaction_id, importe, created_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                tenant.companyId,
                ordenId,
                linea.comprobanteId,
                linea.importe,
                `user:${auth.user.userId}`,
              ],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'EDITAR_ORDEN_DE_PAGO',
            objectType: 'payment_orders',
            objectId: ordenId,
            newValue: { renglones: body.renglones.length },
            motivo: 'Reemplazo completo de los renglones del borrador.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { renglones: body.renglones.length };
        },
      );
    } catch (error) {
      throw traducirOrden(error);
    }
  });

  /** Aprueba la orden. Deja constancia de quién y cuándo. */
  app.post('/payment-orders/:ordenId/aprobar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:approve');
    const auth = requireAuth(request);
    const { ordenId } = z.object({ ordenId: z.string().uuid() }).parse(request.params);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query(
            `UPDATE payment_orders
                SET status = 'APROBADA', aprobada_at = now(), aprobada_por = $3
              WHERE id = $1 AND company_id = $2
              RETURNING numero::text`,
            [ordenId, tenant.companyId, `user:${auth.user.userId}`],
          );
          if (r.rowCount === 0) throw notFound('Orden de pago no encontrada');

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'APROBAR_ORDEN_DE_PAGO',
            objectType: 'payment_orders',
            objectId: ordenId,
            newValue: { estado: 'APROBADA' },
            motivo: 'La orden queda aprobada. La plata todavía no salió: falta el asiento.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { estado: 'APROBADA' };
        },
      );
    } catch (error) {
      throw traducirOrden(error);
    }
  });

  /** Anula la orden, con motivo. No se borra: el número quedaría sin explicación. */
  app.post('/payment-orders/:ordenId/anular', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:approve');
    const auth = requireAuth(request);
    const { ordenId } = z.object({ ordenId: z.string().uuid() }).parse(request.params);
    const { motivo } = z.object({ motivo: z.string().min(5).max(2000) }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query(
            `UPDATE payment_orders
                SET status = 'ANULADA', motivo_anulacion = $3
              WHERE id = $1 AND company_id = $2
              RETURNING numero::text`,
            [ordenId, tenant.companyId, motivo],
          );
          if (r.rowCount === 0) throw notFound('Orden de pago no encontrada');

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ANULAR_ORDEN_DE_PAGO',
            objectType: 'payment_orders',
            objectId: ordenId,
            newValue: { estado: 'ANULADA' },
            motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { estado: 'ANULADA' };
        },
      );
    } catch (error) {
      throw traducirOrden(error);
    }
  });

  /**
   * Registra que la orden se pagó, citando el asiento.
   *
   * No arma el asiento: de qué cuenta sale la plata es una decisión de la
   * empresa. Y no alcanza con nombrarlo — la base exige que ese asiento tenga
   * imputación activa sobre cada comprobante de la orden. Sin eso, «pagada»
   * sería una palabra al lado de un hecho que puede no haber ocurrido.
   */
  app.post('/payment-orders/:ordenId/pagar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'payment_order:approve');
    const auth = requireAuth(request);
    const { ordenId } = z.object({ ordenId: z.string().uuid() }).parse(request.params);
    const { asientoId } = z.object({ asientoId: z.string().uuid() }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query(
            `UPDATE payment_orders
                SET status = 'PAGADA', entry_id = $3, pagada_at = now()
              WHERE id = $1 AND company_id = $2
              RETURNING numero::text`,
            [ordenId, tenant.companyId, asientoId],
          );
          if (r.rowCount === 0) throw notFound('Orden de pago no encontrada');

          const estado = await tx.query<{ situacion: string; imputado: string | null }>(
            `SELECT situacion, imputado_por_el_asiento::text AS imputado
               FROM payment_order_status
              WHERE payment_order_id = $1 AND company_id = $2`,
            [ordenId, tenant.companyId],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'PAGAR_ORDEN_DE_PAGO',
            objectType: 'payment_orders',
            objectId: ordenId,
            newValue: { estado: 'PAGADA', asientoId },
            motivo:
              'La orden cita el asiento del pago, y el asiento tiene imputación activa sobre ' +
              'cada uno de sus comprobantes.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            estado: 'PAGADA',
            imputadoPorElAsiento: estado.rows[0]?.imputado ?? null,
            situacion: estado.rows[0]?.situacion ?? null,
          };
        },
      );
    } catch (error) {
      throw traducirOrden(error);
    }
  });
}

/**
 * Traduce los códigos que levantan los triggers.
 *
 * Los mensajes de la base ya explican qué pasó; acá se les pone el código que
 * la pantalla puede distinguir sin leer el texto.
 */
function traducirOrden(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  const porCodigo: ReadonlyArray<readonly [string, string, string]> = [
    [
      'E_OP_NO_EDITABLE',
      'ORDEN_NO_EDITABLE',
      'La orden ya no está en borrador: aprobada, pagada o anulada no se modifican.',
    ],
    [
      'E_OP_COMPROBANTE_DE_VENTAS',
      'COMPROBANTE_DE_VENTAS',
      'Una orden de pago cancela comprobantes de compras.',
    ],
    [
      'E_OP_COMPROBANTE_AJENO',
      'COMPROBANTE_AJENO',
      'El comprobante no es del proveedor de la orden.',
    ],
    [
      'E_OP_COMPROBANTE_SIN_TERCERO',
      'COMPROBANTE_SIN_TERCERO',
      'El comprobante no tiene proveedor imputable, así que no hay cuenta corriente que cancelar.',
    ],
    [
      'E_OP_EXCEDE_PENDIENTE',
      'EXCEDE_PENDIENTE',
      'La orden ordena pagar más de lo que ese comprobante debe.',
    ],
    [
      'E_OP_SIN_RENGLONES',
      'ORDEN_SIN_RENGLONES',
      'No se aprueba una orden que no dice qué paga.',
    ],
    [
      'E_OP_SIN_ASIENTO',
      'PAGO_SIN_ASIENTO',
      'Una orden pagada nombra el asiento del pago.',
    ],
    [
      'E_OP_PAGO_NO_IMPUTADO',
      'PAGO_NO_IMPUTADO',
      'El asiento no está imputado a todos los comprobantes de la orden. Imputar el pago es ' +
        'lo que hace que la cuenta del proveedor baje: sin eso, la orden diría pagada y el ' +
        'saldo seguiría entero.',
    ],
    [
      'E_OP_TRANSICION',
      'TRANSICION_INVALIDA',
      'Ese estado no puede seguir al anterior.',
    ],
    [
      'E_OP_NO_SE_BORRA',
      'ORDEN_NO_SE_BORRA',
      'Una orden que salió del borrador se anula con motivo, no se borra.',
    ],
    ['E_OP_SIN_ORDEN', 'ORDEN_INEXISTENTE', 'El renglón no pertenece a ninguna orden.'],
  ];

  for (const [marca, code, texto] of porCodigo) {
    if (mensaje.includes(marca)) return unprocessable(code, texto, { detalle: mensaje });
  }

  if (fallo.code === '23505' && mensaje.includes('pol_comprobante_unico')) {
    return unprocessable(
      'COMPROBANTE_REPETIDO',
      'El mismo comprobante aparece dos veces en la orden.',
    );
  }
  if (fallo.code === '23503') {
    return notFound('El proveedor, el comprobante o el asiento no existen en esta empresa');
  }
  return error;
}
