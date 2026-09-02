/**
 * Exportaciones: llevarse lo que se ve en pantalla.
 *
 * ## Por qué hacían falta
 *
 * La auditoría integral las puso como P1 de producto: hasta acá solo el Diario
 * y el Mayor se podían exportar. El balance de sumas y saldos, la antigüedad de
 * saldos y la analítica se leían en pantalla y no se podían llevar a ningún
 * lado — y son justamente las tres que alguien necesita mandar por correo,
 * pasar al asesor o revisar en una planilla.
 *
 * ## Se exporta lo que la API ya afirma
 *
 * Ninguna de estas rutas calcula nada: leen las mismas vistas que las pantallas
 * y las serializan. Un exportador que rehiciera la cuenta sería una segunda
 * aritmética capaz de contradecir a la pantalla, y el archivo que sale por
 * correo es justamente el que nadie va a poder contrastar después.
 *
 * ## Los importes salen como decimal exacto
 *
 * Tal como los devuelve `numeric`, sin pasar por punto flotante y sin separador
 * de miles. Un CSV que trae «1.234,56» se abre distinto en cada planilla del
 * mundo; uno que trae `1234.56` se abre igual en todas.
 *
 * ## Y un archivo vacío es una respuesta
 *
 * Si no hay filas, sale el encabezado solo. Devolver un error o un archivo de
 * cero bytes obligaría a adivinar si el período estaba vacío o si algo falló.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

/**
 * Una celda, escapada según RFC 4180.
 *
 * Se citan las que llevan coma, comilla o salto de línea, y la comilla interna
 * se duplica. Sin esto, una razón social con coma corre todas las columnas de
 * esa fila y el archivo se lee mal sin que nadie lo note.
 */
function celda(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor);
  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/** Filas a CSV, con el encabezado siempre presente. */
export function aCsv(
  columnas: readonly (readonly [string, string])[],
  filas: readonly Record<string, unknown>[],
): string {
  const encabezado = columnas.map(([titulo]) => celda(titulo)).join(',');
  const cuerpo = filas.map((f) => columnas.map(([, campo]) => celda(f[campo])).join(','));
  // Terminador CRLF y BOM: es lo que hace que Excel en Windows abra los
  // acentos bien sin que nadie tenga que elegir la codificación. El BOM va
  // escrito como escape y no como carácter literal — el lint lo rechaza, y con
  // razón: un carácter invisible en el fuente no se ve al leerlo.
  return `\uFEFF${[encabezado, ...cuerpo].join('\r\n')}\r\n`;
}

function responder(reply: FastifyReply, nombre: string, csv: string): string {
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${nombre}"`);
  return csv;
}

export async function exportacionRoutes(app: FastifyInstance): Promise<void> {
  /** Balance de sumas y saldos. */
  app.get('/exports/trial-balance.csv', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z.object({ desde: fecha.optional(), hasta: fecha.optional() }).parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<Record<string, unknown>>(
          `SELECT a.code AS codigo, a.name AS nombre, a.type AS tipo,
                  coalesce(sum(lm.debit), 0)::text  AS debe,
                  coalesce(sum(lm.credit), 0)::text AS haber,
                  coalesce(sum(lm.debit - lm.credit), 0)::text AS saldo
             FROM accounts a
             LEFT JOIN ledger_movements lm
                    ON lm.account_id = a.id AND lm.company_id = a.company_id
                   AND ($2::date IS NULL OR lm.movement_date >= $2)
                   AND ($3::date IS NULL OR lm.movement_date <= $3)
            WHERE a.company_id = $1 AND a.is_postable
            GROUP BY a.code, a.name, a.type
            HAVING coalesce(sum(lm.debit), 0) <> 0 OR coalesce(sum(lm.credit), 0) <> 0
            ORDER BY a.code`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        return responder(
          reply,
          `balance-de-sumas-y-saldos.csv`,
          aCsv(
            [
              ['Código', 'codigo'],
              ['Cuenta', 'nombre'],
              ['Tipo', 'tipo'],
              ['Debe', 'debe'],
              ['Haber', 'haber'],
              ['Saldo', 'saldo'],
            ],
            r.rows,
          ),
        );
      },
    );
  });

  /** Antigüedad de saldos: la lista con la que se sale a cobrar. */
  app.get('/exports/aging.csv', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:read');
    requirePermission(tenant, 'allocation:read');
    const auth = requireAuth(request);
    const query = z
      .object({ direccion: z.enum(['VENTAS', 'COMPRAS']).default('VENTAS') })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<Record<string, unknown>>(
          `SELECT razon_social AS tercero, direction AS direccion,
                  cbte_tipo AS "tipo", punto_venta AS "puntoVenta",
                  cbte_numero AS numero, cbte_fecha::text AS fecha,
                  total::text, imputado::text, pendiente::text,
                  vencimiento::text, dias_de_mora::text AS mora,
                  CASE WHEN vencimiento_declarado THEN 'declarado' ELSE 'sin declarar' END
                    AS "vencimiento_origen"
             FROM invoice_settlement
            WHERE company_id = $1 AND direction = $2 AND pendiente > 0
            ORDER BY razon_social, cbte_fecha`,
          [tenant.companyId, query.direccion],
        );

        return responder(
          reply,
          `antiguedad-de-saldos-${query.direccion.toLowerCase()}.csv`,
          aCsv(
            [
              ['Tercero', 'tercero'],
              ['Tipo', 'tipo'],
              ['Punto de venta', 'puntoVenta'],
              ['Número', 'numero'],
              ['Fecha', 'fecha'],
              ['Total', 'total'],
              ['Imputado', 'imputado'],
              ['Pendiente', 'pendiente'],
              ['Vencimiento', 'vencimiento'],
              ['Días de mora', 'mora'],
              // Sin esta columna, un vencimiento en blanco y uno declarado se
              // leerían igual, y la mora de los dos diría lo mismo.
              ['Origen del vencimiento', 'vencimiento_origen'],
            ],
            r.rows,
          ),
        );
      },
    );
  });

  /** Ventas y compras por mes: la serie que se mira para decidir. */
  app.get('/exports/analytics.csv', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<Record<string, unknown>>(
          `SELECT mes::text, direccion, comprobantes::text,
                  neto::text, iva::text, total::text
             FROM analytics_operaciones_mensuales
            WHERE company_id = $1
            ORDER BY mes DESC, direccion`,
          [tenant.companyId],
        );

        return responder(
          reply,
          'operaciones-por-mes.csv',
          aCsv(
            [
              ['Mes', 'mes'],
              ['Dirección', 'direccion'],
              ['Comprobantes', 'comprobantes'],
              ['Neto', 'neto'],
              ['IVA', 'iva'],
              ['Total', 'total'],
            ],
            r.rows,
          ),
        );
      },
    );
  });

  /** Existencias con su valuación, cuando la empresa declaró cómo valuarlas. */
  app.get('/exports/stock.csv', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<Record<string, unknown>>(
          `SELECT producto_codigo AS codigo, producto_nombre AS nombre,
                  cantidad::text,
                  -- El costo puede no estar afirmado, y el CSV lo dice con la
                  -- misma palabra que la pantalla en vez de con un cero.
                  coalesce(costo_unitario::text, 'no se afirma')  AS "costoUnitario",
                  coalesce(costo_total::text, 'no se afirma')     AS "costoTotal",
                  coalesce(metodo, 'sin declarar')                AS metodo,
                  metodologia
             FROM stock_valuation WHERE company_id = $1
            ORDER BY producto_codigo`,
          [tenant.companyId],
        );

        return responder(
          reply,
          'existencias-valuadas.csv',
          aCsv(
            [
              ['Código', 'codigo'],
              ['Producto', 'nombre'],
              ['Cantidad', 'cantidad'],
              ['Costo unitario', 'costoUnitario'],
              ['Costo total', 'costoTotal'],
              ['Método', 'metodo'],
              ['Por qué', 'metodologia'],
            ],
            r.rows,
          ),
        );
      },
    );
  });
}
