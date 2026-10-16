/**
 * «Mis clientes»: cuántas cuentas entran a NEXO y cuántas suscripciones pagan — sólo para la empresa PROPIETARIA.
 *
 *   GET /propietario/resumen
 *
 * ## Quién lo ve
 *
 * Una sola empresa: la designada en `platform_owner` por el operador (`scripts/designar-propietaria.mjs`). El control no está
 * acá: está en la función de base de datos `resumen_de_cuentas_del_propietario()` (migración 0140), que comprueba la empresa en
 * contexto **antes** de contar. Esta ruta agrega lo de siempre —sesión, empresa y un permiso— y traduce el rechazo de la base a
 * un **404**: a cualquier otra empresa, la ruta no existe. No se contesta 403 porque eso confirmaría que hay una propietaria
 * y que esta ruta es la de ella.
 *
 * ## Qué devuelve
 *
 * Números: usuarios, empresas por mes, suscripciones por estado, cuáles **pagan** (activa con al menos un cargo pagado) y cuáles
 * están activas sin cobro, lo cobrado por moneda, y una lista mínima para poder cobrarle a cada cliente. Nunca el contenido
 * contable de ninguna empresa.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound } from '../http/errors.js';

export async function propietarioRoutes(app: FastifyInstance): Promise<void> {
  app.get('/propietario/resumen', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:read');
    const auth = requireAuth(request);

    try {
      const resumen = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ resumen: unknown }>('SELECT resumen_de_cuentas_del_propietario() AS resumen');
          return r.rows[0]!.resumen;
        },
      );
      void reply.header('cache-control', 'no-store');
      return resumen;
    } catch (error) {
      // 42501: la empresa en contexto no es la propietaria (o no hay propietaria designada). Para ella la ruta no existe.
      if ((error as { code?: string }).code === '42501') throw notFound();
      throw error;
    }
  });
}
