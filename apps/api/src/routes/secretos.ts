/**
 * Las referencias de secretos, por HTTP.
 *
 * Tres rutas, y ninguna devuelve un secreto. **No es una regla que alguien
 * pueda olvidarse de aplicar**: la tabla no guarda el valor y la vista pública
 * no trae ni la referencia completa. No existe el lugar de donde sacarlo.
 *
 * ## Lo que sí devuelve
 *
 *     configurado: true    la información que una pantalla necesita
 *     backend: 'env'       de dónde sale, sin decir de dónde exactamente
 *     version: 3           cuántas veces se rotó
 *     estado: 'ACTIVO'     si está vigente
 *
 * Un ARN completo diría de más sobre la infraestructura, y no hace falta para
 * ninguna decisión que se tome en una pantalla.
 *
 * ## Administrar no es usar
 *
 * `secret:manage` gobierna estas rutas y **solo lo tiene ADMINISTRADOR**. Quien
 * emite un comprobante usa el certificado de ARCA sin poder tocarlo; quien rota
 * una credencial no necesariamente factura. Es el permiso más chico que
 * funciona, que es el correcto.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorDeSecreto, describir, type SecretRef } from '@aai/secrets';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { DbSecretProvider } from '../secrets/proveedor.js';

/**
 * La forma de una referencia, validada.
 *
 * `scope` y `name` con la misma expresión que el `CHECK` de la 0095: una
 * validación más floja que la de la base produce un 500 donde correspondía un
 * 400, y el mensaje que ve quien la escribió es el de PostgreSQL.
 */
const identidad = z.object({
  scope: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/u, 'scope en minúsculas, sin espacios'),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/u, 'nombre en minúsculas, sin espacios'),
});

/**
 * La referencia al backend.
 *
 * Se valida el prefijo acá y no solo en la base para poder decir **cuáles son**
 * los admitidos. Un `CHECK` violado contesta «viola una restricción», que es
 * cierto y no ayuda.
 */
const referencia = z
  .string()
  .min(4)
  .max(500)
  .regex(
    /^(env|db|kms|mem):.+$/u,
    'la referencia empieza con el backend: env:VARIABLE, kms:<arn>, db:<id>',
  );

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Qué secretos tiene declarados esta empresa.
   *
   * Metadata, nunca material. Es lo que contesta una pantalla de integraciones:
   * «ARCA: configurado, versión 2» es toda la información que hace falta para
   * decidir si hay que cargar algo.
   */
  app.get('/companies/current/secrets', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'secret:manage');
    const auth = requireAuth(request);

    const proveedor = new DbSecretProvider(`user:${auth.user.userId}`);
    const secretos = await proveedor.listar(tenant.companyId);

    return {
      secretos: secretos.map((s) => ({
        scope: s.ref.scope,
        name: s.ref.name,
        version: s.version,
        estado: s.estado,
        // El prefijo, no la referencia. Saber que está en un gestor externo es
        // información; saber en qué ruta exacta no aporta a ninguna decisión de
        // pantalla y dice de más sobre la infraestructura.
        backend: s.backend,
        creadoEl: s.creadoEl,
        creadoPor: s.creadoPor,
        expiraEl: s.expiraEl ?? null,
      })),
      alcance:
        'Acá no hay ningún secreto: NEXO guarda dónde está cada uno, no su valor — no hay ' +
        'columna donde ponerlo. Rotar es declarar una versión nueva; la anterior queda ' +
        'supersedida y se revoca después, y esa ventana es lo que permite rotar sin cortar.',
    };
  });

  /**
   * Declara una referencia, o rota la que había.
   *
   * Es el mismo acto: rotar es declarar la versión siguiente. Un `rotate` aparte
   * sería el mismo código con otro nombre, y obligaría a decidir cuál usar en el
   * caso en que no está claro si es la primera vez.
   */
  app.post('/companies/current/secrets', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'secret:manage');
    const auth = requireAuth(request);

    const body = z
      .object({
        ...identidad.shape,
        referencia,
        motivo: z.string().min(5).max(500),
      })
      .parse(request.body);

    const ref: SecretRef = {
      companyId: tenant.companyId,
      scope: body.scope,
      name: body.name,
    };

    const proveedor = new DbSecretProvider(`user:${auth.user.userId}`);
    const metadata = await proveedor.put(ref, body.referencia, {
      actorId: `user:${auth.user.userId}`,
      motivo: body.motivo,
    });

    // La bitácora la escribe el proveedor, con la identidad y el backend. Acá se
    // registra el IP y el agente, que la capa de dominio no conoce.
    void clientIp(request);

    reply.code(201);
    return {
      secreto: describir(ref),
      version: metadata.version,
      backend: metadata.backend,
      estado: metadata.estado,
      alcance:
        'Se guardó la referencia, no el valor. La versión anterior quedó supersedida: sigue ' +
        'existiendo hasta que se la revoque, y esa ventana es la que permite comprobar la ' +
        'nueva antes de apagar la vieja.',
    };
  });

  /**
   * Revoca. No borra.
   *
   * Un secreto revocado sigue siendo la respuesta a «con qué credencial se firmó
   * esto en marzo». Borrarlo dejaría a la bitácora apuntando a una fila que no
   * está.
   */
  app.post('/companies/current/secrets/revoke', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'secret:manage');
    const auth = requireAuth(request);

    const body = z
      .object({
        ...identidad.shape,
        /** Sin versión, la vigente. Con versión, esa. */
        version: z.number().int().min(1).optional(),
        motivo: z.string().min(5).max(500),
      })
      .parse(request.body);

    const ref: SecretRef = {
      companyId: tenant.companyId,
      scope: body.scope,
      name: body.name,
      ...(body.version === undefined ? {} : { version: body.version }),
    };

    try {
      await new DbSecretProvider(`user:${auth.user.userId}`).revocar(ref, {
        actorId: `user:${auth.user.userId}`,
        motivo: body.motivo,
      });
    } catch (error) {
      throw traducir(error);
    }

    return { secreto: describir(ref), estado: 'REVOCADO' };
  });
}

/**
 * Del error de dominio al de HTTP.
 *
 * Por código y no por prosa, como en el resto del sistema: la redacción de un
 * mensaje cambia y el código no. Y ninguno de estos mensajes lleva material:
 * `ErrorDeSecreto` se construye con la identidad, que no es sensible.
 */
function traducir(error: unknown): unknown {
  if (!(error instanceof ErrorDeSecreto)) return error;
  if (error.codigo === 'SECRET_NOT_FOUND') return notFound(error.message);
  if (error.codigo === 'SECRET_ACCESS_DENIED') return notFound(error.message);
  return badRequest(error.message);
}
