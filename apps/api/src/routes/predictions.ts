/**
 * Clasificación asistida y pantalla de revisión del contador (FASE 4).
 *
 * Acá se arma el contexto que el agente recibe. Es el trabajo más importante de
 * este archivo y el más fácil de hacer mal: **el agente solo puede citar lo que
 * le pongamos en el contexto**, así que qué normas se cargan acá determina qué
 * puede afirmar el sistema.
 *
 * Hoy se cargan cero, y no por un olvido: el motor normativo llega en FASE 6.
 * Mientras tanto el estado normativo es `NO_CONSULTADO`, que es un disparador
 * duro. La consecuencia es deliberada y conviene decirla en voz alta:
 *
 *     Toda propuesta cae en 🔴 y ninguna se puede aprobar en lote.
 *
 * No es un bug. Aprobar contabilidad en tanda sin motor normativo sería
 * exactamente lo que este diseño existe para no hacer. La sugerencia igual sirve
 * —el contador la ve, con su razón y su cuenta, y aprueba de a una—, que es
 * bastante más que escribirla desde cero.
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  ClassificationAgent,
  MockLLMProvider,
  NullLLMProvider,
  POLITICA_POR_DEFECTO,
  PROMPT_DETERMINISTICO,
  PROMPT_HASH_DETERMINISTICO,
  TRATAMIENTOS_POR_DEFECTO,
  cambiosPorRevision,
  promptsRegistrados,
  type ContextoClasificacion,
  type CuentaDelPlan,
  type HechosDelComprobante,
  type LLMProvider,
  type PreferenciaAprendida,
  type ResultadoSelloFiscal,
} from '@aai/ai-engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';

/**
 * Proveedor según configuración.
 *
 * Mismo criterio que con ARCA y con el OCR: el simulado se usa si y solo si está
 * pedido explícitamente. Sin configuración, `NullLLMProvider` — y el sistema
 * sigue sugiriendo con la historia de la empresa, sin mandar nada afuera (§8).
 */
function proveedor(): LLMProvider {
  if (config.ai.provider !== 'mock') return new NullLLMProvider();
  return new MockLLMProvider({
    respuestas: [
      {
        output: {
          cuentaCodigo: '__SIMULACION__',
          tratamiento: 'NO_DETERMINADO',
          confianza: 0.1,
          razon: 'Respuesta de simulación: no proviene de ningún modelo y no tiene valor.',
          citas: [],
          abstencion: true,
        },
      },
    ],
    alAgotarse: 'REPETIR',
  });
}

export async function predictionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents/:documentId/classify', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'prediction:run');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const params = z.object({ documentId: z.string().uuid() }).parse(request.params);

    const contexto = await withCompany({ companyId: tenant.companyId, actorId }, (tx) =>
      armarContexto(tx, tenant.companyId, params.documentId),
    );

    const resultado = await new ClassificationAgent({ provider: proveedor() }).clasificar(contexto);

    if (resultado.estado === 'SIN_SUGERENCIA') {
      // Una propuesta descartada por la Validation Layer no se pierde: se
      // registra. Es la métrica de deriva del modelo.
      const rechazo = resultado.rechazo;
      if (rechazo !== undefined) {
        await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
          await tx.query(
            `INSERT INTO ai_rejections
               (company_id, document_id, agent, model_provider, model_id, prompt_hash,
                motivo, es_alucinacion, detalle)
             VALUES ($1, $2, 'CLASSIFICATION', $3, $4, $5, $6, $7, $8)`,
            [
              tenant.companyId,
              params.documentId,
              config.ai.provider,
              config.ai.provider,
              promptsRegistrados()[0]!.hash,
              rechazo.motivo,
              rechazo.esAlucinacion,
              rechazo.detalle,
            ],
          );
        });
      }
      reply.code(200);
      return { estado: 'SIN_SUGERENCIA', motivo: resultado.motivo, detalle: resultado.detalle };
    }

    const propuesta = resultado.propuesta;
    const predictionId = await withCompany(
      { companyId: tenant.companyId, actorId },
      async (tx) => {
        const insertado = await tx.query<{ id: string }>(
          `INSERT INTO ai_predictions
             (company_id, document_id, agent, model_provider, model_id, prompt_hash,
              input_ref, output, confidence, reason, normative_sources,
              triage_band, hard_blocks, advertencias, passes, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING id`,
          [
            tenant.companyId,
            params.documentId,
            propuesta.agent,
            propuesta.modelProvider,
            propuesta.modelId,
            propuesta.promptHash,
            propuesta.inputRef,
            JSON.stringify(propuesta.output),
            propuesta.confidence,
            propuesta.reason,
            JSON.stringify(propuesta.normativeSources),
            propuesta.triage.band,
            propuesta.triage.hardBlocks,
            propuesta.advertencias,
            propuesta.pasadas,
            propuesta.latencyMs,
          ],
        );

        // §8: el estudio tiene que poder demostrar qué se mandó a un tercero y
        // cuándo. Por eso el actor es `AI`, no el usuario que apretó el botón.
        await recordAudit(tx, tenant.companyId, {
          actorType: 'AI',
          actorId: `ai:${propuesta.agent}`,
          action: 'PROPONER_CLASIFICACION',
          objectType: 'document',
          objectId: params.documentId,
          newValue: {
            modelProvider: propuesta.modelProvider,
            modelId: propuesta.modelId,
            promptHash: propuesta.promptHash,
            triage: propuesta.triage,
            solicitadoPor: actorId,
          },
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return insertado.rows[0]!.id;
      },
    );

    reply.code(201);
    return {
      estado: 'PROPUESTA',
      id: predictionId,
      output: propuesta.output,
      confidence: propuesta.confidence,
      reason: propuesta.reason,
      normativeSources: propuesta.normativeSources,
      triage: propuesta.triage,
      advertencias: propuesta.advertencias,
      // §42: nunca se presenta como asesoramiento profesional.
      aviso: 'Sugerencia generada automáticamente. Requiere aprobación profesional.',
    };
  });

  app.get('/predictions', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'prediction:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        banda: z.enum(['ALTA', 'MEDIA', 'BAJA']).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT id, document_id AS "documentId", documento_nombre AS "documento",
                  output, confidence, reason, normative_sources AS "normativeSources",
                  triage_band AS "banda", hard_blocks AS "bloqueos",
                  advertencias, model_provider AS "proveedor", model_id AS "modelo",
                  prompt_hash AS "promptHash", created_at AS "creadaEn"
             FROM predictions_pendientes
            WHERE company_id = $1 AND ($2::text IS NULL OR triage_band = $2)
            ORDER BY created_at DESC
            LIMIT $3`,
          [tenant.companyId, query.banda ?? null, query.limite],
        );
        return {
          predicciones: result.rows,
          aviso: 'Ninguna de estas propuestas está contabilizada. Requieren aprobación profesional.',
        };
      },
    );
  });

  app.post('/predictions/:predictionId/review', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'prediction:review');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const params = z.object({ predictionId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        decision: z.enum(['APROBADA', 'MODIFICADA', 'RECHAZADA']),
        cuentaFinalId: z.string().uuid().optional(),
        motivo: z.string().min(3).max(500).optional(),
      })
      .parse(request.body);

    if (body.decision === 'MODIFICADA' && body.cuentaFinalId === undefined) {
      throw badRequest('Una modificación tiene que decir a qué cuenta se corrigió');
    }
    if (body.decision === 'RECHAZADA' && body.motivo === undefined) {
      throw badRequest('Un rechazo tiene que decir por qué');
    }

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const prediccion = await tx.query<{
        id: string;
        document_id: string | null;
        output: { cuentaId: string; cuentaCodigo: string };
      }>(
        'SELECT id, document_id, output FROM ai_predictions WHERE id = $1',
        [params.predictionId],
      );
      if (prediccion.rowCount === 0) throw notFound('Propuesta no encontrada');

      const yaRevisada = await tx.query(
        'SELECT 1 FROM ai_reviews WHERE prediction_id = $1',
        [params.predictionId],
      );
      if (yaRevisada.rowCount !== 0) throw conflict('Esa propuesta ya fue revisada');

      const propuesta = prediccion.rows[0]!;
      const correccion =
        body.decision === 'MODIFICADA' ? { cuentaId: body.cuentaFinalId! } : null;

      await tx.query(
        `INSERT INTO ai_reviews
           (company_id, prediction_id, reviewer_id, decision, corrected_output, motivo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenant.companyId,
          params.predictionId,
          actorId,
          body.decision,
          correccion === null ? null : JSON.stringify(correccion),
          body.motivo ?? null,
        ],
      );

      // Aprendizaje (§14). Solo mueve la sugerencia: no hay ruta de código desde
      // acá hacia `accounting_rules` ni `norm_versions`.
      const hechos =
        propuesta.document_id === null
          ? null
          : await hechosDelDocumento(tx, tenant.companyId, propuesta.document_id);

      if (hechos !== null) {
        const cambios = cambiosPorRevision({
          hechos,
          decision: body.decision,
          cuentaPropuestaId: propuesta.output.cuentaId,
          ...(body.cuentaFinalId !== undefined ? { cuentaFinalId: body.cuentaFinalId } : {}),
        });
        for (const cambio of cambios) {
          await aplicarCambio(tx, tenant.companyId, cambio);
        }
      }

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'REVISAR_PROPUESTA_IA',
        objectType: 'ai_prediction',
        objectId: params.predictionId,
        oldValue: propuesta.output,
        newValue: { decision: body.decision, cuentaFinalId: body.cuentaFinalId ?? null },
        ...(body.motivo !== undefined ? { motivo: body.motivo } : {}),
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      reply.code(201);
      return { predictionId: params.predictionId, decision: body.decision };
    });
  });

  /**
   * Deriva del modelo (§4).
   *
   * Tres números distintos que suelen mezclarse: cuánto inventó, cuánto se
   * equivocó de criterio, y cuánto le rechazó el contador. El primero mide al
   * modelo; el tercero mide qué tan útil es para *esta* empresa.
   */
  app.get('/predictions/metrics', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'prediction:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const rechazos = await tx.query(
          `SELECT motivo, es_alucinacion AS "esAlucinacion", count(*)::int AS total
             FROM ai_rejections WHERE company_id = $1
            GROUP BY motivo, es_alucinacion ORDER BY total DESC`,
          [tenant.companyId],
        );
        const revisiones = await tx.query(
          `SELECT r.decision, count(*)::int AS total
             FROM ai_reviews r WHERE r.company_id = $1
            GROUP BY r.decision`,
          [tenant.companyId],
        );
        const bandas = await tx.query(
          `SELECT triage_band AS banda, count(*)::int AS total
             FROM ai_predictions WHERE company_id = $1
            GROUP BY triage_band`,
          [tenant.companyId],
        );
        return {
          rechazosAutomaticos: rechazos.rows,
          revisionesHumanas: revisiones.rows,
          distribucionPorBanda: bandas.rows,
          nota:
            'La tasa de rechazo humano que sube es señal de deriva: si crece, hay que bajar el ' +
            'umbral automático antes de que el contador empiece a aprobar sin mirar.',
        };
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Armado del contexto
// ---------------------------------------------------------------------------

async function armarContexto(
  tx: Tx,
  companyId: string,
  documentId: string,
): Promise<ContextoClasificacion> {
  const hechos = await hechosDelDocumento(tx, companyId, documentId);
  if (hechos === null) throw notFound('Documento no encontrado');

  const cuentas = await tx.query<{
    id: string;
    codigo: string;
    nombre: string;
    tipo: string;
    imputable: boolean;
    usada_antes: boolean;
  }>(
    `SELECT a.id, a.code AS codigo, a.name AS nombre, a.type AS tipo,
            a.is_postable AS imputable,
            EXISTS (
              SELECT 1 FROM journal_entry_lines l WHERE l.account_id = a.id
            ) AS usada_antes
       FROM accounts a
      WHERE a.company_id = $1 AND a.status = 'ACTIVE'
      ORDER BY a.code`,
    [companyId],
  );

  const preferencias = await tx.query<{
    signal: string;
    cuenta_id: string;
    codigo: string;
    support_count: number;
    last_confirmed_at: Date | null;
  }>(
    `SELECT p.signal, p.suggested_account_id AS cuenta_id, a.code AS codigo,
            p.support_count, p.last_confirmed_at
       FROM classification_preferences p
       JOIN accounts a ON a.id = p.suggested_account_id
      WHERE p.company_id = $1 AND p.support_count > 0
      ORDER BY p.support_count DESC`,
    [companyId],
  );

  const politica = await tx.query<{ auto_threshold: string; review_threshold: string }>(
    `SELECT auto_threshold, review_threshold FROM confidence_policies
      WHERE company_id = $1 AND agent = 'CLASSIFICATION'`,
    [companyId],
  );

  return {
    companyId,
    documentId,
    hechos,
    cuentas: cuentas.rows.map(
      (fila): CuentaDelPlan => ({
        id: fila.id,
        codigo: fila.codigo,
        nombre: fila.nombre,
        tipo: fila.tipo,
        imputable: fila.imputable,
        usadaAntes: fila.usada_antes,
      }),
    ),
    // Vacío hasta FASE 6. No es una lista que se olvidó de llenarse: es que el
    // motor normativo no existe, y por eso `estadoNormativo` es NO_CONSULTADO.
    normas: [],
    preferencias: preferencias.rows.map(
      (fila): PreferenciaAprendida => ({
        signal: fila.signal,
        cuentaId: fila.cuenta_id,
        cuentaCodigo: fila.codigo,
        vecesConfirmada: fila.support_count,
        ultimaConfirmacion: fila.last_confirmed_at?.toISOString() ?? null,
      }),
    ),
    politica:
      politica.rowCount === 0
        ? POLITICA_POR_DEFECTO
        : {
            autoThreshold: Number(politica.rows[0]!.auto_threshold),
            reviewThreshold: Number(politica.rows[0]!.review_threshold),
          },
    tratamientos: [...TRATAMIENTOS_POR_DEFECTO],
  };
}

async function hechosDelDocumento(
  tx: Tx,
  companyId: string,
  documentId: string,
): Promise<HechosDelComprobante | null> {
  const documento = await tx.query<{ id: string }>(
    'SELECT id FROM documents WHERE id = $1 AND company_id = $2',
    [documentId, companyId],
  );
  if (documento.rowCount === 0) return null;

  const campos = await tx.query<{ field_path: string; parsed_value: unknown; raw_value: string | null }>(
    `SELECT DISTINCT ON (f.field_path) f.field_path, f.parsed_value, f.raw_value
       FROM document_extraction_fields f
       JOIN document_extractions e ON e.id = f.extraction_id
      WHERE e.document_id = $1
      -- La corrección manual gana sobre la lectura del motor.
      ORDER BY f.field_path, (f.method = 'MANUAL') DESC, f.created_at DESC`,
    [documentId],
  );

  const valor = (fieldPath: string, clave: string): string | null => {
    const campo = campos.rows.find((fila) => fila.field_path === fieldPath);
    const parsed = campo?.parsed_value as Record<string, unknown> | null | undefined;
    const bruto = parsed?.[clave];
    return typeof bruto === 'string' ? bruto : null;
  };

  const cuit = valor('emisor.cuit', 'value');
  const totalMenor = valor('importes.total', 'amount');
  const moneda = valor('importes.total', 'currency');
  const fecha = valor('comprobante.fecha', 'value');

  const historico =
    cuit === null
      ? { rows: [] as { amount: string }[] }
      : await tx.query<{ amount: string }>(
          `SELECT f.parsed_value ->> 'amount' AS amount
             FROM document_extraction_fields f
             JOIN document_extractions e ON e.id = f.extraction_id
             JOIN documents d ON d.id = e.document_id
            WHERE d.company_id = $1 AND d.id <> $2 AND d.status <> 'ANULADO'
              AND f.field_path = 'importes.total' AND f.parsed_value IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM document_extraction_fields c
                 WHERE c.extraction_id = e.id
                   AND c.field_path = 'emisor.cuit'
                   AND c.parsed_value ->> 'value' = $3
              )
            LIMIT 200`,
          [companyId, documentId, cuit],
        );

  const sello = await tx.query<{ outcome: string; reason: string | null }>(
    `SELECT outcome, reason FROM arca_query_log
      WHERE company_id = $1 AND service = 'wscdc' AND request_key = $2
      ORDER BY queried_at DESC LIMIT 1`,
    [companyId, documentId],
  );

  const hallazgos = await tx.query<{ codigo: string }>(
    `SELECT f.codigo FROM document_findings f
       JOIN document_extractions e ON e.id = f.extraction_id
      WHERE e.document_id = $1 AND f.bloquea`,
    [documentId],
  );

  return {
    cuitEmisor: cuit,
    razonSocialEmisor: valor('emisor.razonSocial', 'value'),
    descripcion: campos.rows.find((f) => f.field_path === 'comprobante.concepto')?.raw_value ?? null,
    totalMenor,
    moneda,
    fecha,
    selloFiscal: mapearSello(sello.rows[0]?.outcome),
    // Conocido significa que ya hubo otra operación con ese CUIT en esta empresa.
    proveedorConocido: historico.rows.length > 0,
    // `null`, no `false`: el servicio de apócrifos todavía no está implementado,
    // y "no pude preguntar" no es "no es apócrifo".
    proveedorApocrifo: null,
    monedaExtranjeraSinCotizacion: moneda !== null && moneda !== 'ARS',
    periodoProximoACierre: false,
    historicoImportes: historico.rows
      .map((fila) => fila.amount)
      .filter((amount): amount is string => amount !== null),
    hallazgosBloqueantes: hallazgos.rows.map((fila) => fila.codigo),
    estadoNormativo: 'NO_CONSULTADO',
  };
}

function mapearSello(outcome: string | undefined): ResultadoSelloFiscal | null {
  if (outcome === undefined) return null;
  if (outcome === 'APROBADO') return 'OK';
  if (outcome === 'RECHAZADO') return 'FAIL';
  return 'NO_VERIFICABLE';
}

async function aplicarCambio(
  tx: Tx,
  companyId: string,
  cambio: { signal: string; cuentaId: string; delta: number; confirmar: boolean },
): Promise<void> {
  await tx.query(
    `INSERT INTO classification_preferences
       (company_id, signal, suggested_account_id, support_count, last_confirmed_at)
     VALUES ($1, $2, $3, greatest(0, $4), CASE WHEN $5 THEN now() ELSE NULL END)
     ON CONFLICT (company_id, signal, suggested_account_id) DO UPDATE
       SET support_count = greatest(0, classification_preferences.support_count + $4),
           last_confirmed_at = CASE
             WHEN $5 THEN now() ELSE classification_preferences.last_confirmed_at
           END`,
    [companyId, cambio.signal, cambio.cuentaId, cambio.delta, cambio.confirmar],
  );
}

// ---------------------------------------------------------------------------
// Registro de prompts
// ---------------------------------------------------------------------------

/**
 * Archiva en la base los prompts que el código conoce.
 *
 * Corre al arrancar, con las credenciales de la aplicación… que no tienen INSERT
 * sobre `prompt_versions` a propósito: un prompt que se pudiera insertar por
 * HTTP dejaría de ser un artefacto versionado. Por eso esto se ejecuta con la
 * conexión de migración, desde `scripts/register-prompts.mjs`.
 *
 * Se exporta la lista para que ese script no tenga que redeclararla.
 */
export function promptsAArchivar(): readonly {
  hash: string;
  name: string;
  version: string;
  texto: string;
}[] {
  return [
    ...promptsRegistrados(),
    {
      hash: PROMPT_HASH_DETERMINISTICO,
      name: PROMPT_DETERMINISTICO.name,
      version: PROMPT_DETERMINISTICO.version,
      texto: PROMPT_DETERMINISTICO.texto,
    },
  ];
}
