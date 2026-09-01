/**
 * Ciclo comercial: presupuesto → pedido → factura (§18, §19).
 *
 * Los dos primeros no tienen efecto fiscal. No hay CAE, no van al subdiario de
 * IVA y no producen asiento: un presupuesto rechazado no dejó ninguna huella
 * contable, y así tiene que ser.
 *
 * El tercero sí, y por eso **no vive acá**. Facturar es convertir el documento
 * comercial en una `tax_transaction` —la que ya existía— con sus renglones. No
 * hay una tabla `facturas` paralela: sería una segunda verdad sobre la misma
 * factura, y algún día no coincidirían.
 *
 * ## Dónde está el corte de permisos
 *
 * `commercial:write` alcanza para presupuestar, emitir y aceptar. **Facturar
 * exige `journal_entry:create`**, que es el permiso de registrar una operación
 * fiscal. Es el mismo corte que separa el trabajo comercial del contable: un
 * vendedor cierra la venta, y quien responde por la contabilidad la registra.
 *
 * ## Qué NO hace
 *
 * No emite ante ARCA ni pide CAE. Eso es `packages/arca` y es otro paso: acá se
 * registra la operación fiscal con los datos del comprobante. Confundir las dos
 * cosas haría que un problema de conectividad con ARCA bloqueara el registro de
 * una venta que ya ocurrió.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflictoTipado, notFound, unprocessable } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');
const precio = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Precio con hasta cuatro decimales');
const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD');

const SELECT_DOC = `
  d.id, d.direction AS direccion, d.kind AS tipo, d.number AS numero,
  d.party_id AS "terceroId", d.razon_social AS "razonSocial",
  d.issue_date::text AS "fecha", d.valid_until::text AS "validoHasta",
  d.status, d.vencido, d.currency AS moneda,
  d.renglones, d.neto::text, d.iva::text, d.exento::text,
  d.no_gravado::text AS "noGravado", d.total::text,
  d.tax_transaction_id AS "operacionFiscalId", d.supersedes_id AS "reemplazaA"`;

export async function comercialRoutes(app: FastifyInstance): Promise<void> {
  app.get('/commercial-documents', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commercial:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        direccion: z.enum(['COMPRAS', 'VENTAS']).optional(),
        tipo: z.enum(['PRESUPUESTO', 'PEDIDO']).optional(),
        status: z.enum(['BORRADOR', 'EMITIDO', 'ACEPTADO', 'RECHAZADO', 'FACTURADO', 'ANULADO'])
          .optional(),
        terceroId: z.string().uuid().optional(),
        // Se filtra por el hecho derivado, no por un estado guardado.
        vencido: z.enum(['si', 'no']).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ fecha: string; id: string }>(
          `SELECT ${SELECT_DOC}
             FROM commercial_document_status d
            WHERE d.company_id = $1
              AND ($2::text IS NULL OR d.direction = $2)
              AND ($3::text IS NULL OR d.kind = $3)
              AND ($4::text IS NULL OR d.status = $4)
              AND ($5::uuid IS NULL OR d.party_id = $5::uuid)
              AND ($6::bool IS NULL OR d.vencido = $6)
              AND ($7::date IS NULL OR (d.issue_date, d.id) < ($7::date, $8::uuid))
            ORDER BY d.issue_date DESC, d.id DESC
            LIMIT $9`,
          [
            tenant.companyId,
            query.direccion ?? null,
            query.tipo ?? null,
            query.status ?? null,
            query.terceroId ?? null,
            query.vencido === undefined ? null : query.vencido === 'si',
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(r.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));
        return { documentos: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });

  app.get('/commercial-documents/:documentId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commercial:read');
    const auth = requireAuth(request);
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const cabecera = await tx.query(
          `SELECT ${SELECT_DOC} FROM commercial_document_status d
            WHERE d.id = $1 AND d.company_id = $2`,
          [documentId, tenant.companyId],
        );
        if (cabecera.rowCount === 0) throw notFound('Documento comercial no encontrado');

        const renglones = await tx.query(
          `SELECT l.id, l.line_no AS linea, l.product_id AS "productoId",
                  p.code AS "productoCodigo", l.descripcion, l.cantidad::text,
                  l.unidad, l.precio_unitario::text AS "precioUnitario",
                  l.descuento::text, l.tratamiento, l.neto::text, l.iva::text
             FROM commercial_document_lines l
             LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
            WHERE l.document_id = $1 AND l.company_id = $2
            ORDER BY l.line_no`,
          [documentId, tenant.companyId],
        );

        return { documento: cabecera.rows[0], renglones: renglones.rows };
      },
    );
  });

  app.post('/commercial-documents', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commercial:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        direccion: z.enum(['COMPRAS', 'VENTAS']).default('VENTAS'),
        tipo: z.enum(['PRESUPUESTO', 'PEDIDO']).default('PRESUPUESTO'),
        terceroId: z.string().uuid(),
        fecha,
        validoHasta: fecha.nullish(),
        moneda: z.string().length(3).default('ARS'),
        notas: z.string().max(2000).nullish(),
        reemplazaA: z.string().uuid().nullish(),
      })
      .parse(request.body);

    if (body.tipo === 'PEDIDO' && body.validoHasta !== undefined && body.validoHasta !== null) {
      throw badRequest(
        'Un pedido no vence: se cumple, se anula o se factura. La fecha de validez es del presupuesto.',
      );
    }

    try {
      const creado = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const numero = await tx.query<{ next_commercial_number: number }>(
            'SELECT next_commercial_number($1, $2, $3)',
            [tenant.companyId, body.direccion, body.tipo],
          );

          const r = await tx.query<{ id: string; number: number }>(
            `INSERT INTO commercial_documents
               (company_id, direction, kind, number, party_id, issue_date, valid_until,
                currency, notes, supersedes_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id, number`,
            [
              tenant.companyId, body.direccion, body.tipo,
              numero.rows[0]!.next_commercial_number,
              body.terceroId, body.fecha, body.validoHasta ?? null,
              body.moneda, body.notas ?? null, body.reemplazaA ?? null,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_DOCUMENTO_COMERCIAL',
            objectType: 'commercial_documents',
            objectId: r.rows[0]!.id,
            newValue: {
              direccion: body.direccion,
              tipo: body.tipo,
              numero: r.rows[0]!.number,
              terceroId: body.terceroId,
            },
            motivo: `Alta de ${body.tipo.toLowerCase()}`,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!;
        },
      );

      reply.code(201);
      return { id: creado.id, numero: creado.number };
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw notFound('El tercero no existe en esta empresa');
      }
      throw error;
    }
  });

  /**
   * Reemplaza el detalle. Solo mientras el documento está en BORRADOR: lo que
   * se le mandó al cliente se mandó, y cambiarle el precio sin que se entere
   * convierte el expediente comercial en ficción.
   */
  app.put('/commercial-documents/:documentId/lines', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'commercial:write');
    const auth = requireAuth(request);
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        renglones: z
          .array(
            z.object({
              productoId: z.string().uuid().nullish(),
              descripcion: z.string().min(1).max(500),
              cantidad,
              unidad: z.string().min(1).max(30).default('UNIDAD'),
              precioUnitario: precio,
              descuento: monto.default('0'),
              tratamiento: z.enum(['GRAVADO', 'EXENTO', 'NO_GRAVADO']).default('GRAVADO'),
              neto: monto,
              iva: monto.default('0'),
            }),
          )
          .max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM commercial_documents WHERE id = $1 AND company_id = $2',
            [documentId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Documento comercial no encontrado');

          await tx.query(
            'DELETE FROM commercial_document_lines WHERE document_id = $1 AND company_id = $2',
            [documentId, tenant.companyId],
          );

          let linea = 0;
          for (const r of body.renglones) {
            linea += 1;
            await tx.query(
              `INSERT INTO commercial_document_lines
                 (company_id, document_id, line_no, product_id, descripcion, cantidad,
                  unidad, precio_unitario, descuento, tratamiento, neto, iva)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [
                tenant.companyId, documentId, linea, r.productoId ?? null, r.descripcion,
                r.cantidad, r.unidad, r.precioUnitario, r.descuento, r.tratamiento,
                r.neto, r.iva,
              ],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DETALLAR_DOCUMENTO_COMERCIAL',
            objectType: 'commercial_documents',
            objectId: documentId,
            newValue: { renglones: body.renglones.length },
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { documentId, renglones: body.renglones.length };
        },
      );
    } catch (error) {
      const fallo = error as { code?: string; message?: string };
      if ((fallo.message ?? '').includes('su detalle no se edita')) {
        throw conflictoTipado(
          'DOCUMENTO_YA_EMITIDO',
          'El documento ya se emitió: su detalle no se edita. Para corregirlo, emitilo de ' +
            'nuevo como revisión que reemplaza a este.',
        );
      }
      if (fallo.code === '23503') throw notFound('Alguno de los productos no existe en esta empresa');
      throw error;
    }
  });

  /** Las cuatro transiciones que no son facturar. La base valida cuál se puede. */
  for (const paso of [
    { ruta: 'emit', destino: 'EMITIDO', accion: 'EMITIR_DOCUMENTO_COMERCIAL', pideMotivo: false },
    { ruta: 'accept', destino: 'ACEPTADO', accion: 'ACEPTAR_DOCUMENTO_COMERCIAL', pideMotivo: false },
    { ruta: 'reject', destino: 'RECHAZADO', accion: 'RECHAZAR_DOCUMENTO_COMERCIAL', pideMotivo: true },
    { ruta: 'cancel', destino: 'ANULADO', accion: 'ANULAR_DOCUMENTO_COMERCIAL', pideMotivo: true },
  ] as const) {
    // Las rutas se escriben completas y no por concatenación para que el
    // barrido S-12 pueda reconstruirlas: '/commercial-documents/:documentId/emit'
    // no se deduce de una variable de bucle.
    const url =
      paso.ruta === 'emit'
        ? '/commercial-documents/:documentId/emit'
        : paso.ruta === 'accept'
          ? '/commercial-documents/:documentId/accept'
          : paso.ruta === 'reject'
            ? '/commercial-documents/:documentId/reject'
            : '/commercial-documents/:documentId/cancel';

    app.post(url, async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'commercial:write');
      const auth = requireAuth(request);
      const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({ motivo: z.string().min(3).max(500).optional() })
        .parse(request.body ?? {});

      if (paso.pideMotivo && body.motivo === undefined) {
        throw badRequest(`Falta el motivo: ${paso.destino.toLowerCase()} sin explicación no se registra`);
      }

      try {
        return await withCompany(
          { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
          async (tx) => {
            const antes = await tx.query<{ status: string }>(
              'SELECT status FROM commercial_documents WHERE id = $1 AND company_id = $2',
              [documentId, tenant.companyId],
            );
            if (antes.rowCount === 0) throw notFound('Documento comercial no encontrado');

            await tx.query(
              `UPDATE commercial_documents
                  SET status = $3,
                      motivo_anulacion = CASE WHEN $3 = 'ANULADO' THEN $4 ELSE motivo_anulacion END
                WHERE id = $1 AND company_id = $2`,
              [documentId, tenant.companyId, paso.destino, body.motivo ?? null],
            );

            await recordAudit(tx, tenant.companyId, {
              actorType: 'USER',
              actorId: `user:${auth.user.userId}`,
              action: paso.accion,
              objectType: 'commercial_documents',
              objectId: documentId,
              oldValue: { status: antes.rows[0]!.status },
              newValue: { status: paso.destino },
              ...(body.motivo === undefined ? {} : { motivo: body.motivo }),
              ip: clientIp(request),
              userAgent: request.headers['user-agent'] ?? null,
            });

            return { documentId, status: paso.destino };
          },
        );
      } catch (error) {
        throw traducirTransicion(error);
      }
    });
  }

  /**
   * Facturar: el documento comercial se convierte en operación fiscal.
   *
   * Los importes **no se reciben del cliente**: salen de los renglones del
   * documento, que son inmutables desde que se emitió. Aceptarlos del cuerpo
   * del pedido permitiría facturar por un importe distinto del que el cliente
   * aceptó, y nadie lo notaría.
   */
  app.post('/commercial-documents/:documentId/invoice', async (request, reply) => {
    const tenant = await requireCompany(request);
    // Facturar es un acto contable: fija los importes con los que después se
    // decide y se asienta. `commercial:write` no alcanza.
    requirePermission(tenant, 'journal_entry:create');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        cbteTipo: z.number().int().min(1).max(999),
        puntoVenta: z.number().int().min(0),
        numero: z.number().int().min(0),
        fecha,
      })
      .parse(request.body);

    try {
      return await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const doc = await tx.query<{
          direction: string;
          status: string;
          party_id: string;
          renglones: number;
          neto: string;
          iva: string;
          exento: string;
          no_gravado: string;
          total: string;
          tipo_documento: string;
          numero_documento: string | null;
          razon_social: string;
          condicion_iva: string;
        }>(
          `SELECT d.direction, d.status, d.party_id, d.renglones,
                  d.neto::text, d.iva::text, d.exento::text,
                  d.no_gravado::text, d.total::text,
                  p.tipo_documento, p.numero_documento, p.razon_social, p.condicion_iva
             FROM commercial_document_status d
             JOIN parties p ON p.id = d.party_id AND p.company_id = d.company_id
            WHERE d.id = $1 AND d.company_id = $2`,
          [documentId, tenant.companyId],
        );
        if (doc.rowCount === 0) throw notFound('Documento comercial no encontrado');
        const d = doc.rows[0]!;

        if (d.status !== 'ACEPTADO') {
          throw conflictoTipado(
            'DOCUMENTO_NO_ACEPTADO',
            `El documento está en ${d.status}. Solo se factura lo que el cliente aceptó.`,
          );
        }
        if (d.renglones === 0) {
          throw unprocessable('DOCUMENTO_SIN_RENGLONES', 'No hay nada que facturar');
        }

        const periodo = await tx.query<{ id: string }>(
          `SELECT id FROM periods
            WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`,
          [tenant.companyId, body.fecha],
        );
        if (periodo.rowCount === 0) {
          throw badRequest(
            `No hay período que contenga la fecha ${body.fecha}. La operación fiscal vive ` +
              'en un período: sin él no se puede registrar.',
          );
        }

        const impuesto = await tx.query<{ id: string }>(
          "SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1",
        );
        if (impuesto.rowCount === 0) {
          throw unprocessable(
            'CATALOGO_INCOMPLETO',
            'El catálogo de impuestos no tiene IVA. Corré `npm run tax:seed`.',
          );
        }

        // El CUIT solo viaja si el tercero tiene uno. Un cliente identificado
        // por DNI no lo tiene, y la columna exige once dígitos: mandar el DNI
        // ahí sería inventar un CUIT.
        const cuit =
          d.tipo_documento === 'CUIT' || d.tipo_documento === 'CUIL' ? d.numero_documento : null;

        const operacion = await tx.query<{ id: string }>(
          `INSERT INTO tax_transactions
             (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
              cbte_fecha, cuit_contraparte, razon_social, condicion_iva, party_id,
              neto, iva, no_gravado, exento, percepciones, total, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17,$18)
           RETURNING id`,
          [
            tenant.companyId, impuesto.rows[0]!.id, periodo.rows[0]!.id, d.direction,
            body.cbteTipo, body.puntoVenta, body.numero, body.fecha,
            cuit, d.razon_social, d.condicion_iva, d.party_id,
            d.neto, d.iva, d.no_gravado, d.exento, d.total, actorId,
          ],
        );
        const taxTransactionId = operacion.rows[0]!.id;

        // Los renglones se copian tal cual. El candado diferido de la 0049
        // verifica al COMMIT que cierren contra la cabecera — y cierran, porque
        // la cabecera se calculó de estos mismos renglones.
        await tx.query(
          `INSERT INTO tax_transaction_lines
             (company_id, tax_transaction_id, line_no, product_id, descripcion, cantidad,
              unidad, precio_unitario, descuento, tratamiento, neto, iva)
           SELECT l.company_id, $2, l.line_no, l.product_id, l.descripcion, l.cantidad,
                  l.unidad, l.precio_unitario, l.descuento, l.tratamiento, l.neto, l.iva
             FROM commercial_document_lines l
            WHERE l.document_id = $1 AND l.company_id = $3
            ORDER BY l.line_no`,
          [documentId, taxTransactionId, tenant.companyId],
        );

        await tx.query(
          `UPDATE commercial_documents
              SET status = 'FACTURADO', tax_transaction_id = $3
            WHERE id = $1 AND company_id = $2`,
          [documentId, tenant.companyId, taxTransactionId],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'FACTURAR_DOCUMENTO_COMERCIAL',
          objectType: 'commercial_documents',
          objectId: documentId,
          oldValue: { status: 'ACEPTADO' },
          newValue: { status: 'FACTURADO', taxTransactionId, total: d.total },
          motivo: 'El pedido aceptado se convierte en operación fiscal',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          documentId,
          taxTransactionId,
          total: d.total,
          /**
           * Lo que este paso NO significa. Va en la respuesta y no en la
           * documentación porque es donde lo lee quien acaba de facturar.
           */
          alcance:
            'La operación fiscal quedó registrada. No se pidió CAE ni se emitió ante ARCA: ' +
            'eso es un paso aparte, para que un problema de conectividad no bloquee el ' +
            'registro de una venta que ya ocurrió.',
        };
      });
    } catch (error) {
      throw traducirTransicion(error);
    }
  });
}

/** Del error de la máquina de estados al error del dominio. */
function traducirTransicion(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';
  if (mensaje.includes('Transición inválida')) {
    return conflictoTipado('TRANSICION_INVALIDA', mensaje.split('CONTEXT')[0]!.trim());
  }
  if (mensaje.includes('sin renglones')) {
    return unprocessable(
      'DOCUMENTO_SIN_RENGLONES',
      'No se emite un documento sin renglones: no habría nada ofrecido.',
    );
  }
  return error;
}
