/**
 * Proyectos: horas, tarifa declarada y la rentabilidad que se puede afirmar.
 *
 * ## Los ingresos y los costos no se cargan acá
 *
 * Salen del Mayor, por el centro de costo que el proyecto cita. Un módulo que
 * además guardara sus propios totales crearía una segunda contabilidad, y
 * cuando dos contabilidades no coinciden gana la que alguien tipeó.
 *
 * ## La hora vale lo que la empresa declaró
 *
 * El costo de una hora sale de la liquidación de sueldos, y RRHH está bloqueado
 * (ADR-012 §8). Inventar un costo horario sería inventar el sueldo de alguien.
 * Sin tarifa vigente para la fecha de la hora, esa hora se informa y el margen
 * queda en `null` — con las horas sin tarifa contadas aparte para que se vea
 * por qué. `null` no es cero: cero diría «no dejó nada».
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');
const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');
// Dos escalas distintas, y confundirlas fue un error real: **un parte** de
// horas no puede pasar de 24 —nadie trabaja más de un día en un día— pero **un
// presupuesto** de horas es la suma de muchos días y llega a los miles.
const horasDelParte = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'Horas del día, hasta 24');
const horasTotales = z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, 'Horas con hasta dos decimales');

export async function proyectoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:read');
    const auth = requireAuth(request);
    const query = z
      .object({ status: z.enum(['ABIERTO', 'CERRADO', 'CANCELADO']).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT project_id AS id, proyecto_codigo AS codigo, proyecto_nombre AS nombre,
                  cliente, party_id AS "terceroId",
                  centro_codigo AS "centroCodigo", cost_center_id AS "centroId",
                  status, fecha_inicio::text AS "fechaInicio",
                  fecha_fin_estimada::text AS "fechaFinEstimada",
                  presupuesto_horas::text AS "presupuestoHoras",
                  horas::text, partes,
                  horas_sin_tarifa::text AS "horasSinTarifa",
                  costo_horas::text AS "costoHoras",
                  avance_pct::text AS "avancePct",
                  ingresos::text, costos::text, margen::text
             FROM project_status
            WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)
            ORDER BY fecha_inicio DESC, proyecto_codigo`,
          [tenant.companyId, query.status ?? null],
        );

        return {
          proyectos: r.rows,
          alcance:
            'Los ingresos y los costos salen del **Mayor**, por el centro de costo que el ' +
            'proyecto cita: no se cargan acá. El margen es `null` cuando falta el centro ' +
            'de costo o hay horas sin tarifa declarada — es «no se puede afirmar», que no ' +
            'es lo mismo que cero.',
        };
      },
    );
  });

  app.get('/projects/:projectId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:read');
    const auth = requireAuth(request);
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const p = await tx.query(
          `SELECT project_id AS id, proyecto_codigo AS codigo, proyecto_nombre AS nombre,
                  cliente, centro_codigo AS "centroCodigo", status,
                  fecha_inicio::text AS "fechaInicio",
                  fecha_fin_estimada::text AS "fechaFinEstimada",
                  presupuesto_horas::text AS "presupuestoHoras",
                  horas::text, horas_sin_tarifa::text AS "horasSinTarifa",
                  costo_horas::text AS "costoHoras", avance_pct::text AS "avancePct",
                  ingresos::text, costos::text, margen::text,
                  cerrado_el::text AS "cerradoEl", motivo_cierre AS "motivoCierre"
             FROM project_status WHERE project_id = $1 AND company_id = $2`,
          [projectId, tenant.companyId],
        );
        if (p.rowCount === 0) throw notFound('Proyecto no encontrado');

        const tareas = await tx.query(
          `SELECT t.id, t.code AS codigo, t.name AS nombre, t.status,
                  t.estimado_horas::text AS "estimadoHoras",
                  coalesce(sum(e.horas), 0)::text AS horas
             FROM project_tasks t
             LEFT JOIN time_entries e ON e.task_id = t.id AND e.company_id = t.company_id
            WHERE t.project_id = $1 AND t.company_id = $2
            GROUP BY t.id, t.code, t.name, t.status, t.estimado_horas
            ORDER BY t.code`,
          [projectId, tenant.companyId],
        );

        const partes = await tx.query(
          `SELECT v.entry_id AS id, v.fecha::text, v.horas::text, v.persona,
                  v.tarifa::text, v.costo::text,
                  e.detalle, t.code AS "tareaCodigo"
             FROM project_time_valuation v
             JOIN time_entries e ON e.id = v.entry_id AND e.company_id = v.company_id
             LEFT JOIN project_tasks t ON t.id = v.task_id AND t.company_id = v.company_id
            WHERE v.project_id = $1 AND v.company_id = $2
            ORDER BY v.fecha DESC, e.created_at DESC
            LIMIT 200`,
          [projectId, tenant.companyId],
        );

        const tarifas = await tx.query(
          `SELECT id, tarifa::text, moneda, vigencia_desde::text AS "vigenciaDesde",
                  vigencia_hasta::text AS "vigenciaHasta"
             FROM project_hour_rates
            WHERE project_id = $1 AND company_id = $2
            ORDER BY vigencia_desde DESC`,
          [projectId, tenant.companyId],
        );

        return {
          proyecto: p.rows[0],
          tareas: tareas.rows,
          partes: partes.rows,
          tarifas: tarifas.rows,
          alcance:
            'Cada parte lleva la tarifa que regía **el día en que se trabajó**, no la de ' +
            'hoy. Un `costo` en `null` es una hora sin tarifa declarada para su fecha: ' +
            'costearla a cero diría que salió gratis.',
        };
      },
    );
  });

  app.post('/projects', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        terceroId: z.string().uuid().nullish(),
        // Por código, no por uuid: el cliente no elige una fila que podría no
        // ser suya, y el centro de costo se resuelve dentro de la empresa.
        centroDeCosto: z.string().min(1).max(40).nullish(),
        fechaInicio: fecha,
        fechaFinEstimada: fecha.nullish(),
        presupuestoHoras: horasTotales.nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          let centroId: string | null = null;
          if (body.centroDeCosto !== null && body.centroDeCosto !== undefined) {
            const c = await tx.query<{ id: string }>(
              'SELECT id FROM cost_centers WHERE company_id = $1 AND code = $2',
              [tenant.companyId, body.centroDeCosto],
            );
            if (c.rowCount === 0) {
              throw notFound(`No existe el centro de costo ${body.centroDeCosto}`);
            }
            centroId = c.rows[0]!.id;
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO projects
               (company_id, code, name, party_id, cost_center_id, fecha_inicio,
                fecha_fin_estimada, presupuesto_horas, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              tenant.companyId, body.codigo, body.nombre, body.terceroId ?? null,
              centroId, body.fechaInicio, body.fechaFinEstimada ?? null,
              body.presupuestoHoras ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CREAR_PROYECTO',
            objectType: 'projects',
            objectId: r.rows[0]!.id,
            newValue: { codigo: body.codigo, centroDeCosto: body.centroDeCosto ?? null },
            motivo:
              'Alta de proyecto. El centro de costo es lo que lo hace medible contra el Mayor.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirProyecto(error);
    }
  });

  app.post('/projects/:projectId/tasks', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:write');
    const auth = requireAuth(request);
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        codigo: z.string().min(1).max(40),
        nombre: z.string().min(1).max(200),
        estimadoHoras: horasTotales.nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO project_tasks
               (company_id, project_id, code, name, estimado_horas, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, projectId, body.codigo, body.nombre,
              body.estimadoHoras ?? null, `user:${auth.user.userId}`,
            ],
          );
          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirProyecto(error);
    }
  });

  app.post('/projects/:projectId/time-entries', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:write');
    const auth = requireAuth(request);
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        fecha,
        horas: horasDelParte,
        // Texto declarado: quien carga las horas del equipo no siempre es quien
        // las trabajó, y sin legajos —RRHH está bloqueado— inventar una
        // identidad de empleado sería inventar medio módulo que no existe.
        persona: z.string().min(2).max(120),
        detalle: z.string().min(3).max(500),
        tareaId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO time_entries
               (company_id, project_id, task_id, fecha, horas, persona, detalle, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              tenant.companyId, projectId, body.tareaId ?? null, body.fecha, body.horas,
              body.persona, body.detalle, `user:${auth.user.userId}`,
            ],
          );
          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirProyecto(error);
    }
  });

  /** Declarar la tarifa horaria con su vigencia. */
  app.post('/projects/:projectId/rates', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:write');
    const auth = requireAuth(request);
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        tarifa: monto,
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
        moneda: z.string().length(3).default('ARS'),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO project_hour_rates
               (company_id, project_id, tarifa, moneda, vigencia_desde, vigencia_hasta,
                created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              tenant.companyId, projectId, body.tarifa, body.moneda,
              body.vigenciaDesde, body.vigenciaHasta ?? null, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_TARIFA_HORARIA',
            objectType: 'projects',
            objectId: projectId,
            newValue: body,
            motivo:
              'Se declara cuánto cuesta la hora de este proyecto. Sin esto el margen no ' +
              'se afirma: el costo real sale de la liquidación de sueldos, que no existe.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirProyecto(error);
    }
  });

  /** Cerrar o cancelar. En los dos casos con motivo, y sin volver atrás. */
  app.post('/projects/:projectId/close', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:write');
    const auth = requireAuth(request);
    const { projectId } = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        status: z.enum(['CERRADO', 'CANCELADO']).default('CERRADO'),
        fecha,
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ status: string; margen: string | null }>(
            'SELECT status, margen::text FROM project_status WHERE project_id = $1 AND company_id = $2',
            [projectId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Proyecto no encontrado');
          if (antes.rows[0]!.status !== 'ABIERTO') {
            throw conflict('El proyecto ya está cerrado: no se reabre ni se cierra dos veces.');
          }

          await tx.query(
            `UPDATE projects
                SET status = $3, cerrado_el = $4, motivo_cierre = $5, updated_at = now()
              WHERE id = $1 AND company_id = $2`,
            [projectId, tenant.companyId, body.status, body.fecha, body.motivo],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CERRAR_PROYECTO',
            objectType: 'projects',
            objectId: projectId,
            oldValue: { status: 'ABIERTO' },
            newValue: { status: body.status, margen: antes.rows[0]!.margen },
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            projectId,
            status: body.status,
            margenAlCerrar: antes.rows[0]!.margen,
            alcance:
              'Desde acá el proyecto no recibe más horas: cambiarían el resultado contra ' +
              'el que se cerró. **No se generó ningún asiento** — el cierre de un proyecto ' +
              'es información de gestión, no un hecho contable.',
          };
        },
      );
    } catch (error) {
      throw traducirProyecto(error);
    }
  });

  /** Cuál de los trabajos deja plata. El aporte a la decisión (ADR-018). */
  app.get('/analysis/proyectos', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'project:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT proyecto_codigo AS "codigo", proyecto_nombre AS "nombre", cliente, status,
                  horas::text, costo_horas::text AS "costoHoras",
                  ingresos::text, costos::text, margen::text,
                  margen_pct::text AS "margenPct", metodologia
             FROM analytics_proyectos WHERE company_id = $1
            ORDER BY margen DESC NULLS LAST, proyecto_codigo`,
          [tenant.companyId],
        );

        const sinAfirmar = r.rows.filter((f) => (f as { margen: string | null }).margen === null);

        return {
          proyectos: r.rows,
          sinMargenAfirmable: sinAfirmar.length,
          alcance:
            'El margen sale de restarle a los ingresos del Mayor —por el centro de costo ' +
            'del proyecto— sus costos y las horas valuadas a la tarifa declarada vigente ' +
            'el día en que se trabajaron. Los proyectos con margen `null` no se ordenan ' +
            'al final por castigo: es que **todavía no se puede afirmar** cuánto dejaron, ' +
            'y cada uno dice en `metodologia` qué le falta.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirProyecto(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_PROY_CERRADO')) {
    return conflict(
      'El proyecto ya está cerrado: una hora nueva cambiaría el resultado contra el que se ' +
        'cerró, igual que un movimiento nuevo en una caja ya arqueada.',
    );
  }
  if (mensaje.includes('E_PROY_TAREA_AJENA')) {
    return unprocessable(
      'TAREA_DE_OTRO_PROYECTO',
      'Esa tarea pertenece a otro proyecto: las horas quedarían contadas donde no se ' +
        'trabajaron.',
    );
  }
  if (mensaje.includes('E_PROY_TARIFA_SUPERPUESTA')) {
    return conflict(
      'Ya hay una tarifa vigente para ese proyecto en esas fechas. Con dos, la hora se ' +
        'costearía por orden de carga, que es azar disfrazado de regla.',
    );
  }
  if (fallo.code === '23505' && mensaje.includes('pj_code_unico')) {
    return conflict('Ya existe un proyecto con ese código en esta empresa');
  }
  if (fallo.code === '23505' && mensaje.includes('pjt_code_unico')) {
    return conflict('Ese proyecto ya tiene una tarea con ese código');
  }
  if (fallo.code === '23503') {
    return notFound('El proyecto, la tarea, el tercero o el centro de costo no existen en esta empresa');
  }
  return error;
}
