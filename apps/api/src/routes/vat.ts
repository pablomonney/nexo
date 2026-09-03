/**
 * IVA: subdiarios de Compras y Ventas, y Libro de IVA Digital.
 *
 * Igual que en `books.ts`: acá no se decide nada. Este archivo lee la base, arma
 * lo que `@aai/tax-engine` espera y devuelve lo que el motor dijo.
 *
 * Dos endpoints devuelven **negativas** en vez de hacer el trabajo, y son
 * endpoints igual —no botones ausentes— porque la pregunta se la va a hacer
 * alguien y merece una respuesta con el artículo adentro:
 *
 * - `GET /vat/books/:anio/:mes/export-file` explica que los diseños de registro
 *   no están en la norma (RG 4597 art. 8°).
 * - `POST /vat/books/:anio/:mes/present` explica que presentar exige Clave
 *   Fiscal Nivel 3 (art. 6°), que este sistema no pide ni guarda.
 */

import {
  evaluarCreditoFiscal,
  puedeGenerarArchivoDeImportacion,
  puedePresentarPorElContribuyente,
  type EstadoLibroIva,
  type Subdiario,
} from '@aai/tax-engine';
import { recordAudit, withCompany } from '@aai/db';
import { toDecimalString } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound } from '../http/errors.js';
import {
  armarLibro,
  armarSubdiario,
  cargarAlicuotas,
  cargarComprobantes,
  declararSubdiario,
} from '../tax/subdiario.js';

const periodoSchema = z.object({
  anio: z.coerce.number().int().min(2000).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
});

export async function vatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Subdiario de IVA Compras o Ventas del período.
   *
   * `excluidos` viaja en la raíz. Un comprobante que quedó fuera de los totales
   * y solo aparece si alguien scrollea la lista es un comprobante que nadie va a
   * ir a buscar.
   */
  app.get<{ Params: { direccion: string; anio: string; mes: string } }>(
    '/vat/subdiarios/:direccion/:anio/:mes',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:read');
      const auth = requireAuth(request);
      const params = periodoSchema
        .extend({ direccion: z.enum(['COMPRAS', 'VENTAS']) })
        .parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const subdiario = await armarSubdiario(
            tx,
            tenant.companyId,
            params.direccion,
            params.anio,
            params.mes,
          );
          return serializar(subdiario);
        },
      );
    },
  );

  /**
   * El subdiario como archivo, con su hash en el encabezado.
   *
   * Es el detalle del que el Diario resumido dice surgir. Sin este endpoint la
   * referencia del art. 327 apuntaba a un archivo que no se podía descargar, y
   * una anotación detallada que nadie puede abrir no respalda nada.
   */
  app.get<{ Params: { direccion: string; anio: string; mes: string } }>(
    '/vat/subdiarios/:direccion/:anio/:mes.csv',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:read');
      const auth = requireAuth(request);
      const params = periodoSchema
        .extend({ direccion: z.enum(['COMPRAS', 'VENTAS']) })
        .parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const firmado = await declararSubdiario(
            tx,
            tenant.companyId,
            params.direccion,
            params.anio,
            params.mes,
          );
          const periodo = `${String(params.anio)}-${String(params.mes).padStart(2, '0')}`;

          return reply
            .header('content-type', 'text/csv; charset=utf-8')
            .header(
              'content-disposition',
              `attachment; filename="subdiario-${params.direccion.toLowerCase()}-${periodo}.csv"`,
            )
            .header('x-content-sha256', firmado.sha256)
            .send(firmado.csv);
        },
      );
    },
  );

  /**
   * Libro de IVA Digital del período.
   *
   * No lo genera: lo arma y dice qué lo bloquea. Generar es un acto con
   * consecuencias —el art. 12 encadena los períodos— y va por POST con permiso
   * aparte.
   */
  app.get<{ Params: { anio: string; mes: string } }>('/vat/books/:anio/:mes', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'vat_book:read');
    const auth = requireAuth(request);
    const params = periodoSchema.parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const libro = await armarLibro(tx, tenant.companyId, params.anio, params.mes);
        return {
          ...libro.resumen,
          compras: serializar(libro.compras),
          ventas: serializar(libro.ventas),
        };
      },
    );
  });

  /**
   * Genera el libro del período y lo deja registrado.
   *
   * Se niega si hay bloqueos. El del art. 12 —el período anterior sin generar—
   * no es una advertencia: la norma dice que la presentación "solo podrá
   * efectuarse" si el anterior se generó, y dejar generar igual produciría una
   * secuencia que el portal después rechaza.
   */
  app.post<{ Params: { anio: string; mes: string } }>(
    '/vat/books/:anio/:mes/generate',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:generate');
      const auth = requireAuth(request);
      const params = periodoSchema.parse(request.params);
      const actorId = `user:${auth.user.userId}`;

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const libro = await armarLibro(tx, tenant.companyId, params.anio, params.mes);

        if (libro.resumen.bloqueos.length > 0) {
          return reply.code(409).send({
            error: 'LIBRO_IVA_BLOQUEADO',
            message:
              'El período no se puede generar todavía. Cada bloqueo trae el artículo del que sale.',
            bloqueos: libro.resumen.bloqueos,
          });
        }

        const status: EstadoLibroIva = libro.resumen.sinMovimiento ? 'SIN_MOVIMIENTO' : 'GENERADO';

        // El hash del subdiario emitido. Las columnas estaban desde la 0021 con
        // el motivo escrito —«es lo que hace verificable la referencia que el
        // art. 327 del CCyC exige para un asiento resumido»— y **nadie las
        // escribía**: el Diario resumido no tenía contra qué verificar que el
        // detalle del que dice surgir siguiera siendo el mismo.
        const comprasFirmado = await declararSubdiario(
          tx,
          tenant.companyId,
          'COMPRAS',
          params.anio,
          params.mes,
        );
        const ventasFirmado = await declararSubdiario(
          tx,
          tenant.companyId,
          'VENTAS',
          params.anio,
          params.mes,
        );

        const guardado = await tx.query<{ id: string }>(
          `INSERT INTO vat_books
             (company_id, anio, mes, vencimiento, status,
              comprobantes_compras, comprobantes_ventas, bloqueos, generated_at, generated_by,
              compras_sha256, ventas_sha256)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7, '[]'::jsonb, now(), $8, $9, $10)
           ON CONFLICT (company_id, anio, mes) DO UPDATE
             SET status = EXCLUDED.status,
                 comprobantes_compras = EXCLUDED.comprobantes_compras,
                 comprobantes_ventas = EXCLUDED.comprobantes_ventas,
                 vencimiento = EXCLUDED.vencimiento,
                 generated_at = now(),
                 generated_by = EXCLUDED.generated_by,
                 compras_sha256 = EXCLUDED.compras_sha256,
                 ventas_sha256 = EXCLUDED.ventas_sha256
           RETURNING id`,
          [
            tenant.companyId,
            params.anio,
            params.mes,
            libro.resumen.vencimiento,
            status,
            libro.resumen.comprobantesCompras,
            libro.resumen.comprobantesVentas,
            actorId,
            comprasFirmado.sha256,
            ventasFirmado.sha256,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'GENERAR_LIBRO_IVA',
          objectType: 'vat_books',
          objectId: guardado.rows[0]!.id,
          ip: clientIp(request),
          newValue: { anio: params.anio, mes: params.mes, status },
        });

        reply.code(201);
        return {
          libroId: guardado.rows[0]!.id,
          status,
          vencimiento: libro.resumen.vencimiento,
          // Las referencias que el Diario resumido va a citar. Se devuelven acá
          // para que quien genera el libro vea de qué archivo está firmando el
          // hash, y no tenga que confiar en que existe.
          subdiarios: {
            compras: comprasFirmado.declarado.referencia,
            ventas: ventasFirmado.declarado.referencia,
          },
          // Se devuelve junto con el alta, porque es acá donde el usuario espera
          // un botón de "presentar" y hay que decirle por qué no está.
          presentacion: puedePresentarPorElContribuyente(),
        };
      });
    },
  );

  /**
   * El archivo de importación de ARCA: no se genera.
   *
   * Devuelve 501 y no 404: el endpoint existe, la funcionalidad está
   * identificada, y lo que falta es una fuente. Un 404 haría pensar que nadie lo
   * pensó.
   */
  app.get('/vat/books/export-file', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'vat_book:read');
    return reply.code(501).send({
      error: 'DISENO_DE_REGISTRO_NO_RELEVADO',
      ...puedeGenerarArchivoDeImportacion(),
    });
  });

  app.post<{ Params: { anio: string; mes: string } }>(
    '/vat/books/:anio/:mes/present',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:generate');
      return reply.code(501).send({
        error: 'PRESENTACION_FUERA_DEL_SISTEMA',
        ...puedePresentarPorElContribuyente(),
      });
    },
  );

  /**
   * Qué se pudo verificar sobre el crédito fiscal de un comprobante.
   *
   * Nunca responde "computable". Devuelve los controles de forma con su
   * resultado y la lista de lo que falta relevar para poder decidir de fondo.
   */
  app.get<{ Params: { txId: string } }>('/vat/credito-fiscal/:txId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'vat_book:read');
    const auth = requireAuth(request);
    const params = z.object({ txId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const catalogo = await cargarAlicuotas(tx);
        const comprobantes = await cargarComprobantes(tx, tenant.companyId, {
          txId: params.txId,
        });
        const comprobante = comprobantes[0];
        if (comprobante === undefined) {
          throw notFound('No existe esa operación de IVA en esta empresa');
        }
        return evaluarCreditoFiscal(comprobante, catalogo);
      },
    );
  });
}

function serializar(subdiario: Subdiario): unknown {
  return {
    direccion: subdiario.direccion,
    periodo: `${String(subdiario.anio)}-${String(subdiario.mes).padStart(2, '0')}`,
    desde: subdiario.desde,
    hasta: subdiario.hasta,
    moneda: subdiario.moneda,
    totales: {
      neto: toDecimalString(subdiario.totalNeto),
      iva: toDecimalString(subdiario.totalIva),
      noGravado: toDecimalString(subdiario.totalNoGravado),
      exento: toDecimalString(subdiario.totalExento),
      percepciones: toDecimalString(subdiario.totalPercepciones),
      total: toDecimalString(subdiario.total),
    },
    porAlicuota: subdiario.porAlicuota.map((fila) => ({
      alicuotaId: fila.alicuotaId,
      etiqueta: fila.etiqueta,
      neto: toDecimalString(fila.neto),
      iva: toDecimalString(fila.iva),
    })),
    excluidos: subdiario.excluidos,
    renglones: subdiario.renglones.map((renglon) => ({
      comprobanteId: renglon.comprobanteId,
      fecha: renglon.fecha,
      tipo: renglon.tipoComprobante,
      puntoVenta: renglon.puntoVenta,
      numero: renglon.numero,
      cuit: renglon.cuitContraparte,
      razonSocial: renglon.razonSocialContraparte,
      condicion: renglon.condicionContraparte,
      neto: toDecimalString(renglon.neto),
      iva: toDecimalString(renglon.iva),
      noGravado: toDecimalString(renglon.noGravado),
      exento: toDecimalString(renglon.exento),
      percepciones: toDecimalString(renglon.percepciones),
      total: toDecimalString(renglon.total),
      alicuotaId: renglon.alicuotaId,
      asientoId: renglon.entryId,
      documentoId: renglon.documentId,
      hallazgos: renglon.hallazgos,
    })),
  };
}
