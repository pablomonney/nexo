/**
 * Integration Hub: la puerta por la que entra lo de afuera (§41–§46).
 *
 * ## La regla que gobierna el módulo
 *
 * **Un conector nunca escribe en el motor contable.** Deposita en
 * `external_records` y ahí se queda hasta que una persona lo resuelva contra
 * una entidad de NEXO. Es la misma forma que ADR-001 le impuso a la IA, y por
 * el mismo motivo: un sistema externo que escribe directo en el Diario es un
 * sistema externo decidiendo la contabilidad de la empresa.
 *
 * ```
 * conector → external_records → (una persona resuelve) → parties · products ·
 *                                tax_transactions · commercial_documents
 * ```
 *
 * ## Qué se puede conectar hoy
 *
 * Solo los proveedores marcados `DISPONIBLE` en el catálogo, y el candado está
 * en la base, no en esta ruta. Hoy hay uno: `IMPORTACION_MANUAL`, que es el
 * camino real por el que una empresa sube la exportación de su tienda o el
 * resumen del banco. Los conectores por API que vengan aterrizan en estas
 * mismas vías, ya recorridas.
 *
 * ## Lo que llegó es evidencia
 *
 * El `payload` se guarda tal cual y es inmutable. Si el dato vino mal, se
 * descarta con motivo y se vuelve a pedir — corregirlo por debajo lo dejaría de
 * ser prueba de lo que la plataforma efectivamente informó.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, conflictoTipado, notFound, unprocessable } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';
import { separarCsv } from '../csv.js';

const TIPOS = [
  'CLIENTE', 'PROVEEDOR', 'PRODUCTO', 'ORDEN', 'PAGO', 'MOVIMIENTO_BANCARIO', 'CAMPANIA',
] as const;

/** Las cuatro entidades contra las que se puede resolver algo de afuera. */
const DESTINOS = {
  tercero: 'party_id',
  producto: 'product_id',
  comprobante: 'tax_transaction_id',
  documentoComercial: 'commercial_document_id',
} as const;

export async function integracionRoutes(app: FastifyInstance): Promise<void> {
  /** El catálogo, con lo que se puede conectar y lo que todavía no. */
  app.get('/integration-providers', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT code, name AS nombre, categoria, estado,
                  autenticacion, notas
             FROM integration_providers ORDER BY estado, categoria, name`,
        );
        return {
          proveedores: r.rows,
          alcance:
            'DISPONIBLE significa que hay un camino probado hoy. PLANIFICADO, que la ' +
            'arquitectura lo contempla y todavía no se puede conectar: la base rechaza el ' +
            'intento, no es una advertencia de pantalla.',
        };
      },
    );
  });

  app.get('/integrations', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT integration_id AS id, provider, proveedor_nombre AS "proveedorNombre",
                  categoria, alias, external_account_id AS "cuentaExterna", status,
                  last_sync_at AS "ultimaSincronizacion", last_error AS "ultimoError",
                  token_vencido AS "tokenVencido",
                  registros_sin_resolver AS "sinResolver",
                  registros_resueltos AS "resueltos",
                  registros_descartados AS "descartados",
                  ultima_corrida AS "ultimaCorrida", ultimo_estado AS "ultimoEstadoCorrida"
             FROM integration_health
            WHERE company_id = $1
            ORDER BY alias`,
          [tenant.companyId],
        );
        // Los tokens NO viajan nunca en una respuesta. La vista no los expone y
        // esta consulta tampoco los pide: son dos capas, a propósito.
        return { integraciones: r.rows };
      },
    );
  });

  app.post('/integrations', async (request, reply) => {
    const tenant = await requireCompany(request);
    // Conectar le da a un sistema externo una puerta a los datos de la empresa.
    // Es una decisión de administración, no de operación.
    requirePermission(tenant, 'integration:connect');
    const auth = requireAuth(request);

    const body = z
      .object({
        provider: z.string().min(1).max(60),
        cuentaExterna: z.string().min(1).max(200),
        alias: z.string().min(1).max(120),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO company_integrations
               (company_id, provider, external_account_id, alias, created_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
              tenant.companyId, body.provider, body.cuentaExterna, body.alias,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CONECTAR_INTEGRACION',
            objectType: 'company_integrations',
            objectId: r.rows[0]!.id,
            newValue: {
              provider: body.provider,
              cuentaExterna: body.cuentaExterna,
              alias: body.alias,
            },
            motivo: 'Se habilita una fuente externa de datos para esta empresa',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirIntegracion(error);
    }
  });

  app.post('/integrations/:integrationId/disconnect', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:connect');
    const auth = requireAuth(request);
    const { integrationId } = z.object({ integrationId: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(3).max(500) }).parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query<{ status: string }>(
          'SELECT status FROM company_integrations WHERE id = $1 AND company_id = $2',
          [integrationId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Integración no encontrada');
        if (antes.rows[0]!.status === 'DESCONECTADA') {
          throw conflict('La integración ya está desconectada');
        }

        // Los tokens se borran al desconectar. Conservar un token revocado no
        // sirve para nada y es un secreto más viviendo en la base.
        await tx.query(
          `UPDATE company_integrations
              SET status = 'DESCONECTADA', disconnected_at = now(), disconnected_by = $3,
                  access_token_encrypted = NULL, refresh_token_encrypted = NULL,
                  key_encryption_ref = NULL, token_expires_at = NULL
            WHERE id = $1 AND company_id = $2`,
          [integrationId, tenant.companyId, `user:${auth.user.userId}`],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'DESCONECTAR_INTEGRACION',
          objectType: 'company_integrations',
          objectId: integrationId,
          oldValue: { status: antes.rows[0]!.status },
          newValue: { status: 'DESCONECTADA', tokensBorrados: true },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return {
          integrationId,
          status: 'DESCONECTADA',
          alcance:
            'Los tokens se borraron. Lo que ya había entrado por esta integración se conserva: ' +
            'sigue teniendo que poder explicarse de dónde salió cada cosa.',
        };
      },
    );
  });

  /**
   * Deposita registros en la zona de aterrizaje.
   *
   * Es la ruta que usa hoy la importación manual y la que van a usar mañana los
   * conectores por API. Lo que llega **no es nada de NEXO todavía**: es lo que
   * dijo el proveedor, guardado tal cual.
   *
   * Idempotente por `(integración, tipo, external_id)`: el mismo pedido por
   * sincronización inicial, por webhook y por reintento es una sola fila, y la
   * respuesta dice cuántos eran repetidos.
   */
  /**
   * Ingesta por archivo: lo que se baja del panel del proveedor.
   *
   * ## Por qué existe
   *
   * El hub estaba **inutilizable**. Su única entrada era el endpoint de abajo,
   * que espera JSON y lo llama un conector — y ningún conector existe todavía
   * porque cada uno necesita la credencial de su plataforma, que es un bloqueo
   * externo. Mientras tanto, toda la zona de aterrizaje de ADR-016 no recibía
   * un solo registro.
   *
   * Pero el CSV **sí está disponible hoy**: cualquiera entra al panel de su
   * tienda o su pasarela de pagos y lo baja. Esto no reemplaza a los
   * conectores; hace que el módulo sirva antes de que existan.
   *
   * ## El mapeo se declara, no se adivina
   *
   * Nadie acá mira los encabezados para decidir cuál es el identificador. El
   * pedido dice qué columna es cada cosa, igual que el layout de un extracto
   * bancario. Adivinar por el nombre del encabezado anda con el archivo de
   * prueba y falla el día que el proveedor traduzca la exportación.
   *
   * ## El payload es la fila entera
   *
   * No solo las columnas mapeadas: la fila completa, con sus encabezados. El
   * registro externo es **prueba de lo que dijo el proveedor**, y recortarlo a
   * lo que hoy sabemos leer destruiría la evidencia del resto.
   */
  app.post('/integrations/:integrationId/records/csv', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:ingest');
    const auth = requireAuth(request);
    const { integrationId } = z.object({ integrationId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        kind: z.enum(TIPOS),
        separador: z.string().length(1).default(','),
        /** Contenido del archivo, tal cual. La separación se hace acá. */
        contenido: z.string().min(1).max(20_000_000),
        mapeo: z.object({
          /** Cuál es el identificador del registro en el sistema de origen. */
          externalId: z.string().min(1).max(200),
          /** Cuándo ocurrió allá. Opcional: no todo archivo lo trae. */
          ocurridoEn: z.string().max(200).nullish(),
        }),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const integracion = await tx.query<{ status: string }>(
          'SELECT status FROM company_integrations WHERE id = $1 AND company_id = $2',
          [integrationId, tenant.companyId],
        );
        if (integracion.rowCount === 0) throw notFound('Integración no encontrada');
        if (integracion.rows[0]!.status === 'DESCONECTADA') {
          throw conflictoTipado(
            'INTEGRACION_DESCONECTADA',
            'La integración está desconectada: no recibe datos nuevos.',
          );
        }

        const filas = separarCsv(body.contenido, body.separador);
        const encabezados = filas[0];
        if (encabezados === undefined || filas.length < 2) {
          throw unprocessable(
            'ARCHIVO_SIN_FILAS',
            'El archivo no tiene encabezados y al menos una fila de datos.',
          );
        }

        const columna = (nombre: string): number => {
          const i = encabezados.findIndex((h) => h.trim() === nombre.trim());
          if (i === -1) {
            throw unprocessable(
              'COLUMNA_NO_ENCONTRADA',
              `El archivo no tiene una columna «${nombre}». Trae: ${encabezados.join(', ')}.`,
            );
          }
          return i;
        };

        const iId = columna(body.mapeo.externalId);
        const iFecha =
          body.mapeo.ocurridoEn === null || body.mapeo.ocurridoEn === undefined
            ? null
            : columna(body.mapeo.ocurridoEn);

        const corrida = await tx.query<{ id: string }>(
          `INSERT INTO integration_sync_runs
             (company_id, integration_id, kind, created_by)
           VALUES ($1,$2,'INICIAL',$3) RETURNING id`,
          [tenant.companyId, integrationId, `user:${auth.user.userId}`],
        );
        const runId = corrida.rows[0]!.id;

        let nuevos = 0;
        let recibidos = 0;
        const sinIdentificador: number[] = [];

        for (const [n, fila] of filas.slice(1).entries()) {
          // Una línea en blanco al final del archivo no es un registro vacío:
          // es cómo terminan casi todos los CSV.
          if (fila.every((c) => c.trim() === '')) continue;

          const externalId = (fila[iId] ?? '').trim();
          if (externalId === '') {
            // Sin identificador no hay idempotencia posible: reimportar el mismo
            // archivo duplicaría la fila. Se informa el número de línea y se
            // sigue, en vez de abortar todo por una fila mala.
            sinIdentificador.push(n + 2);
            continue;
          }
          recibidos += 1;

          // La fila entera, con sus encabezados. Es la prueba de lo que dijo el
          // proveedor: recortarla a lo que hoy sabemos leer perdería el resto.
          const payload: Record<string, string> = {};
          encabezados.forEach((h, i) => {
            payload[h.trim() === '' ? `columna_${String(i + 1)}` : h.trim()] = fila[i] ?? '';
          });

          const ocurrido =
            iFecha === null ? null : ((fila[iFecha] ?? '').trim() === '' ? null : fila[iFecha]);

          const ins = await tx.query(
            `INSERT INTO external_records
               (company_id, integration_id, sync_run_id, kind, external_id,
                occurred_at, payload)
             VALUES ($1,$2,$3,$4,$5,
                     -- La fecha se convierte en la base o el registro entra sin
                     -- ella: interpretar acá formatos de fecha de cada país es
                     -- exactamente el error que este módulo evita.
                     CASE WHEN $6::text IS NULL THEN NULL
                          ELSE (SELECT CASE WHEN $6 ~ '^\\d{4}-\\d{2}-\\d{2}'
                                            THEN $6::timestamptz END) END,
                     $7)
             ON CONFLICT (company_id, integration_id, kind, external_id) DO NOTHING`,
            [
              tenant.companyId, integrationId, runId, body.kind, externalId,
              ocurrido, JSON.stringify(payload),
            ],
          );
          if (Number(ins.rowCount) > 0) nuevos += 1;
        }

        const duplicados = recibidos - nuevos;

        await tx.query(
          `UPDATE integration_sync_runs
              SET status = 'COMPLETADA', finished_at = now(),
                  records_received = $3, records_new = $4, records_duplicados = $5
            WHERE id = $1 AND company_id = $2`,
          [runId, tenant.companyId, recibidos, nuevos, duplicados],
        );

        await tx.query(
          `UPDATE company_integrations SET last_sync_at = now()
            WHERE id = $1 AND company_id = $2`,
          [integrationId, tenant.companyId],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'INGESTAR_ARCHIVO_EXTERNO',
          objectType: 'company_integrations',
          objectId: integrationId,
          newValue: {
            corrida: runId,
            kind: body.kind,
            recibidos,
            nuevos,
            duplicados,
            sinIdentificador: sinIdentificador.length,
          },
          motivo:
            'Se cargan registros externos desde un archivo exportado del proveedor. Nada ' +
            'entra al motor contable: quedan sin resolver hasta que una persona los vincule.',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return {
          corrida: runId,
          recibidos,
          nuevos,
          duplicados,
          // Las filas descartadas se informan por número de línea. Un contador
          // sin las líneas obliga a comparar el archivo a ojo.
          sinIdentificador,
          alcance:
            'Los registros quedan SIN_RESOLVER. Nada de esto tocó el motor contable: ' +
            'vincular cada uno con un tercero, un producto o un comprobante es una afirmación ' +
            'de una persona y queda firmada (ADR-016).',
        };
      },
    );
  });

  app.post('/integrations/:integrationId/records', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:ingest');
    const auth = requireAuth(request);
    const { integrationId } = z.object({ integrationId: z.string().uuid() }).parse(request.params);

    const body = z
      .object({
        tipoDeCorrida: z.enum(['INICIAL', 'INCREMENTAL', 'WEBHOOK']).default('INCREMENTAL'),
        cursor: z.string().max(500).nullish(),
        registros: z
          .array(
            z.object({
              kind: z.enum(TIPOS),
              externalId: z.string().min(1).max(200),
              ocurridoEn: z.string().datetime().nullish(),
              payload: z.record(z.unknown()),
            }),
          )
          .min(1)
          .max(500),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const integracion = await tx.query<{ status: string }>(
          'SELECT status FROM company_integrations WHERE id = $1 AND company_id = $2',
          [integrationId, tenant.companyId],
        );
        if (integracion.rowCount === 0) throw notFound('Integración no encontrada');
        if (integracion.rows[0]!.status === 'DESCONECTADA') {
          throw conflictoTipado(
            'INTEGRACION_DESCONECTADA',
            'La integración está desconectada: no recibe datos nuevos.',
          );
        }

        const corrida = await tx.query<{ id: string }>(
          `INSERT INTO integration_sync_runs
             (company_id, integration_id, kind, cursor, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [
            tenant.companyId, integrationId, body.tipoDeCorrida,
            body.cursor ?? null, `user:${auth.user.userId}`,
          ],
        );
        const runId = corrida.rows[0]!.id;

        let nuevos = 0;
        for (const r of body.registros) {
          // `ON CONFLICT DO NOTHING` sobre el índice de idempotencia: el
          // duplicado no es un error, es lo esperado en un reintento.
          const ins = await tx.query(
            `INSERT INTO external_records
               (company_id, integration_id, sync_run_id, kind, external_id,
                occurred_at, payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (company_id, integration_id, kind, external_id) DO NOTHING`,
            [
              tenant.companyId, integrationId, runId, r.kind, r.externalId,
              r.ocurridoEn ?? null, JSON.stringify(r.payload),
            ],
          );
          if (Number(ins.rowCount) > 0) nuevos += 1;
        }

        const duplicados = body.registros.length - nuevos;

        await tx.query(
          `UPDATE integration_sync_runs
              SET status = 'COMPLETADA', finished_at = now(),
                  records_received = $3, records_new = $4, records_duplicados = $5
            WHERE id = $1 AND company_id = $2`,
          [runId, tenant.companyId, body.registros.length, nuevos, duplicados],
        );

        await tx.query(
          `UPDATE company_integrations SET last_sync_at = now()
            WHERE id = $1 AND company_id = $2`,
          [integrationId, tenant.companyId],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'INGESTAR_REGISTROS_EXTERNOS',
          objectType: 'company_integrations',
          objectId: integrationId,
          newValue: {
            corrida: runId,
            recibidos: body.registros.length,
            nuevos,
            duplicados,
          },
          motivo: `Sincronización ${body.tipoDeCorrida.toLowerCase()}`,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          corrida: runId,
          recibidos: body.registros.length,
          nuevos,
          duplicados,
          alcance:
            'Los registros quedaron en la zona de aterrizaje. Todavía no son nada de NEXO: ' +
            'cada uno tiene que resolverse contra una entidad, y hasta entonces figura como ' +
            'pendiente en la bandeja.',
        };
      },
    );
  });

  app.get('/external-records', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        status: z.enum(['SIN_RESOLVER', 'RESUELTO', 'DESCARTADO']).optional(),
        kind: z.enum(TIPOS).optional(),
        integrationId: z.string().uuid().optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ fecha: Date; id: string }>(
          `SELECT e.id, e.kind, e.external_id AS "externalId", e.status,
                  e.received_at AS fecha, e.occurred_at AS "ocurridoEn",
                  e.payload, e.motivo_descarte AS "motivoDescarte",
                  e.party_id AS "terceroId", e.product_id AS "productoId",
                  e.tax_transaction_id AS "comprobanteId",
                  e.commercial_document_id AS "documentoComercialId",
                  e.resolved_at AS "resueltoEn", e.resolved_by AS "resueltoPor",
                  i.alias AS integracion, i.provider
             FROM external_records e
             JOIN company_integrations i
               ON i.id = e.integration_id AND i.company_id = e.company_id
            WHERE e.company_id = $1
              AND ($2::text IS NULL OR e.status = $2)
              AND ($3::text IS NULL OR e.kind = $3)
              AND ($4::uuid IS NULL OR e.integration_id = $4::uuid)
              AND ($5::timestamptz IS NULL
                   OR (e.received_at, e.id) < ($5::timestamptz, $6::uuid))
            ORDER BY e.received_at DESC, e.id DESC
            LIMIT $7`,
          [
            tenant.companyId,
            query.status ?? null,
            query.kind ?? null,
            query.integrationId ?? null,
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(r.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));
        return { registros: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });

  /**
   * Resuelve un registro externo contra una entidad de NEXO.
   *
   * Este es el paso que el diseño **no** automatiza. Que el pedido 4821 de la
   * tienda sea este cliente del maestro es una afirmación de una persona, y por
   * eso queda firmada.
   */
  app.post('/external-records/:recordId/resolve', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:resolve');
    const auth = requireAuth(request);
    const { recordId } = z.object({ recordId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        destino: z.enum(['tercero', 'producto', 'comprobante', 'documentoComercial']),
        entidadId: z.string().uuid(),
      })
      .parse(request.body);

    const columna = DESTINOS[body.destino];

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ status: string; kind: string }>(
            'SELECT status, kind FROM external_records WHERE id = $1 AND company_id = $2',
            [recordId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Registro externo no encontrado');
          if (antes.rows[0]!.status !== 'SIN_RESOLVER') {
            throw conflictoTipado(
              'REGISTRO_YA_RESUELTO',
              `El registro está en ${antes.rows[0]!.status}: ya no espera resolución.`,
            );
          }

          // El nombre de columna sale del mapa `DESTINOS`, no del cuerpo del
          // pedido: no hay forma de que un valor del cliente llegue al SQL.
          await tx.query(
            `UPDATE external_records
                SET status = 'RESUELTO', ${columna} = $3,
                    resolved_at = now(), resolved_by = $4
              WHERE id = $1 AND company_id = $2`,
            [recordId, tenant.companyId, body.entidadId, `user:${auth.user.userId}`],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'RESOLVER_REGISTRO_EXTERNO',
            objectType: 'external_records',
            objectId: recordId,
            oldValue: { status: 'SIN_RESOLVER' },
            newValue: { status: 'RESUELTO', destino: body.destino, entidadId: body.entidadId },
            motivo: `Se afirma que este ${antes.rows[0]!.kind.toLowerCase()} externo corresponde a ${body.destino}`,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { recordId, status: 'RESUELTO', destino: body.destino };
        },
      );
    } catch (error) {
      throw traducirIntegracion(error);
    }
  });

  app.post('/external-records/:recordId/discard', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'integration:resolve');
    const auth = requireAuth(request);
    const { recordId } = z.object({ recordId: z.string().uuid() }).parse(request.params);
    const body = z.object({ motivo: z.string().min(3).max(500) }).parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query<{ status: string }>(
          'SELECT status FROM external_records WHERE id = $1 AND company_id = $2',
          [recordId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Registro externo no encontrado');
        if (antes.rows[0]!.status !== 'SIN_RESOLVER') {
          throw conflictoTipado(
            'REGISTRO_YA_RESUELTO',
            `El registro está en ${antes.rows[0]!.status}.`,
          );
        }

        await tx.query(
          `UPDATE external_records SET status = 'DESCARTADO', motivo_descarte = $3
            WHERE id = $1 AND company_id = $2`,
          [recordId, tenant.companyId, body.motivo],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'DESCARTAR_REGISTRO_EXTERNO',
          objectType: 'external_records',
          objectId: recordId,
          oldValue: { status: 'SIN_RESOLVER' },
          newValue: { status: 'DESCARTADO' },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return {
          recordId,
          status: 'DESCARTADO',
          alcance:
            'El registro queda con su payload intacto y marcado como descartado. Lo que ' +
            'informó el proveedor no se borra ni se edita: sigue siendo prueba de lo que dijo.',
        };
      },
    );
  });
}

const POR_CODIGO: ReadonlyArray<readonly [string, string, string]> = [
  [
    'E_INT_NO_DISPONIBLE',
    'PROVEEDOR_NO_DISPONIBLE',
    'Ese proveedor todavía no se puede conectar: está PLANIFICADO, no DISPONIBLE. ' +
      'Consultá GET /integration-providers para ver cuáles tienen camino hoy.',
  ],
  [
    'E_EXT_INMUTABLE',
    'REGISTRO_INMUTABLE',
    'Lo que informó el proveedor es evidencia y no se edita. Descartalo con motivo y pedilo de nuevo.',
  ],
];

function traducirIntegracion(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';
  for (const [interno, publico, texto] of POR_CODIGO) {
    if (mensaje.includes(interno)) return unprocessable(publico, texto);
  }
  if (fallo.code === '23505') {
    return conflictoTipado(
      'INTEGRACION_DUPLICADA',
      'Esa cuenta externa ya está conectada en esta empresa. Dos integraciones a la misma ' +
        'cuenta traerían cada pedido dos veces y la idempotencia no lo vería.',
    );
  }
  if (fallo.code === '23503') {
    return badRequest('El proveedor o la entidad de destino no existen en esta empresa');
  }
  return error;
}
