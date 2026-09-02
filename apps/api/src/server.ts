import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError, tooManyRequests } from './http/errors.js';
import { attachContext } from './http/context.js';
import { contarFallo, puedeIntentar } from './http/limite-de-intentos.js';
// La comparación en tiempo constante ya existe: duplicarla habría dejado dos
// implementaciones de lo mismo, y la segunda sin los tests de la primera.
import { constantTimeEquals } from './auth/crypto.js';
import { exponerMetricas, registrarPedido } from './observabilidad.js';
import { accountRoutes } from './routes/accounts.js';
import { afectacionRoutes } from './routes/afectaciones.js';
import { arcaRoutes } from './routes/arca.js';
import { authRoutes } from './routes/auth.js';
import { documentRoutes } from './routes/documents.js';
import { bankRoutes } from './routes/banks.js';
import { statementRoutes } from './routes/statements.js';
import { bookRoutes } from './routes/books.js';
import { noteRoutes } from './routes/notes.js';
import { closureRoutes } from './routes/closures.js';
import { journalEntryRoutes } from './routes/journal-entries.js';
import { decisionRoutes } from './routes/decisions.js';
import { comprobanteRoutes } from './routes/comprobantes.js';
import { vatRoutes } from './routes/vat.js';
import { periodRoutes } from './routes/periods.js';
import { predictionRoutes } from './routes/predictions.js';
import { studioRoutes } from './routes/studio.js';
import { workQueueRoutes } from './routes/work-queue.js';
import { auditRoutes } from './routes/audit.js';
import { partyRoutes } from './routes/parties.js';
import { productRoutes } from './routes/products.js';
import { comercialRoutes, vincularFacturaDeCompra } from './routes/comercial.js';
import { recepcionRoutes } from './routes/recepciones.js';
import { imputacionRoutes } from './routes/imputaciones.js';
import { stockRoutes } from './routes/stock.js';
import { activoRoutes } from './routes/activos.js';
import { integracionRoutes } from './routes/integraciones.js';
import { analiticaRoutes } from './routes/analitica.js';
import { analisisRoutes } from './routes/analisis.js';
import { precioRoutes } from './routes/precios.js';
import { chequeRoutes } from './routes/cheques.js';
import { recuentoRoutes } from './routes/recuentos.js';
import { cajaRoutes } from './routes/caja.js';
import { crmRoutes } from './routes/crm.js';
import { proyectoRoutes } from './routes/proyectos.js';
import { comisionRoutes } from './routes/comisiones.js';
import { sucursalRoutes } from './routes/sucursales.js';
import { suscripcionRoutes } from './routes/suscripciones.js';
import { mapeoContableRoutes } from './routes/mapeo-contable.js';
import { arranqueRoutes } from './routes/arranque.js';
import { ordenDePagoRoutes } from './routes/ordenes-de-pago.js';
import { valuacionRoutes } from './routes/valuacion.js';
import { exportacionRoutes } from './routes/exportaciones.js';

/**
 * Las rutas donde un intento cuesta poco y probar mil sale gratis.
 *
 * No es toda la API: limitar una lectura de la bandeja castigaría a una empresa
 * que trabaja rápido. Son las tres que aceptan credenciales.
 */
const RUTAS_LIMITADAS = new Set([
  '/auth/login',
  '/auth/mfa/verify',
  '/auth/register-first-admin',
]);

/**
 * La clave del límite: origen y ruta.
 *
 * Por origen, para que un atacante no deje afuera a toda la clientela con un
 * script; y por ruta, para que quedarse sin intentos de contraseña no impida
 * confirmar el segundo factor a alguien que ya entró bien.
 */
function claveDeLimite(ip: string, url: string): string {
  return `${ip} ${url.split('?')[0]}`;
}

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

  // ── Métricas ─────────────────────────────────────────────────────────────
  // Se mide en el borde, no adentro de cada ruta: una métrica que hay que
  // acordarse de agregar en cada endpoint nuevo mide lo que alguien se acordó.
  //
  // La etiqueta es la **plantilla** de la ruta y no la url: con la url
  // concreta, el recolector guardaría los identificadores de cada empresa.
  app.addHook('onResponse', async (request, reply) => {
    // El límite cuenta **fallos**, no pedidos: el que entra bien no consume
    // presupuesto. Se cuenta acá porque recién ahora se sabe cómo terminó.
    if (RUTAS_LIMITADAS.has(request.url.split('?')[0] ?? '') && reply.statusCode >= 400) {
      contarFallo(claveDeLimite(request.ip, request.url), 60);
    }

    registrarPedido(
      request.method,
      request.routeOptions.url ?? 'desconocida',
      reply.statusCode,
      Math.round(reply.elapsedTime),
    );
  });

  /**
   * El recolector, si hay token declarado.
   *
   * Sin `METRICS_TOKEN` la ruta **no existe**: contesta 404 como cualquier otra
   * inexistente. No se deja abierta «porque son solo contadores»: dicen cuántas
   * empresas operan, a qué hora y con qué volumen.
   */
  app.get('/metrics', async (request, reply) => {
    const declarado = config.metricsToken;
    const presentado = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

    if (declarado === null || !constantTimeEquals(presentado, declarado)) {
      // La misma respuesta con token mal puesto que sin la función habilitada:
      // distinguirlas diría si el recolector está configurado.
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'No existe' });
    }

    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(exponerMetricas());
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    // La API no sirve HTML; una CSP restrictiva no cuesta nada.
    reply.header('Content-Security-Policy', "default-src 'none'");

    // El límite va **antes** de buscar la sesión: si no, cada intento de fuerza
    // bruta seguiría costando una consulta a la base, que es justo lo que un
    // atacante quiere.
    if (RUTAS_LIMITADAS.has(request.url.split('?')[0] ?? '')) {
      const decision = puedeIntentar(
        claveDeLimite(request.ip, request.url),
        config.login.maxPorMinutoPorOrigen,
        60,
      );
      if (!decision.permitido) {
        reply.header('retry-after', String(decision.esperar));
        throw tooManyRequests(
          `Demasiados intentos desde este origen. Probá de nuevo en ${decision.esperar} ` +
            'segundos. El límite es por origen y por minuto, y es independiente del bloqueo ' +
            'de la cuenta.',
        );
      }
    }

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
  await app.register(partyRoutes);
  await app.register(productRoutes);
  await app.register(comercialRoutes);
  await app.register(vincularFacturaDeCompra);
  await app.register(recepcionRoutes);
  await app.register(imputacionRoutes);
  await app.register(stockRoutes);
  await app.register(activoRoutes);
  await app.register(integracionRoutes);
  await app.register(analiticaRoutes);
  await app.register(analisisRoutes);
  await app.register(precioRoutes);
  await app.register(chequeRoutes);
  await app.register(recuentoRoutes);
  await app.register(cajaRoutes);
  await app.register(crmRoutes);
  await app.register(proyectoRoutes);
  await app.register(comisionRoutes);
  await app.register(sucursalRoutes);
  await app.register(suscripcionRoutes);
  await app.register(mapeoContableRoutes);
  await app.register(arranqueRoutes);
  await app.register(ordenDePagoRoutes);
  await app.register(valuacionRoutes);
  await app.register(exportacionRoutes);
  await app.register(periodRoutes);
  await app.register(documentRoutes);
  await app.register(predictionRoutes);
  await app.register(journalEntryRoutes);
  await app.register(decisionRoutes);
  await app.register(comprobanteRoutes);
  await app.register(afectacionRoutes);
  await app.register(arcaRoutes);
  await app.register(bookRoutes);
  await app.register(closureRoutes);
  await app.register(vatRoutes);
  await app.register(bankRoutes);
  await app.register(statementRoutes);
  await app.register(noteRoutes);
  await app.register(workQueueRoutes);
  await app.register(auditRoutes);

  return app;
}
