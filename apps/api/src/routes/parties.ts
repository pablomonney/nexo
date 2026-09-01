/**
 * Maestro de terceros: clientes, proveedores y demás contrapartes (§14).
 *
 * El maestro es **por empresa**. Dos empresas que le compran al mismo proveedor
 * tienen dos fichas distintas y no se ven entre sí: son estudios contables o
 * grupos que no comparten información, y unificarlas sería la fuga que la
 * arquitectura entera existe para impedir.
 *
 * ## La cuenta corriente no se guarda
 *
 * `GET /parties/:id/cuenta-corriente` no lee un saldo: lo suma del Mayor, en la
 * vista `party_balances` (migración 0047). No hay una columna `saldo` que
 * mantener al día porque no puede quedar desactualizado algo que no existe.
 * Si el saldo y los asientos discrepan, es que la consulta está mal — y eso se
 * arregla; un saldo almacenado que discrepa obliga a decidir cuál de las dos
 * cifras es la verdadera, y esa pregunta no tiene respuesta buena.
 *
 * ## Lo que el maestro NO hace
 *
 * No corrige comprobantes. `tax_transactions.cuit_contraparte` y `razon_social`
 * son lo que declara el papel y siguen intactos aunque el tercero cambie de
 * nombre. Vincular un comprobante a un tercero es afirmar «este comprobante es
 * de esta persona», no «el comprobante decía otra cosa».
 */

import { recordAudit, withCompany } from '@aai/db';
// El módulo 11 ya vive en `@aai/shared` y es el que aplica el resto del sistema
// —incluida la validación de prefijos y la convención de ARCA para resto 1—.
// Una segunda copia acá sería una segunda regla que algún día se desviaría.
import { isValidCuit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, conflictoTipado, notFound } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const TIPOS_DOCUMENTO = [
  'CUIT', 'CUIL', 'DNI', 'PASAPORTE', 'DOC_EXTRANJERO', 'SIN_IDENTIFICAR',
] as const;

const CONDICIONES_IVA = [
  'RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO',
  'CONSUMIDOR_FINAL', 'NO_CATEGORIZADO', 'DESCONOCIDA',
] as const;

const ROLES = [
  'CLIENTE', 'PROVEEDOR', 'EMPLEADO', 'ACREEDOR', 'DEUDOR', 'TRANSPORTISTA', 'OTRO',
] as const;

/** Campos que el alta y la edición comparten. */
const datosDeContacto = {
  nombreFantasia: z.string().max(200).nullish(),
  condicionIva: z.enum(CONDICIONES_IVA).optional(),
  email: z.string().email().max(200).nullish(),
  telefono: z.string().max(60).nullish(),
  domicilio: z.string().max(300).nullish(),
  localidad: z.string().max(120).nullish(),
  provincia: z.string().max(120).nullish(),
  codigoPostal: z.string().max(20).nullish(),
  pais: z.string().length(2).optional(),
  observaciones: z.string().max(2000).nullish(),
};

const SELECT_TERCERO = `
  p.id, p.tipo_documento AS "tipoDocumento", p.numero_documento AS "numeroDocumento",
  p.razon_social AS "razonSocial", p.nombre_fantasia AS "nombreFantasia",
  p.condicion_iva AS "condicionIva", p.email, p.telefono, p.domicilio,
  p.localidad, p.provincia, p.codigo_postal AS "codigoPostal", p.pais,
  p.observaciones, p.status, p.created_at AS "creadoEn", p.created_by AS "creadoPor",
  coalesce(
    (SELECT array_agg(r.role ORDER BY r.role) FROM party_roles r
      WHERE r.party_id = p.id AND r.company_id = p.company_id),
    ARRAY[]::text[]) AS roles`;

export async function partyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/parties', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        // Búsqueda por nombre o documento. Una sola caja: quien busca un
        // proveedor tipea lo que recuerda, no elige antes en qué campo mirar.
        q: z.string().min(1).max(120).optional(),
        rol: z.enum(ROLES).optional(),
        status: z.enum(['ACTIVO', 'ARCHIVADO']).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query<{ creadoEn: Date; id: string }>(
          `SELECT ${SELECT_TERCERO}
             FROM parties p
            WHERE p.company_id = $1
              AND ($2::text IS NULL
                   OR lower(p.razon_social) LIKE '%' || lower($2) || '%'
                   OR lower(coalesce(p.nombre_fantasia, '')) LIKE '%' || lower($2) || '%'
                   OR p.numero_documento LIKE $2 || '%')
              AND ($3::text IS NULL
                   OR EXISTS (SELECT 1 FROM party_roles r
                               WHERE r.party_id = p.id AND r.company_id = p.company_id
                                 AND r.role = $3))
              AND ($4::text IS NULL OR p.status = $4)
              AND ($5::timestamptz IS NULL
                   OR (p.created_at, p.id) < ($5::timestamptz, $6::uuid))
            ORDER BY p.created_at DESC, p.id DESC
            LIMIT $7`,
          [
            tenant.companyId,
            query.q ?? null,
            query.rol ?? null,
            query.status ?? null,
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(result.rows, query.limite, (fila) => ({
          fecha: fila.creadoEn,
          id: fila.id,
        }));
        return { terceros: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });

  app.post('/parties', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        tipoDocumento: z.enum(TIPOS_DOCUMENTO).default('CUIT'),
        numeroDocumento: z.string().max(40).nullish(),
        razonSocial: z.string().min(1).max(200),
        // Al menos un rol. Un tercero sin rol no se puede ofrecer en ninguna
        // pantalla: existiría sin que nadie pueda encontrarlo para usarlo.
        roles: z.array(z.enum(ROLES)).min(1),
        ...datosDeContacto,
      })
      .parse(request.body);

    const numero = body.numeroDocumento ?? null;

    if (body.tipoDocumento === 'SIN_IDENTIFICAR') {
      if (numero !== null) {
        throw badRequest('Un tercero SIN_IDENTIFICAR no lleva número de documento');
      }
    } else if (numero === null) {
      throw badRequest('Falta el número de documento');
    } else if (
      (body.tipoDocumento === 'CUIT' || body.tipoDocumento === 'CUIL') &&
      !isValidCuit(numero)
    ) {
      // Comprobación **de forma**, no fiscal: dice que el número está bien
      // construido, no que el contribuyente exista ni esté activo. Eso lo
      // contesta ARCA y para eso está `tax_transaction:constatar` (§11).
      throw badRequest(`El ${body.tipoDocumento} ${numero} no supera la verificación de módulo 11`);
    }

    try {
      const creado = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const result = await tx.query<{ id: string }>(
            `INSERT INTO parties
               (company_id, tipo_documento, numero_documento, razon_social, nombre_fantasia,
                condicion_iva, email, telefono, domicilio, localidad, provincia,
                codigo_postal, pais, observaciones, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             RETURNING id`,
            [
              tenant.companyId, body.tipoDocumento, numero, body.razonSocial,
              body.nombreFantasia ?? null, body.condicionIva ?? 'DESCONOCIDA',
              body.email ?? null, body.telefono ?? null, body.domicilio ?? null,
              body.localidad ?? null, body.provincia ?? null, body.codigoPostal ?? null,
              body.pais ?? 'AR', body.observaciones ?? null, `user:${auth.user.userId}`,
            ],
          );
          const id = result.rows[0]!.id;

          for (const rol of new Set(body.roles)) {
            await tx.query(
              `INSERT INTO party_roles (party_id, company_id, role, created_by)
               VALUES ($1, $2, $3, $4)`,
              [id, tenant.companyId, rol, `user:${auth.user.userId}`],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_TERCERO',
            objectType: 'parties',
            objectId: id,
            newValue: {
              tipoDocumento: body.tipoDocumento,
              numeroDocumento: numero,
              razonSocial: body.razonSocial,
              roles: [...new Set(body.roles)],
            },
            motivo: 'Alta de tercero',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return id;
        },
      );

      reply.code(201);
      return { id: creado };
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === '23505') {
        throw conflictoTipado(
          'TERCERO_DUPLICADO',
          `Ya existe un tercero con el documento ${numero ?? ''} en esta empresa`,
        );
      }
      throw error;
    }
  });

  app.get('/parties/:partyId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:read');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const ficha = await tx.query(
          `SELECT ${SELECT_TERCERO} FROM parties p WHERE p.id = $1 AND p.company_id = $2`,
          [partyId, tenant.companyId],
        );
        if (ficha.rowCount === 0) throw notFound('Tercero no encontrado');

        const saldo = await tx.query(
          `SELECT debe::text, haber::text, saldo::text, movimientos,
                  ultimo_movimiento::text AS "ultimoMovimiento"
             FROM party_balances WHERE party_id = $1 AND company_id = $2`,
          [partyId, tenant.companyId],
        );

        // Cuántos comprobantes se le resolvieron. Es el dato que dice si la
        // ficha está viva o quedó de un alta que nadie volvió a usar.
        const comprobantes = await tx.query<{ cantidad: string }>(
          `SELECT count(*)::text AS cantidad FROM tax_transactions
            WHERE party_id = $1 AND company_id = $2`,
          [partyId, tenant.companyId],
        );

        return {
          tercero: ficha.rows[0],
          cuentaCorriente: saldo.rows[0] ?? null,
          comprobantesVinculados: Number(comprobantes.rows[0]!.cantidad),
        };
      },
    );
  });

  app.patch('/parties/:partyId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:write');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        razonSocial: z.string().min(1).max(200).optional(),
        status: z.enum(['ACTIVO', 'ARCHIVADO']).optional(),
        // El documento no se edita. Cambiarlo convertiría la ficha en otra
        // persona conservando sus movimientos: si el número está mal, se
        // archiva esta y se da de alta la correcta.
        motivo: z.string().min(3).max(500),
        ...datosDeContacto,
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query(
          `SELECT ${SELECT_TERCERO} FROM parties p WHERE p.id = $1 AND p.company_id = $2`,
          [partyId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Tercero no encontrado');

        const despues = await tx.query(
          `UPDATE parties
              SET razon_social    = COALESCE($3, razon_social),
                  status          = COALESCE($4, status),
                  nombre_fantasia = CASE WHEN $5  THEN $6  ELSE nombre_fantasia END,
                  condicion_iva   = COALESCE($7, condicion_iva),
                  email           = CASE WHEN $8  THEN $9  ELSE email END,
                  telefono        = CASE WHEN $10 THEN $11 ELSE telefono END,
                  domicilio       = CASE WHEN $12 THEN $13 ELSE domicilio END,
                  localidad       = CASE WHEN $14 THEN $15 ELSE localidad END,
                  provincia       = CASE WHEN $16 THEN $17 ELSE provincia END,
                  codigo_postal   = CASE WHEN $18 THEN $19 ELSE codigo_postal END,
                  pais            = COALESCE($20, pais),
                  observaciones   = CASE WHEN $21 THEN $22 ELSE observaciones END
            WHERE id = $1 AND company_id = $2
            RETURNING id`,
          [
            partyId, tenant.companyId,
            body.razonSocial ?? null, body.status ?? null,
            // Cada campo opcional viaja con un booleano que dice si vino en el
            // cuerpo: `null` significa borrarlo, no «dejarlo como estaba».
            body.nombreFantasia !== undefined, body.nombreFantasia ?? null,
            body.condicionIva ?? null,
            body.email !== undefined, body.email ?? null,
            body.telefono !== undefined, body.telefono ?? null,
            body.domicilio !== undefined, body.domicilio ?? null,
            body.localidad !== undefined, body.localidad ?? null,
            body.provincia !== undefined, body.provincia ?? null,
            body.codigoPostal !== undefined, body.codigoPostal ?? null,
            body.pais ?? null,
            body.observaciones !== undefined, body.observaciones ?? null,
          ],
        );

        const ficha = await tx.query(
          `SELECT ${SELECT_TERCERO} FROM parties p WHERE p.id = $1`,
          [despues.rows[0]!.id],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'MODIFICAR_TERCERO',
          objectType: 'parties',
          objectId: partyId,
          oldValue: antes.rows[0],
          newValue: ficha.rows[0],
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return ficha.rows[0];
      },
    );
  });

  app.post('/parties/:partyId/roles', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:write');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);
    const body = z.object({ role: z.enum(ROLES) }).parse(request.body);

    try {
      await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM parties WHERE id = $1 AND company_id = $2',
            [partyId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Tercero no encontrado');

          await tx.query(
            `INSERT INTO party_roles (party_id, company_id, role, created_by)
             VALUES ($1, $2, $3, $4)`,
            [partyId, tenant.companyId, body.role, `user:${auth.user.userId}`],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'MODIFICAR_TERCERO',
            objectType: 'parties',
            objectId: partyId,
            newValue: { rolAgregado: body.role },
            motivo: `Se declara al tercero como ${body.role}`,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });
        },
      );
      reply.code(201);
      return { partyId, role: body.role };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('El tercero ya tiene ese rol');
      }
      throw error;
    }
  });

  /**
   * La cuenta corriente: los movimientos del Mayor imputados a este tercero.
   *
   * Solo asientos `APROBADO`. Un borrador no le debe plata a nadie, y mostrarlo
   * en el saldo daría una cifra que cambia sola cuando alguien aprueba —o
   * descarta— un asiento que el tercero nunca vio.
   */
  app.get('/parties/:partyId/cuenta-corriente', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'party:read');
    // Los movimientos son el Mayor. Quien no puede leer el Mayor no puede
    // leerlo filtrado por tercero: sería la misma información por otra puerta.
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const saldo = await tx.query(
          `SELECT razon_social AS "razonSocial", debe::text, haber::text, saldo::text,
                  movimientos, ultimo_movimiento::text AS "ultimoMovimiento"
             FROM party_balances WHERE party_id = $1 AND company_id = $2`,
          [partyId, tenant.companyId],
        );
        if (saldo.rowCount === 0) throw notFound('Tercero no encontrado');

        const movimientos = await tx.query<{ fecha: string; id: string }>(
          `SELECT l.id, e.entry_date::text AS fecha, e.entry_number AS "numeroAsiento",
                  e.id AS "entryId", e.description AS detalle, e.journal_code AS diario,
                  a.code AS "cuentaCodigo", a.name AS "cuentaNombre",
                  l.debit::text AS debe, l.credit::text AS haber,
                  l.description AS "detalleLinea"
             FROM journal_entry_lines l
             JOIN journal_entries e
               ON e.id = l.entry_id AND e.company_id = l.company_id
             JOIN accounts a
               ON a.id = l.account_id AND a.company_id = l.company_id
            WHERE l.party_id = $1
              AND l.company_id = $2
              AND e.status = 'APROBADO'
              AND ($3::date IS NULL OR (e.entry_date, l.id) < ($3::date, $4::uuid))
            ORDER BY e.entry_date DESC, l.id DESC
            LIMIT $5`,
          [partyId, tenant.companyId, cursorFecha, cursorId, query.limite + 1],
        );

        const pagina = armarPagina(movimientos.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));

        return {
          tercero: saldo.rows[0],
          movimientos: pagina.items,
          cursor: pagina.cursor,
          limite: pagina.limite,
        };
      },
    );
  });
}
