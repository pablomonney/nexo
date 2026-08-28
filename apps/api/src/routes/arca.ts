/**
 * Los certificados de ARCA de una empresa: cargar, listar, rotar, revocar.
 *
 * ## La regla que gobierna este archivo
 *
 * SECURITY.md §27, literal: *«Nunca almacenar claves privadas, tokens o
 * credenciales en el repositorio.»* Por eso la clave entra **en tiempo de
 * ejecución**, por esta ruta, y no por un archivo versionado ni por una variable
 * de entorno con el PEM adentro.
 *
 * Y una vez adentro no vuelve a salir. Nunca:
 *
 * - la respuesta de cualquier endpoint de este archivo sale de la vista
 *   `company_arca_credentials_public`, que **no tiene** las columnas del
 *   certificado ni de la clave;
 * - la clave se guarda envuelta y se desenvuelve solo en `DbCredentialStore`,
 *   por el tiempo de una firma;
 * - ni el PEM ni la clave aparecen en un mensaje de error ni en la bitácora: lo
 *   que se audita es el acto y la huella, no el material.
 *
 * ## Qué queda pendiente y por qué no se disimula
 *
 * El sobre real que pide el §5 —DEK por empresa envuelta con la KEK del KMS—
 * necesita un cliente de KMS que no existe. Mientras tanto se envuelve con la
 * llave del entorno y `key_encryption_ref` lo dice: `local:dev`. En producción
 * `envolver()` y `desenvolver()` se niegan a funcionar con esa referencia, así
 * que el sistema no puede fingir una protección que no tiene.
 */

import { createHash } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { envolver } from '../arca/credential-store.js';
import { config } from '../config.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflictoTipado, notFound } from '../http/errors.js';

/** Los servicios que el sistema sabe usar. Sale de `packages/arca`. */
const SERVICIOS = ['wsfe', 'wscdc', 'ws_sr_padron_a5', 'wsapoc'] as const;

export async function arcaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Cargar un certificado.
   *
   * No hay `PATCH`: un certificado no se edita. Rotar es cargar el nuevo y
   * revocar el viejo, que deja los dos en la tabla y permite saber cuál firmó
   * qué. Es el mismo criterio que las decisiones y las notas.
   */
  app.post('/companies/current/arca/credentials', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'arca_credential:manage');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;

    const body = z
      .object({
        /** Nombre con el que el estudio lo reconoce. No es un secreto. */
        alias: z.string().min(1).max(80),
        cuit: z.string().regex(/^\d{11}$/, 'El CUIT del contribuyente representado, 11 dígitos'),
        environment: z.enum(['homologacion', 'produccion']),
        certificatePem: z.string().min(64).max(20_000),
        privateKeyPem: z.string().min(64).max(20_000),
      })
      .parse(request.body);

    // El certificado se parsea acá y no se cree lo que diga el cuerpo: las
    // fechas de vigencia salen del X.509, que es el que manda. Aceptarlas del
    // pedido dejaría cargar un certificado vencido declarándolo vigente, y el
    // store lo entregaría convencido.
    let certificado: X509Certificate;
    try {
      certificado = new X509Certificate(body.certificatePem);
    } catch {
      throw badRequest(
        'El certificado no se pudo leer como X.509. Tiene que ser el PEM que devuelve ARCA, ' +
          'con sus líneas BEGIN/END CERTIFICATE.',
      );
    }

    const notBefore = new Date(certificado.validFrom);
    const notAfter = new Date(certificado.validTo);
    if (Number.isNaN(notAfter.getTime())) {
      throw badRequest('El certificado no declara una fecha de vencimiento legible');
    }
    if (notAfter.getTime() <= Date.now()) {
      throw conflictoTipado(
        'CERTIFICADO_VENCIDO',
        `El certificado venció el ${notAfter.toISOString().slice(0, 10)}. Cargar uno vencido ` +
          'solo produciría validaciones que fallan sin decir por qué.',
      );
    }

    // La clave tiene que ser la de este certificado. Sin esta comprobación, un
    // par mal armado se descubre recién cuando ARCA rechaza la firma, y el
    // mensaje de ese momento no dice nada útil.
    try {
      const { createPrivateKey } = await import('node:crypto');
      const privada = createPrivateKey(body.privateKeyPem);
      if (!certificado.checkPrivateKey(privada)) {
        throw new Error('par no coincidente');
      }
    } catch {
      throw badRequest(
        'La clave privada no corresponde a ese certificado. Revisá que sean el par que generó ' +
          'el mismo pedido de certificación.',
      );
    }

    const { envuelta, referencia } = envolver(body.privateKeyPem);

    // La huella del certificado —no la clave— es lo que se puede mostrar y
    // comparar sin exponer nada.
    const huella = createHash('sha256').update(certificado.raw).digest('hex');

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const fila = await tx.query<{ id: string }>(
        `INSERT INTO company_arca_credentials
           (company_id, environment, cuit, alias, certificate_pem, private_key_encrypted,
            key_encryption_ref, not_before, not_after, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10)
         RETURNING id`,
        [
          tenant.companyId,
          body.environment,
          body.cuit,
          body.alias,
          body.certificatePem,
          envuelta,
          referencia,
          notBefore.toISOString(),
          notAfter.toISOString(),
          actorId,
        ],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'CREDENCIAL_ARCA_CARGADA',
        objectType: 'company_arca_credentials',
        objectId: fila.rows[0]!.id,
        // Ni el PEM ni la clave. La huella identifica el certificado sin
        // reproducirlo, y las fechas explican por qué dejará de servir.
        newValue: {
          alias: body.alias,
          cuit: body.cuit,
          environment: body.environment,
          huellaSha256: huella,
          notAfter: notAfter.toISOString(),
          envoltura: referencia,
        },
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      reply.code(201);
      return {
        id: fila.rows[0]!.id,
        alias: body.alias,
        cuit: body.cuit,
        environment: body.environment,
        huellaSha256: huella,
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        envoltura: referencia,
        advertencia:
          referencia.startsWith('local:')
            ? 'Envuelta con la llave del entorno: sirve para desarrollo y homologación. En ' +
              'producción hace falta un cliente de KMS, que todavía no existe.'
            : null,
      };
    });
  });

  /**
   * Las credenciales de la empresa.
   *
   * Sale de la vista pública, que no tiene el certificado ni la clave. No es
   * una precaución del handler: la vista **no puede** devolverlos, así que un
   * descuido acá tampoco los filtra.
   */
  app.get('/companies/current/arca/credentials', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'arca_credential:manage');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT id, environment, cuit, alias, status,
                  not_before::text AS "notBefore", not_after::text AS "notAfter",
                  vencido, dias_restantes AS "diasRestantes",
                  created_at::text AS "createdAt", created_by AS "createdBy"
             FROM company_arca_credentials_public
            WHERE company_id = $1
            ORDER BY created_at DESC`,
          [tenant.companyId],
        );
        return { credenciales: r.rows };
      },
    );
  });

  /**
   * Revocar. No borra: apaga.
   *
   * Una credencial revocada tiene que seguir existiendo para que
   * `arca_query_log.credential_id` siga apuntando a algo, que es justamente lo
   * que permite contestar «¿qué firmó esta credencial antes de que la
   * revocáramos?» — la pregunta que se hace cuando una se compromete.
   */
  app.post<{ Params: { credentialId: string } }>(
    '/arca/credentials/:credentialId/revoke',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'arca_credential:manage');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { credentialId } = z
        .object({ credentialId: z.string().uuid() })
        .parse(request.params);
      const body = z
        .object({ motivo: z.string().min(10).max(500) })
        .parse(request.body);

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const actual = await tx.query<{ status: string; alias: string }>(
          'SELECT status, alias FROM company_arca_credentials WHERE id = $1',
          [credentialId],
        );
        if (actual.rowCount === 0) throw notFound('Credencial no encontrada');
        if (actual.rows[0]!.status === 'REVOKED') {
          throw conflictoTipado('YA_REVOCADA', 'Esa credencial ya está revocada');
        }

        await tx.query(
          `UPDATE company_arca_credentials
              SET status = 'REVOKED', revoked_at = now(), revoked_by = $2
            WHERE id = $1`,
          [credentialId, actorId],
        );

        const usos = await tx.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM arca_query_log WHERE credential_id = $1',
          [credentialId],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CREDENCIAL_ARCA_REVOCADA',
          objectType: 'company_arca_credentials',
          objectId: credentialId,
          oldValue: { status: actual.rows[0]!.status, alias: actual.rows[0]!.alias },
          newValue: { status: 'REVOKED', consultasFirmadas: Number(usos.rows[0]!.n) },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return {
          id: credentialId,
          status: 'REVOKED' as const,
          /** Cuántas consultas firmó: el alcance de lo que hay que revisar. */
          consultasFirmadas: Number(usos.rows[0]!.n),
        };
      });
    },
  );

  /**
   * Qué servicios de ARCA tiene habilitados la empresa.
   *
   * Un servicio sin autorizar en WSASS **no es un error del sistema**: es un
   * trámite pendiente del contribuyente, y el endpoint lo dice con esas
   * palabras. La alternativa —dejar que la consulta falle y traducir el error
   * del organismo— confundiría «no tenés permiso» con «el comprobante está mal».
   */
  app.get('/companies/current/arca/capabilities', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'company:read');
    const auth = requireAuth(request);

    // `mock` no tiene capacidades: el simulador contesta por sí mismo y no hay
    // trámite ante ARCA que relevar. Se consulta homologación —que es lo que el
    // estudio está tramitando— y se dice en qué ambiente está corriendo, para
    // que nadie lea «HABILITADO» y crea que el sistema está hablando con ARCA.
    const ambienteReal = config.arca.environment === 'mock' ? 'homologacion' : config.arca.environment;

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ service: string; enabled: boolean; notes: string | null }>(
          `SELECT service, enabled, notes, verified_at::text AS "verifiedAt",
                  last_probe_result AS "lastProbeResult"
             FROM company_arca_capabilities
            WHERE company_id = $1 AND environment = $2`,
          [tenant.companyId, ambienteReal],
        );

        const porServicio = new Map(r.rows.map((f) => [f.service, f]));

        return {
          /** En qué ambiente corre el sistema ahora mismo. */
          environment: config.arca.environment,
          /** De qué ambiente son las capacidades que se listan. */
          ambienteConsultado: ambienteReal,
          simulado: config.arca.environment === 'mock',
          servicios: SERVICIOS.map((s) => {
            const fila = porServicio.get(s);
            return {
              servicio: s,
              habilitado: fila?.enabled ?? false,
              // Sin fila no es «deshabilitado»: es que nadie lo relevó. Son
              // estados distintos y mandan a hacer cosas distintas.
              estado: fila === undefined ? 'NO_RELEVADO' : fila.enabled ? 'HABILITADO' : 'NO_AUTORIZADO',
              notas: fila?.notes ?? null,
              queHacer:
                fila?.enabled === true
                  ? null
                  : 'Autorizar el servicio en WSASS con la clave fiscal del contribuyente. Es un ' +
                    'trámite ante ARCA: el sistema no lo puede hacer por su cuenta.',
            };
          }),
        };
      },
    );
  });
}
