/**
 * Ingesta y revisión de documentos (§9, §10).
 *
 * Dos cosas que estos handlers hacen y conviene no perder de vista:
 *
 * **El documento se archiva antes de interpretarse, y se archiva aunque la
 * interpretación falle.** Un 4xx acá significa "este archivo no entra al
 * sistema"; no significa "no pude leerlo". Lo segundo es un documento válido
 * con una extracción vacía y un motivo.
 *
 * **La corrección de un campo inserta, no actualiza.** La base lo impide con un
 * trigger, pero el handler tampoco lo intenta: la lectura original del motor y
 * la corrección del contador conviven, y ese par es lo que permite medir si el
 * motor está mejorando (§10).
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  FilesystemDocumentStore,
  MockOcrEngine,
  NullOcrEngine,
  claveEsDeEmpresa,
  ingerir,
  paginaDeTexto,
  type CampoExtraido,
  type HuellaDocumento,
  type OcrEngine,
} from '@aai/document-engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';

const store = new FilesystemDocumentStore(config.documents.storagePath);

/**
 * Motor de OCR según configuración.
 *
 * Igual que con ARCA: el simulado se usa **si y solo si** está pedido
 * explícitamente. Sin configuración, el motor es el nulo, que archiva el
 * documento y declara que no leyó nada. Nunca se cae en el simulado por
 * omisión: eso convertiría una configuración incompleta en producción en
 * lecturas inventadas presentadas como reales.
 */
function motorOcr(): OcrEngine {
  if (config.documents.ocrEngine !== 'mock') return new NullOcrEngine();
  return new MockOcrEngine({
    porDefecto: { paginas: [paginaDeTexto(1, ['SIMULACIÓN — sin valor probatorio'], 0.5)] },
  });
}

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'document:upload');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;

    const archivo = await request.file({ limits: { fileSize: config.documents.maxBytes } });
    if (archivo === undefined) throw badRequest('Falta el archivo en el formulario');

    const bytes = await archivo.toBuffer();
    if (archivo.file.truncated) {
      throw badRequest(`El archivo supera el máximo de ${config.documents.maxBytes} bytes`);
    }

    const origen = z
      .enum(['UPLOAD', 'EMAIL', 'FOLDER', 'API'])
      .catch('UPLOAD')
      .parse(campoDeTexto(archivo.fields, 'origen'));

    const resultado = await ingerir(
      {
        companyId: tenant.companyId,
        nombreOriginal: archivo.filename,
        ...(archivo.mimetype !== undefined ? { mimeDeclarado: archivo.mimetype } : {}),
        origen,
        bytes,
      },
      {
        store,
        ocr: motorOcr(),
        maxBytes: config.documents.maxBytes,
        huellas: { huellasDe: (companyId) => huellasDe(companyId, actorId) },
      },
    );

    if (!resultado.ok) {
      // El rechazo se audita igual: que un archivo no haya entrado también es
      // información, y sin registro nadie puede reconstruir por qué falta.
      await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'RECHAZAR_DOCUMENTO',
          objectType: 'document',
          objectId: resultado.sha256,
          newValue: { motivo: resultado.motivo, detalle: resultado.detalle },
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });
      });
      throw badRequest(resultado.detalle, { motivo: resultado.motivo, sha256: resultado.sha256 });
    }

    const persistido = await withCompany(
      { companyId: tenant.companyId, actorId },
      async (tx) => guardar(tx, tenant.companyId, actorId, resultado),
    );

    if (persistido.yaExistia) {
      // Mismo archivo, misma empresa: no es un hecho contable nuevo. Se devuelve
      // el documento que ya estaba, con 200, en vez de crear un segundo.
      return {
        id: persistido.documentId,
        duplicadoDe: persistido.documentId,
        nivel: 'ARCHIVO_IDENTICO',
        mensaje: 'Este archivo ya estaba cargado. Se devolvió el documento existente.',
      };
    }

    await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'INGRESAR_DOCUMENTO',
        objectType: 'document',
        objectId: persistido.documentId,
        newValue: {
          sha256: resultado.documento.sha256,
          tipo: resultado.documento.tipo,
          bytes: resultado.documento.bytes,
          extraccionDisponible: resultado.extraccion.disponible,
        },
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });
    });

    reply.code(201);
    return {
      id: persistido.documentId,
      extractionId: persistido.extractionId,
      documento: resultado.documento,
      extraccion: {
        disponible: resultado.extraccion.disponible,
        motivo: resultado.extraccion.motivoNoDisponible ?? null,
        motor: resultado.extraccion.motor,
        confianzaGlobal: resultado.extraccion.confianzaGlobal,
        campos: resultado.extraccion.campos,
      },
      hallazgos: resultado.hallazgos,
      duplicados: resultado.duplicados,
    };
  });

  app.get('/documents', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'document:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        soloPendientes: z.coerce.boolean().default(false),
        limite: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT id, original_name AS "nombre", content_type AS "tipo", status,
                  received_at AS "recibidoEn", extraction_id AS "extractionId",
                  engine AS "motor", extraccion_disponible AS "extraccionDisponible",
                  unavailable_reason AS "motivoNoDisponible",
                  overall_confidence AS "confianza",
                  tiene_hallazgo_bloqueante AS "tieneHallazgoBloqueante",
                  tiene_duplicado_sin_resolver AS "tieneDuplicadoSinResolver"
             FROM documents_pendientes
            WHERE company_id = $1
              AND ($2 = false OR tiene_hallazgo_bloqueante OR tiene_duplicado_sin_resolver
                   OR extraccion_disponible IS NOT TRUE)
            ORDER BY received_at DESC
            LIMIT $3`,
          [tenant.companyId, query.soloPendientes, query.limite],
        );
        return { documentos: result.rows };
      },
    );
  });

  app.get('/documents/:documentId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'document:read');
    const auth = requireAuth(request);
    const params = z.object({ documentId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const documento = await tx.query(
          `SELECT id, original_name AS "nombre", content_type AS "tipo", mime, bytes,
                  sha256, source AS "origen", status, risk_flags AS "riesgos",
                  received_at AS "recibidoEn", uploaded_by AS "subidoPor"
             FROM documents WHERE id = $1`,
          [params.documentId],
        );
        if (documento.rowCount === 0) throw notFound('Documento no encontrado');

        const extracciones = await tx.query(
          `SELECT id, engine AS "motor", engine_version AS "motorVersion", available AS "disponible",
                  unavailable_reason AS "motivoNoDisponible", overall_confidence AS "confianza",
                  started_at AS "iniciadaEn"
             FROM document_extractions WHERE document_id = $1 ORDER BY started_at DESC`,
          [params.documentId],
        );

        const ultima = extracciones.rows[0]?.['id'] as string | undefined;
        const campos =
          ultima === undefined
            ? { rows: [] }
            : await tx.query(
                `SELECT field_path AS "fieldPath", raw_value AS "rawValue",
                        parsed_value AS "parsedValue", confidence, method, page, bbox, nota
                   FROM document_extraction_fields
                  WHERE extraction_id = $1
                  -- La corrección manual se muestra primero; la lectura original
                  -- queda debajo, visible, no reemplazada.
                  ORDER BY field_path, (method = 'MANUAL') DESC`,
                [ultima],
              );

        const hallazgos =
          ultima === undefined
            ? { rows: [] }
            : await tx.query(
                `SELECT codigo, severidad, mensaje, campos, bloquea
                   FROM document_findings WHERE extraction_id = $1`,
                [ultima],
              );

        const duplicados = await tx.query(
          `SELECT id, duplicate_of_id AS "duplicadoDe", nivel, explicacion, bloquea,
                  resolucion, resuelto_por AS "resueltoPor", motivo
             FROM document_duplicates WHERE document_id = $1`,
          [params.documentId],
        );

        return {
          documento: documento.rows[0],
          extracciones: extracciones.rows,
          campos: campos.rows,
          hallazgos: hallazgos.rows,
          duplicados: duplicados.rows,
        };
      },
    );
  });

  app.get('/documents/:documentId/content', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'document:download');
    const auth = requireAuth(request);
    const params = z.object({ documentId: z.string().uuid() }).parse(request.params);

    const fila = await withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query<{ storage_key: string; mime: string; original_name: string }>(
          'SELECT storage_key, mime, original_name FROM documents WHERE id = $1',
          [params.documentId],
        );
        if (result.rowCount === 0) throw notFound('Documento no encontrado');
        return result.rows[0]!;
      },
    );

    // Cinturón y tirantes sobre RLS: la clave tiene que pertenecer a la empresa
    // en contexto. Si RLS fallara, el archivo igual no sale.
    if (!claveEsDeEmpresa(tenant.companyId, fila.storage_key)) throw notFound('Documento no encontrado');

    const bytes = await store.get(tenant.companyId, fila.storage_key);
    reply.header('Content-Type', fila.mime);
    // `attachment` y no `inline`: un HTML o un SVG servido inline se ejecutaría
    // en el origen de la aplicación.
    reply.header('Content-Disposition', `attachment; filename="${sanitizarNombre(fila.original_name)}"`);
    return reply.send(bytes);
  });

  app.post('/documents/:documentId/fields', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'document:upload');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const params = z.object({ documentId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        extractionId: z.string().uuid(),
        fieldPath: z.string().min(1).max(120),
        rawValue: z.string().min(1).max(2000),
        parsedValue: z.unknown().optional(),
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const pertenece = await tx.query(
        'SELECT 1 FROM document_extractions WHERE id = $1 AND document_id = $2',
        [body.extractionId, params.documentId],
      );
      if (pertenece.rowCount === 0) throw notFound('Extracción no encontrada para ese documento');

      try {
        const insertado = await tx.query<{ id: string }>(
          `INSERT INTO document_extraction_fields
             (company_id, extraction_id, field_path, raw_value, parsed_value,
              confidence, method, nota)
           VALUES ($1, $2, $3, $4, $5, 1, 'MANUAL', $6)
           RETURNING id`,
          [
            tenant.companyId,
            body.extractionId,
            body.fieldPath,
            body.rawValue,
            body.parsedValue === undefined ? null : JSON.stringify(body.parsedValue),
            body.motivo,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CORREGIR_CAMPO_EXTRAIDO',
          objectType: 'document_extraction_field',
          objectId: insertado.rows[0]!.id,
          newValue: { fieldPath: body.fieldPath, rawValue: body.rawValue },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return { id: insertado.rows[0]!.id, method: 'MANUAL' };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('Ya hay una corrección manual para ese campo en esta extracción');
        }
        throw error;
      }
    });
  });

  app.post('/documents/:documentId/duplicates/:duplicateId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'document:upload');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const params = z
      .object({ documentId: z.string().uuid(), duplicateId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        resolucion: z.enum(['ES_DUPLICADO', 'NO_ES_DUPLICADO']),
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const actualizado = await tx.query(
        `UPDATE document_duplicates
            SET resolucion = $3, resuelto_por = $4, resuelto_en = now(), motivo = $5
          WHERE id = $1 AND document_id = $2 AND resolucion IS NULL
          RETURNING id, nivel, resolucion`,
        [params.duplicateId, params.documentId, body.resolucion, actorId, body.motivo],
      );
      if (actualizado.rowCount === 0) {
        throw notFound('No hay un duplicado sin resolver con ese identificador');
      }

      if (body.resolucion === 'ES_DUPLICADO') {
        await tx.query(
          `UPDATE documents
              SET status = 'ANULADO', voided_at = now(), voided_by = $2,
                  void_reason = $3
            WHERE id = $1 AND status <> 'IMPUTADO'`,
          [params.documentId, actorId, `Duplicado confirmado: ${body.motivo}`],
        );
      }

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'RESOLVER_DUPLICADO',
        objectType: 'document',
        objectId: params.documentId,
        newValue: actualizado.rows[0],
        motivo: body.motivo,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return actualizado.rows[0];
    });
  });
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

interface Persistido {
  readonly documentId: string;
  readonly extractionId: string | null;
  readonly yaExistia: boolean;
}

async function guardar(
  tx: Tx,
  companyId: string,
  actorId: string,
  resultado: Extract<Awaited<ReturnType<typeof ingerir>>, { ok: true }>,
): Promise<Persistido> {
  const { documento, extraccion, hallazgos, duplicados } = resultado;

  const insertado = await tx.query<{ id: string }>(
    `INSERT INTO documents
       (company_id, storage_key, sha256, bytes, mime, content_type, original_name,
        source, risk_flags, uploaded_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (company_id, sha256) DO NOTHING
     RETURNING id`,
    [
      companyId,
      documento.storageKey,
      documento.sha256,
      documento.bytes,
      documento.mime,
      documento.tipo,
      documento.nombreOriginal,
      documento.origen,
      JSON.stringify(documento.riesgos),
      actorId,
      extraccion.disponible ? 'EXTRAIDO' : 'RECIBIDO',
    ],
  );

  if (insertado.rowCount === 0) {
    const existente = await tx.query<{ id: string }>(
      'SELECT id FROM documents WHERE company_id = $1 AND sha256 = $2',
      [companyId, documento.sha256],
    );
    return { documentId: existente.rows[0]!.id, extractionId: null, yaExistia: true };
  }

  const documentId = insertado.rows[0]!.id;

  const extraccionFila = await tx.query<{ id: string }>(
    `INSERT INTO document_extractions
       (company_id, document_id, engine, engine_version, available, unavailable_reason,
        overall_confidence, raw_payload, finished_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
     RETURNING id`,
    [
      companyId,
      documentId,
      extraccion.motor,
      extraccion.motorVersion,
      extraccion.disponible,
      extraccion.motivoNoDisponible ?? null,
      extraccion.disponible ? extraccion.confianzaGlobal : null,
      extraccion.payloadCrudo === undefined ? null : JSON.stringify(extraccion.payloadCrudo),
      actorId,
    ],
  );
  const extractionId = extraccionFila.rows[0]!.id;

  for (const campo of extraccion.campos) {
    await insertarCampo(tx, companyId, extractionId, campo);
  }

  for (const hallazgo of hallazgos) {
    await tx.query(
      `INSERT INTO document_findings
         (company_id, extraction_id, codigo, severidad, mensaje, campos, bloquea)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        companyId,
        extractionId,
        hallazgo.codigo,
        hallazgo.severidad,
        hallazgo.mensaje,
        hallazgo.campos,
        hallazgo.bloquea,
      ],
    );
  }

  for (const duplicado of duplicados) {
    // El nivel `ARCHIVO_IDENTICO` no llega acá: ese caso se resolvió arriba, con
    // el conflicto de `sha256`. Lo que se registra son duplicados lógicos.
    await tx.query(
      `INSERT INTO document_duplicates
         (company_id, document_id, duplicate_of_id, nivel, explicacion, bloquea)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (document_id, duplicate_of_id, nivel) DO NOTHING`,
      [
        companyId,
        documentId,
        duplicado.documentIdExistente,
        duplicado.nivel,
        duplicado.explicacion,
        duplicado.bloquea,
      ],
    );
  }

  return { documentId, extractionId, yaExistia: false };
}

async function insertarCampo(
  tx: Tx,
  companyId: string,
  extractionId: string,
  campo: CampoExtraido,
): Promise<void> {
  await tx.query(
    `INSERT INTO document_extraction_fields
       (company_id, extraction_id, field_path, raw_value, parsed_value, confidence,
        method, page, bbox, nota)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (extraction_id, field_path, method) DO NOTHING`,
    [
      companyId,
      extractionId,
      campo.fieldPath,
      campo.rawValue,
      campo.parsedValue === null ? null : JSON.stringify(campo.parsedValue),
      campo.confidence,
      campo.method,
      campo.page ?? null,
      campo.bbox === undefined ? null : JSON.stringify(campo.bbox),
      campo.nota ?? null,
    ],
  );
}

/** Huellas de los documentos ya cargados, para deduplicar. */
async function huellasDe(companyId: string, actorId: string): Promise<readonly HuellaDocumento[]> {
  return withCompany({ companyId, actorId }, async (tx) => {
    const result = await tx.query<{
      id: string;
      sha256: string;
      total: string | null;
      moneda: string | null;
      fecha: string | null;
      cuit: string | null;
    }>(
      `SELECT d.id, d.sha256,
              max(f.parsed_value ->> 'amount')   FILTER (WHERE f.field_path = 'importes.total')      AS total,
              max(f.parsed_value ->> 'currency') FILTER (WHERE f.field_path = 'importes.total')      AS moneda,
              max(f.parsed_value ->> 'value')    FILTER (WHERE f.field_path = 'comprobante.fecha')   AS fecha,
              max(f.parsed_value ->> 'value')    FILTER (WHERE f.field_path = 'emisor.cuit')         AS cuit
         FROM documents d
         LEFT JOIN document_extractions e ON e.document_id = d.id
         LEFT JOIN document_extraction_fields f ON f.extraction_id = e.id
        WHERE d.company_id = $1 AND d.status <> 'ANULADO'
        GROUP BY d.id, d.sha256
        ORDER BY d.received_at DESC
        LIMIT 2000`,
      [companyId],
    );

    return result.rows.map((fila) => ({
      documentId: fila.id,
      sha256: fila.sha256,
      ...(fila.total !== null ? { total: fila.total } : {}),
      ...(fila.moneda !== null ? { moneda: fila.moneda } : {}),
      ...(fila.fecha !== null ? { fecha: fila.fecha } : {}),
      ...(fila.cuit !== null ? { cuitContraparte: fila.cuit } : {}),
    }));
  });
}

function campoDeTexto(fields: unknown, nombre: string): string | undefined {
  if (fields === null || typeof fields !== 'object') return undefined;
  const campo = (fields as Record<string, unknown>)[nombre];
  if (campo === null || typeof campo !== 'object') return undefined;
  const valor = (campo as { value?: unknown }).value;
  return typeof valor === 'string' ? valor : undefined;
}

/** El nombre viaja en una cabecera: se le sacan comillas, saltos y rutas. */
function sanitizarNombre(nombre: string): string {
  return nombre.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}
