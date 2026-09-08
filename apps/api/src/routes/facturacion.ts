/**
 * Lo que NEXO le cobra a esta empresa. **Solo lectura.**
 *
 * No hay POST, no hay PUT y no hay DELETE, y no es que falten: no puede
 * haberlos. El administrador de una empresa cliente no tiene por qué poder
 * emitirse un cargo, marcarlo pagado ni levantarse una suspensión.
 *
 * La regla no se sostiene en que nadie escriba la ruta. `aai_app` —el rol con
 * el que corre la aplicación— tiene **solo `SELECT`** sobre las tablas de
 * facturación (0096): aunque alguien escribiera el `INSERT`, la base lo
 * rechazaría. Y `tests/security/facturacion-sin-ruta.test.ts` comprueba que
 * ninguna ruta importe el ciclo de facturación.
 *
 * Quien emite es el ciclo, que corre como operador de la instalación desde
 * `npm run facturacion:ciclo`.
 *
 * ## Qué se devuelve y qué no
 *
 * Se devuelve lo que la empresa necesita para saber qué debe y qué pagó. **No**
 * se devuelve la referencia externa del proveedor de pagos ni el detalle del
 * medio: son datos de la integración, no de la cuenta, y no hacen falta para
 * ninguna decisión que se tome en una pantalla.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCompany } from '@aai/db';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound } from '../http/errors.js';

export async function facturacionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * El estado de cuenta.
   *
   * Trae los documentos y un resumen de lo adeudado. El resumen se calcula acá
   * y no se guarda: guardarlo sería un segundo número sobre los mismos hechos, y
   * el día que se desincronizara no habría forma de saber cuál miente (ADR-022).
   */
  app.get('/companies/current/billing', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'billing:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const documentos = await tx.query<{
          document_id: string;
          numero: string;
          tipo: string;
          estado: string;
          moneda: string;
          importe_total: string;
          impuestos: string | null;
          emitido_el: string | null;
          vence_el: string | null;
          pagado_el: string | null;
          es_comprobante_fiscal: boolean;
          periodo_desde: string | null;
          periodo_hasta: string | null;
          dias_de_atraso: number | null;
          intentos_fallidos: string;
        }>(
          `SELECT document_id, numero::text AS numero, tipo, estado, moneda,
                  importe_total::text AS importe_total, impuestos::text AS impuestos,
                  emitido_el::text AS emitido_el, vence_el::text AS vence_el,
                  pagado_el::text AS pagado_el, es_comprobante_fiscal,
                  periodo_desde::text AS periodo_desde, periodo_hasta::text AS periodo_hasta,
                  dias_de_atraso, intentos_fallidos::text AS intentos_fallidos
             FROM billing_account_status
            ORDER BY numero DESC
            LIMIT 200`,
        );

        // Lo adeudado, por moneda. Sumar monedas distintas daría un número que
        // no significa nada, y se vería igual que uno que sí.
        const adeudado = new Map<string, bigint>();
        for (const d of documentos.rows) {
          if (d.estado !== 'EMITIDO') continue;
          const centavos = BigInt(d.importe_total.replace('.', ''));
          adeudado.set(d.moneda, (adeudado.get(d.moneda) ?? 0n) + centavos);
        }

        return {
          documentos: documentos.rows.map((d) => ({
            id: d.document_id,
            numero: d.numero,
            tipo: d.tipo,
            estado: d.estado,
            moneda: d.moneda,
            importe: d.importe_total,
            // NULL, no cero: los impuestos no se discriminaron. Discriminarlos
            // exige decidir la condición de IVA de NEXO.
            impuestos: d.impuestos,
            emitidoEl: d.emitido_el,
            venceEl: d.vence_el,
            pagadoEl: d.pagado_el,
            esComprobanteFiscal: d.es_comprobante_fiscal,
            periodo:
              d.periodo_desde === null
                ? null
                : { desde: d.periodo_desde, hasta: d.periodo_hasta },
            diasDeAtraso: d.dias_de_atraso,
            intentosFallidos: Number(d.intentos_fallidos),
          })),
          adeudado: [...adeudado].map(([moneda, centavos]) => ({
            moneda,
            importe: formatearCentavos(centavos),
          })),
          alcance:
            'Estos documentos NO son comprobantes fiscales mientras esComprobanteFiscal ' +
            'sea falso: no llevan CAE y no entran en ningún Libro IVA. Los impuestos en ' +
            'null significan que no se discriminaron, no que sean cero.',
        };
      },
    );
  });

  /** Un documento con su detalle y sus intentos de cobro. */
  app.get('/companies/current/billing/:documentId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'billing:read');
    const auth = requireAuth(request);

    const { documentId } = z
      .object({ documentId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const doc = await tx.query<{
          id: string;
          numero: string;
          tipo: string;
          estado: string;
          moneda: string;
          importe_total: string;
          emitido_el: string | null;
          pagado_el: string | null;
          es_comprobante_fiscal: boolean;
        }>(
          `SELECT id, numero::text AS numero, tipo, estado, moneda,
                  importe_total::text AS importe_total,
                  emitido_el::text AS emitido_el, pagado_el::text AS pagado_el,
                  es_comprobante_fiscal
             FROM billing_documents WHERE id = $1`,
          [documentId],
        );
        // Si el documento es de otra empresa, RLS ya lo dejó afuera y esto es un
        // 404, no un 403: contestar «existe pero no es tuyo» confirmaría su
        // existencia a quien no debería poder averiguarla.
        if (doc.rows[0] === undefined) throw notFound('No existe ese documento de cobro.');

        const lineas = await tx.query(
          `SELECT orden, concepto, cantidad::text AS cantidad,
                  precio_unitario::text AS precio_unitario, importe::text AS importe,
                  medido_hasta
             FROM billing_document_lines WHERE document_id = $1 ORDER BY orden`,
          [documentId],
        );

        const intentos = await tx.query(
          // Sin `referencia_externa` ni `medio_referencia`: son de la
          // integración. `medio_ultimos4` sí, que es lo que le sirve al cliente
          // para reconocer con qué pagó.
          `SELECT proveedor, estado, moneda, importe::text AS importe,
                  medio_ultimos4, detalle_error, created_at
             FROM payment_intents WHERE document_id = $1 ORDER BY created_at DESC`,
          [documentId],
        );

        const cobranza = await tx.query(
          `SELECT tipo, numero, programado_para::text AS programado_para,
                  ejecutado_el, resultado, detalle
             FROM collection_steps WHERE document_id = $1 ORDER BY programado_para, tipo`,
          [documentId],
        );

        return {
          documento: doc.rows[0],
          lineas: lineas.rows,
          intentos: intentos.rows,
          cobranza: cobranza.rows,
        };
      },
    );
  });
}

/**
 * De centavos a la cadena decimal, sin pasar por punto flotante.
 *
 * Existe porque el importe viaja como texto desde la base y vuelve como texto a
 * la respuesta: convertirlo a `number` en el medio para volver a formatearlo es
 * exactamente el paso que `check:no-float` prohíbe, y bastaría con un importe
 * grande para que apareciera un centavo de la nada.
 */
function formatearCentavos(centavos: bigint): string {
  const negativo = centavos < 0n;
  const magnitud = negativo ? -centavos : centavos;
  const entero = magnitud / 100n;
  const resto = magnitud % 100n;
  return `${negativo ? '-' : ''}${entero}.${String(resto).padStart(2, '0')}`;
}
