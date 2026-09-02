/**
 * Valuación de existencias: el método se declara, el costo se calcula.
 *
 * ## La decisión sigue siendo de la empresa
 *
 * Qué método de valuación usa un ente es una decisión contable con norma
 * detrás, y este sistema no la toma. Lo que cambió con la 0077 es que hay dónde
 * declararla y que el método declarado se calcula de verdad.
 *
 * ## Se ofrece lo que se calcula
 *
 * El catálogo dice de cada método si está DISPONIBLE o PLANIFICADO, igual que
 * los proveedores de integración. Hoy solo el promedio ponderado móvil está
 * disponible: sale de los movimientos que ya existen. Declarar FIFO se rechaza
 * con el motivo escrito — ofrecerlo y no calcularlo dejaría a una empresa sin
 * valuación sin entender por qué.
 *
 * ## Y no escribe ningún asiento
 *
 * El costo de mercadería vendida es un asiento, y lo firma una persona. Acá se
 * calcula y se informa; llevarlo al Mayor es el paso siguiente y pasa por el
 * mismo camino que todo lo demás.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

export async function valuacionRoutes(app: FastifyInstance): Promise<void> {
  /** Qué métodos existen y cuáles se calculan. */
  app.get('/stock-valuation/methods', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT code AS codigo, name AS nombre, descripcion, estado, por_que AS "porQue"
             FROM stock_valuation_methods ORDER BY estado, code`,
        );

        return {
          metodos: r.rows,
          alcance:
            'Un método **PLANIFICADO** no se puede declarar: ofrecerlo y no calcularlo ' +
            'dejaría a la empresa sin valuación sin entender por qué. Cada uno dice qué le ' +
            'falta para estar disponible.',
        };
      },
    );
  });

  /** Qué declaró la empresa y cuánto valen sus existencias. */
  app.get('/stock-valuation', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const declarado = await tx.query(
          `SELECT v.metodo, m.name AS nombre,
                  v.vigencia_desde::text AS "vigenciaDesde",
                  v.vigencia_hasta::text AS "vigenciaHasta",
                  v.motivo, v.declarado_por AS "declaradoPor"
             FROM company_stock_valuation v
             JOIN stock_valuation_methods m ON m.code = v.metodo
            WHERE v.company_id = $1
            ORDER BY v.vigencia_desde DESC`,
          [tenant.companyId],
        );

        const productos = await tx.query(
          `SELECT producto_codigo AS codigo, producto_nombre AS nombre, metodo,
                  cantidad::text, costo_total::text AS "costoTotal",
                  costo_unitario::text AS "costoUnitario",
                  entradas_sin_costo AS "entradasSinCosto", metodologia
             FROM stock_valuation WHERE company_id = $1
            ORDER BY producto_codigo`,
          [tenant.companyId],
        );

        // El total se suma en `numeric`, del lado de la base, y **solo** sobre
        // lo que se pudo valuar. Lo que no, se cuenta aparte: sumarlo como cero
        // diría que esa mercadería no vale nada.
        const total = await tx.query<{ valuado: string; sin_valuar: number }>(
          `SELECT coalesce(sum(costo_total), 0)::text AS valuado,
                  count(*) FILTER (WHERE costo_total IS NULL AND cantidad > 0)::int
                    AS sin_valuar
             FROM stock_valuation WHERE company_id = $1`,
          [tenant.companyId],
        );

        const vigente = declarado.rows.find(
          (f) => (f as { vigenciaHasta: string | null }).vigenciaHasta === null,
        );

        return {
          metodoVigente: vigente ?? null,
          historial: declarado.rows,
          productos: productos.rows,
          totalValuado: total.rows[0]!.valuado,
          productosSinValuar: total.rows[0]!.sin_valuar,
          alcance:
            'Sin método declarado el costo es `null` y se dice por qué: es una decisión ' +
            'contable con norma detrás, no un valor por defecto. Con método declarado, un ' +
            'producto con **entradas sin costo** tampoco se valúa — un promedio que las ' +
            'ignora no es un promedio, es un número más chico. ' +
            'Las transferencias entre depósitos propios no mueven el promedio: no cambian ' +
            'ni la cantidad ni el costo de la empresa.',
        };
      },
    );
  });

  /**
   * Declarar el método, con su vigencia y su motivo.
   *
   * Cambiar de método es un cambio de política contable: la norma exige
   * exponerlo, y por eso el motivo es obligatorio y queda en la bitácora.
   */
  app.put('/stock-valuation', async (request) => {
    const tenant = await requireCompany(request);
    // Es una política contable, no una operación de depósito: va con el mismo
    // permiso que tocar el plan de cuentas.
    requirePermission(tenant, 'account:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        metodo: z.string().min(1).max(40),
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const metodo = await tx.query<{ estado: string; por_que: string; name: string }>(
            'SELECT estado, por_que, name FROM stock_valuation_methods WHERE code = $1',
            [body.metodo],
          );
          if (metodo.rowCount === 0) throw notFound(`No existe el método ${body.metodo}`);

          if (metodo.rows[0]!.estado !== 'DISPONIBLE') {
            throw unprocessable(
              'METODO_NO_DISPONIBLE',
              `${metodo.rows[0]!.name} todavía no se calcula: ${metodo.rows[0]!.por_que} ` +
                'Declararlo dejaría a la empresa sin valuación sin entender por qué.',
            );
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO company_stock_valuation
               (company_id, metodo, vigencia_desde, vigencia_hasta, motivo, declarado_por)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, body.metodo, body.vigenciaDesde,
              body.vigenciaHasta ?? null, body.motivo, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_METODO_DE_VALUACION',
            objectType: 'company_stock_valuation',
            objectId: r.rows[0]!.id,
            newValue: body,
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            id: r.rows[0]!.id,
            metodo: body.metodo,
            alcance:
              'Desde la fecha declarada las existencias se valúan así. Los movimientos ' +
              'anteriores **no se revalúan**: el histórico queda como se valuó cuando se ' +
              'registró, que es lo que la norma pide exponer al cambiar de método.',
          };
        },
      );
    } catch (error) {
      throw traducirValuacion(error);
    }
  });

  /** El costo de lo que salió por venta, mes a mes. */
  app.get('/analysis/costo-de-ventas', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);
    const query = z.object({ desde: fecha.optional(), hasta: fecha.optional() }).parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT mes::text, producto_codigo AS codigo, producto_nombre AS nombre,
                  unidades::text, costo::text, salidas_sin_costo AS "salidasSinCosto",
                  metodo
             FROM analytics_costo_de_ventas
            WHERE company_id = $1
              AND ($2::date IS NULL OR mes >= date_trunc('month', $2::date))
              AND ($3::date IS NULL OR mes <= $3::date)
            ORDER BY mes DESC, producto_codigo`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        const total = await tx.query<{ costo: string; sin_costo: number }>(
          `SELECT coalesce(sum(costo), 0)::text AS costo,
                  coalesce(sum(salidas_sin_costo), 0)::int AS sin_costo
             FROM analytics_costo_de_ventas
            WHERE company_id = $1
              AND ($2::date IS NULL OR mes >= date_trunc('month', $2::date))
              AND ($3::date IS NULL OR mes <= $3::date)`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        return {
          porMes: r.rows,
          costoTotal: total.rows[0]!.costo,
          salidasSinCosto: total.rows[0]!.sin_costo,
          alcance:
            'El costo de cada salida es el promedio vigente **en el momento de salir**, no ' +
            'el de hoy. Las salidas sin costo —porque el producto tenía entradas sin ' +
            'costear— se cuentan aparte en vez de sumar cero: cero diría que esa mercadería ' +
            'salió gratis. ' +
            'Este número **no genera ningún asiento**: el asiento de costo de mercadería ' +
            'vendida lo firma una persona, por el camino de siempre.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirValuacion(error: unknown): unknown {
  const mensaje = (error as { message?: string }).message ?? '';

  if (mensaje.includes('E_VAL_METODO_SUPERPUESTO')) {
    return conflict(
      'Ya hay un método de valuación vigente en esas fechas. Con dos, el mismo producto ' +
        'tendría dos costos y el balance dependería de cuál se leyó primero: cerrá el ' +
        'anterior y declará el nuevo desde el día siguiente.',
    );
  }
  return error;
}
