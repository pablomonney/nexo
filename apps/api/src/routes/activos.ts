/**
 * Bienes de uso y amortizaciones (§22).
 *
 * ## Qué calcula y qué no firma
 *
 * La amortización de un ejercicio es una **función pura** de datos declarados
 * —costo, mejoras, vida útil, método y fechas—, y por eso se calcula en vez de
 * guardarse. Lo que NEXO **no hace** es asentarla solo: el profesional registra
 * el asiento por el camino de siempre y después lo vincula acá.
 *
 * Al vincularlo se comprueba que el importe del asiento sea exactamente el
 * calculado. Es el mismo esquema que la factura de compra (0052): el sistema no
 * escribe en el Diario, pero tampoco deja pasar un importe que no cierra.
 *
 * ## El valor de libros dice lo que dice el Diario
 *
 * `asset_book_value` descuenta **solo lo asentado**. Una amortización calculada
 * y no registrada no baja el valor del bien: si lo bajara, el balance y el
 * módulo dirían cosas distintas sobre el mismo activo.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, conflictoTipado, notFound, unprocessable } from '../http/errors.js';

const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD');

const SELECT_BIEN = `
  a.id, a.code AS codigo, a.name AS nombre, a.description AS descripcion,
  a.costo::text, a.fecha_alta::text AS "fechaAlta",
  a.vida_util_meses AS "vidaUtilMeses", a.metodo,
  a.valor_residual::text AS "valorResidual",
  a.status, a.fecha_baja::text AS "fechaBaja", a.motivo_baja AS "motivoBaja",
  a.valor_de_venta::text AS "valorDeVenta",
  ca.code AS "cuentaBien", cu.code AS "cuentaAcumulada", cg.code AS "cuentaGasto",
  a.tax_transaction_id AS "comprobanteId", a.created_at AS "creadoEn"`;

const DESDE_BIEN = `
  FROM fixed_assets a
  JOIN accounts ca ON ca.id = a.account_id             AND ca.company_id = a.company_id
  JOIN accounts cu ON cu.id = a.accumulated_account_id AND cu.company_id = a.company_id
  JOIN accounts cg ON cg.id = a.expense_account_id     AND cg.company_id = a.company_id`;

export async function activoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fixed-assets', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:read');
    const auth = requireAuth(request);
    const query = z
      .object({ status: z.enum(['EN_USO', 'BAJA']).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT ${SELECT_BIEN},
                  v.base::text, v.amortizado::text,
                  v.valor_de_libros::text AS "valorDeLibros",
                  v.ejercicios_pendientes AS "ejerciciosPendientes"
             ${DESDE_BIEN}
             LEFT JOIN asset_book_value v
                    ON v.fixed_asset_id = a.id AND v.company_id = a.company_id
            WHERE a.company_id = $1
              AND ($2::text IS NULL OR a.status = $2)
            ORDER BY a.code`,
          [tenant.companyId, query.status ?? null],
        );
        return { bienes: r.rows, alcance: ALCANCE };
      },
    );
  });

  app.get('/fixed-assets/:assetId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:read');
    const auth = requireAuth(request);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const bien = await tx.query(
          `SELECT ${SELECT_BIEN} ${DESDE_BIEN} WHERE a.id = $1 AND a.company_id = $2`,
          [assetId, tenant.companyId],
        );
        if (bien.rowCount === 0) throw notFound('Bien de uso no encontrado');

        const mejoras = await tx.query(
          `SELECT id, descripcion, importe::text, fecha::text,
                  tax_transaction_id AS "comprobanteId"
             FROM fixed_asset_improvements
            WHERE fixed_asset_id = $1 AND company_id = $2
            ORDER BY fecha`,
          [assetId, tenant.companyId],
        );

        const plan = await tx.query(
          `SELECT fiscal_year_id AS "ejercicioId", ejercicio, base::text, meses,
                  amortizacion::text, entry_id AS "entryId"
             FROM asset_depreciation_schedule
            WHERE fixed_asset_id = $1 AND company_id = $2
            ORDER BY start_date`,
          [assetId, tenant.companyId],
        );

        const valor = await tx.query(
          `SELECT base::text, amortizado::text, valor_de_libros::text AS "valorDeLibros",
                  ejercicios_pendientes AS "ejerciciosPendientes"
             FROM asset_book_value WHERE fixed_asset_id = $1 AND company_id = $2`,
          [assetId, tenant.companyId],
        );

        return {
          bien: bien.rows[0],
          mejoras: mejoras.rows,
          plan: plan.rows,
          valor: valor.rows[0] ?? null,
          alcance: ALCANCE,
        };
      },
    );
  });

  app.post('/fixed-assets', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        descripcion: z.string().max(2000).nullish(),
        costo: monto,
        fechaAlta: fecha,
        // Se declara. No hay una tabla de vidas útiles correctas: hay una
        // decisión profesional sobre el uso que la empresa le va a dar.
        vidaUtilMeses: z.number().int().min(1).max(1200),
        valorResidual: monto.default('0'),
        // Las cuentas llegan por código y se resuelven dentro de la empresa:
        // aceptar un uuid del cuerpo dejaría al cliente eligiendo una fila que
        // podría no ser suya.
        cuentaBien: z.string().min(1).max(40),
        cuentaAcumulada: z.string().min(1).max(40),
        cuentaGasto: z.string().min(1).max(40),
        comprobanteId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const cuenta = async (codigo: string): Promise<string> => {
            const a = await tx.query<{ id: string }>(
              'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
              [tenant.companyId, codigo],
            );
            if (a.rowCount === 0) throw notFound(`No existe la cuenta ${codigo} en esta empresa`);
            return a.rows[0]!.id;
          };

          const r = await tx.query<{ id: string }>(
            `INSERT INTO fixed_assets
               (company_id, code, name, description, costo, fecha_alta, vida_util_meses,
                valor_residual, account_id, accumulated_account_id, expense_account_id,
                tax_transaction_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.descripcion ?? null,
              body.costo, body.fechaAlta, body.vidaUtilMeses, body.valorResidual,
              await cuenta(body.cuentaBien), await cuenta(body.cuentaAcumulada),
              await cuenta(body.cuentaGasto), body.comprobanteId ?? null,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ALTA_DE_BIEN_DE_USO',
            objectType: 'fixed_assets',
            objectId: r.rows[0]!.id,
            newValue: {
              codigo: body.codigo,
              costo: body.costo,
              vidaUtilMeses: body.vidaUtilMeses,
              valorResidual: body.valorResidual,
            },
            motivo:
              'Alta de bien de uso: fija la vida útil y las cuentas con las que va a ' +
              'cargar resultado en cada ejercicio',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirActivo(error, body.codigo);
    }
  });

  app.post('/fixed-assets/:assetId/improvements', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:write');
    const auth = requireAuth(request);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        descripcion: z.string().min(1).max(500),
        importe: monto,
        fecha,
        comprobanteId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const bien = await tx.query<{ status: string }>(
            'SELECT status FROM fixed_assets WHERE id = $1 AND company_id = $2',
            [assetId, tenant.companyId],
          );
          if (bien.rowCount === 0) throw notFound('Bien de uso no encontrado');
          if (bien.rows[0]!.status === 'BAJA') {
            throw conflictoTipado(
              'BIEN_DADO_DE_BAJA',
              'El bien está dado de baja: no admite mejoras.',
            );
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO fixed_asset_improvements
               (company_id, fixed_asset_id, descripcion, importe, fecha,
                tax_transaction_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, assetId, body.descripcion, body.importe, body.fecha,
              body.comprobanteId ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'MEJORA_DE_BIEN_DE_USO',
            objectType: 'fixed_assets',
            objectId: assetId,
            newValue: { importe: body.importe, fecha: body.fecha },
            motivo: `Mejora: ${body.descripcion}`,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirActivo(error, '');
    }
  });

  app.post('/fixed-assets/:assetId/baja', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:write');
    const auth = requireAuth(request);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        fecha,
        motivo: z.string().min(3).max(500),
        valorDeVenta: monto.nullish(),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query<{ status: string }>(
          'SELECT status FROM fixed_assets WHERE id = $1 AND company_id = $2',
          [assetId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Bien de uso no encontrado');
        if (antes.rows[0]!.status === 'BAJA') throw conflict('El bien ya está dado de baja');

        await tx.query(
          `UPDATE fixed_assets
              SET status = 'BAJA', fecha_baja = $3, motivo_baja = $4, valor_de_venta = $5
            WHERE id = $1 AND company_id = $2`,
          [assetId, tenant.companyId, body.fecha, body.motivo, body.valorDeVenta ?? null],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'BAJA_DE_BIEN_DE_USO',
          objectType: 'fixed_assets',
          objectId: assetId,
          oldValue: { status: 'EN_USO' },
          newValue: { status: 'BAJA', fecha: body.fecha, valorDeVenta: body.valorDeVenta ?? null },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return {
          assetId,
          status: 'BAJA',
          /**
           * Lo que la baja NO hace. Va en la respuesta porque es donde lo lee
           * quien acaba de darla: el resultado de la venta —o de la baja sin
           * venta— es un asiento que decide una persona, y NEXO no lo arma.
           */
          alcance:
            'La baja no produce asiento. El resultado por venta o por baja se registra por el ' +
            'camino del Diario, con las cuentas que corresponda a esta operación.',
        };
      },
    );
  });

  /** Qué hay que amortizar en un ejercicio, en toda la empresa. */
  app.get('/reports/depreciation', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z.object({ ejercicioId: z.string().uuid() }).parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT fixed_asset_id AS "bienId", bien_codigo AS codigo, bien_nombre AS nombre,
                  base::text, meses, amortizacion::text, entry_id AS "entryId"
             FROM asset_depreciation_schedule
            WHERE company_id = $1 AND fiscal_year_id = $2 AND amortizacion > 0
            ORDER BY bien_codigo`,
          [tenant.companyId, query.ejercicioId],
        );

        const pendientes = r.rows.filter((f) => (f as { entryId: string | null }).entryId === null);

        return {
          bienes: r.rows,
          pendientes: pendientes.length,
          alcance:
            'Importes calculados por método lineal, prorrateados por los meses en uso dentro ' +
            'del ejercicio. NEXO no los asienta: el asiento lo firma una persona y después se ' +
            'vincula, comprobando que el importe coincida.',
        };
      },
    );
  });

  /**
   * Vincula el asiento que amortizó un ejercicio.
   *
   * Comprueba que el importe del asiento sea **exactamente** el calculado. Sin
   * esa comprobación el vínculo sería decorativo: la bandeja dejaría de avisar
   * y el cargo del ejercicio podría ser cualquiera.
   */
  app.post('/fixed-assets/:assetId/depreciations', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'asset:depreciate');
    const auth = requireAuth(request);
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        ejercicioId: z.string().uuid(),
        entryId: z.string().uuid(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const plan = await tx.query<{ amortizacion: string; entry_id: string | null }>(
            `SELECT amortizacion::text AS amortizacion, entry_id
               FROM asset_depreciation_schedule
              WHERE fixed_asset_id = $1 AND fiscal_year_id = $2 AND company_id = $3`,
            [assetId, body.ejercicioId, tenant.companyId],
          );
          if (plan.rowCount === 0) {
            throw notFound('El bien no tiene plan de amortización para ese ejercicio');
          }
          const esperado = plan.rows[0]!.amortizacion;
          if (Number(esperado) <= 0) {
            throw unprocessable(
              'SIN_AMORTIZACION',
              'Ese ejercicio no tiene amortización para este bien: el plan da cero.',
            );
          }

          const asiento = await tx.query<{ status: string; total_debit: string }>(
            `SELECT status, total_debit::text AS total_debit
               FROM journal_entries WHERE id = $1 AND company_id = $2`,
            [body.entryId, tenant.companyId],
          );
          if (asiento.rowCount === 0) throw notFound('El asiento no existe en esta empresa');
          if (asiento.rows[0]!.status !== 'APROBADO') {
            throw unprocessable(
              'ASIENTO_SIN_APROBAR',
              'El asiento no está aprobado: todavía puede cambiar o descartarse.',
            );
          }
          if (asiento.rows[0]!.total_debit !== esperado) {
            throw unprocessable(
              'IMPORTE_NO_COINCIDE',
              `El asiento es por ${asiento.rows[0]!.total_debit} y la amortización calculada ` +
                `del ejercicio es ${esperado}. Si el cálculo está mal, corregí la vida útil o ` +
                'las mejoras; si está bien, corregí el asiento.',
            );
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO fixed_asset_depreciations
               (company_id, fixed_asset_id, fiscal_year_id, entry_id, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              tenant.companyId, assetId, body.ejercicioId, body.entryId,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'AMORTIZAR_EJERCICIO',
            objectType: 'fixed_assets',
            objectId: assetId,
            newValue: {
              ejercicioId: body.ejercicioId,
              entryId: body.entryId,
              importe: esperado,
            },
            motivo: 'Se vincula el asiento que amortiza el ejercicio',
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
        throw conflictoTipado(
          'EJERCICIO_YA_AMORTIZADO',
          'Ese ejercicio ya tiene su amortización asentada para este bien. Dos asientos ' +
            'duplicarían el cargo, y el error no se ve hasta el estado de resultados.',
        );
      }
      throw error;
    }
  });
}

const ALCANCE =
  'El valor de libros descuenta solo lo asentado. Una amortización calculada y no ' +
  'registrada no baja el valor del bien: el balance dice lo que dice el Diario.';

const POR_CODIGO: ReadonlyArray<readonly [string, string, string]> = [
  [
    'E_BIEN_CUENTA_ACTIVO',
    'CUENTA_DEL_BIEN_INVALIDA',
    'La cuenta del bien tiene que ser de ACTIVO e imputable.',
  ],
  [
    'E_BIEN_CUENTA_ACUMULADA',
    'CUENTA_ACUMULADA_INVALIDA',
    'La amortización acumulada es regularizadora del activo: va en una cuenta de ACTIVO ' +
      'imputable, no en PASIVO.',
  ],
  [
    'E_BIEN_CUENTA_GASTO',
    'CUENTA_DE_GASTO_INVALIDA',
    'La amortización del ejercicio va a una cuenta de GASTO o COSTO imputable.',
  ],
  [
    'E_BIEN_CUENTAS_IGUALES',
    'CUENTAS_IGUALES',
    'El bien y su amortización acumulada no pueden compartir cuenta: el activo quedaría neto ' +
      'y se perdería el costo de origen.',
  ],
];

function traducirActivo(error: unknown, codigo: string): unknown {
  const fallo = error as { code?: string; message?: string; constraint?: string };
  const mensaje = fallo.message ?? '';
  for (const [interno, publico, texto] of POR_CODIGO) {
    if (mensaje.includes(interno)) return unprocessable(publico, texto);
  }
  if (fallo.code === '23505') {
    return conflictoTipado('BIEN_DUPLICADO', `Ya existe un bien con el código ${codigo}`);
  }
  if (fallo.constraint === 'fa_residual_menor_al_costo') {
    return unprocessable(
      'RESIDUAL_INVALIDO',
      'El valor residual tiene que ser menor que el costo: si fueran iguales no habría nada ' +
        'que amortizar.',
    );
  }
  return error;
}
