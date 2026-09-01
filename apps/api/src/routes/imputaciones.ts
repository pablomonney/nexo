/**
 * Composición y antigüedad de la cuenta corriente (§21).
 *
 * `party_balances` (0047) contesta *cuánto* se le debe a un tercero. Esto
 * contesta las dos preguntas que hacen falta para trabajar: **qué facturas**
 * componen ese saldo y **desde cuándo**.
 *
 * ## Qué se declara y qué se deriva
 *
 * Se **declara** una sola cosa: qué movimiento del Mayor cancela qué factura.
 * No es deducible — un cliente que debe tres facturas de $1.000 y paga $1.000
 * puede estar pagando cualquiera, y la convención de la más vieja primero es
 * una suposición con consecuencias: cambia qué se reclama.
 *
 * Se **deriva** todo lo demás: el pendiente de cada comprobante, el
 * vencimiento, la mora y los tramos de antigüedad. Ninguna de esas cifras se
 * almacena, así que ninguna puede quedar desactualizada.
 *
 * ## El vencimiento no se inventa
 *
 * NEXO no conoce las condiciones de pago pactadas. Cuando el tercero tiene
 * `diasDePago` declarado, el vencimiento se deriva y la mora es una afirmación
 * fundada; cuando no, `diasDeMora` viene en `null` y **el sistema no afirma que
 * nada esté vencido** (§42). La diferencia viaja en cada respuesta.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');

const ALCANCE_SIN_CONDICION =
  'Los comprobantes de terceros sin condición de pago declarada no cuentan como vencidos: ' +
  'NEXO no conoce el plazo acordado y no lo deduce. Declaralo en la ficha del tercero ' +
  'para que la mora sea una afirmación fundada.';

export async function imputacionRoutes(app: FastifyInstance): Promise<void> {
  /** La composición del saldo de un tercero, comprobante por comprobante. */
  app.get('/parties/:partyId/saldo', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:read');
    requirePermission(tenant, 'party:read');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        // Por defecto solo lo que queda pendiente: es lo que se mira. Lo
        // saldado se pide explícitamente.
        incluirSaldados: z.enum(['si', 'no']).default('no'),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const tercero = await tx.query<{ razon_social: string; dias_de_pago: number | null }>(
          'SELECT razon_social, dias_de_pago FROM parties WHERE id = $1 AND company_id = $2',
          [partyId, tenant.companyId],
        );
        if (tercero.rowCount === 0) throw notFound('Tercero no encontrado');

        const comprobantes = await tx.query<{ fecha: string; id: string }>(
          `SELECT s.tax_transaction_id AS id, s.cbte_fecha::text AS fecha,
                  s.direction AS direccion, s.cbte_tipo AS "cbteTipo",
                  s.punto_venta AS "puntoVenta", s.cbte_numero::text AS numero,
                  s.total::text, s.imputado::text, s.pendiente::text,
                  s.vencimiento::text, s.vencimiento_declarado AS "vencimientoDeclarado",
                  s.dias_de_mora AS "diasDeMora", s.antiguedad_dias AS "antiguedadDias"
             FROM invoice_settlement s
            WHERE s.party_id = $1 AND s.company_id = $2
              AND ($3::bool OR s.pendiente > 0)
              AND ($4::date IS NULL
                   OR (s.cbte_fecha, s.tax_transaction_id) < ($4::date, $5::uuid))
            ORDER BY s.cbte_fecha DESC, s.tax_transaction_id DESC
            LIMIT $6`,
          [
            partyId,
            tenant.companyId,
            query.incluirSaldados === 'si',
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const antiguedad = await tx.query(
          `SELECT direction AS direccion, pendiente::text, hasta_30::text AS "hasta30",
                  de_31_a_60::text AS "de31a60", de_61_a_90::text AS "de61a90",
                  mas_de_90::text AS "masDe90", vencido::text, comprobantes,
                  mas_antiguo AS "masAntiguo"
             FROM party_aging WHERE party_id = $1 AND company_id = $2`,
          [partyId, tenant.companyId],
        );

        const pagina = armarPagina(comprobantes.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));

        return {
          tercero: {
            razonSocial: tercero.rows[0]!.razon_social,
            diasDePago: tercero.rows[0]!.dias_de_pago,
          },
          antiguedad: antiguedad.rows,
          comprobantes: pagina.items,
          cursor: pagina.cursor,
          limite: pagina.limite,
          alcance:
            tercero.rows[0]!.dias_de_pago === null
              ? 'Este tercero no tiene condición de pago declarada: no se afirma mora sobre ' +
                'sus comprobantes. La antigüedad se cuenta desde la fecha del comprobante.'
              : `Vencimiento derivado de la condición declarada: ${tercero.rows[0]!.dias_de_pago} días.`,
        };
      },
    );
  });

  /** La antigüedad de saldos de toda la cartera. */
  app.get('/reports/aging', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z
      .object({ direccion: z.enum(['COMPRAS', 'VENTAS']).default('VENTAS') })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const filas = await tx.query(
          `SELECT party_id AS "terceroId", razon_social AS "razonSocial",
                  pendiente::text, hasta_30::text AS "hasta30",
                  de_31_a_60::text AS "de31a60", de_61_a_90::text AS "de61a90",
                  mas_de_90::text AS "masDe90", vencido::text,
                  comprobantes, mas_antiguo AS "masAntiguo"
             FROM party_aging
            WHERE company_id = $1 AND direction = $2
            ORDER BY pendiente DESC`,
          [tenant.companyId, query.direccion],
        );

        return {
          direccion: query.direccion,
          terceros: filas.rows,
          alcance: ALCANCE_SIN_CONDICION,
        };
      },
    );
  });

  /**
   * Qué movimientos del Mayor tiene este tercero sin imputar.
   *
   * Es la otra mitad de la pantalla: para imputar hay que poder elegir el cobro,
   * y para elegirlo hay que verlo.
   */
  app.get('/parties/:partyId/movimientos-sin-imputar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:read');
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { partyId } = z.object({ partyId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT l.id AS "lineaId", l.entry_id AS "entryId", e.entry_number AS "numeroAsiento",
                  e.entry_date::text AS fecha, e.description AS detalle,
                  a.code AS "cuentaCodigo", a.name AS "cuentaNombre",
                  (l.debit + l.credit)::text AS importe,
                  coalesce(im.usado, 0)::text AS imputado,
                  (l.debit + l.credit - coalesce(im.usado, 0))::text AS disponible,
                  CASE WHEN l.debit > 0 THEN 'DEBE' ELSE 'HABER' END AS lado
             FROM journal_entry_lines l
             JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
             JOIN accounts a ON a.id = l.account_id AND a.company_id = l.company_id
             LEFT JOIN LATERAL (
                   SELECT sum(x.importe) AS usado
                     FROM party_allocations x
                    WHERE x.journal_entry_line_id = l.id AND x.status = 'ACTIVA'
                  ) im ON true
            WHERE l.party_id = $1
              AND l.company_id = $2
              AND e.status = 'APROBADO'
              -- El asiento de la propia factura no es un cobro. Se excluye por
              -- el hecho —tiene origen en una operación fiscal—, no por una
              -- lista de códigos de diario que alguien tendría que mantener.
              AND e.source_id IS NULL
              AND (l.debit + l.credit) > coalesce(im.usado, 0)
            ORDER BY e.entry_date DESC, l.id DESC
            LIMIT 200`,
          [partyId, tenant.companyId],
        );

        return { movimientos: r.rows };
      },
    );
  });

  app.post('/party-allocations', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        taxTransactionId: z.string().uuid(),
        journalEntryLineId: z.string().uuid(),
        importe: monto,
      })
      .parse(request.body);

    try {
      const creada = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const factura = await tx.query<{ party_id: string | null }>(
            'SELECT party_id FROM tax_transactions WHERE id = $1 AND company_id = $2',
            [body.taxTransactionId, tenant.companyId],
          );
          if (factura.rowCount === 0) throw notFound('Comprobante no encontrado');
          const partyId = factura.rows[0]!.party_id;
          if (partyId === null) {
            throw unprocessable(
              'COMPROBANTE_SIN_TERCERO',
              'El comprobante no está resuelto contra ningún tercero: sin eso no se sabe de ' +
                'quién es la deuda que se cancela. Vinculalo primero.',
            );
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO party_allocations
               (company_id, party_id, tax_transaction_id, journal_entry_line_id, importe, created_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id`,
            [
              tenant.companyId, partyId, body.taxTransactionId,
              body.journalEntryLineId, body.importe, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'IMPUTAR_COBRO',
            objectType: 'tax_transactions',
            objectId: body.taxTransactionId,
            newValue: {
              allocationId: r.rows[0]!.id,
              journalEntryLineId: body.journalEntryLineId,
              importe: body.importe,
            },
            motivo: 'Se declara qué movimiento cancela este comprobante',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );

      reply.code(201);
      return { id: creada };
    } catch (error) {
      throw traducirImputacion(error);
    }
  });

  app.post('/party-allocations/:allocationId/cancel', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:write');
    const auth = requireAuth(request);
    const { allocationId } = z.object({ allocationId: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(3).max(500) }).parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query<{ status: string; tax_transaction_id: string }>(
          'SELECT status, tax_transaction_id FROM party_allocations WHERE id = $1 AND company_id = $2',
          [allocationId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Imputación no encontrada');
        if (antes.rows[0]!.status === 'ANULADA') {
          throw conflict('La imputación ya estaba anulada');
        }

        await tx.query(
          `UPDATE party_allocations SET status = 'ANULADA', motivo_anulacion = $3
            WHERE id = $1 AND company_id = $2`,
          [allocationId, tenant.companyId, body.motivo],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'ANULAR_IMPUTACION',
          objectType: 'tax_transactions',
          objectId: antes.rows[0]!.tax_transaction_id,
          oldValue: { allocationId, status: 'ACTIVA' },
          newValue: { allocationId, status: 'ANULADA' },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return { allocationId, status: 'ANULADA' };
      },
    );
  });

  /** Las imputaciones de un comprobante: quién dijo que estaba pago y cuándo. */
  app.get('/tax-transactions/:taxTransactionId/allocations', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:read');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const saldo = await tx.query(
          `SELECT total::text, imputado::text, pendiente::text,
                  vencimiento::text, vencimiento_declarado AS "vencimientoDeclarado",
                  dias_de_mora AS "diasDeMora", antiguedad_dias AS "antiguedadDias"
             FROM invoice_settlement
            WHERE tax_transaction_id = $1 AND company_id = $2`,
          [taxTransactionId, tenant.companyId],
        );
        if (saldo.rowCount === 0) {
          throw notFound('El comprobante no existe o no está vinculado a un tercero');
        }

        const imputaciones = await tx.query(
          `SELECT a.id, a.importe::text, a.status, a.motivo_anulacion AS "motivoAnulacion",
                  a.created_at AS "creadoEn", a.created_by AS "creadoPor",
                  a.journal_entry_line_id AS "lineaId",
                  e.entry_number AS "numeroAsiento", e.entry_date::text AS fecha
             FROM party_allocations a
             JOIN journal_entry_lines l
               ON l.id = a.journal_entry_line_id AND l.company_id = a.company_id
             JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
            WHERE a.tax_transaction_id = $1 AND a.company_id = $2
            ORDER BY a.created_at`,
          [taxTransactionId, tenant.companyId],
        );

        return { saldo: saldo.rows[0], imputaciones: imputaciones.rows };
      },
    );
  });
}

/**
 * Del código del candado al error del dominio.
 *
 * Se reconoce por el prefijo `E_ALLOC_*` que emite cada trigger, no por su
 * prosa. La versión anterior comparaba fragmentos de texto y se equivocaba en
 * dos de los cinco casos: un mensaje decía «no cancela» y otro «no la cancela»,
 * que no contiene al primero. El código es estable; la redacción no tiene por
 * qué serlo.
 *
 * El mensaje de PostgreSQL no se reenvía nunca: puede revelar nombres de tablas
 * y de restricciones.
 */
const POR_CODIGO: ReadonlyArray<readonly [string, string, string]> = [
  [
    'E_ALLOC_EXCEDE_COMPROBANTE',
    'IMPUTACION_EXCEDE_COMPROBANTE',
    'La imputación deja el comprobante cancelado por más de lo que dice.',
  ],
  [
    'E_ALLOC_EXCEDE_MOVIMIENTO',
    'IMPUTACION_EXCEDE_MOVIMIENTO',
    'El movimiento no alcanza: ya está imputado por su importe total.',
  ],
  [
    'E_ALLOC_ES_LA_FACTURA',
    'MOVIMIENTO_ES_LA_FACTURA',
    'Ese movimiento pertenece al asiento que registra la propia factura: no la cancela.',
  ],
  [
    'E_ALLOC_SIN_APROBAR',
    'ASIENTO_SIN_APROBAR',
    'El asiento del movimiento no está aprobado: todavía puede no existir.',
  ],
  [
    'E_ALLOC_TERCERO_DISTINTO',
    'TERCERO_NO_COINCIDE',
    'El movimiento y el comprobante no son del mismo tercero.',
  ],
  [
    'E_ALLOC_SIN_TERCERO',
    'COMPROBANTE_SIN_TERCERO',
    'El comprobante no está resuelto contra ningún tercero: sin eso no se sabe de quién es ' +
      'la deuda que se cancela.',
  ],
];

function traducirImputacion(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  for (const [interno, publico, texto] of POR_CODIGO) {
    if (mensaje.includes(interno)) return unprocessable(publico, texto);
  }
  if (fallo.code === '23505') {
    return conflict('Ese movimiento ya está imputado a este comprobante');
  }
  if (fallo.code === '23503') {
    return notFound('El movimiento del Mayor no existe en esta empresa');
  }
  return error;
}
