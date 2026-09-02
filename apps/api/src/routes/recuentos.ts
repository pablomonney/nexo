/**
 * Recuento físico de existencias.
 *
 * ## El recuento no corrige: ajusta
 *
 * La tentación es que cerrar un recuento «ponga» la existencia en lo contado.
 * Eso sería editar el libro, y el libro de movimientos es append-only por la
 * misma razón que el Diario: lo que pasó, pasó.
 *
 * Al cerrar, cada diferencia produce un **movimiento de ajuste** con su motivo
 * citando el recuento. La historia queda entera: se contó, no coincidía, se
 * ajustó, y está escrito quién y cuándo.
 *
 * ## Contar cero no es no contar
 *
 * Un renglón con cantidad `0` dice «fui, miré, no hay ninguno» y produce un
 * ajuste negativo por todo lo que el libro decía. Un producto que no aparece en
 * el recuento no se tocó: no se asume que su existencia es cero, porque nadie lo
 * miró. Los dos casos existen y significan cosas distintas.
 *
 * ## Lo que no hace
 *
 * **No valúa la diferencia.** Cuánto vale lo que falta depende de la valuación
 * de existencias —PPP, FIFO o costo de reposición—, que es una decisión contable
 * con norma detrás y sigue sin tomarse. El recuento informa cantidades.
 *
 * **No genera el asiento.** Un faltante de inventario tiene consecuencia
 * contable, y ese asiento lo firma una persona por el camino de siempre.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');

export async function recuentoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stock-counts', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT c.id, c.fecha::text, c.status, c.notas,
                  c.warehouse_id AS "depositoId", w.code AS "depositoCodigo",
                  c.closed_at AS "cerradoEn", c.closed_by AS "cerradoPor",
                  (SELECT count(*)::int FROM stock_count_lines l
                    WHERE l.count_id = c.id AND l.company_id = c.company_id) AS renglones
             FROM stock_counts c
             JOIN warehouses w ON w.id = c.warehouse_id AND w.company_id = c.company_id
            WHERE c.company_id = $1
            ORDER BY c.fecha DESC, c.created_at DESC
            LIMIT 100`,
          [tenant.companyId],
        );
        return { recuentos: r.rows };
      },
    );
  });

  /** El recuento con sus diferencias contra el libro, calculadas al mirarlas. */
  app.get('/stock-counts/:countId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);
    const { countId } = z.object({ countId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const recuento = await tx.query(
          `SELECT c.id, c.fecha::text, c.status, c.notas,
                  c.warehouse_id AS "depositoId", w.code AS "depositoCodigo",
                  c.closed_at AS "cerradoEn", c.closed_by AS "cerradoPor"
             FROM stock_counts c
             JOIN warehouses w ON w.id = c.warehouse_id AND w.company_id = c.company_id
            WHERE c.id = $1 AND c.company_id = $2`,
          [countId, tenant.companyId],
        );
        if (recuento.rowCount === 0) throw notFound('Recuento no encontrado');

        const diferencias = await tx.query(
          `SELECT product_id AS "productoId", producto_codigo AS codigo,
                  producto_nombre AS nombre, lote,
                  contado::text, segun_libro::text AS "segunLibro",
                  diferencia::text
             FROM stock_count_differences
            WHERE count_id = $1 AND company_id = $2
            ORDER BY producto_codigo, lote`,
          [countId, tenant.companyId],
        );

        return {
          recuento: recuento.rows[0],
          diferencias: diferencias.rows,
          alcance:
            'La diferencia se calcula al mirarla: ni lo contado ni lo que dice el libro se ' +
            'guardan como saldo. Son **cantidades**: cuánto vale lo que falta depende de la ' +
            'valuación de existencias, que es una decisión contable sin tomar.',
        };
      },
    );
  });

  app.post('/stock-counts', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:count');
    const auth = requireAuth(request);
    const body = z
      .object({
        depositoId: z.string().uuid(),
        fecha,
        notas: z.string().max(2000).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO stock_counts (company_id, warehouse_id, fecha, notas, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              tenant.companyId, body.depositoId, body.fecha,
              body.notas ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ABRIR_RECUENTO',
            objectType: 'stock_counts',
            objectId: r.rows[0]!.id,
            newValue: { depositoId: body.depositoId, fecha: body.fecha },
            motivo: 'Se abre un recuento físico. Todavía no ajusta nada.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw notFound('Ese depósito no existe en esta empresa');
      }
      throw error;
    }
  });

  /**
   * Carga lo contado. Reemplaza lo que hubiera.
   *
   * Entero y no de a uno porque un recuento es una foto: cargarlo en dos pasos
   * deja un estado donde media planilla ya se comparó y la otra mitad no.
   */
  app.put('/stock-counts/:countId/lines', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:count');
    const auth = requireAuth(request);
    const { countId } = z.object({ countId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        renglones: z
          .array(
            z.object({
              productoId: z.string().uuid(),
              // Nulo cuando el producto no lleva lotes. No se inventa uno.
              lote: z.string().min(1).max(80).nullish(),
              cantidad,
            }),
          )
          .max(5000),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const estado = await tx.query<{ status: string }>(
            'SELECT status FROM stock_counts WHERE id = $1 AND company_id = $2',
            [countId, tenant.companyId],
          );
          if (estado.rowCount === 0) throw notFound('Recuento no encontrado');

          await tx.query(
            'DELETE FROM stock_count_lines WHERE count_id = $1 AND company_id = $2',
            [countId, tenant.companyId],
          );

          for (const renglon of body.renglones) {
            await tx.query(
              `INSERT INTO stock_count_lines (company_id, count_id, product_id, lote, cantidad)
               VALUES ($1,$2,$3,$4,$5)`,
              [
                tenant.companyId, countId, renglon.productoId,
                renglon.lote ?? null, renglon.cantidad,
              ],
            );
          }

          return { countId, renglones: body.renglones.length };
        },
      );
    } catch (error) {
      throw traducirRecuento(error);
    }
  });

  /**
   * Cierra el recuento y aplica las diferencias como ajustes.
   *
   * Es el único momento en que este módulo escribe en el libro de stock, y
   * escribe **movimientos nuevos**: nada se edita.
   */
  app.post('/stock-counts/:countId/close', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:count');
    // Cerrar un recuento cambia la existencia sin que entre ni salga nada del
    // mundo real, que es exactamente lo que `stock:adjust` protege.
    requirePermission(tenant, 'stock:adjust');
    const auth = requireAuth(request);
    const { countId } = z.object({ countId: z.string().uuid() }).parse(request.params);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const recuento = await tx.query<{ status: string; fecha: string; warehouse_id: string }>(
            `SELECT status, fecha::text, warehouse_id
               FROM stock_counts WHERE id = $1 AND company_id = $2`,
            [countId, tenant.companyId],
          );
          if (recuento.rowCount === 0) throw notFound('Recuento no encontrado');
          if (recuento.rows[0]!.status !== 'BORRADOR') {
            throw conflict(
              `El recuento está en ${recuento.rows[0]!.status}: ya se cerró o se anuló.`,
            );
          }

          // Un solo `INSERT … SELECT` y no un bucle: la aritmética ocurre en
          // `numeric` del lado de la base. La primera versión traía la
          // diferencia como texto, la pasaba por `Number` y la devolvía con
          // `toFixed` — y `check:no-float` la rechazó, con razón: una cantidad
          // que sale de la base como decimal exacto y vuelve por IEEE 754 ya no
          // es la misma cantidad.
          //
          // El movimiento lleva siempre la **magnitud**; el signo lo pone el
          // tipo, que es como funciona el libro desde la 0054.
          const ajustes = await tx.query(
            `INSERT INTO stock_movements
               (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
                origen_tipo, motivo, lote, created_by)
             SELECT $2, d.product_id, $3,
                    CASE WHEN d.diferencia > 0 THEN 'AJUSTE_POSITIVO'
                         ELSE 'AJUSTE_NEGATIVO' END,
                    abs(d.diferencia), $4::date, 'AJUSTE', $5, d.lote, $6
               FROM stock_count_differences d
              WHERE d.count_id = $1 AND d.company_id = $2 AND d.diferencia <> 0`,
            [
              countId,
              tenant.companyId,
              recuento.rows[0]!.warehouse_id,
              recuento.rows[0]!.fecha,
              `Recuento físico del ${recuento.rows[0]!.fecha} (${countId})`,
              `user:${auth.user.userId}`,
            ],
          );

          await tx.query(
            `UPDATE stock_counts
                SET status = 'CERRADO', closed_at = now(), closed_by = $3
              WHERE id = $1 AND company_id = $2`,
            [countId, tenant.companyId, `user:${auth.user.userId}`],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CERRAR_RECUENTO',
            objectType: 'stock_counts',
            objectId: countId,
            oldValue: { status: 'BORRADOR' },
            newValue: { status: 'CERRADO', ajustes: ajustes.rowCount },
            motivo:
              'Se cierra el recuento y las diferencias se aplican como ajustes. El libro de ' +
              'movimientos no se reescribe: se le agrega la corrección con su motivo.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            countId,
            ajustes: ajustes.rowCount,
            alcance:
              'Se registraron los ajustes de cantidad. **No se generó ningún asiento**: un ' +
              'faltante de inventario tiene consecuencia contable y ese asiento lo firma una ' +
              'persona, por el camino de siempre.',
          };
        },
      );
    } catch (error) {
      throw traducirRecuento(error);
    }
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirRecuento(error: unknown): unknown {
  const mensaje = (error as { message?: string }).message ?? '';

  if (mensaje.includes('E_RECUENTO_CERRADO')) {
    return conflict(
      'El recuento ya está cerrado y sus diferencias se ajustaron: editarlo dejaría el ' +
        'ajuste sin respaldo. Abrí un recuento nuevo.',
    );
  }
  if (mensaje.includes('E_STOCK_SIN_LOTE')) {
    return unprocessable(
      'FALTA_EL_LOTE',
      'El producto lleva trazabilidad por lote: cada renglón tiene que decir cuál.',
    );
  }
  if (mensaje.includes('E_STOCK_LOTE_SIN_TRAZABILIDAD')) {
    return unprocessable(
      'LOTE_SIN_TRAZABILIDAD',
      'El producto no lleva lotes y el renglón declara uno.',
    );
  }
  if ((error as { code?: string }).code === '23505') {
    return conflict(
      'El mismo producto y lote aparecen dos veces en el recuento: la diferencia quedaría ' +
        'sin definir.',
    );
  }
  if ((error as { code?: string }).code === '23503') {
    return notFound('Alguno de los productos no existe en esta empresa');
  }
  return error;
}
