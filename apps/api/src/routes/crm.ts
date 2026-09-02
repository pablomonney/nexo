/**
 * CRM: oportunidades, embudo y el paso al presupuesto.
 *
 * ## El embudo lo declara la empresa
 *
 * No hay etapas por defecto. Un embudo es cómo vende una empresa, y sembrar
 * «Contacto → Demo → Negociación» haría que todos los tableros hablaran de una
 * realidad que nadie acordó. Sin etapas declaradas el módulo no arranca, y eso
 * es correcto: primero se dice cómo se vende.
 *
 * ## La probabilidad también, y sin ella no hay ponderado
 *
 * Un embudo ponderado con probabilidades inventadas produce un número que
 * parece plata y no lo es. Si la etapa no declaró probabilidad, el valor
 * ponderado viene en `null` y el motivo va escrito al lado. Es la misma
 * disciplina que los umbrales de análisis.
 *
 * ## La etapa no se manda: se registra el paso
 *
 * No hay `PATCH /opportunities/:id/etapa`. Se registra la transición y la etapa
 * actual sale de la última — igual que el estado de un cheque. Perder exige
 * decir por qué; una oportunidad cerrada no se reabre.
 *
 * ## Y el embudo no entra al flujo de fondos
 *
 * Una oportunidad no es un crédito. Sumar el pipeline a la proyección de caja
 * metería plata que nadie debe todavía en el número con el que se decide si se
 * paga un sueldo.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');

export async function crmRoutes(app: FastifyInstance): Promise<void> {
  // ── Las etapas ──────────────────────────────────────────────────────────
  app.get('/crm/stages', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT id, code AS codigo, name AS nombre, orden, tipo,
                  probabilidad::text, status
             FROM crm_stages WHERE company_id = $1 ORDER BY orden`,
          [tenant.companyId],
        );

        return {
          etapas: r.rows,
          alcance:
            'NEXO no trae un embudo por defecto: las etapas son cómo vende esta empresa. ' +
            'La probabilidad es opcional, y sin ella el embudo informa el importe estimado ' +
            'y **no pondera** — inventar un 60% da un número que parece plata y no lo es.',
        };
      },
    );
  });

  app.post('/crm/stages', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        orden: z.number().int().gt(0),
        tipo: z.enum(['ABIERTA', 'GANADA', 'PERDIDA']),
        probabilidad: z.number().min(0).max(100).nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO crm_stages (company_id, code, name, orden, tipo, probabilidad, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.orden, body.tipo,
              body.probabilidad ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_ETAPA_CRM',
            objectType: 'crm_stages',
            objectId: r.rows[0]!.id,
            newValue: body,
            motivo:
              'Se declara una etapa del embudo. La probabilidad, si viene, es lo que ' +
              'habilita el valor ponderado.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCrm(error);
    }
  });

  /** Declarar la probabilidad después, o archivar la etapa. */
  app.put('/crm/stages/:stageId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:write');
    const auth = requireAuth(request);
    const { stageId } = z.object({ stageId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        nombre: z.string().min(1).max(200).optional(),
        probabilidad: z.number().min(0).max(100).nullable().optional(),
        status: z.enum(['ACTIVA', 'ARCHIVADA']).optional(),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query(
          'SELECT * FROM crm_stages WHERE id = $1 AND company_id = $2',
          [stageId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Etapa no encontrada');

        await tx.query(
          `UPDATE crm_stages
              SET name = coalesce($3, name),
                  probabilidad = CASE WHEN $5::boolean THEN $4::numeric ELSE probabilidad END,
                  status = coalesce($6, status)
            WHERE id = $1 AND company_id = $2`,
          [
            stageId, tenant.companyId,
            body.nombre ?? null,
            body.probabilidad ?? null,
            // `probabilidad: null` es una declaración —«dejo de afirmarla»— y
            // no lo mismo que no mandar el campo.
            Object.prototype.hasOwnProperty.call(body, 'probabilidad'),
            body.status ?? null,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'ACTUALIZAR_ETAPA_CRM',
          objectType: 'crm_stages',
          objectId: stageId,
          oldValue: antes.rows[0],
          newValue: body,
          motivo: 'Cambia cómo se describe el embudo y si se pondera',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return { id: stageId };
      },
    );
  });

  // ── Las oportunidades ───────────────────────────────────────────────────
  app.get('/crm/opportunities', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        estado: z.enum(['ABIERTA', 'GANADA', 'PERDIDA']).optional(),
        etapa: z.string().max(40).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT opportunity_id AS id, titulo, quien, party_id AS "terceroId",
                  prospecto, importe_estimado::text AS "importeEstimado", moneda,
                  fecha_estimada_cierre::text AS "fechaEstimadaCierre",
                  etapa_codigo AS "etapaCodigo", etapa_nombre AS "etapaNombre",
                  estado, probabilidad::text,
                  valor_ponderado::text AS "valorPonderado",
                  dias_en_etapa AS "diasEnEtapa",
                  ultima_actividad::text AS "ultimaActividad",
                  dias_sin_actividad AS "diasSinActividad",
                  dias_sin_movimiento AS "diasSinMovimiento",
                  actividades,
                  commercial_document_id AS "presupuestoId",
                  motivo_cierre AS "motivoCierre"
             FROM crm_opportunity_status
            WHERE company_id = $1
              AND ($2::text IS NULL OR estado = $2)
              AND ($3::text IS NULL OR etapa_codigo = $3)
            ORDER BY created_at DESC
            LIMIT $4`,
          [tenant.companyId, query.estado ?? null, query.etapa ?? null, query.limite],
        );

        return {
          oportunidades: r.rows,
          alcance:
            'La etapa sale de la última transición del libro, no de una columna. ' +
            '`valorPonderado` en `null` significa que la etapa no declaró probabilidad: ' +
            'es «no se puede afirmar», que no es lo mismo que cero. ' +
            '`diasSinActividad` cuenta contactos registrados y es `null` cuando no hubo ' +
            'ninguno; `diasSinMovimiento` cuenta también los cambios de etapa, porque ' +
            'mover una oportunidad es actividad tanto como llamar.',
        };
      },
    );
  });

  app.get('/crm/opportunities/:opportunityId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:read');
    const auth = requireAuth(request);
    const { opportunityId } = z
      .object({ opportunityId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const o = await tx.query(
          `SELECT opportunity_id AS id, titulo, quien, party_id AS "terceroId", prospecto,
                  importe_estimado::text AS "importeEstimado", moneda,
                  fecha_estimada_cierre::text AS "fechaEstimadaCierre",
                  etapa_codigo AS "etapaCodigo", estado, probabilidad::text,
                  valor_ponderado::text AS "valorPonderado",
                  dias_en_etapa AS "diasEnEtapa",
                  commercial_document_id AS "presupuestoId",
                  motivo_cierre AS "motivoCierre"
             FROM crm_opportunity_status
            WHERE opportunity_id = $1 AND company_id = $2`,
          [opportunityId, tenant.companyId],
        );
        if (o.rowCount === 0) throw notFound('Oportunidad no encontrada');

        const transiciones = await tx.query(
          `SELECT t.fecha::text, s.code AS "etapaCodigo", s.name AS "etapaNombre",
                  s.tipo, t.motivo, t.created_by AS "registradoPor"
             FROM crm_stage_transitions t
             JOIN crm_stages s ON s.id = t.stage_id AND s.company_id = t.company_id
            WHERE t.opportunity_id = $1 AND t.company_id = $2
            ORDER BY t.created_at`,
          [opportunityId, tenant.companyId],
        );

        const actividades = await tx.query(
          `SELECT id, tipo, fecha::text, detalle, created_by AS "registradoPor"
             FROM crm_activities
            WHERE opportunity_id = $1 AND company_id = $2
            ORDER BY fecha DESC, created_at DESC`,
          [opportunityId, tenant.companyId],
        );

        return {
          oportunidad: o.rows[0],
          transiciones: transiciones.rows,
          actividades: actividades.rows,
        };
      },
    );
  });

  app.post('/crm/opportunities', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        titulo: z.string().min(3).max(200),
        // Uno de los dos. Un prospecto todavía no es un tercero, y llenar el
        // maestro de gente que nunca compró lo vuelve inservible para facturar.
        terceroId: z.string().uuid().nullish(),
        prospecto: z.string().min(3).max(200).nullish(),
        etapaId: z.string().uuid(),
        importeEstimado: monto.nullish(),
        fechaEstimadaCierre: fecha.nullish(),
        fecha,
      })
      .refine(
        (b) => (b.terceroId ?? null) !== null || (b.prospecto ?? null) !== null,
        { message: 'Nombrá al tercero o al prospecto: una oportunidad es de alguien' },
      )
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO crm_opportunities
               (company_id, titulo, party_id, prospecto, importe_estimado,
                fecha_estimada_cierre, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, body.titulo, body.terceroId ?? null, body.prospecto ?? null,
              body.importeEstimado ?? null, body.fechaEstimadaCierre ?? null,
              `user:${auth.user.userId}`,
            ],
          );
          const id = r.rows[0]!.id;

          // La etapa inicial es una transición como cualquier otra: si no se
          // escribiera, la oportunidad no tendría etapa y el embudo la perdería.
          await tx.query(
            `INSERT INTO crm_stage_transitions
               (company_id, opportunity_id, stage_id, fecha, created_by)
             VALUES ($1,$2,$3,$4,$5)`,
            [tenant.companyId, id, body.etapaId, body.fecha, `user:${auth.user.userId}`],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_OPORTUNIDAD',
            objectType: 'crm_opportunities',
            objectId: id,
            newValue: { titulo: body.titulo, etapaId: body.etapaId },
            motivo: 'Alta de oportunidad con su etapa inicial',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCrm(error);
    }
  });

  /** Mover de etapa: se registra el paso, no se fija el estado. */
  app.post('/crm/opportunities/:opportunityId/transiciones', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:write');
    const auth = requireAuth(request);
    const { opportunityId } = z
      .object({ opportunityId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({ etapaId: z.string().uuid(), fecha, motivo: z.string().max(500).nullish() })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO crm_stage_transitions
               (company_id, opportunity_id, stage_id, fecha, motivo, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, opportunityId, body.etapaId, body.fecha,
              body.motivo ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'MOVER_OPORTUNIDAD',
            objectType: 'crm_opportunities',
            objectId: opportunityId,
            newValue: { etapaId: body.etapaId, fecha: body.fecha },
            motivo: body.motivo ?? 'Cambio de etapa registrado en el libro',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCrm(error);
    }
  });

  app.post('/crm/opportunities/:opportunityId/activities', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:write');
    const auth = requireAuth(request);
    const { opportunityId } = z
      .object({ opportunityId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        tipo: z.enum(['LLAMADA', 'REUNION', 'EMAIL', 'VISITA', 'OTRA']),
        fecha,
        detalle: z.string().min(3).max(1000),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO crm_activities
               (company_id, opportunity_id, tipo, fecha, detalle, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, opportunityId, body.tipo, body.fecha, body.detalle,
              `user:${auth.user.userId}`,
            ],
          );
          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirCrm(error);
    }
  });

  /**
   * Citar el presupuesto que salió de la oportunidad.
   *
   * CRM no crea documentos comerciales: el presupuesto nace del circuito de
   * siempre, con su numeración y su máquina de estados. Acá solo se ata el
   * cabo, y mientras no esté atado la bandeja lo dice.
   */
  app.put('/crm/opportunities/:opportunityId/presupuesto', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:write');
    requirePermission(tenant, 'commercial:read');
    const auth = requireAuth(request);
    const { opportunityId } = z
      .object({ opportunityId: z.string().uuid() })
      .parse(request.params);
    const body = z.object({ presupuestoId: z.string().uuid() }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query(
            `UPDATE crm_opportunities
                SET commercial_document_id = $3, updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [opportunityId, tenant.companyId, body.presupuestoId],
          );
          if (r.rowCount === 0) throw notFound('Oportunidad no encontrada');

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'VINCULAR_PRESUPUESTO',
            objectType: 'crm_opportunities',
            objectId: opportunityId,
            newValue: { presupuestoId: body.presupuestoId },
            motivo: 'La oportunidad cita el presupuesto que salió de ella',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { opportunityId, presupuestoId: body.presupuestoId };
        },
      );
    } catch (error) {
      throw traducirCrm(error);
    }
  });

  /** El embudo: el aporte de este módulo a la capa de decisión (ADR-018). */
  app.get('/analysis/embudo', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'crm:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT etapa_codigo AS "etapaCodigo", etapa_nombre AS "etapaNombre",
                  orden, tipo, probabilidad::text, cantidad,
                  importe_estimado::text AS "importeEstimado",
                  valor_ponderado::text AS "valorPonderado",
                  metodologia
             FROM analytics_embudo WHERE company_id = $1 ORDER BY orden`,
          [tenant.companyId],
        );

        // El total ponderado se suma en la base y **solo sobre las etapas que
        // declararon probabilidad**. Las que no, se informan aparte: sumarlas
        // como cero diría que no valen nada, y lo que pasa es que no se sabe.
        const total = await tx.query<{ ponderado: string; sin_declarar: number }>(
          `SELECT coalesce(sum(valor_ponderado), 0)::text AS ponderado,
                  count(*) FILTER (WHERE probabilidad IS NULL AND cantidad > 0)::int
                    AS sin_declarar
             FROM analytics_embudo
            WHERE company_id = $1 AND tipo = 'ABIERTA'`,
          [tenant.companyId],
        );

        return {
          etapas: r.rows,
          ponderadoAbierto: total.rows[0]!.ponderado,
          etapasSinProbabilidad: total.rows[0]!.sin_declarar,
          alcance:
            '`ponderadoAbierto` suma **solo** las etapas abiertas que declararon ' +
            'probabilidad. Las que no la declararon se cuentan en ' +
            '`etapasSinProbabilidad` y quedan afuera del total: sumarlas como cero diría ' +
            'que no valen nada, y lo que pasa es que no se sabe cuánto valen. ' +
            'Este embudo **no entra al flujo de fondos**: una oportunidad no es un ' +
            'crédito, y sumarla metería plata que nadie debe todavía en la proyección ' +
            'con la que se decide si se paga un sueldo.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirCrm(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string; constraint?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_CRM_SIN_MOTIVO')) {
    return unprocessable(
      'PERDIDA_SIN_MOTIVO',
      'Perder una oportunidad exige decir por qué: es la única información que un embudo ' +
        'deja para la próxima vez.',
    );
  }
  if (mensaje.includes('E_CRM_CERRADA')) {
    return conflict(
      'La oportunidad ya está cerrada y no se reabre. Si volvió a haber conversación, es ' +
        'una oportunidad nueva — y así el embudo del mes que viene sigue siendo comparable.',
    );
  }
  if (fallo.code === '23505' && mensaje.includes('cst_orden_unico')) {
    return conflict('Ya hay una etapa en esa posición del embudo');
  }
  if (fallo.code === '23505' && mensaje.includes('cst_code_unico')) {
    return conflict('Ya existe una etapa con ese código en esta empresa');
  }
  if (fallo.code === '23514' && mensaje.includes('co_alguien')) {
    return unprocessable(
      'OPORTUNIDAD_SIN_NOMBRE',
      'Nombrá al tercero o al prospecto: una oportunidad es de alguien.',
    );
  }
  if (fallo.code === '23503') {
    return notFound('La etapa, el tercero, la oportunidad o el presupuesto no existen en esta empresa');
  }
  return error;
}
