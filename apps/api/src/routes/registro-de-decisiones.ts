/**
 * El registro de decisiones: qué se decidió, por qué, y qué pasó después.
 *
 * No se confunde con `routes/decisions.ts`, que registra la decisión contable
 * sobre **un comprobante** —cómo se imputa esta factura—. Esto es la decisión de
 * negocio: subir el precio, cambiar de proveedor, cortar un gasto.
 *
 * ## Lo que estas rutas se niegan a hacer
 *
 *   · Registrar una decisión **sin evidencia**. Una decisión sin evidencia es
 *     una opinión, y una opinión guardada como decisión contamina para siempre
 *     cualquier medición de aciertos.
 *   · Registrar **una sola alternativa**. Eso no es haber decidido, es haber
 *     ejecutado. Se exigen al menos dos.
 *   · Dejar que **la misma persona proponga y apruebe** una decisión de riesgo
 *     alto o crítico. Es la misma separación de funciones que la reapertura de
 *     período, y la impone un `CHECK` además de esta ruta.
 *   · Contar como fracaso lo que **no se pudo atribuir**. Es un veredicto
 *     propio y queda afuera del porcentaje de aciertos.
 *
 * ## Por qué se guarda qué recomendó el sistema
 *
 * Porque sin eso nunca se puede contestar si conviene escucharlo. Guardar solo
 * «qué se hizo» deja el sistema sin forma de saber si sus recomendaciones
 * sirven. La contrapartida es que queda escrito, con nombre y fecha, cada vez
 * que alguien fue en contra — y por eso el motivo es obligatorio cuando difiere:
 * lo que se registra no es la desobediencia, es el argumento.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit, withCompany } from '@aai/db';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';

/** Una cita: de dónde salió el dato que sostiene la decisión. */
const cita = z.object({
  tipo: z.enum(['SENAL', 'ESCENARIO', 'COMPROBANTE', 'INFORME', 'EXTERNO', 'OTRO']),
  referencia: z.string().min(1).max(200),
  resumen: z.string().min(3).max(500),
});

const alternativa = z.object({
  nombre: z.string().min(1).max(120),
  escenarioId: z.string().uuid().optional(),
  descripcion: z.string().min(3).max(1000),
});

export async function registroDeDecisionesRoutes(app: FastifyInstance): Promise<void> {
  /** El registro de la empresa, con su calibración. */
  app.get('/decision-records', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:read');
    const auth = requireAuth(request);

    const query = z
      .object({ estado: z.enum(['PROPUESTA', 'APROBADA', 'EJECUTADA', 'DESCARTADA']).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const decisiones = await tx.query(
          `SELECT d.id, d.titulo, d.problema, d.evidencia, d.alternativas,
                  d.nivel_de_riesgo AS "nivelDeRiesgo", d.estado,
                  d.propuesta_por AS "propuestaPor", d.propuesta_el AS "propuestaEl",
                  d.motivo, d.aprobada_por AS "aprobadaPor", d.aprobada_el AS "aprobadaEl",
                  d.ejecutada_el::text AS "ejecutadaEl",
                  d.descartada_motivo AS "descartadaMotivo",
                  d.recomendada_id AS "recomendadaId", d.elegida_id AS "elegidaId",
                  d.elegida_texto AS "elegidaTexto",
                  sr.nombre AS "recomendadaNombre", se.nombre AS "elegidaNombre",
                  (SELECT count(*)::int FROM decision_reviews r WHERE r.decision_id = d.id)
                    AS revisiones
             FROM decision_records d
             LEFT JOIN analysis_scenarios sr ON sr.id = d.recomendada_id
             LEFT JOIN analysis_scenarios se ON se.id = d.elegida_id
            WHERE ($1::text IS NULL OR d.estado = $1)
            ORDER BY d.propuesta_el DESC
            LIMIT 200`,
          [query.estado ?? null],
        );

        const calibracion = await tx.query(
          `SELECT revisadas::text, cumplieron::text, no_cumplieron::text AS "noCumplieron",
                  no_medibles::text AS "noMedibles",
                  ejecutadas_sin_revisar::text AS "ejecutadasSinRevisar",
                  aciertos_pct::text AS "aciertosPct",
                  siguieron_recomendacion::text AS "siguieronRecomendacion",
                  fueron_en_contra::text AS "fueronEnContra"
             FROM decision_calibracion`,
        );

        return {
          decisiones: decisiones.rows,
          calibracion: calibracion.rows[0] ?? null,
          alcance:
            'El porcentaje de aciertos sale de revisiones que escribió una persona: no hay ' +
            'ningún modelo que se ajuste solo. Las decisiones cuyo resultado no se pudo ' +
            'atribuir quedan afuera del porcentaje, no cuentan como error. Y si todavía no ' +
            'hay ninguna revisión medible, el porcentaje es null y no cero.',
        };
      },
    );
  });

  /** Una decisión con su historia completa. */
  app.get('/decision-records/:id', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:read');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const d = await tx.query(
          `SELECT d.*, sr.nombre AS recomendada_nombre, se.nombre AS elegida_nombre
             FROM decision_records d
             LEFT JOIN analysis_scenarios sr ON sr.id = d.recomendada_id
             LEFT JOIN analysis_scenarios se ON se.id = d.elegida_id
            WHERE d.id = $1`,
          [id],
        );
        // RLS ya dejó afuera las de otra empresa: esto es un 404 y no un 403,
        // porque contestar «existe y no es tuya» confirmaría su existencia.
        if (d.rows[0] === undefined) throw notFound('No existe esa decisión.');

        const revisiones = await tx.query(
          `SELECT id, ventana_desde::text AS "ventanaDesde",
                  ventana_hasta::text AS "ventanaHasta", veredicto, medicion,
                  comentario, revisado_por AS "revisadoPor", revisado_el AS "revisadoEl"
             FROM decision_reviews WHERE decision_id = $1 ORDER BY ventana_hasta DESC`,
          [id],
        );

        return { decision: d.rows[0], revisiones: revisiones.rows };
      },
    );
  });

  /** Registra una decisión. Nace PROPUESTA: registrarla no la aprueba. */
  app.post('/decision-records', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        titulo: z.string().min(5).max(200),
        problema: z.string().min(20).max(4000),
        evidencia: z.array(cita).min(1, 'Una decisión sin evidencia es una opinión'),
        alternativas: z
          .array(alternativa)
          .min(2, 'Con una sola alternativa no se decidió: se ejecutó'),
        nivelDeRiesgo: z.enum(['BAJO', 'MEDIO', 'ALTO', 'CRITICO']),
        recomendadaId: z.string().uuid().nullish(),
        elegidaId: z.string().uuid().nullish(),
        elegidaTexto: z.string().min(1).max(500).nullish(),
        motivo: z.string().min(10).max(2000).nullish(),
      })
      .parse(request.body);

    // El desvío de la recomendación exige argumento. Se comprueba acá para
    // poder decir cuál es el problema; el `CHECK` de la 0101 lo impide igual por
    // si alguien escribe la fila por otro camino.
    if (
      body.recomendadaId != null &&
      body.elegidaId != null &&
      body.recomendadaId !== body.elegidaId &&
      (body.motivo ?? '').trim().length < 10
    ) {
      throw badRequest(
        'Elegiste una alternativa distinta de la recomendada, lo cual es legítimo, pero el ' +
          'motivo es obligatorio: lo que se registra no es la decisión de ir en contra, es ' +
          'el argumento.',
      );
    }

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO decision_records
             (company_id, titulo, problema, evidencia, alternativas, nivel_de_riesgo,
              recomendada_id, elegida_id, elegida_texto, motivo, propuesta_por)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            tenant.companyId,
            body.titulo,
            body.problema,
            JSON.stringify(body.evidencia),
            JSON.stringify(body.alternativas),
            body.nivelDeRiesgo,
            body.recomendadaId ?? null,
            body.elegidaId ?? null,
            body.elegidaTexto ?? null,
            body.motivo ?? null,
            `user:${auth.user.userId}`,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'REGISTRAR_DECISION',
          objectType: 'decision_record',
          objectId: r.rows[0]!.id,
          newValue: {
            titulo: body.titulo,
            nivelDeRiesgo: body.nivelDeRiesgo,
            alternativas: body.alternativas.length,
            fueEnContraDeLaRecomendacion:
              body.recomendadaId != null &&
              body.elegidaId != null &&
              body.recomendadaId !== body.elegidaId,
          },
          ip: clientIp(request),
        });

        reply.code(201);
        return {
          id: r.rows[0]!.id,
          estado: 'PROPUESTA',
          alcance:
            'Queda PROPUESTA: registrarla no la aprueba. Una decisión de riesgo alto o ' +
            'crítico la tiene que aprobar otra persona.',
        };
      },
    );
  });

  /** Aprueba una decisión propuesta. */
  app.post('/decision-records/:id/aprobar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:approve');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const previa = await tx.query<{
          estado: string;
          propuesta_por: string;
          nivel_de_riesgo: string;
        }>('SELECT estado, propuesta_por, nivel_de_riesgo FROM decision_records WHERE id = $1', [id]);
        const d = previa.rows[0];
        if (d === undefined) throw notFound('No existe esa decisión.');
        if (d.estado !== 'PROPUESTA') {
          throw conflict(`La decisión está ${d.estado}: solo se aprueba lo propuesto.`);
        }

        const actor = `user:${auth.user.userId}`;
        if (['ALTO', 'CRITICO'].includes(d.nivel_de_riesgo) && d.propuesta_por === actor) {
          throw conflict(
            'Una decisión de riesgo alto o crítico la tiene que aprobar alguien distinto de ' +
              'quien la propuso. Es la misma separación de funciones que la reapertura de un ' +
              'período, y por el mismo motivo: una sola persona no debería poder llevar un ' +
              'acto grave de punta a punta.',
          );
        }

        await tx.query(
          `UPDATE decision_records
              SET estado = 'APROBADA', aprobada_por = $2, aprobada_el = now(), updated_at = now()
            WHERE id = $1`,
          [id, actor],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: actor,
          action: 'APROBAR_DECISION',
          objectType: 'decision_record',
          objectId: id,
          oldValue: { estado: d.estado },
          newValue: { estado: 'APROBADA' },
          ip: clientIp(request),
        });

        return { id, estado: 'APROBADA' };
      },
    );
  });

  /** Declara que la decisión se ejecutó, y desde cuándo. */
  app.post('/decision-records/:id/ejecutar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:approve');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Fecha ISO (AAAA-MM-DD)') })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const previa = await tx.query<{
          estado: string;
          elegida_id: string | null;
          elegida_texto: string | null;
        }>('SELECT estado, elegida_id, elegida_texto FROM decision_records WHERE id = $1', [id]);
        const d = previa.rows[0];
        if (d === undefined) throw notFound('No existe esa decisión.');
        if (d.estado !== 'APROBADA') {
          throw conflict(
            `La decisión está ${d.estado}. Se ejecuta lo aprobado: sin la aprobación, la ` +
              'ejecución no tiene quién la respalde.',
          );
        }

        // Sin alternativa elegida no hay qué ejecutar. El `CHECK` de la 0101 lo
        // impide igual, pero un `CHECK` violado contesta 500 y «viola una
        // restricción», que es cierto y no le dice a nadie qué hacer. Lo
        // encontró el test del ciclo completo.
        if (d.elegida_id === null && (d.elegida_texto ?? '').trim() === '') {
          throw badRequest(
            'La decisión no dice qué alternativa se eligió. Ejecutar sin eso dejaría un acto ' +
              'sin contenido: dentro de seis meses el registro diría que se decidió algo y no ' +
              'cuál de las opciones.',
          );
        }

        await tx.query(
          `UPDATE decision_records
              SET estado = 'EJECUTADA', ejecutada_el = $2::date, updated_at = now()
            WHERE id = $1`,
          [id, body.desde],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'EJECUTAR_DECISION',
          objectType: 'decision_record',
          objectId: id,
          oldValue: { estado: 'APROBADA' },
          newValue: { estado: 'EJECUTADA', desde: body.desde },
          ip: clientIp(request),
        });

        return {
          id,
          estado: 'EJECUTADA',
          alcance:
            'Desde acá corre el reloj de la revisión. Lo que se mida después no prueba que ' +
            'la decisión haya causado el resultado: dice qué se esperaba, qué pasó y cuánto ' +
            'se separaron.',
        };
      },
    );
  });

  /** Descarta una decisión propuesta, con motivo. */
  app.post('/decision-records/:id/descartar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:write');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(5).max(1000) }).parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const previa = await tx.query<{ estado: string }>(
          'SELECT estado FROM decision_records WHERE id = $1',
          [id],
        );
        const d = previa.rows[0];
        if (d === undefined) throw notFound('No existe esa decisión.');
        if (d.estado === 'EJECUTADA') {
          throw conflict('Una decisión ejecutada no se descarta: se revisa y se decide otra.');
        }

        await tx.query(
          `UPDATE decision_records
              SET estado = 'DESCARTADA', descartada_motivo = $2, updated_at = now()
            WHERE id = $1`,
          [id, body.motivo],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'DESCARTAR_DECISION',
          objectType: 'decision_record',
          objectId: id,
          motivo: body.motivo,
          oldValue: { estado: d.estado },
          newValue: { estado: 'DESCARTADA' },
          ip: clientIp(request),
        });

        return { id, estado: 'DESCARTADA' };
      },
    );
  });

  /**
   * Registra la revisión posterior.
   *
   * `medicion` la manda quien revisa, y es lo que vio: se congela tal cual. La
   * medición cambia cuando entran comprobantes atrasados, y una revisión de
   * marzo tiene que seguir diciendo en diciembre lo que decía en marzo.
   */
  app.post('/decision-records/:id/revisar', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'decision:write');
    const auth = requireAuth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        ventanaDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        ventanaHasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        veredicto: z.enum(['SUPERO', 'CUMPLIO', 'NO_CUMPLIO', 'NO_ATRIBUIBLE', 'SIN_EVIDENCIA']),
        medicion: z.record(z.unknown()),
        comentario: z.string().min(15).max(2000),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const previa = await tx.query<{ estado: string }>(
          'SELECT estado FROM decision_records WHERE id = $1',
          [id],
        );
        const d = previa.rows[0];
        if (d === undefined) throw notFound('No existe esa decisión.');
        if (d.estado !== 'EJECUTADA') {
          throw conflict(
            `La decisión está ${d.estado}. Se revisa lo que se ejecutó: revisar una ` +
              'propuesta sería evaluar algo que no pasó.',
          );
        }

        const ya = await tx.query(
          'SELECT 1 FROM decision_reviews WHERE decision_id = $1 AND ventana_hasta = $2::date',
          [id, body.ventanaHasta],
        );
        if (ya.rowCount !== null && ya.rowCount > 0) {
          throw conflict(
            'Ya hay una revisión de esa ventana. Volver a revisarla cambiaría el porcentaje ' +
              'de aciertos sin que haya pasado nada nuevo; para revisar de nuevo, usá una ' +
              'ventana que llegue más lejos.',
          );
        }

        const r = await tx.query<{ id: string }>(
          `INSERT INTO decision_reviews
             (company_id, decision_id, ventana_desde, ventana_hasta, veredicto,
              medicion, comentario, revisado_por)
           VALUES ($1, $2, $3::date, $4::date, $5, $6::jsonb, $7, $8)
           RETURNING id`,
          [
            tenant.companyId,
            id,
            body.ventanaDesde,
            body.ventanaHasta,
            body.veredicto,
            JSON.stringify(body.medicion),
            body.comentario,
            `user:${auth.user.userId}`,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'REVISAR_DECISION',
          objectType: 'decision_record',
          objectId: id,
          newValue: { veredicto: body.veredicto, ventana: body.ventanaHasta },
          ip: clientIp(request),
        });

        reply.code(201);
        return {
          id: r.rows[0]!.id,
          veredicto: body.veredicto,
          alcance:
            body.veredicto === 'NO_ATRIBUIBLE' || body.veredicto === 'SIN_EVIDENCIA'
              ? 'Esta revisión queda afuera del porcentaje de aciertos, y no cuenta como ' +
                'error. Contarla como error empujaría a evitar las decisiones difíciles de ' +
                'medir, que suelen ser las que más importan.'
              : 'La medición quedó congelada tal como se informó: cuando entren comprobantes ' +
                'atrasados el cálculo de hoy va a dar otra cosa, y esta revisión tiene que ' +
                'seguir diciendo lo que decía.',
        };
      },
    );
  });
}
