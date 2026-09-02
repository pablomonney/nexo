/**
 * Listas de precios.
 *
 * `products.list_price` es **un** precio y alcanza para proponer un renglón.
 * Acá viven el precio mayorista, el acordado con un cliente y la escala por
 * cantidad, cada uno con su período de vigencia.
 *
 * ## Por qué toda consulta lleva fecha
 *
 * Porque una lista rige entre dos fechas y el §6 vale igual para los precios
 * que para las normas: reimprimir un presupuesto de marzo con la lista de
 * septiembre produce un documento que dice algo que nunca se ofreció. La fecha
 * es obligatoria en la resolución, no un parámetro opcional con `current_date`
 * por defecto — un default silencioso es justo cómo se cuela el error.
 *
 * ## El precio viene con su procedencia
 *
 * Ninguna respuesta devuelve un número pelado. Trae de qué lista salió y de qué
 * tramo, o que salió del precio base del producto, o que no hay precio. Un
 * precio sin procedencia es indefendible frente al cliente que pregunta por qué
 * le cobraron eso.
 *
 * ## La lista no impone
 *
 * El renglón de un presupuesto sigue guardando el precio que alguien escribió.
 * La lista sugiere, igual que la cuenta contable sugerida de un producto:
 * imponerla haría imposible la excepción, que en una venta es la mitad del
 * trabajo.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const importe = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Importe con hasta cuatro decimales');
const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');

export async function precioRoutes(app: FastifyInstance): Promise<void> {
  /** Las listas de la empresa, con qué cubre cada una. */
  app.get('/price-lists', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT price_list_id AS id, code AS codigo, name AS nombre, currency AS moneda,
                  vigente_desde::text AS "vigenteDesde",
                  vigente_hasta::text AS "vigenteHasta",
                  status, productos, tramos,
                  terceros_asignados AS "tercerosAsignados",
                  vigente_hoy AS "vigenteHoy"
             FROM price_list_coverage
            WHERE company_id = $1
            ORDER BY vigente_desde DESC, code`,
          [tenant.companyId],
        );

        return {
          listas: r.rows,
          alcance:
            '`vigenteHoy` es para mirar el tablero. El precio de una operación se resuelve ' +
            'siempre por **la fecha de la operación**: un presupuesto de marzo se reimprime ' +
            'con la lista de marzo (§6).',
        };
      },
    );
  });

  app.post('/price-lists', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        moneda: z.string().min(3).max(3).default('ARS'),
        vigenteDesde: fecha,
        vigenteHasta: fecha.nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO price_lists
               (company_id, code, name, currency, vigente_desde, vigente_hasta, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.moneda,
              body.vigenteDesde, body.vigenteHasta ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_LISTA_DE_PRECIOS',
            objectType: 'price_lists',
            objectId: r.rows[0]!.id,
            newValue: body,
            motivo: 'Alta de lista de precios con su período de vigencia',
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
        throw conflict('Ya existe una lista con ese código en esta empresa');
      }
      throw error;
    }
  });

  /** Los precios de una lista. */
  app.get('/price-lists/:listId/items', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:read');
    const auth = requireAuth(request);
    const { listId } = z.object({ listId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const existe = await tx.query(
          'SELECT 1 FROM price_lists WHERE id = $1 AND company_id = $2',
          [listId, tenant.companyId],
        );
        if (existe.rowCount === 0) throw notFound('Lista de precios no encontrada');

        const r = await tx.query(
          `SELECT i.id, i.product_id AS "productoId", p.code AS codigo, p.name AS nombre,
                  i.cantidad_desde::text AS "cantidadDesde", i.precio::text
             FROM price_list_items i
             JOIN products p ON p.id = i.product_id AND p.company_id = i.company_id
            WHERE i.price_list_id = $1 AND i.company_id = $2
            ORDER BY p.code, i.cantidad_desde`,
          [listId, tenant.companyId],
        );

        return {
          items: r.rows,
          alcance:
            'El tramo de cada precio llega hasta el `cantidadDesde` del siguiente. No hay ' +
            'columna de tope: dos columnas que describen el mismo borde pueden contradecirse.',
        };
      },
    );
  });

  /**
   * Carga los precios de una lista. Reemplaza los que había.
   *
   * Entera y no de a uno porque una lista es un conjunto coherente: cargarla en
   * dos pasos deja un estado intermedio donde algunos productos tienen precio
   * nuevo y otros viejo, y en ese intervalo se cotiza mal.
   */
  app.put('/price-lists/:listId/items', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:write');
    const auth = requireAuth(request);
    const { listId } = z.object({ listId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        items: z
          .array(
            z.object({
              productoId: z.string().uuid(),
              cantidadDesde: cantidad.default('1'),
              precio: importe,
            }),
          )
          .max(5000),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM price_lists WHERE id = $1 AND company_id = $2',
            [listId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Lista de precios no encontrada');

          await tx.query(
            'DELETE FROM price_list_items WHERE price_list_id = $1 AND company_id = $2',
            [listId, tenant.companyId],
          );

          for (const item of body.items) {
            await tx.query(
              `INSERT INTO price_list_items
                 (company_id, price_list_id, product_id, cantidad_desde, precio)
               VALUES ($1,$2,$3,$4,$5)`,
              [tenant.companyId, listId, item.productoId, item.cantidadDesde, item.precio],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CARGAR_PRECIOS',
            objectType: 'price_lists',
            objectId: listId,
            newValue: { items: body.items.length },
            motivo: 'Se reemplazan los precios de la lista',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { listId, items: body.items.length };
        },
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict(
          'Hay dos precios para el mismo producto y el mismo tramo de cantidad: el sistema ' +
            'no tendría con qué elegir entre ellos.',
        );
      }
      if ((error as { code?: string }).code === '23503') {
        throw notFound('Alguno de los productos no existe en esta empresa');
      }
      throw error;
    }
  });

  /** Qué lista tiene asignada un tercero, y desde cuándo. */
  app.get('/parties/:partyId/price-lists', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:read');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT a.id, a.price_list_id AS "priceListId", l.code AS codigo, l.name AS nombre,
                  a.desde::text, a.hasta::text,
                  (current_date BETWEEN a.desde AND coalesce(a.hasta, 'infinity'::date))
                    AS "vigenteHoy"
             FROM party_price_lists a
             JOIN price_lists l ON l.id = a.price_list_id AND l.company_id = a.company_id
            WHERE a.party_id = $1 AND a.company_id = $2
            ORDER BY a.desde DESC`,
          [partyId, tenant.companyId],
        );

        return {
          asignaciones: r.rows,
          alcance:
            'Un tercero no puede tener dos listas el mismo día: el sistema no tendría con qué ' +
            'elegir, y hacerlo por orden de carga sería azar disfrazado.',
        };
      },
    );
  });

  app.post('/parties/:partyId/price-lists', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:write');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        priceListId: z.string().uuid(),
        desde: fecha,
        hasta: fecha.nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO party_price_lists
               (company_id, party_id, price_list_id, desde, hasta, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, partyId, body.priceListId,
              body.desde, body.hasta ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ASIGNAR_LISTA_DE_PRECIOS',
            objectType: 'parties',
            objectId: partyId,
            newValue: body,
            motivo: 'Se declara con qué lista se cotiza a este tercero y desde cuándo',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      if ((error as { message?: string }).message?.includes('E_PRECIO_LISTAS_SUPERPUESTAS')) {
        throw unprocessable(
          'LISTAS_SUPERPUESTAS',
          'El tercero ya tiene otra lista asignada en ese período. Cerrá la anterior con una ' +
            'fecha `hasta` antes de asignar la nueva.',
        );
      }
      if ((error as { code?: string }).code === '23503') {
        throw notFound('El tercero o la lista no existen en esta empresa');
      }
      throw error;
    }
  });

  /**
   * El precio de un producto para un tercero, a una fecha y una cantidad.
   *
   * La fecha es **obligatoria**. Un default a hoy sería el camino más corto
   * para cotizar un presupuesto viejo con la lista de esta semana.
   */
  app.get('/pricing/resolve', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'product:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        productoId: z.string().uuid(),
        terceroId: z.string().uuid().optional(),
        fecha,
        cantidad: cantidad.default('1'),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{
          precio: string | null;
          origen: string;
          lista_codigo: string | null;
          tramo_desde: string | null;
        }>(
          `SELECT precio::text, origen, lista_codigo, tramo_desde::text
             FROM resolver_precio($1, $2, $3, $4::date, $5::numeric)`,
          [
            tenant.companyId,
            query.productoId,
            // Sin tercero no hay lista asignada que buscar, y la función cae
            // sola al precio base. Se pasa un uuid nulo en vez de ramificar acá.
            query.terceroId ?? null,
            query.fecha,
            query.cantidad,
          ],
        );

        const fila = r.rows[0]!;
        return {
          precio: fila.precio,
          origen: fila.origen,
          listaCodigo: fila.lista_codigo,
          tramoDesde: fila.tramo_desde,
          fecha: query.fecha,
          cantidad: query.cantidad,
          metodologia:
            'Se busca la lista asignada al tercero **vigente a la fecha pedida**, y dentro de ' +
            'ella el mayor tramo de cantidad que no supere a la cantidad pedida. Si no hay ' +
            'lista aplicable se usa el precio base del producto. Si tampoco hay, `SIN_PRECIO`: ' +
            'no se estima, no se arrastra el del mes pasado y no se interpola entre tramos.',
          alcance:
            'Es una sugerencia. El renglón guarda el precio que escriba la persona: imponer la ' +
            'lista haría imposible la excepción, que en una venta es la mitad del trabajo.',
        };
      },
    );
  });
}
