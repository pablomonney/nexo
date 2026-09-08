/**
 * Alertas: lo que cruzó su umbral, desde cuándo, y quién lo miró.
 *
 * ## Lo que estas rutas cierran
 *
 * `alerts`, `alert:read` y `alert:acknowledge` existen desde la 0028 y **nunca
 * los usó nadie**: la tabla estaba registrada como deuda por no tener escritor y
 * los dos permisos no gobernaban ninguna ruta. Estaban construidos y
 * desconectados, que es el defecto que este repositorio ya encontró en las
 * funciones, en las tablas, en los permisos y en las pantallas.
 *
 * ## Por qué hace falta la tabla si ya existen las señales
 *
 * `GET /analysis/signals` contesta **qué es cierto ahora**. Lo que no puede
 * contestar es desde cuándo: una señal que cruzó el umbral hoy y otra que lo
 * cruzó hace tres semanas se ven idénticas, y la segunda es un problema que
 * nadie miró.
 *
 * Y no tiene dónde anotar que alguien la vio y decidió que no importaba. Ese
 * juicio —con nombre, fecha y motivo— es lo que separa un tablero de un sistema
 * de trabajo.
 *
 * ## Reconocer no es resolver
 *
 * Reconocer dice «la vi, sé que está y la dejo abierta a propósito». Resolver lo
 * hace el detector solo, cuando la señal deja de cruzar el umbral. Descartar
 * dice «esto no es un problema» y exige motivo, porque es la acción que hace que
 * algo detectado deje de verse.
 *
 * Ninguna de las tres borra la alerta. Cuánto duró un problema es información
 * que no está en ningún otro lado.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit, withCompany } from '@aai/db';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound } from '../http/errors.js';
import { detectar } from '../analisis/detector.js';

export async function alertaRoutes(app: FastifyInstance): Promise<void> {
  /** Las alertas de la empresa, abiertas primero y por gravedad. */
  app.get('/analysis/alerts', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'alert:read');
    const auth = requireAuth(request);

    const query = z
      .object({ estado: z.enum(['ABIERTA', 'RECONOCIDA', 'RESUELTA', 'DESCARTADA']).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT id, kind AS tipo, severity AS gravedad, status AS estado,
                  sujeto, valor::text, unidad, umbral::text, referencia::text,
                  metodologia,
                  detectada_el AS "detectadaEl", vista_el AS "vistaEl",
                  resuelta_el AS "resueltaEl",
                  acknowledged_by AS "reconocidaPor", acknowledged_at AS "reconocidaEl",
                  ack_reason AS "motivo"
             FROM alerts
            WHERE ($1::text IS NULL OR status = $1)
            ORDER BY (status = 'ABIERTA') DESC,
                     CASE severity WHEN 'CRITICA' THEN 0 WHEN 'ALTA' THEN 1
                                   WHEN 'MEDIA' THEN 2 ELSE 3 END,
                     detectada_el DESC
            LIMIT 300`,
          [query.estado ?? null],
        );

        return {
          alertas: r.rows,
          alcance:
            'Cada alerta trae en `metodologia` la cuenta exacta para rehacerla a mano: una ' +
            'alerta sin eso es una afirmación sin evidencia, y eso entrena a ignorarlas. ' +
            '`detectadaEl` es cuándo cruzó el umbral por primera vez y `vistaEl` la última ' +
            'vez que el detector la volvió a encontrar — la distancia entre las dos es ' +
            'cuánto lleva el problema.',
        };
      },
    );
  });

  /**
   * Corre la detección para esta empresa.
   *
   * Es idempotente por diseño: si el problema sigue, la alerta es la misma y se
   * le actualiza el valor. Correrlo dos veces seguidas no abre nada nuevo.
   *
   * Pide `alert:acknowledge` y no `alert:read`, aunque para el usuario se sienta
   * una lectura: **escribe filas y escribe en la bitácora**. Lo encontró S-18,
   * que le pega a cada ruta de escritura con un usuario de solo lectura y exige
   * un 403 — con `alert:read` alcanzaba, y SOLO_LECTURA lo tiene.
   */
  app.post('/analysis/alerts/detectar', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'alert:acknowledge');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const informe = await detectar(tx, tenant.companyId, `user:${auth.user.userId}`);

        return {
          ...informe,
          alcance:
            informe.sinUmbral > 0
              ? `${informe.sinUmbral} señal(es) no se pudieron juzgar porque esta empresa no ` +
                'declaró contra qué compararlas. Eso no es «no superan el umbral»: es que no ' +
                'hay umbral, y abrir una alerta ahí sería inventar la política. Se declaran ' +
                'en Análisis → Umbrales.'
              : 'Todas las señales tenían umbral declarado contra el cual juzgarlas.',
        };
      },
    );
  });

  /** Reconocer: «la vi, sé que está». No la cierra. */
  app.post('/analysis/alerts/:id/reconocer', async (request) => {
    return cambiarEstado(request, 'RECONOCIDA', 'RECONOCER_ALERTA');
  });

  /** Descartar: «esto no es un problema». Exige motivo. */
  app.post('/analysis/alerts/:id/descartar', async (request) => {
    return cambiarEstado(request, 'DESCARTADA', 'DESCARTAR_ALERTA');
  });

  /**
   * Las dos transiciones que hace una persona, en un solo lugar.
   *
   * Comparten todo salvo el estado y la acción de bitácora; separarlas en dos
   * copias haría que la próxima corrección se aplicara a una sola.
   */
  async function cambiarEstado(
    request: FastifyRequest,
    estado: 'RECONOCIDA' | 'DESCARTADA',
    accion: 'RECONOCER_ALERTA' | 'DESCARTAR_ALERTA',
  ): Promise<{ id: string; estado: string }> {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'alert:acknowledge');
    const auth = requireAuth(request);

    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(5).max(1000) }).parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const previa = await tx.query<{ status: string }>(
          'SELECT status FROM alerts WHERE id = $1',
          [id],
        );
        const a = previa.rows[0];
        // RLS ya dejó afuera las de otra empresa.
        if (a === undefined) throw notFound('No existe esa alerta.');
        if (a.status === 'RESUELTA') {
          throw conflict(
            'La alerta ya está resuelta: la señal dejó de cruzar el umbral. Reconocer o ' +
              'descartar algo que ya no pasa no aporta nada, y dejaría el historial diciendo ' +
              'que alguien la revisó después de que se arreglara sola.',
          );
        }

        await tx.query(
          `UPDATE alerts
              SET status = $2, acknowledged_by = $3, acknowledged_at = now(), ack_reason = $4
            WHERE id = $1`,
          [id, estado, `user:${auth.user.userId}`, body.motivo],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: accion,
          objectType: 'alert',
          objectId: id,
          motivo: body.motivo,
          oldValue: { estado: a.status },
          newValue: { estado },
          ip: clientIp(request),
        });

        return { id, estado };
      },
    );
  }
}
