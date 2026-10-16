/**
 * `POST /companies/current/exportacion-completa` — todo lo de la empresa, en un ZIP.
 *
 * Qué entra, qué no y cómo se comprueba que no falta nada: `exportacion/empresa-completa.ts` y `docs/EXPORTACION_COMPLETA.md`.
 *
 * ## Por qué es un POST y exige motivo
 *
 * Es un acto: saca de NEXO la contabilidad entera. Un `GET` se puede disparar por error (un enlace, una precarga del
 * navegador); un `POST` con un motivo escrito no. Queda en la bitácora (`EXPORTAR_EMPRESA`) con el motivo y los totales.
 *
 * ## Cómo sale
 *
 * Armado en streaming: el ZIP se escribe a medida que se lee la base, así que el uso de memoria no depende del tamaño de la
 * empresa y no se escribe nada en disco. Si algo falla a mitad, la respuesta se **corta** (el archivo queda sin su
 * directorio central y ningún programa lo abre como ZIP válido): nunca se entrega un archivo que parezca completo y no lo
 * sea. La transacción confirma **después** de escribir el último byte: la bitácora y el archivo van juntos o no van.
 *
 * Una exportación por empresa a la vez (`409 EXPORTACION_EN_CURSO`) y un tope de tiempo: es lo más pesado que hace la API.
 */

import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { recordAudit, withCompany } from '@aai/db';
import { FilesystemDocumentStore } from '@aai/document-engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { exportarEmpresaCompleta } from '../exportacion/empresa-completa.js';
import { EscritorZip } from '../exportacion/zip-streaming.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflictoTipado } from '../http/errors.js';

/** Tope de tiempo de una exportación. */
const TOPE_MS = 20 * 60 * 1000;

/** Las empresas que están exportando ahora (por proceso: hay una sola instancia de la API). */
const exportando = new Set<string>();

export async function exportacionCompletaRoutes(app: FastifyInstance): Promise<void> {
  const almacen = new FilesystemDocumentStore(config.documents.storagePath);

  app.post('/companies/current/exportacion-completa', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'company:export');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const body = z
      .object({
        motivo: z.string().trim().min(5).max(500),
        incluirArchivos: z.boolean().default(true),
      })
      .parse(request.body ?? {});

    if (exportando.has(tenant.companyId)) {
      throw conflictoTipado(
        'EXPORTACION_EN_CURSO',
        'Ya hay una exportación de esta empresa en curso. Esperá a que termine antes de pedir otra.',
      );
    }
    exportando.add(tenant.companyId);

    const salida = new PassThrough();
    // Sin un oyente de `error`, un `destroy(error)` antes de que Fastify enganche el flujo tiraría el proceso entero.
    salida.on('error', () => undefined);
    const vencimiento = AbortSignal.timeout(TOPE_MS);
    let primerPedazo: () => void = () => undefined;
    const huboBytes = new Promise<void>((resolver) => {
      primerPedazo = resolver;
    });

    /** Escribe hacia el cliente respetando la contrapresión; si el cliente se fue o se pasó el tiempo, corta. */
    const sumidero = async (pedazo: Buffer): Promise<void> => {
      if (vencimiento.aborted) throw new Error('La exportación superó el tiempo máximo.');
      if (salida.destroyed) throw new Error('El cliente cerró la conexión.');
      primerPedazo();
      if (!salida.write(pedazo)) {
        await Promise.race([
          once(salida, 'drain'),
          once(salida, 'close').then(() => {
            throw new Error('El cliente cerró la conexión.');
          }),
        ]);
      }
    };

    const trabajo = withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const zip = new EscritorZip(sumidero);
      const resumen = await exportarEmpresaCompleta(tx, zip, {
        companyId: tenant.companyId,
        exportadoPor: actorId,
        motivo: body.motivo,
        incluirArchivos: body.incluirArchivos,
        almacen,
      });
      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'EXPORTAR_EMPRESA',
        objectType: 'companies',
        objectId: tenant.companyId,
        newValue: {
          tablas: resumen.tablas.length,
          filas: resumen.filasTotales,
          catalogos: resumen.catalogos.length,
          archivos: resumen.archivos.incluidos,
          archivosFaltantes: resumen.archivos.faltantes.length,
          noLegibles: resumen.noLegibles.length,
        },
        motivo: body.motivo,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });
    });

    // El archivo termina recién cuando la transacción confirmó: si confirmar falla, la respuesta se corta.
    void trabajo
      .then(() => salida.end())
      .catch((error: unknown) => salida.destroy(error instanceof Error ? error : new Error('Falló la exportación.')))
      .finally(() => exportando.delete(tenant.companyId));

    // Si falla antes de producir el primer byte (la empresa no existe, un permiso), se contesta como un error común y no
    // como una respuesta 200 vacía. Si falla después, la respuesta ya empezó y se corta.
    try {
      await Promise.race([huboBytes, trabajo]);
    } catch (error) {
      salida.destroy();
      throw error;
    }

    // Sin fecha en el nombre: la fecha del archivo es la del manifiesto (sale de la base) y la consola la agrega al guardar.
    void reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="nexo-exportacion.zip"')
      .header('cache-control', 'no-store');
    return reply.send(salida);
  });
}
