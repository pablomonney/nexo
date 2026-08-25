import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './http/errors.js';
import { attachContext } from './http/context.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/documents.js';
import { bookRoutes } from './routes/books.js';
import { journalEntryRoutes } from './routes/journal-entries.js';
import { periodRoutes } from './routes/periods.js';
import { predictionRoutes } from './routes/predictions.js';
import { studioRoutes } from './routes/studio.js';

export interface RouteEntry {
  readonly method: string;
  readonly url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Inventario de rutas registradas.
     *
     * Existe para que el test de aislamiento pueda recorrer **todos** los
     * endpoints en vez de una lista escrita a mano que se desactualiza en cuanto
     * alguien agrega una ruta y se olvida de sumarla. El criterio de salida de la
     * FASE 2 es "cero fugas sobre todos los endpoints", y "todos" tiene que ser
     * comprobable.
     */
    routeTable: RouteEntry[];
  }
}

export async function buildServer(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Sin esto, un proxy podría inyectar cabeceras de identidad.
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  app.decorate('routeTable', [] as RouteEntry[]);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      app.routeTable.push({ method, url: route.url });
    }
  });

  await app.register(cookie);

  // El límite de cuerpo general es de 1 MB; los documentos escaneados no entran
  // ahí. Multipart tiene su propio tope, y sube un solo archivo por petición:
  // un lote de cien facturas son cien peticiones, cada una con su resultado.
  await app.register(multipart, {
    limits: { fileSize: config.documents.maxBytes, files: 1, fields: 8 },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    // La API no sirve HTML; una CSP restrictiva no cuesta nada.
    reply.header('Content-Security-Policy', "default-src 'none'");
    await attachContext(request);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message, details: error.details });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Datos inválidos',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    // Nunca se filtra el detalle interno al cliente: un mensaje de PostgreSQL
    // puede revelar nombres de tablas, constraints y hasta datos de la fila.
    request.log.error({ err: error }, 'error no controlado');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Error interno' });
  });

  await app.register(authRoutes);
  await app.register(studioRoutes);
  await app.register(accountRoutes);
  await app.register(periodRoutes);
  await app.register(documentRoutes);
  await app.register(predictionRoutes);
  await app.register(journalEntryRoutes);
  await app.register(bookRoutes);

  return app;
}
