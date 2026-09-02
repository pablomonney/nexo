/**
 * Sucursales.
 *
 * ## La sucursal no se guarda en la factura
 *
 * Cada boca de facturación tiene su punto de venta habilitado ante ARCA, y ese
 * número ya viaja en cada comprobante. Se declara qué puntos de venta son de
 * cada sucursal y la atribución **se deriva** de un dato que ya estaba. Un
 * `branch_id` en el comprobante sería una segunda verdad: el punto de venta
 * diciendo una cosa y la columna otra.
 *
 * ## Con vigencia, porque las bocas se mudan
 *
 * Reasignar un punto de venta sin fecha reescribiría a qué sucursal pertenecen
 * las ventas del año pasado. Cada comprobante se atribuye por el mapa que regía
 * **el día en que se emitió**.
 *
 * ## Dos atribuciones, y se muestran las dos
 *
 * Las ventas vienen del punto de venta; los gastos, del centro de costo. Pueden
 * no coincidir, y la diferencia se informa en vez de promediarse: es justamente
 * el dato que le sirve a quien tiene que revisar.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

export async function sucursalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/branches', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'branch:read');
    const auth = requireAuth(request);
    const query = z
      .object({ status: z.enum(['ACTIVA', 'CERRADA']).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT branch_id AS id, sucursal_codigo AS codigo, sucursal_nombre AS nombre,
                  direccion, localidad, provincia, status,
                  deposito_codigo AS "depositoCodigo",
                  centro_codigo AS "centroCodigo",
                  puntos_de_venta AS "puntosDeVenta", puntos_detalle AS "puntosDetalle",
                  comprobantes, ventas_neto::text AS "ventasNeto",
                  ventas_total::text AS "ventasTotal",
                  ultima_venta::text AS "ultimaVenta",
                  ingresos_imputados::text AS "ingresosImputados",
                  costos_imputados::text AS "costosImputados",
                  productos_con_existencia AS "productosConExistencia"
             FROM branch_status
            WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)
            ORDER BY sucursal_codigo`,
          [tenant.companyId, query.status ?? null],
        );

        return {
          sucursales: r.rows,
          alcance:
            'Las ventas se atribuyen por el **punto de venta vigente el día del ' +
            'comprobante**: no hay columna de sucursal en la factura. ' +
            '`productosConExistencia` cuenta productos, no unidades: sumar kilos con cajas ' +
            'da un número que no significa nada.',
        };
      },
    );
  });

  app.get('/branches/:branchId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'branch:read');
    const auth = requireAuth(request);
    const { branchId } = z.object({ branchId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const s = await tx.query(
          `SELECT branch_id AS id, sucursal_codigo AS codigo, sucursal_nombre AS nombre,
                  direccion, localidad, provincia, status,
                  deposito_codigo AS "depositoCodigo", centro_codigo AS "centroCodigo",
                  puntos_de_venta AS "puntosDeVenta",
                  comprobantes, ventas_neto::text AS "ventasNeto",
                  ventas_total::text AS "ventasTotal",
                  ingresos_imputados::text AS "ingresosImputados",
                  costos_imputados::text AS "costosImputados",
                  productos_con_existencia AS "productosConExistencia",
                  cerrada_el::text AS "cerradaEl", motivo_cierre AS "motivoCierre"
             FROM branch_status WHERE branch_id = $1 AND company_id = $2`,
          [branchId, tenant.companyId],
        );
        if (s.rowCount === 0) throw notFound('Sucursal no encontrada');

        const puntos = await tx.query(
          `SELECT id, punto_venta AS "puntoVenta",
                  vigencia_desde::text AS "vigenciaDesde",
                  vigencia_hasta::text AS "vigenciaHasta"
             FROM branch_points_of_sale
            WHERE branch_id = $1 AND company_id = $2
            ORDER BY punto_venta, vigencia_desde DESC`,
          [branchId, tenant.companyId],
        );

        const ventas = await tx.query(
          `SELECT tax_transaction_id AS "comprobanteId", punto_venta AS "puntoVenta",
                  cbte_numero AS numero, cbte_fecha::text AS fecha, cliente,
                  neto::text, total::text
             FROM branch_sales
            WHERE branch_id = $1 AND company_id = $2
            ORDER BY cbte_fecha DESC
            LIMIT 200`,
          [branchId, tenant.companyId],
        );

        return { sucursal: s.rows[0], puntosDeVenta: puntos.rows, ventas: ventas.rows };
      },
    );
  });

  app.post('/branches', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'branch:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        direccion: z.string().max(300).nullish(),
        localidad: z.string().max(120).nullish(),
        provincia: z.string().max(120).nullish(),
        // Por código, no por uuid: el cliente no elige una fila que podría no
        // ser suya, y los dos se resuelven dentro de la empresa.
        deposito: z.string().min(1).max(40).nullish(),
        centroDeCosto: z.string().min(1).max(40).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          let warehouseId: string | null = null;
          if (body.deposito !== null && body.deposito !== undefined) {
            const w = await tx.query<{ id: string }>(
              'SELECT id FROM warehouses WHERE company_id = $1 AND code = $2',
              [tenant.companyId, body.deposito],
            );
            if (w.rowCount === 0) throw notFound(`No existe el depósito ${body.deposito}`);
            warehouseId = w.rows[0]!.id;
          }

          let centroId: string | null = null;
          if (body.centroDeCosto !== null && body.centroDeCosto !== undefined) {
            const c = await tx.query<{ id: string }>(
              'SELECT id FROM cost_centers WHERE company_id = $1 AND code = $2',
              [tenant.companyId, body.centroDeCosto],
            );
            if (c.rowCount === 0) {
              throw notFound(`No existe el centro de costo ${body.centroDeCosto}`);
            }
            centroId = c.rows[0]!.id;
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO branches
               (company_id, code, name, direccion, localidad, provincia,
                warehouse_id, cost_center_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre,
              body.direccion ?? null, body.localidad ?? null, body.provincia ?? null,
              warehouseId, centroId, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_SUCURSAL',
            objectType: 'branches',
            objectId: r.rows[0]!.id,
            newValue: { codigo: body.codigo, deposito: body.deposito ?? null },
            motivo:
              'Alta de sucursal. Todavía no se le atribuye ninguna venta: eso lo hace el ' +
              'punto de venta.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirSucursal(error);
    }
  });

  /**
   * Declarar un punto de venta con su vigencia.
   *
   * Cambia a qué sucursal se atribuyen las ventas de ese punto, así que queda
   * en la bitácora con la fecha desde la que rige.
   */
  app.post('/branches/:branchId/points-of-sale', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'branch:write');
    const auth = requireAuth(request);
    const { branchId } = z.object({ branchId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        puntoVenta: z.number().int().gt(0).max(99_999),
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO branch_points_of_sale
               (company_id, branch_id, punto_venta, vigencia_desde, vigencia_hasta, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, branchId, body.puntoVenta, body.vigenciaDesde,
              body.vigenciaHasta ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_PUNTO_DE_VENTA',
            objectType: 'branches',
            objectId: branchId,
            newValue: body,
            motivo:
              'Cambia a qué sucursal se atribuyen las ventas de ese punto, desde la fecha ' +
              'declarada y no hacia atrás.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirSucursal(error);
    }
  });

  app.post('/branches/:branchId/close', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'branch:write');
    const auth = requireAuth(request);
    const { branchId } = z.object({ branchId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ fecha, motivo: z.string().min(3).max(500) })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ status: string }>(
            'SELECT status FROM branches WHERE id = $1 AND company_id = $2',
            [branchId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Sucursal no encontrada');
          if (antes.rows[0]!.status !== 'ACTIVA') {
            throw conflict('La sucursal ya está cerrada.');
          }

          await tx.query(
            `UPDATE branches
                SET status = 'CERRADA', cerrada_el = $3, motivo_cierre = $4, updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [branchId, tenant.companyId, body.fecha, body.motivo],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CERRAR_SUCURSAL',
            objectType: 'branches',
            objectId: branchId,
            oldValue: { status: 'ACTIVA' },
            newValue: { status: 'CERRADA', fecha: body.fecha },
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            branchId,
            alcance:
              'La sucursal queda cerrada y **sus ventas siguen atribuidas**: cerrar una boca ' +
              'no cambia de dónde salieron las facturas del año pasado. Si su punto de venta ' +
              'pasa a otra sucursal, declaralo con vigencia desde la fecha del traspaso.',
          };
        },
      );
    } catch (error) {
      throw traducirSucursal(error);
    }
  });

  /** Cómo le va a cada boca (ADR-018). */
  app.get('/analysis/sucursales', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'branch:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT sucursal_codigo AS codigo, sucursal_nombre AS nombre, status,
                  comprobantes, ventas_neto::text AS "ventasNeto",
                  ventas_total::text AS "ventasTotal",
                  ingresos_imputados::text AS "ingresosImputados",
                  costos_imputados::text AS "costosImputados",
                  resultado_imputado::text AS "resultadoImputado",
                  brecha_de_atribucion::text AS "brechaDeAtribucion",
                  productos_con_existencia AS "productosConExistencia",
                  metodologia
             FROM analytics_sucursales WHERE company_id = $1
            ORDER BY ventas_neto DESC, sucursal_codigo`,
          [tenant.companyId],
        );

        // Lo que ninguna sucursal se lleva. Se calcula del lado de la base, en
        // `numeric`, y se informa: es la parte de las ventas que la suma por
        // sucursal no explica.
        const sinAtribuir = await tx.query<{ comprobantes: number; neto: string }>(
          `SELECT count(*)::int AS comprobantes, coalesce(sum(t.neto), 0)::text AS neto
             FROM tax_transactions t
            WHERE t.company_id = $1 AND t.direction = 'VENTAS'
              AND NOT EXISTS (
                    SELECT 1 FROM branch_points_of_sale p
                     WHERE p.company_id = t.company_id
                       AND p.punto_venta = t.punto_venta
                       AND p.vigencia_desde <= t.cbte_fecha
                       AND (p.vigencia_hasta IS NULL OR p.vigencia_hasta >= t.cbte_fecha))`,
          [tenant.companyId],
        );

        return {
          sucursales: r.rows,
          sinAtribuir: sinAtribuir.rows[0],
          alcance:
            'Cada sucursal informa **dos atribuciones**: las ventas por punto de venta y lo ' +
            'imputado al centro de costo en el Mayor. Su diferencia va en ' +
            '`brechaDeAtribucion` en vez de promediarse — elegir una y callar la otra daría ' +
            'un número más lindo y menos cierto. ' +
            '`sinAtribuir` es la venta cuyo punto no pertenece a ninguna boca: sin eso, la ' +
            'suma de las sucursales parecería el total de la empresa cuando no lo es.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirSucursal(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_SUC_PUNTO_SUPERPUESTO')) {
    return conflict(
      'Ese punto de venta ya pertenece a otra sucursal en esas fechas. Con dos, el mismo ' +
        'comprobante se contaría dos veces y el total de la empresa dejaría de cerrar contra ' +
        'la suma de sus bocas.',
    );
  }
  if (fallo.code === '23505' && mensaje.includes('br_un_deposito_por_sucursal')) {
    return conflict(
      'Ese depósito ya es de otra sucursal. Con dos, la existencia de una boca sería también ' +
        'la de la otra y el recuento dejaría de significar algo.',
    );
  }
  if (fallo.code === '23505' && mensaje.includes('br_code_unico')) {
    return conflict('Ya existe una sucursal con ese código en esta empresa');
  }
  if (fallo.code === '23503') {
    return notFound('La sucursal, el depósito o el centro de costo no existen en esta empresa');
  }
  return error;
}
