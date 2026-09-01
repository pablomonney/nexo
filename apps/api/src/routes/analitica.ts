/**
 * Analítica del negocio (§28, §63, §64).
 *
 * ## Cada cifra se puede abrir
 *
 * Es lo que distingue esta capa de un tablero cualquiera. Junto a cada total
 * viaja `trazaRef`: la consulta exacta que muestra los comprobantes que lo
 * formaron. Un número que no se puede abrir es un número en el que hay que
 * creer, y este sistema no pide que se le crea (§64).
 *
 * ```
 * ventas de marzo  →  /tax-transactions?direccion=VENTAS&desde=…&hasta=…
 *                  →  el comprobante  →  el documento  →  el asiento
 * ```
 *
 * ## Lo que NO mide, y va dicho en cada respuesta
 *
 * **Margen y rentabilidad.** Exigen el costo de lo vendido, y el stock de NEXO
 * lleva cantidades, no valores. Calcular un «margen» contra el precio de lista
 * sería inventar el número más importante del tablero.
 *
 * **Cobertura.** Un informe por producto solo ve los comprobantes que tienen
 * detalle cargado. `GET /analytics/cobertura` dice qué porción es, para que un
 * informe sobre el 30% de las ventas no se lea igual que uno sobre el 100%.
 *
 * ## Permisos
 *
 * `analytics:read` no alcanza por sí solo: cada consulta pide además el permiso
 * del dominio que expone. Quien no puede leer el maestro de productos tampoco
 * ve qué se vendió de cada uno por esta otra puerta.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';

const direccion = z.enum(['COMPRAS', 'VENTAS']).default('VENTAS');

const SIN_MARGEN =
  'No incluye margen ni rentabilidad: exigen el costo de lo vendido, y el stock lleva ' +
  'cantidades, no valores. Calcularlo contra el precio de lista sería inventarlo.';

export async function analiticaRoutes(app: FastifyInstance): Promise<void> {
  /** El estado de la empresa en una pantalla. */
  app.get('/analytics/resumen', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT ventas_mes::text AS "ventasMes", ventas_comprobantes AS "ventasComprobantes",
                  compras_mes::text AS "comprasMes", compras_comprobantes AS "comprasComprobantes",
                  a_cobrar::text AS "aCobrar", vencido_a_cobrar::text AS "vencidoACobrar",
                  a_pagar::text AS "aPagar",
                  productos_bajo_minimo AS "productosBajoMinimo",
                  productos_en_negativo AS "productosEnNegativo",
                  pendientes, pendientes_bloqueantes AS "pendientesBloqueantes"
             FROM analytics_resumen WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          resumen: r.rows[0] ?? null,
          alcance:
            `${SIN_MARGEN} «Vencido a cobrar» solo cuenta comprobantes de terceros con ` +
            'condición de pago declarada: sin plazo acordado el sistema no afirma mora.',
        };
      },
    );
  });

  /** La serie mensual, con el filtro que abre cada mes. */
  app.get('/analytics/operaciones', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const query = z
      .object({ direccion, meses: z.coerce.number().int().min(1).max(60).default(12) })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ desde: string; hasta: string }>(
          `SELECT mes::text AS desde,
                  (mes + interval '1 month - 1 day')::date::text AS hasta,
                  comprobantes, neto::text, iva::text, exento::text,
                  no_gravado::text AS "noGravado", percepciones::text,
                  total::text, terceros, sin_tercero AS "sinTercero"
             FROM analytics_operaciones_mensuales
            WHERE company_id = $1 AND direccion = $2
            ORDER BY mes DESC
            LIMIT $3`,
          [tenant.companyId, query.direccion, query.meses],
        );

        // §64: cada fila trae la consulta que muestra los comprobantes detrás.
        const meses = r.rows.map((fila) => ({
          ...fila,
          trazaRef:
            '/tax-transactions?direccion=' + query.direccion +
            '&desde=' + fila.desde + '&hasta=' + fila.hasta,
        }));

        return {
          direccion: query.direccion,
          meses,
          alcance:
            'El mes sale de la fecha del comprobante, no de cuándo se cargó: una factura de ' +
            'marzo asentada en abril es de marzo. `sinTercero` dice cuántos comprobantes de ' +
            'ese total no están resueltos contra el maestro.',
        };
      },
    );
  });

  app.get('/analytics/productos', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    requirePermission(tenant, 'product:read');
    const auth = requireAuth(request);
    const query = z
      .object({ direccion, limite: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ productId: string }>(
          `SELECT product_id AS "productId", producto_codigo AS codigo,
                  producto_nombre AS nombre, unidad, comprobantes,
                  cantidad::text, neto::text,
                  primera::text, ultima::text
             FROM analytics_por_producto
            WHERE company_id = $1 AND direccion = $2
            ORDER BY neto DESC
            LIMIT $3`,
          [tenant.companyId, query.direccion, query.limite],
        );

        const cobertura = await tx.query<{ neto_con_detalle: string; neto_total: string }>(
          `SELECT neto_con_detalle::text, neto_total::text
             FROM analytics_cobertura_de_detalle
            WHERE company_id = $1 AND direccion = $2`,
          [tenant.companyId, query.direccion],
        );

        const c = cobertura.rows[0];
        const productos = r.rows.map((fila) => ({
          ...fila,
          trazaRef: '/products/' + fila.productId + '/movimientos',
        }));

        return {
          direccion: query.direccion,
          productos,
          // La cobertura viaja con el informe, no en otro endpoint que nadie
          // consulta: es lo que dice si estos números son el total o una parte.
          cobertura:
            c === undefined
              ? null
              : { netoConDetalle: c.neto_con_detalle, netoTotal: c.neto_total },
          alcance:
            `${SIN_MARGEN} Solo cuenta comprobantes con detalle cargado: mirá \`cobertura\` ` +
            'para saber qué porción del total representan estos productos.',
        };
      },
    );
  });

  app.get('/analytics/terceros', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    requirePermission(tenant, 'party:read');
    const auth = requireAuth(request);
    const query = z
      .object({ direccion, limite: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ partyId: string }>(
          `SELECT party_id AS "partyId", razon_social AS "razonSocial",
                  tipo_documento AS "tipoDocumento", numero_documento AS "numeroDocumento",
                  comprobantes, neto::text, total::text,
                  primera::text, ultima::text, dias_sin_operar AS "diasSinOperar"
             FROM analytics_por_tercero
            WHERE company_id = $1 AND direccion = $2
            ORDER BY neto DESC
            LIMIT $3`,
          [tenant.companyId, query.direccion, query.limite],
        );

        const terceros = r.rows.map((fila) => ({
          ...fila,
          trazaRef: '/parties/' + fila.partyId + '/saldo',
        }));

        return {
          direccion: query.direccion,
          terceros,
          alcance:
            'Solo comprobantes resueltos contra el maestro: los que no tienen tercero no ' +
            'tienen a quién sumarse y no aparecen acá, aunque sí en el total mensual.',
        };
      },
    );
  });

  app.get('/analytics/flujo-bancario', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    requirePermission(tenant, 'bank:read');
    const auth = requireAuth(request);
    const query = z
      .object({ meses: z.coerce.number().int().min(1).max(60).default(12) })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT mes::text, bank_account_id AS "cuentaBancariaId", banco,
                  cuenta_codigo AS "cuentaCodigo", ingresos::text, egresos::text,
                  neto::text, movimientos
             FROM analytics_flujo_bancario
            WHERE company_id = $1
            ORDER BY mes DESC, banco
            LIMIT $2`,
          [tenant.companyId, query.meses * 12],
        );

        return {
          flujo: r.rows,
          alcance:
            'Mide el Mayor de las cuentas bancarias DECLARADAS y solo asientos aprobados. ' +
            'El efectivo en caja no entra: ninguna tabla dice cuál es la cuenta de caja, y ' +
            'adivinarla por el nombre sería inventar el dato.',
        };
      },
    );
  });

  /**
   * Qué tan completa está la información sobre la que se decide.
   *
   * Existe porque un informe por producto que cubre el 30% de las ventas se lee
   * igual que uno que cubre el 100% si nadie dice la diferencia.
   */
  app.get('/analytics/cobertura', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analytics:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT direccion, comprobantes, con_detalle AS "conDetalle",
                  con_tercero AS "conTercero",
                  neto_total::text AS "netoTotal",
                  neto_con_detalle::text AS "netoConDetalle"
             FROM analytics_cobertura_de_detalle
            WHERE company_id = $1
            ORDER BY direccion`,
          [tenant.companyId],
        );

        return {
          cobertura: r.rows,
          alcance:
            'Es la medida de confianza del propio tablero. Un comprobante sin detalle suma ' +
            'al total del mes y no a ningún producto; uno sin tercero resuelto no suma a ' +
            'ningún cliente. La diferencia entre informes se explica acá.',
        };
      },
    );
  });
}
