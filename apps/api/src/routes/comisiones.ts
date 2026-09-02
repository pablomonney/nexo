/**
 * Vendedores y comisiones.
 *
 * ## El porcentaje se declara, siempre
 *
 * Un porcentaje de comisión es un acuerdo entre dos personas, no un dato
 * derivable de las ventas. Sin esquema vigente para la fecha del comprobante,
 * la comisión es `null` y la bandeja dice de quién falta el acuerdo. `null` no
 * es cero: cero diría que ese vendedor no ganó nada por esa venta.
 *
 * ## La base también, porque las tres dan números distintos
 *
 * Sobre el neto, sobre el total con IVA, o sobre lo cobrado. La segunda paga
 * comisión sobre un impuesto que la empresa cobra para ARCA y no es suyo; la
 * tercera devenga a medida que entra la plata. Cuál corresponde lo dice el
 * acuerdo, y cada cifra viene con la base y el porcentaje que se usaron para
 * que la cuenta se pueda rehacer a mano.
 *
 * ## Devengar no es pagar
 *
 * Este módulo no escribe un peso en el Mayor. La comisión a pagar es un pasivo,
 * y ese asiento lo firma una persona por el camino de siempre.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

export async function comisionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/salespeople', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT salesperson_id AS id, vendedor_codigo AS codigo,
                  vendedor_nombre AS nombre, status, comprobantes,
                  facturado::text, cobrado::text,
                  pendiente_de_cobro::text AS "pendienteDeCobro",
                  comision_devengada::text AS "comisionDevengada",
                  comprobantes_sin_esquema AS "comprobantesSinEsquema",
                  metodologia
             FROM analytics_comisiones WHERE company_id = $1
            ORDER BY vendedor_codigo`,
          [tenant.companyId],
        );

        return {
          vendedores: r.rows,
          alcance:
            'La comisión es **devengada, no pagada**: pagarla es un asiento que firma una ' +
            'persona. Los comprobantes sin esquema declarado para su fecha se cuentan ' +
            'aparte en vez de sumar cero, que diría que no generaron comisión.',
        };
      },
    );
  });

  app.get('/salespeople/:salespersonId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:read');
    const auth = requireAuth(request);
    const { salespersonId } = z
      .object({ salespersonId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const v = await tx.query(
          `SELECT salesperson_id AS id, vendedor_codigo AS codigo,
                  vendedor_nombre AS nombre, status, comprobantes,
                  facturado::text, cobrado::text,
                  comision_devengada::text AS "comisionDevengada",
                  comprobantes_sin_esquema AS "comprobantesSinEsquema", metodologia
             FROM analytics_comisiones
            WHERE salesperson_id = $1 AND company_id = $2`,
          [salespersonId, tenant.companyId],
        );
        if (v.rowCount === 0) throw notFound('Vendedor no encontrado');

        const esquemas = await tx.query(
          `SELECT id, porcentaje::text, base,
                  vigencia_desde::text AS "vigenciaDesde",
                  vigencia_hasta::text AS "vigenciaHasta"
             FROM commission_schemes
            WHERE salesperson_id = $1 AND company_id = $2
            ORDER BY vigencia_desde DESC`,
          [salespersonId, tenant.companyId],
        );

        const devengado = await tx.query(
          `SELECT tax_transaction_id AS "comprobanteId", cbte_fecha::text AS fecha,
                  cbte_tipo AS tipo, punto_venta AS "puntoVenta",
                  cbte_numero AS numero, cliente,
                  neto::text, total::text, cobrado::text,
                  porcentaje::text, base, base_importe::text AS "baseImporte",
                  comision::text
             FROM commission_accruals
            WHERE salesperson_id = $1 AND company_id = $2
            ORDER BY cbte_fecha DESC
            LIMIT 200`,
          [salespersonId, tenant.companyId],
        );

        return {
          vendedor: v.rows[0],
          esquemas: esquemas.rows,
          devengado: devengado.rows,
          alcance:
            'Cada renglón lleva la base y el porcentaje **vigentes el día del ' +
            'comprobante**, no los de hoy, y el importe sobre el que se aplicó: sin eso ' +
            'la cifra no se puede rehacer a mano.',
        };
      },
    );
  });

  app.post('/salespeople', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        // Solo cuando el vendedor es externo y factura sus comisiones. Crear un
        // tercero para un empleado ensuciaría el maestro con alguien a quien no
        // se le compra ni se le vende.
        terceroId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO salespeople (company_id, code, name, party_id, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.terceroId ?? null,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_VENDEDOR',
            objectType: 'salespeople',
            objectId: r.rows[0]!.id,
            newValue: { codigo: body.codigo, nombre: body.nombre },
            motivo: 'Alta de vendedor. Desde acá las ventas se le pueden atribuir.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirComision(error);
    }
  });

  app.put('/salespeople/:salespersonId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:write');
    const auth = requireAuth(request);
    const { salespersonId } = z
      .object({ salespersonId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        nombre: z.string().min(1).max(200).optional(),
        status: z.enum(['ACTIVO', 'INACTIVO']).optional(),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query(
          'SELECT * FROM salespeople WHERE id = $1 AND company_id = $2',
          [salespersonId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Vendedor no encontrado');

        await tx.query(
          `UPDATE salespeople
              SET name = coalesce($3, name), status = coalesce($4, status)
            WHERE id = $1 AND company_id = $2`,
          [salespersonId, tenant.companyId, body.nombre ?? null, body.status ?? null],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'ACTUALIZAR_VENDEDOR',
          objectType: 'salespeople',
          objectId: salespersonId,
          oldValue: antes.rows[0],
          newValue: body,
          motivo:
            'Un vendedor se inactiva, no se borra: sus ventas quedarían sin dueño y el ' +
            'histórico dejaría de ser comparable.',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return { id: salespersonId };
      },
    );
  });

  /** Declarar el acuerdo: porcentaje, base y desde cuándo rige. */
  app.post('/salespeople/:salespersonId/schemes', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:write');
    const auth = requireAuth(request);
    const { salespersonId } = z
      .object({ salespersonId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        porcentaje: z.number().gt(0).max(100),
        base: z.enum(['NETO_FACTURADO', 'TOTAL_FACTURADO', 'TOTAL_COBRADO']),
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO commission_schemes
               (company_id, salesperson_id, porcentaje, base, vigencia_desde,
                vigencia_hasta, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, salespersonId, body.porcentaje, body.base,
              body.vigenciaDesde, body.vigenciaHasta ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_ESQUEMA_DE_COMISION',
            objectType: 'salespeople',
            objectId: salespersonId,
            newValue: body,
            motivo:
              'Se declara el acuerdo de comisión. La base importa: TOTAL_FACTURADO paga ' +
              'sobre el IVA, que la empresa cobra para ARCA y no es suyo.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirComision(error);
    }
  });

  /**
   * Atribuirle la venta a un vendedor.
   *
   * Es un atributo del comprobante y no una tabla puente: con dos vendedores
   * por comprobante —o dos con el mismo derecho— la comisión pasa a ser una
   * opinión.
   */
  app.post('/tax-transactions/:taxTransactionId/salesperson', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:write');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);
    const body = z.object({ vendedorId: z.string().uuid() }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ direction: string; salesperson_id: string | null }>(
            'SELECT direction, salesperson_id FROM tax_transactions WHERE id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Comprobante no encontrado');
          if (antes.rows[0]!.direction !== 'VENTAS') {
            throw conflict('Solo las ventas tienen vendedor: una compra no genera comisión.');
          }

          await tx.query(
            'UPDATE tax_transactions SET salesperson_id = $3 WHERE id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId, body.vendedorId],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ATRIBUIR_VENTA_A_VENDEDOR',
            objectType: 'tax_transactions',
            objectId: taxTransactionId,
            oldValue: { vendedorId: antes.rows[0]!.salesperson_id },
            newValue: { vendedorId: body.vendedorId },
            motivo: 'Se declara quién vendió: es lo que permite atribuir la comisión.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { taxTransactionId, vendedorId: body.vendedorId };
        },
      );
    } catch (error) {
      throw traducirComision(error);
    }
  });

  /** Cuánto vendió cada uno y cuánto se le devengó (ADR-018). */
  app.get('/analysis/comisiones', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commission:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT vendedor_codigo AS codigo, vendedor_nombre AS nombre, status,
                  comprobantes, facturado::text, cobrado::text,
                  comision_devengada::text AS "comisionDevengada",
                  comprobantes_sin_esquema AS "comprobantesSinEsquema", metodologia
             FROM analytics_comisiones WHERE company_id = $1
            ORDER BY comision_devengada DESC, vendedor_codigo`,
          [tenant.companyId],
        );

        // Los totales se suman en `numeric`, del lado de la base: plata que
        // sale como decimal exacto y vuelve por IEEE 754 ya no es la misma.
        const total = await tx.query<{ devengado: string; sin_esquema: number }>(
          `SELECT coalesce(sum(comision_devengada), 0)::text AS devengado,
                  coalesce(sum(comprobantes_sin_esquema), 0)::int AS sin_esquema
             FROM analytics_comisiones WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          vendedores: r.rows,
          totalDevengado: total.rows[0]!.devengado,
          comprobantesSinEsquema: total.rows[0]!.sin_esquema,
          alcance:
            '`totalDevengado` suma **solo** los comprobantes con esquema declarado para su ' +
            'fecha. Los que no lo tienen se cuentan en `comprobantesSinEsquema` y quedan ' +
            'afuera: sumarlos como cero diría que esas ventas no generaron comisión, y lo ' +
            'que pasa es que nadie declaró el acuerdo. ' +
            'Es **devengado, no pagado**: la comisión a pagar es un pasivo, y ese asiento ' +
            'lo firma una persona por el camino de siempre.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirComision(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_COM_ESQUEMA_SUPERPUESTO')) {
    return conflict(
      'Ese vendedor ya tiene un esquema vigente en esas fechas. Con dos, la comisión se ' +
        'calcularía por orden de carga, que es azar disfrazado de regla.',
    );
  }
  if (fallo.code === '23505' && mensaje.includes('sp_code_unico')) {
    return conflict('Ya existe un vendedor con ese código en esta empresa');
  }
  if (fallo.code === '23503') {
    return notFound('El vendedor, el tercero o el comprobante no existen en esta empresa');
  }
  return error;
}
