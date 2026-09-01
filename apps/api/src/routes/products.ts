/**
 * Maestro de productos y servicios (§14, §20).
 *
 * Es el segundo maestro por empresa, después de terceros. Lo necesitan ventas,
 * compras, stock, producción y los conectores de e-commerce.
 *
 * ## Qué NO decide este módulo
 *
 * **La alícuota.** El producto declara cómo está tratado frente al impuesto
 * —GRAVADO, EXENTO, NO_GRAVADO— y cuál le aplica. Cuánto es esa alícuota lo
 * resuelve el motor normativo **por fecha de la operación** (§6). Guardar un 21
 * acá sería usar la norma de hoy para una operación de ayer.
 *
 * **La imputación contable.** `sales_account_id` y `purchase_account_id` son
 * sugerencias. El asiento lo sigue firmando una persona: ADR-001 no se afloja
 * porque ahora exista un maestro que sepa a qué cuenta suele ir cada cosa.
 *
 * **El precio de una venta.** `list_price` es el precio vigente para proponer.
 * Lo que se cobró vive en el renglón del comprobante, y por eso subir la lista
 * mañana no altera nada facturado ayer.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflictoTipado, notFound, unprocessable } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const UNIDADES = [
  'UNIDAD', 'KILOGRAMO', 'GRAMO', 'TONELADA', 'LITRO', 'MILILITRO',
  'METRO', 'METRO_CUADRADO', 'METRO_CUBICO', 'HORA', 'DIA', 'MES',
  'DOCENA', 'CAJA', 'PAQUETE', 'OTRA',
] as const;

const TRATAMIENTOS = ['GRAVADO', 'EXENTO', 'NO_GRAVADO'] as const;

/** Importe decimal como texto. Nunca `number`: un float pierde centavos. */
const importe = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Importe con hasta cuatro decimales, como texto');

const SELECT_PRODUCTO = `
  p.id, p.code AS codigo, p.name AS nombre, p.description AS descripcion,
  p.kind AS tipo, p.unit AS unidad, p.tax_treatment AS "tratamientoImpositivo",
  p.tax_id AS "taxId", t.code AS "impuesto",
  p.sales_account_id AS "cuentaVentaId", av.code AS "cuentaVentaCodigo",
  p.purchase_account_id AS "cuentaCompraId", ac.code AS "cuentaCompraCodigo",
  p.tracks_stock AS "llevaStock", p.list_price::text AS "precioLista",
  p.stock_minimo::text AS "stockMinimo",
  p.currency AS moneda, p.status, p.created_at AS "creadoEn"`;

const DESDE_PRODUCTO = `
  FROM products p
  LEFT JOIN taxes t ON t.id = p.tax_id
  -- Toda unión lleva la igualdad de empresa explícita. RLS ya filtra; esto
  -- hace que una fila cruzada sea imposible aunque no filtrara.
  LEFT JOIN accounts av ON av.id = p.sales_account_id AND av.company_id = p.company_id
  LEFT JOIN accounts ac ON ac.id = p.purchase_account_id AND ac.company_id = p.company_id`;

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        q: z.string().min(1).max(120).optional(),
        tipo: z.enum(['PRODUCTO', 'SERVICIO']).optional(),
        status: z.enum(['ACTIVO', 'ARCHIVADO']).optional(),
        llevaStock: z.enum(['si', 'no']).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query<{ creadoEn: Date; id: string }>(
          `SELECT ${SELECT_PRODUCTO} ${DESDE_PRODUCTO}
            WHERE p.company_id = $1
              AND ($2::text IS NULL
                   OR lower(p.name) LIKE '%' || lower($2) || '%'
                   OR lower(p.code) LIKE lower($2) || '%')
              AND ($3::text IS NULL OR p.kind = $3)
              AND ($4::text IS NULL OR p.status = $4)
              AND ($5::bool IS NULL OR p.tracks_stock = $5)
              AND ($6::timestamptz IS NULL
                   OR (p.created_at, p.id) < ($6::timestamptz, $7::uuid))
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT $8`,
          [
            tenant.companyId,
            query.q ?? null,
            query.tipo ?? null,
            query.status ?? null,
            query.llevaStock === undefined ? null : query.llevaStock === 'si',
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(result.rows, query.limite, (fila) => ({
          fecha: fila.creadoEn,
          id: fila.id,
        }));
        return { productos: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });

  app.get('/products/:productId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:read');
    const auth = requireAuth(request);
    const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT ${SELECT_PRODUCTO} ${DESDE_PRODUCTO}
            WHERE p.id = $1 AND p.company_id = $2`,
          [productId, tenant.companyId],
        );
        if (r.rowCount === 0) throw notFound('Producto no encontrado');
        return { producto: r.rows[0] };
      },
    );
  });

  /**
   * Qué se compró y qué se vendió de este producto.
   *
   * **No es stock.** Es movimiento facturado: lo que pasó por comprobantes. El
   * stock necesita depósitos y movimientos que no son comprobantes —ajustes,
   * transferencias, consumos de producción— y esos todavía no existen. Decirle
   * stock a esto sería dar por cierta una existencia que nadie contó.
   */
  app.get('/products/:productId/movimientos', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:read');
    // El detalle de los comprobantes es la misma información que el subdiario
    // visto por producto: quien no puede leer uno no puede leer el otro.
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const existe = await tx.query(
          'SELECT name FROM products WHERE id = $1 AND company_id = $2',
          [productId, tenant.companyId],
        );
        if (existe.rowCount === 0) throw notFound('Producto no encontrado');

        const r = await tx.query(
          `SELECT direccion, comprobantes, cantidad::text, neto::text,
                  primera::text, ultima::text
             FROM product_movements
            WHERE product_id = $1 AND company_id = $2
            ORDER BY direccion`,
          [productId, tenant.companyId],
        );

        return {
          producto: existe.rows[0],
          movimientos: r.rows,
          alcance:
            'Movimiento facturado, no existencias. El stock exige depósitos y movimientos ' +
            'que no son comprobantes, y ese módulo todavía no existe.',
        };
      },
    );
  });

  app.post('/products', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        codigo: z.string().min(1).max(60),
        nombre: z.string().min(1).max(200),
        descripcion: z.string().max(2000).nullish(),
        tipo: z.enum(['PRODUCTO', 'SERVICIO']).default('PRODUCTO'),
        unidad: z.enum(UNIDADES).default('UNIDAD'),
        tratamientoImpositivo: z.enum(TRATAMIENTOS).default('GRAVADO'),
        // Se identifica por código —`IVA`— y no por uuid: quien da de alta un
        // producto sabe que lleva IVA, no el identificador de la fila.
        impuesto: z.string().min(1).max(40).optional(),
        cuentaVenta: z.string().min(1).max(40).nullish(),
        cuentaCompra: z.string().min(1).max(40).nullish(),
        llevaStock: z.boolean().default(false),
        // Mínimo declarado. Sin esto el sistema no avisa que falte stock: no
        // hay umbral que comparar y un aviso inventado es ruido (0054).
        stockMinimo: importe.nullish(),
        precioLista: importe.nullish(),
        moneda: z.string().length(3).default('ARS'),
      })
      .parse(request.body);

    if (body.tipo === 'SERVICIO' && body.llevaStock) {
      throw badRequest('Un servicio no lleva stock: no ocupa lugar en ningún depósito');
    }
    if (body.tratamientoImpositivo === 'GRAVADO' && body.impuesto === undefined) {
      throw badRequest(
        'Un producto gravado tiene que decir qué impuesto le aplica. La alícuota no: ' +
          'esa la resuelve el sistema por la fecha de cada operación.',
      );
    }

    try {
      const creado = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          let taxId: string | null = null;
          if (body.impuesto !== undefined) {
            const t = await tx.query<{ id: string }>('SELECT id FROM taxes WHERE code = $1', [
              body.impuesto,
            ]);
            if (t.rowCount === 0) throw notFound(`No existe el impuesto ${body.impuesto}`);
            taxId = t.rows[0]!.id;
          }

          // Las cuentas llegan por código y se resuelven dentro de la empresa.
          // Aceptar un uuid del cuerpo dejaría al cliente eligiendo una fila que
          // podría no ser suya; con el código, la empresa la pone el servidor.
          const cuenta = async (codigo: string | null | undefined): Promise<string | null> => {
            if (codigo === null || codigo === undefined) return null;
            const a = await tx.query<{ id: string }>(
              'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
              [tenant.companyId, codigo],
            );
            if (a.rowCount === 0) throw notFound(`No existe la cuenta ${codigo} en esta empresa`);
            return a.rows[0]!.id;
          };

          const result = await tx.query<{ id: string }>(
            `INSERT INTO products
               (company_id, code, name, description, kind, unit, tax_treatment, tax_id,
                sales_account_id, purchase_account_id, tracks_stock, list_price, currency,
                stock_minimo, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.descripcion ?? null,
              body.tipo, body.unidad, body.tratamientoImpositivo, taxId,
              await cuenta(body.cuentaVenta), await cuenta(body.cuentaCompra),
              body.llevaStock, body.precioLista ?? null, body.moneda, body.stockMinimo ?? null,
              `user:${auth.user.userId}`,
            ],
          );
          const id = result.rows[0]!.id;

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_PRODUCTO',
            objectType: 'products',
            objectId: id,
            newValue: {
              codigo: body.codigo,
              nombre: body.nombre,
              tipo: body.tipo,
              tratamientoImpositivo: body.tratamientoImpositivo,
            },
            motivo: 'Alta de producto',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return id;
        },
      );

      reply.code(201);
      return { id: creado };
    } catch (error) {
      throw traducir(error, body.codigo);
    }
  });

  app.patch('/products/:productId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:write');
    const auth = requireAuth(request);
    const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        nombre: z.string().min(1).max(200).optional(),
        descripcion: z.string().max(2000).nullish(),
        unidad: z.enum(UNIDADES).optional(),
        cuentaVenta: z.string().min(1).max(40).nullish(),
        cuentaCompra: z.string().min(1).max(40).nullish(),
        precioLista: importe.nullish(),
        stockMinimo: importe.nullish(),
        status: z.enum(['ACTIVO', 'ARCHIVADO']).optional(),
        // El código no se edita: es la referencia con la que el producto ya
        // figura en presupuestos, remitos y listas impresas. Si está mal, se
        // archiva este y se da de alta el correcto.
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query(
            `SELECT ${SELECT_PRODUCTO} ${DESDE_PRODUCTO}
              WHERE p.id = $1 AND p.company_id = $2`,
            [productId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Producto no encontrado');

          const cuenta = async (codigo: string | null | undefined): Promise<string | null> => {
            if (codigo === null || codigo === undefined) return null;
            const a = await tx.query<{ id: string }>(
              'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
              [tenant.companyId, codigo],
            );
            if (a.rowCount === 0) throw notFound(`No existe la cuenta ${codigo} en esta empresa`);
            return a.rows[0]!.id;
          };

          await tx.query(
            `UPDATE products
                SET name        = COALESCE($3, name),
                    description = CASE WHEN $4 THEN $5 ELSE description END,
                    unit        = COALESCE($6, unit),
                    sales_account_id    = CASE WHEN $7  THEN $8  ELSE sales_account_id END,
                    purchase_account_id = CASE WHEN $9  THEN $10 ELSE purchase_account_id END,
                    list_price  = CASE WHEN $11 THEN $12 ELSE list_price END,
                    stock_minimo = CASE WHEN $14 THEN $15 ELSE stock_minimo END,
                    status      = COALESCE($13, status)
              WHERE id = $1 AND company_id = $2`,
            [
              productId, tenant.companyId,
              body.nombre ?? null,
              body.descripcion !== undefined, body.descripcion ?? null,
              body.unidad ?? null,
              body.cuentaVenta !== undefined, await cuenta(body.cuentaVenta),
              body.cuentaCompra !== undefined, await cuenta(body.cuentaCompra),
              body.precioLista !== undefined, body.precioLista ?? null,
              body.status ?? null,
              body.stockMinimo !== undefined, body.stockMinimo ?? null,
            ],
          );

          const despues = await tx.query(
            `SELECT ${SELECT_PRODUCTO} ${DESDE_PRODUCTO} WHERE p.id = $1`,
            [productId],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'MODIFICAR_PRODUCTO',
            objectType: 'products',
            objectId: productId,
            oldValue: antes.rows[0],
            newValue: despues.rows[0],
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return despues.rows[0];
        },
      );
    } catch (error) {
      throw traducir(error, '');
    }
  });
}

/**
 * Del error de PostgreSQL al error del dominio.
 *
 * Los mensajes de la base no se reenvían al cliente: pueden revelar nombres de
 * tablas y constraints. Se los reconoce y se contesta con el propio.
 */
function traducir(error: unknown, codigo: string): unknown {
  const fallo = error as { code?: string; constraint?: string; message?: string };
  if (fallo.code === '23505') {
    return conflictoTipado('PRODUCTO_DUPLICADO', `Ya existe un producto con el código ${codigo}`);
  }
  const mensaje = fallo.message ?? '';
  if (fallo.code === '23514' && mensaje.includes('cuenta de venta')) {
    return unprocessable(
      'CUENTA_DE_VENTA_INVALIDA',
      'La cuenta de venta tiene que ser imputable y de tipo INGRESO.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('cuenta de compra')) {
    return unprocessable(
      'CUENTA_DE_COMPRA_INVALIDA',
      'La cuenta de compra tiene que ser imputable y de tipo COSTO, GASTO o ACTIVO.',
    );
  }
  return error;
}
