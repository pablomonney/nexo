/**
 * Cheques propios y de terceros.
 *
 * ## Por qué es un módulo y no un campo
 *
 * En Argentina el cheque de tercero en cartera es una parte central del capital
 * de trabajo: se recibe de un cliente, se guarda, se deposita, o se endosa a un
 * proveedor en lugar de pagar. Tiene su propio ciclo, su propio riesgo —el
 * rechazo— y su propia fecha, que casi nunca es la de la factura que lo originó.
 *
 * ## El estado no se manda: se deriva
 *
 * No hay `PATCH /checks/:id/estado`. Se registra **lo que pasó** —se depositó,
 * lo rechazaron, se endosó— y el estado sale del último movimiento. Un endpoint
 * que dejara escribir el estado permitiría decir «acreditado» sin que existiera
 * el hecho, y ahí la cartera pasa a ser una opinión.
 *
 * ## Este módulo no toca el Mayor
 *
 * Recibir un cheque en cancelación de una factura es un asiento, y ese asiento
 * lo firma una persona por el camino de siempre. El cheque puede **citarlo** con
 * `journalEntryId`, y la bandeja avisa mientras no lo cite. Si el registro de
 * cheques moviera el Mayor por su cuenta, habría dos orígenes para el mismo
 * saldo de «Valores a depositar».
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');

export async function chequeRoutes(app: FastifyInstance): Promise<void> {
  /** La cartera y su resumen por tramo de fecha de pago. */
  app.get('/checks', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'check:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        tipo: z.enum(['RECIBIDO', 'EMITIDO']).optional(),
        estado: z.string().max(40).optional(),
        soloEnCartera: z.enum(['si', 'no']).default('no'),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT check_id AS id, tipo, numero, banco,
                  cuit_librador AS "cuitLibrador", importe::text, moneda,
                  fecha_emision::text AS "fechaEmision",
                  fecha_pago::text AS "fechaPago",
                  party_id AS "terceroId", razon_social AS "razonSocial",
                  bank_account_id AS "cuentaBancariaId",
                  journal_entry_id AS "asientoId",
                  estado, ultimo_movimiento::text AS "ultimoMovimiento",
                  ultimo_motivo AS "ultimoMotivo",
                  en_cartera AS "enCartera",
                  dias_desde_fecha_de_pago AS "diasDesdeFechaDePago"
             FROM check_status
            WHERE company_id = $1
              AND ($2::text IS NULL OR tipo = $2)
              AND ($3::text IS NULL OR estado = $3)
              AND ($4::bool IS NOT TRUE OR en_cartera)
            ORDER BY fecha_pago, numero`,
          [
            tenant.companyId,
            query.tipo ?? null,
            query.estado ?? null,
            query.soloEnCartera === 'si',
          ],
        );

        const cartera = await tx.query(
          `SELECT cantidad, total::text,
                  al_dia_de_hoy::text AS "alDiaDeHoy",
                  proximos_30::text AS "proximos30",
                  de_31_a_60::text AS "de31a60",
                  mas_de_60::text AS "masDe60",
                  proxima_fecha::text AS "proximaFecha"
             FROM checks_en_cartera WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          cheques: r.rows,
          // «Sin cheques en cartera» y «la consulta no devolvió nada» no se ven
          // igual: el resumen ausente se informa como null, no como ceros.
          cartera: cartera.rows[0] ?? null,
          alcance:
            'El estado sale del último movimiento registrado: no hay columna de estado que ' +
            'mantener. Los importes son los del cheque, no los del Mayor — un cheque cargado ' +
            'y sin asiento no está en «Valores a depositar», y la bandeja lo avisa.',
        };
      },
    );
  });

  /** Un cheque con toda su historia. */
  app.get('/checks/:checkId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'check:read');
    const auth = requireAuth(request);
    const { checkId } = z.object({ checkId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const cheque = await tx.query(
          `SELECT check_id AS id, tipo, numero, banco,
                  cuit_librador AS "cuitLibrador", importe::text, moneda,
                  fecha_emision::text AS "fechaEmision", fecha_pago::text AS "fechaPago",
                  party_id AS "terceroId", razon_social AS "razonSocial",
                  bank_account_id AS "cuentaBancariaId", journal_entry_id AS "asientoId",
                  estado, en_cartera AS "enCartera"
             FROM check_status WHERE check_id = $1 AND company_id = $2`,
          [checkId, tenant.companyId],
        );
        if (cheque.rowCount === 0) throw notFound('Cheque no encontrado');

        const movimientos = await tx.query(
          `SELECT m.id, m.tipo, m.fecha::text, m.motivo,
                  m.bank_account_id AS "cuentaBancariaId",
                  m.party_id AS "terceroId", p.razon_social AS "razonSocial",
                  m.created_by AS "registradoPor", m.created_at AS "registradoEn"
             FROM check_movements m
             LEFT JOIN parties p ON p.id = m.party_id AND p.company_id = m.company_id
            WHERE m.check_id = $1 AND m.company_id = $2
            ORDER BY m.fecha, m.id`,
          [checkId, tenant.companyId],
        );

        return {
          cheque: cheque.rows[0],
          movimientos: movimientos.rows,
          alcance:
            'El libro es append-only: un error se corrige con otro movimiento, no editando el ' +
            'anterior. Es la misma regla que el Diario y que el libro de stock.',
        };
      },
    );
  });

  /**
   * Carga un cheque. **No lo pone en circulación**: eso es el primer movimiento.
   *
   * Se separan porque son dos hechos: que el papel existe y que entró a la
   * cartera. Un cheque cargado por error y nunca recibido se distingue de uno
   * que se recibió y después se anuló, y esa diferencia importa al reclamar.
   */
  app.post('/checks', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'check:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        tipo: z.enum(['RECIBIDO', 'EMITIDO']),
        numero: z.string().min(1).max(40),
        banco: z.string().min(1).max(120),
        cuitLibrador: z.string().regex(/^\d{11}$/).nullish(),
        importe: monto,
        moneda: z.string().length(3).default('ARS'),
        fechaEmision: fecha,
        // Se declara siempre, incluso cuando coincide con la emisión: derivarla
        // exigiría el plazo legal, que no está archivado.
        fechaPago: fecha,
        terceroId: z.string().uuid().nullish(),
        cuentaBancariaId: z.string().uuid().nullish(),
        asientoId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO checks
               (company_id, tipo, numero, banco, cuit_librador, importe, moneda,
                fecha_emision, fecha_pago, party_id, bank_account_id,
                journal_entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id`,
            [
              tenant.companyId, body.tipo, body.numero, body.banco,
              body.cuitLibrador ?? null, body.importe, body.moneda,
              body.fechaEmision, body.fechaPago, body.terceroId ?? null,
              body.cuentaBancariaId ?? null, body.asientoId ?? null,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CARGAR_CHEQUE',
            objectType: 'checks',
            objectId: r.rows[0]!.id,
            newValue: {
              tipo: body.tipo,
              banco: body.banco,
              numero: body.numero,
              importe: body.importe,
              fechaPago: body.fechaPago,
            },
            motivo: 'Alta del cheque. Todavía no circuló: eso es el primer movimiento.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCheque(error);
    }
  });

  /**
   * Registra qué le pasó al cheque.
   *
   * La máquina de estados vive en la base, no acá: depositar uno ya acreditado
   * o endosar uno anulado es imposible por cualquier camino, no solo por este.
   */
  app.post('/checks/:checkId/movimientos', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'check:write');
    const auth = requireAuth(request);
    const { checkId } = z.object({ checkId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        tipo: z.enum([
          'RECIBIDO', 'ENTREGADO', 'DEPOSITADO',
          'ACREDITADO', 'ENDOSADO', 'RECHAZADO', 'ANULADO',
        ]),
        fecha,
        cuentaBancariaId: z.string().uuid().nullish(),
        terceroId: z.string().uuid().nullish(),
        motivo: z.string().max(500).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM checks WHERE id = $1 AND company_id = $2',
            [checkId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Cheque no encontrado');

          const r = await tx.query<{ id: string }>(
            `INSERT INTO check_movements
               (company_id, check_id, tipo, fecha, bank_account_id, party_id, motivo, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              tenant.companyId, checkId, body.tipo, body.fecha,
              body.cuentaBancariaId ?? null, body.terceroId ?? null,
              body.motivo ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'MOVER_CHEQUE',
            objectType: 'checks',
            objectId: checkId,
            newValue: { tipo: body.tipo, fecha: body.fecha },
            motivo:
              body.motivo ??
              'Se registra un hecho del cheque. El estado se deriva de acá, no se escribe.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCheque(error);
    }
  });

  /**
   * Lo que va a entrar por cheques, por tramo de fecha de pago.
   *
   * Va aparte de la proyección de cobranzas y **no se suma a ella**: una factura
   * cancelada con un cheque ya no figura como pendiente, así que sumarlos daría
   * la plata dos veces. Son dos preguntas distintas —qué me deben y qué tengo
   * cobrado a fecha futura— y se contestan por separado.
   */
  app.get('/checks/flujo', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'check:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT cantidad, total::text,
                  al_dia_de_hoy::text AS "alDiaDeHoy",
                  proximos_30::text AS "proximos30",
                  de_31_a_60::text AS "de31a60",
                  mas_de_60::text AS "masDe60",
                  proxima_fecha::text AS "proximaFecha"
             FROM checks_en_cartera WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          cartera: r.rows[0] ?? null,
          metodologia:
            'Cheques de terceros en cartera —recibidos y no depositados, o rechazados y ' +
            'todavía en poder de la empresa— ubicados por su **fecha de pago declarada**, no ' +
            'por la del comprobante que los originó.',
          alcance:
            'NO se suma a la proyección de cobranzas: una factura cancelada con un cheque ya ' +
            'no figura como pendiente, y sumar las dos cosas contaría la misma plata dos ' +
            'veces. Son dos preguntas distintas y se contestan por separado.',
        };
      },
    );
  });
}

/**
 * Del candado al error del dominio.
 *
 * Por código y no por prosa, como en el resto del sistema: la redacción de un
 * mensaje cambia, el código no.
 */
function traducirCheque(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  const porCodigo: ReadonlyArray<readonly [string, string, string]> = [
    [
      'E_CHEQUE_PRIMER_MOVIMIENTO',
      'PRIMER_MOVIMIENTO_INVALIDO',
      'Un cheque de tercero entra a la cartera con RECIBIDO; uno propio empieza por ' +
        'ENTREGADO o ANULADO.',
    ],
    [
      'E_CHEQUE_CERRADO',
      'CHEQUE_CERRADO',
      'El cheque ya terminó su recorrido: acreditado, endosado o anulado no admiten más ' +
        'movimientos.',
    ],
    [
      'E_CHEQUE_TRANSICION',
      'TRANSICION_INVALIDA',
      'Ese movimiento no puede seguir al anterior.',
    ],
    [
      'E_CHEQUE_SIN_CUENTA',
      'DEPOSITO_SIN_CUENTA',
      'Depositar exige decir en qué cuenta bancaria.',
    ],
    [
      'E_CHEQUE_SIN_DESTINATARIO',
      'ENDOSO_SIN_DESTINATARIO',
      'Endosar exige decir a quién se le entregó.',
    ],
  ];

  for (const [interno, publico, texto] of porCodigo) {
    if (mensaje.includes(interno)) return unprocessable(publico, texto);
  }

  if (fallo.code === '23505') {
    return conflict(
      'Ya existe un cheque de ese banco con ese número. Cargarlo dos veces duplicaría la ' +
        'cartera sin que nada lo advierta.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('ck_propio_con_cuenta')) {
    return unprocessable(
      'CUENTA_INCOHERENTE',
      'Un cheque propio sale de una cuenta de la empresa y uno de tercero no tiene ninguna.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('ck_fecha_pago_no_anterior')) {
    return unprocessable(
      'FECHA_DE_PAGO_ANTERIOR',
      'La fecha de pago no puede ser anterior a la de emisión.',
    );
  }
  if (fallo.code === '23503') {
    return notFound('El tercero, la cuenta bancaria o el asiento no existen en esta empresa');
  }
  return error;
}
