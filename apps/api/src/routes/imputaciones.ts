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
        // Obligatoria si el comprobante tiene plan, prohibida si no lo tiene.
        // No se valida acá: lo hace el trigger, que es el que ve el plan y el
        // que sigue valiendo cuando alguien entre por otro camino.
        installmentId: z.string().uuid().nullish(),
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
               (company_id, party_id, tax_transaction_id, journal_entry_line_id, importe,
                installment_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id`,
            [
              tenant.companyId, partyId, body.taxTransactionId,
              body.journalEntryLineId, body.importe,
              body.installmentId ?? null, `user:${auth.user.userId}`,
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

  // ── Plan de pagos (0060) ─────────────────────────────────────────────────

  /**
   * El plan de cuotas de un comprobante, con lo pendiente de cada una.
   *
   * Sin plan devuelve la lista vacía y dice de dónde sale entonces el
   * vencimiento. «No tiene plan» y «tiene un plan vacío» no se pueden
   * distinguir mirando una lista de cero elementos, y mandan a hacer cosas
   * distintas.
   */
  app.get('/tax-transactions/:taxTransactionId/installments', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:read');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const comprobante = await tx.query<{ total: string; dias_de_pago: number | null }>(
          `SELECT t.total::text, p.dias_de_pago
             FROM tax_transactions t
             LEFT JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
            WHERE t.id = $1 AND t.company_id = $2`,
          [taxTransactionId, tenant.companyId],
        );
        if (comprobante.rowCount === 0) throw notFound('Comprobante no encontrado');

        const cuotas = await tx.query(
          `SELECT installment_id AS id, numero, vencimiento::text, importe::text,
                  imputado::text, pendiente::text, dias_de_mora AS "diasDeMora"
             FROM installment_settlement
            WHERE tax_transaction_id = $1 AND company_id = $2
            ORDER BY numero`,
          [taxTransactionId, tenant.companyId],
        );

        const plazoDelTercero = comprobante.rows[0]!.dias_de_pago;

        return {
          total: comprobante.rows[0]!.total,
          tienePlan: cuotas.rows.length > 0,
          cuotas: cuotas.rows,
          vencimiento:
            cuotas.rows.length > 0
              ? 'Sale del plan: cada cuota tiene el suyo.'
              : plazoDelTercero === null
                ? 'No hay: el comprobante no tiene plan y el tercero no tiene condición de pago declarada. NEXO no lo deduce.'
                : `Sale del tercero: fecha del comprobante más ${String(plazoDelTercero)} días.`,
        };
      },
    );
  });

  /**
   * Declara el plan completo. Reemplaza el anterior si lo había.
   *
   * Es un `PUT` y no un `POST` por cuota: el plan **cierra contra el total** y
   * un plan a medio cargar no es un estado válido del mundo. Mandarlo entero
   * hace que la transacción sea la unidad, y el candado diferido lo verifica al
   * confirmar.
   *
   * Cambiar el plan de un comprobante ya imputado se rechaza: las imputaciones
   * nombran cuotas, y borrarlas dejaría cobros apuntando a nada.
   */
  app.put('/tax-transactions/:taxTransactionId/installments', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'allocation:write');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    const body = z
      .object({
        cuotas: z
          .array(
            z.object({
              vencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              importe: monto,
            }),
          )
          .min(1)
          .max(360),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM tax_transactions WHERE id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Comprobante no encontrado');

          const imputadas = await tx.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM party_allocations
              WHERE tax_transaction_id = $1 AND company_id = $2 AND status = 'ACTIVA'`,
            [taxTransactionId, tenant.companyId],
          );
          if (Number(imputadas.rows[0]!.n) > 0) {
            throw conflict(
              'El comprobante ya tiene cobros imputados a sus cuotas. Anulá las imputaciones ' +
                'antes de cambiar el plan: si no, quedarían apuntando a cuotas que ya no existen.',
            );
          }

          const antes = await tx.query(
            `SELECT numero, fecha_vencimiento::text, importe::text
               FROM tax_transaction_installments
              WHERE tax_transaction_id = $1 AND company_id = $2 ORDER BY numero`,
            [taxTransactionId, tenant.companyId],
          );

          await tx.query(
            'DELETE FROM tax_transaction_installments WHERE tax_transaction_id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId],
          );

          // El número sale de la posición en el arreglo y no del cuerpo: dos
          // cuotas con el mismo número serían un plan sin orden, y aceptarlo
          // para después rechazarlo con un error de índice único no ayuda.
          for (const [i, cuota] of body.cuotas.entries()) {
            await tx.query(
              `INSERT INTO tax_transaction_installments
                 (company_id, tax_transaction_id, numero, fecha_vencimiento, importe, created_by)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [
                tenant.companyId, taxTransactionId, i + 1,
                cuota.vencimiento, cuota.importe, `user:${auth.user.userId}`,
              ],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_PLAN_DE_PAGOS',
            objectType: 'tax_transactions',
            objectId: taxTransactionId,
            ...(antes.rowCount === 0 ? {} : { oldValue: { cuotas: antes.rows } }),
            newValue: { cuotas: body.cuotas },
            motivo:
              'Se declara cuándo vence cada parte del comprobante. Sin plan, el vencimiento ' +
              'sale del plazo del tercero, y sin eso no hay vencimiento.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { taxTransactionId, cuotas: body.cuotas.length };
        },
      );
    } catch (error) {
      throw traducirPlan(error);
    }
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
  // Plan de pagos (0060).
  [
    'E_ALLOC_SIN_CUOTA',
    'IMPUTACION_SIN_CUOTA',
    'El comprobante tiene un plan de pagos: la imputación tiene que decir qué cuota cancela. ' +
      'Consultá GET /tax-transactions/:id/installments.',
  ],
  [
    'E_ALLOC_CUOTA_SIN_PLAN',
    'CUOTA_SIN_PLAN',
    'El comprobante no tiene plan de pagos y la imputación nombra una cuota.',
  ],
  [
    'E_ALLOC_CUOTA_DE_OTRO_COMPROBANTE',
    'CUOTA_DE_OTRO_COMPROBANTE',
    'Esa cuota pertenece a otra factura.',
  ],
  [
    'E_ALLOC_EXCEDE_CUOTA',
    'IMPUTACION_EXCEDE_CUOTA',
    'La imputación deja la cuota cancelada por más de lo que la cuota vale.',
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

/** Del candado del plan al error del dominio. Mismo criterio: por código. */
function traducirPlan(error: unknown): unknown {
  const mensaje = (error as { message?: string }).message ?? '';

  if (mensaje.includes('E_PLAN_NO_CIERRA')) {
    return unprocessable(
      'PLAN_NO_CIERRA',
      'Las cuotas no suman el total del comprobante. Un plan que no cierra dejaría una ' +
        'parte de la factura sin fecha de vencimiento.',
    );
  }
  if (mensaje.includes('E_PLAN_ANTES_DEL_COMPROBANTE')) {
    return unprocessable(
      'CUOTA_ANTES_DEL_COMPROBANTE',
      'Hay una cuota que vence antes de la fecha del comprobante.',
    );
  }
  return error;
}
