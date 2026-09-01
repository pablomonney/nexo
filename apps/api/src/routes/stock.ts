/**
 * Depósitos, movimientos y existencias (§20).
 *
 * `product_movements` (0049) decía cuánto se compró y cuánto se vendió. Esto es
 * otra cosa: **cuánto hay, y dónde**.
 *
 * ## Las existencias no se guardan
 *
 * `stock_movements` es un libro que solo crece —no se edita ni se borra, y una
 * corrección es un movimiento nuevo, igual que un contraasiento (ADR-003)—. La
 * existencia se suma de ese libro cada vez que se la mira. Un `stock_actual`
 * que la aplicación mantuviera al día sería la segunda verdad de siempre, y las
 * dos cifras conviven mucho tiempo antes de que alguien note la diferencia.
 *
 * ## La entrada por recepción no pasa por acá
 *
 * La escribe un trigger al confirmar la recepción, como el Mayor (A-7). Si la
 * escribiera una ruta, bastaría una segunda ruta que confirmara recepciones sin
 * acordarse de mover stock para que el libro quedara corto.
 *
 * ## Por qué facturar no descuenta solo
 *
 * Porque **el comprobante no sabe de qué depósito salió la mercadería**, y
 * elegir uno por defecto sería inventar el dato más importante del movimiento.
 * La salida se registra acá, diciendo el depósito. Lo que sí hace el sistema es
 * no dejar que el hueco pase inadvertido: una venta con productos de stock y
 * sin salida registrada aparece en la bandeja.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound, unprocessable } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD');

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  // ── Depósitos ────────────────────────────────────────────────────────────
  app.get('/warehouses', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT id, code AS codigo, name AS nombre, direccion, status
             FROM warehouses WHERE company_id = $1 ORDER BY code`,
          [tenant.companyId],
        );
        return { depositos: r.rows };
      },
    );
  });

  app.post('/warehouses', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        direccion: z.string().max(300).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO warehouses (company_id, code, name, direccion, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre,
              body.direccion ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_DEPOSITO',
            objectType: 'warehouses',
            objectId: r.rows[0]!.id,
            newValue: { codigo: body.codigo, nombre: body.nombre },
            motivo: 'Alta de depósito',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('Ya existe un depósito con ese código');
      }
      throw error;
    }
  });

  // ── Existencias ──────────────────────────────────────────────────────────
  app.get('/stock', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        depositoId: z.string().uuid().optional(),
        // Por defecto se ve el total por producto; con depósito, el desglose.
        soloBajoMinimo: z.enum(['si', 'no']).default('no'),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        if (query.depositoId !== undefined) {
          const r = await tx.query(
            `SELECT product_id AS "productoId", producto_codigo AS codigo,
                    producto_nombre AS nombre, unidad, existencia::text,
                    stock_minimo::text AS "stockMinimo", movimientos,
                    ultimo_movimiento::text AS "ultimoMovimiento"
               FROM stock_on_hand
              WHERE company_id = $1 AND warehouse_id = $2
              ORDER BY producto_codigo`,
            [tenant.companyId, query.depositoId],
          );
          return { existencias: r.rows, porDeposito: true, alcance: ALCANCE };
        }

        const r = await tx.query(
          `SELECT product_id AS "productoId", producto_codigo AS codigo,
                  producto_nombre AS nombre, unidad, existencia::text,
                  stock_minimo::text AS "stockMinimo", depositos,
                  bajo_minimo AS "bajoMinimo",
                  ultimo_movimiento::text AS "ultimoMovimiento"
             FROM stock_by_product
            WHERE company_id = $1
              AND ($2::bool IS NOT TRUE OR bajo_minimo)
            ORDER BY producto_codigo`,
          [tenant.companyId, query.soloBajoMinimo === 'si'],
        );
        return { existencias: r.rows, porDeposito: false, alcance: ALCANCE };
      },
    );
  });

  app.get('/products/:productId/stock', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);
    const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const producto = await tx.query<{ tracks_stock: boolean; name: string }>(
          'SELECT tracks_stock, name FROM products WHERE id = $1 AND company_id = $2',
          [productId, tenant.companyId],
        );
        if (producto.rowCount === 0) throw notFound('Producto no encontrado');
        if (!producto.rows[0]!.tracks_stock) {
          return {
            producto: producto.rows[0]!.name,
            llevaStock: false,
            existencias: [],
            movimientos: [],
            cursor: null,
            limite: query.limite,
            alcance: 'Este producto no lleva existencias: es un servicio o se declaró así.',
          };
        }

        const existencias = await tx.query(
          `SELECT warehouse_id AS "depositoId", deposito_codigo AS "depositoCodigo",
                  deposito_nombre AS "depositoNombre", existencia::text,
                  ultimo_movimiento::text AS "ultimoMovimiento"
             FROM stock_on_hand
            WHERE product_id = $1 AND company_id = $2
            ORDER BY deposito_codigo`,
          [productId, tenant.companyId],
        );

        const movimientos = await tx.query<{ fecha: string; id: string }>(
          `SELECT m.id, m.fecha::text, m.tipo, m.cantidad::text,
                  m.origen_tipo AS "origenTipo", m.origen_id AS "origenId",
                  m.motivo, m.created_by AS "creadoPor",
                  w.code AS "depositoCodigo"
             FROM stock_movements m
             JOIN warehouses w ON w.id = m.warehouse_id AND w.company_id = m.company_id
            WHERE m.product_id = $1 AND m.company_id = $2
              AND ($3::date IS NULL OR (m.fecha, m.id) < ($3::date, $4::uuid))
            ORDER BY m.fecha DESC, m.id DESC
            LIMIT $5`,
          [productId, tenant.companyId, cursorFecha, cursorId, query.limite + 1],
        );

        const pagina = armarPagina(movimientos.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));

        return {
          producto: producto.rows[0]!.name,
          llevaStock: true,
          existencias: existencias.rows,
          movimientos: pagina.items,
          cursor: pagina.cursor,
          limite: pagina.limite,
          alcance: ALCANCE,
        };
      },
    );
  });

  // ── Movimientos ──────────────────────────────────────────────────────────
  /**
   * Salida de mercadería.
   *
   * Puede citar la venta que la origina. No se genera sola al facturar porque
   * el comprobante no dice de qué depósito salió, y elegir uno por defecto
   * sería inventar el dato más importante del movimiento.
   */
  app.post('/stock-movements/salida', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        productoId: z.string().uuid(),
        depositoId: z.string().uuid(),
        cantidad,
        fecha,
        taxTransactionId: z.string().uuid(),
      })
      .parse(request.body);

    const creado = await registrar(request, tenant, auth, {
      tipo: 'SALIDA',
      origenTipo: 'VENTA',
      origenId: body.taxTransactionId,
      motivo: null,
      ...body,
    });
    reply.code(201);
    return creado;
  });

  /**
   * Ajuste por recuento, rotura o diferencia.
   *
   * Lleva permiso propio: cambia la existencia sin que entre ni salga nada del
   * mundo real, y eso impacta en la valuación. Y exige motivo — un ajuste sin
   * explicación es una existencia que cambió porque sí (§24).
   */
  app.post('/stock-movements/ajuste', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:adjust');
    const auth = requireAuth(request);
    const body = z
      .object({
        productoId: z.string().uuid(),
        depositoId: z.string().uuid(),
        cantidad,
        fecha,
        sentido: z.enum(['POSITIVO', 'NEGATIVO']),
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    const creado = await registrar(request, tenant, auth, {
      tipo: body.sentido === 'POSITIVO' ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO',
      origenTipo: 'AJUSTE',
      origenId: null,
      productoId: body.productoId,
      depositoId: body.depositoId,
      cantidad: body.cantidad,
      fecha: body.fecha,
      motivo: body.motivo,
    });
    reply.code(201);
    return creado;
  });

  /**
   * Transferencia entre depósitos.
   *
   * Son **dos** movimientos en una transacción: la salida de uno y la entrada
   * en el otro. No es un movimiento con dos depósitos porque la existencia se
   * suma por depósito, y una fila que restara de uno y sumara a otro obligaría
   * a que cada consulta supiera interpretarla.
   */
  app.post('/stock-movements/transferencia', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        productoId: z.string().uuid(),
        origenDepositoId: z.string().uuid(),
        destinoDepositoId: z.string().uuid(),
        cantidad,
        fecha,
        motivo: z.string().max(500).nullish(),
      })
      .parse(request.body);

    if (body.origenDepositoId === body.destinoDepositoId) {
      throw badRequest('El depósito de origen y el de destino son el mismo');
    }

    try {
      const ids = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const inserta = async (deposito: string, tipo: string): Promise<string> => {
            const r = await tx.query<{ id: string }>(
              `INSERT INTO stock_movements
                 (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
                  origen_tipo, motivo, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,'TRANSFERENCIA',$7,$8)
               RETURNING id`,
              [
                tenant.companyId, body.productoId, deposito, tipo, body.cantidad,
                body.fecha, body.motivo ?? null, `user:${auth.user.userId}`,
              ],
            );
            return r.rows[0]!.id;
          };

          const salida = await inserta(body.origenDepositoId, 'TRANSFERENCIA_SALIDA');
          const entrada = await inserta(body.destinoDepositoId, 'TRANSFERENCIA_ENTRADA');

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'TRANSFERIR_STOCK',
            objectType: 'stock_movements',
            objectId: salida,
            newValue: {
              productoId: body.productoId,
              desde: body.origenDepositoId,
              hacia: body.destinoDepositoId,
              cantidad: body.cantidad,
              entrada,
            },
            motivo: body.motivo ?? 'Transferencia entre depósitos',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { salida, entrada };
        },
      );
      reply.code(201);
      return ids;
    } catch (error) {
      throw traducirStock(error);
    }
  });

  /** El alta de un movimiento simple, compartida por salida y ajuste. */
  async function registrar(
    request: Parameters<typeof clientIp>[0],
    tenant: { companyId: string },
    auth: { user: { userId: string } },
    datos: {
      tipo: string;
      origenTipo: string;
      origenId: string | null;
      productoId: string;
      depositoId: string;
      cantidad: string;
      fecha: string;
      motivo: string | null;
    },
  ): Promise<{ id: string }> {
    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO stock_movements
               (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
                origen_tipo, origen_id, motivo, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id`,
            [
              tenant.companyId, datos.productoId, datos.depositoId, datos.tipo,
              datos.cantidad, datos.fecha, datos.origenTipo, datos.origenId,
              datos.motivo, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: datos.origenTipo === 'AJUSTE' ? 'AJUSTAR_STOCK' : 'REGISTRAR_SALIDA_DE_STOCK',
            objectType: 'stock_movements',
            objectId: r.rows[0]!.id,
            newValue: {
              productoId: datos.productoId,
              depositoId: datos.depositoId,
              tipo: datos.tipo,
              cantidad: datos.cantidad,
              origenId: datos.origenId,
            },
            ...(datos.motivo === null ? {} : { motivo: datos.motivo }),
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      return { id };
    } catch (error) {
      throw traducirStock(error);
    }
  }
}

const ALCANCE =
  'Existencia derivada del libro de movimientos. Un producto sin mínimo declarado nunca ' +
  'figura bajo mínimo: el sistema no inventa el umbral.';

/** Del código del candado al error del dominio. */
const POR_CODIGO: ReadonlyArray<readonly [string, string, string]> = [
  [
    'E_STOCK_PRODUCTO_SIN_STOCK',
    'PRODUCTO_SIN_STOCK',
    'El producto no lleva existencias: un servicio no ocupa lugar en un depósito.',
  ],
  [
    'E_STOCK_PRODUCTO_ARCHIVADO',
    'PRODUCTO_ARCHIVADO',
    'El producto está archivado: no se le registran movimientos nuevos.',
  ],
  [
    'E_STOCK_SIN_DEPOSITO',
    'RECEPCION_SIN_DEPOSITO',
    'La recepción tiene productos con stock y no dice en qué depósito entraron. ' +
      'Indicá el depósito antes de confirmarla.',
  ],
  [
    'E_LIBRO_INMUTABLE',
    'MOVIMIENTO_INMUTABLE',
    'Un movimiento de stock no se edita ni se borra. Corregí con un ajuste.',
  ],
];

function traducirStock(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';
  for (const [interno, publico, texto] of POR_CODIGO) {
    if (mensaje.includes(interno)) return unprocessable(publico, texto);
  }
  if (fallo.code === '23503') {
    return notFound('El producto o el depósito no existen en esta empresa');
  }
  return error;
}
