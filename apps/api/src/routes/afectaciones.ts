/**
 * La declaración profesional de afectación fiscal.
 *
 * El eslabón que faltaba, y faltaba entero: `tax_affectations` existe desde la
 * migración 0031 con sus tres triggers, su vista `tax_affectations_declaradas`,
 * su auditoría y sus tests — y **ninguna ruta la escribía**. Las únicas filas
 * del sistema las producían tres suites de integración.
 *
 * Sin esta ruta, el hecho `vinculadaConOperacionesGravadas` no puede pasar
 * nunca de AUSENTE a PROVISTO, y el circuito de IVA no se puede completar con el
 * producto aunque la regla estuviera ACTIVE. Es el mismo hallazgo que las notas
 * en su momento: modelo correcto, cero escritores.
 *
 * ## Qué NO hace este archivo
 *
 * No valida la evidencia. La base ya lo hace, y mejor: `assert_affectation_shape`
 * exige la forma, `assert_evidence_exists` comprueba que cada referencia apunte
 * a un objeto **de esta empresa** que exista de verdad, y `assert_affectation_tenant`
 * cierra el aro. Repetir esas reglas acá crearía una segunda definición que
 * puede divergir, y la que gobierna sería la que nadie revisó.
 *
 * Lo que sí hace es **traducir**: un `RAISE EXCEPTION` de un trigger es un 500
 * si nadie lo mira, y el §8 del pliego pide errores de dominio tipados. Cada
 * candado de la 0031 tiene acá su código y su mensaje.
 *
 * ## La declaración es un acto, no un dato
 *
 * `declarada_por` y `declarada_at` no vienen del cuerpo del pedido: los pone el
 * servidor a partir de quién está autenticado. Aceptarlos de afuera permitiría
 * firmar en nombre de otro, que es exactamente lo que una firma existe para
 * impedir.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflictoTipado, notFound, unprocessable } from '../http/errors.js';

/**
 * Los tipos de evidencia que la 0031 admite.
 *
 * Se repiten acá para poder rechazar en el borde con un 400 legible en vez de
 * dejar que el trigger conteste. La lista es la misma, y hay un test que lo
 * comprueba contra el catálogo de la base para que no puedan divergir.
 */
export const TIPOS_DE_EVIDENCIA = [
  'COMPROBANTE',
  'CUENTA',
  'CENTRO_DE_COSTO',
  'DOCUMENTO',
  'ASIENTO',
  'DECLARACION_PROFESIONAL',
  'NOTA',
] as const;

const itemDeEvidencia = z.union([
  z.object({
    tipo: z.literal('NOTA'),
    texto: z.string().min(10, 'Una NOTA necesita texto de al menos 10 caracteres'),
  }),
  z.object({
    tipo: z.enum([
      'COMPROBANTE',
      'CUENTA',
      'CENTRO_DE_COSTO',
      'DOCUMENTO',
      'ASIENTO',
      'DECLARACION_PROFESIONAL',
    ]),
    id: z.string().uuid('La evidencia referencia un id que no es un UUID'),
  }),
]);

const cuerpo = z
  .object({
    afectacion: z.enum(['GRAVADAS', 'EXENTAS', 'NO_GRAVADAS', 'MIXTA', 'NO_DETERMINADA']),

    /**
     * Solo para MIXTA, en centésimas de punto porcentual: 6550 = 65,50 %.
     *
     * Entero y no decimal, por la misma razón que los importes: la proporción
     * que reparte un crédito fiscal no puede tener error de redondeo.
     */
    proporcionGravada: z.number().int().min(0).max(10000).optional(),

    evidencia: z.array(itemDeEvidencia).max(50).default([]),

    /** Por qué se declara así. Queda en la bitácora junto al antes y el después. */
    motivo: z.string().min(10).max(2000).optional(),
  })
  .superRefine((valor, ctx) => {
    // El mismo par de reglas que el CHECK de la 0031, adelantado al borde para
    // que el error diga qué corregir en vez de nombrar una restricción.
    if (valor.afectacion === 'MIXTA' && valor.proporcionGravada === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proporcionGravada'],
        message:
          'Una afectación MIXTA exige la proporción gravada: es la medida del cómputo, y sin ella ' +
          'la declaración no dice cuánto se computa.',
      });
    }
    if (valor.afectacion !== 'MIXTA' && valor.proporcionGravada !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proporcionGravada'],
        message: `La proporción gravada solo tiene sentido en MIXTA, y esta declaración es ${valor.afectacion}.`,
      });
    }
  });

interface AfectacionLeida {
  id: string;
  afectacion: string;
  origen: string;
  proporcion_gravada: number | null;
  evidencia: readonly unknown[];
  declarada_por: string | null;
  declarada_at: string | null;
  updated_at: string;
}

const SELECCION = `
  SELECT id, afectacion, origen, proporcion_gravada, evidencia,
         declarada_por, declarada_at::text, updated_at::text
    FROM tax_affectations
   WHERE tax_transaction_id = $1`;

/**
 * Traduce los candados de la 0031 a errores de dominio.
 *
 * Sin esto cada trigger contesta 500. Con esto, quien llama sabe si le falta
 * evidencia, si la referencia no existe, o si está pisando una declaración de
 * otra empresa — que son tres cosas distintas y mandan a hacer tres cosas
 * distintas.
 */
function traducir(error: unknown): never {
  const falla = error as { code?: string; message?: string; constraint?: string };
  const mensaje = falla.message ?? '';

  if (falla.constraint === 'tax_affectations_tax_transaction_id_key') {
    throw conflictoTipado(
      'AFECTACION_YA_DECLARADA',
      'Esta operación fiscal ya tiene una afectación declarada. Una operación, una declaración: ' +
        'corregirla es reemplazarla explícitamente, no declararla dos veces.',
    );
  }

  if (/no puede ser solo notas/.test(mensaje)) {
    throw unprocessable(
      'EVIDENCIA_SIN_REFERENCIA',
      'La evidencia no puede ser solo notas: hace falta al menos una referencia a un objeto del ' +
        'sistema. Un texto libre explica una declaración; no la respalda.',
    );
  }

  if (/necesita al menos un ítem de evidencia/.test(mensaje)) {
    throw unprocessable(
      'EVIDENCIA_REQUERIDA',
      'Una declaración profesional necesita al menos un ítem de evidencia. La única afectación que ' +
        'se admite sin respaldo es NO_DETERMINADA, que es decir "todavía no lo sé".',
    );
  }

  if (/que no existe en esta empresa/.test(mensaje)) {
    throw unprocessable(
      'EVIDENCIA_INEXISTENTE',
      `${mensaje}. Un id que no apunta a nada es peor que ninguna evidencia: se ve como respaldo.`,
    );
  }

  if (/pertenece a otra empresa|otra empresa/.test(mensaje)) {
    throw notFound('La operación fiscal no existe');
  }

  throw error;
}

export async function afectacionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Declarar la afectación de un comprobante.
   *
   * `origen` es siempre `DECLARACION_PROFESIONAL`: esta ruta es la que firma.
   * Las sugerencias por precedente entran por otro camino y **nunca** por acá,
   * porque la diferencia entre las dos es justamente que una tiene firma.
   */
  app.post<{ Params: { taxTransactionId: string } }>(
    '/tax-transactions/:taxTransactionId/afectacion',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'tax_affectation:declare');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { taxTransactionId } = z
        .object({ taxTransactionId: z.string().uuid() })
        .parse(request.params);
      const body = cuerpo.parse(request.body ?? {});

      // El try envuelve a `withCompany` **entero**, y no solo al INSERT.
      //
      // `tax_affectations_evidence` es un CONSTRAINT TRIGGER DEFERRABLE: no
      // dispara al insertar sino en el COMMIT, que lo hace `withCompany`. Un
      // try alrededor del `tx.query` no lo atrapa nunca, y el rechazo salía como
      // 500 — el mismo defecto que la fase anterior encontró con el período
      // BLOQUEADO, en otro lugar.
      try {
        return await declarar();
      } catch (error) {
        traducir(error);
      }

      async function declarar(): Promise<unknown> {
      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        // El RLS ya limita la consulta a la empresa en contexto: si la operación
        // es de otra, acá no aparece, y para quien pregunta no existe.
        const operacion = await tx.query<{ id: string }>(
          'SELECT id FROM tax_transactions WHERE id = $1',
          [taxTransactionId],
        );
        if (operacion.rowCount === 0) throw notFound('La operación fiscal no existe');

        const anterior = await tx.query<AfectacionLeida>(SELECCION, [taxTransactionId]);

        let creada: AfectacionLeida;
        try {
          const insercion = await tx.query<AfectacionLeida>(
            `INSERT INTO tax_affectations
               (company_id, tax_transaction_id, afectacion, proporcion_gravada, evidencia,
                origen, declarada_por, declarada_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, 'DECLARACION_PROFESIONAL', $6, now())
             RETURNING id, afectacion, origen, proporcion_gravada, evidencia,
                       declarada_por, declarada_at::text, updated_at::text`,
            [
              tenant.companyId,
              taxTransactionId,
              body.afectacion,
              body.proporcionGravada ?? null,
              JSON.stringify(body.evidencia),
              auth.user.email,
            ],
          );
          creada = insercion.rows[0]!;
        } catch (error) {
          traducir(error);
        }

        // La auditoría de la fila la escribe el trigger `audit_tax_affectation`
        // (0031). Esta entrada es la del **acto por HTTP**: quién lo pidió, desde
        // dónde y con qué motivo, que el trigger no puede saber.
        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'DECLARAR_AFECTACION',
          objectType: 'tax_affectations',
          objectId: creada.id,
          oldValue: anterior.rows[0] ?? null,
          newValue: {
            afectacion: creada.afectacion,
            proporcionGravada: creada.proporcion_gravada,
            evidencia: creada.evidencia,
            taxTransactionId,
          },
          ...(body.motivo === undefined ? {} : { motivo: body.motivo }),
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          id: creada.id,
          afectacion: creada.afectacion,
          origen: creada.origen,
          proporcionGravada: creada.proporcion_gravada,
          evidencia: creada.evidencia,
          declaradaPor: creada.declarada_por,
          declaradaAt: creada.declarada_at,
          /**
           * Qué le pasa a la regla con esta declaración. No es una conclusión
           * fiscal: es el estado del hecho, que es lo único que el sistema
           * puede afirmar hoy.
           */
          hecho: efectoSobreElHecho(creada.afectacion),
        };
      });
      }
    },
  );

  app.get<{ Params: { taxTransactionId: string } }>(
    '/tax-transactions/:taxTransactionId/afectacion',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'journal_entry:read');
      const auth = requireAuth(request);
      const { taxTransactionId } = z
        .object({ taxTransactionId: z.string().uuid() })
        .parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const operacion = await tx.query('SELECT id FROM tax_transactions WHERE id = $1', [
            taxTransactionId,
          ]);
          if (operacion.rowCount === 0) throw notFound('La operación fiscal no existe');

          const fila = await tx.query<AfectacionLeida>(SELECCION, [taxTransactionId]);
          if (fila.rowCount === 0) {
            // 200 y no 404: la operación existe y no tiene declaración, que es
            // un estado legítimo y distinto de "no encontré la operación".
            return {
              declarada: false,
              hecho: {
                estado: 'AUSENTE' as const,
                motivo: 'SIN_DECLARACION',
                explicacion:
                  'Nadie declaró la afectación de este comprobante. El hecho no existe, y no ' +
                  'existir no es lo mismo que ser falso.',
              },
            };
          }

          const a = fila.rows[0]!;
          return {
            declarada: a.origen === 'DECLARACION_PROFESIONAL',
            id: a.id,
            afectacion: a.afectacion,
            origen: a.origen,
            proporcionGravada: a.proporcion_gravada,
            evidencia: a.evidencia,
            declaradaPor: a.declarada_por,
            declaradaAt: a.declarada_at,
            hecho:
              a.origen === 'DECLARACION_PROFESIONAL'
                ? efectoSobreElHecho(a.afectacion)
                : {
                    estado: 'AUSENTE' as const,
                    motivo: 'SUGERIDA_SIN_DECLARAR',
                    explicacion:
                      'Hay una sugerencia por precedente y nadie la firmó. Una sugerencia no ' +
                      'resuelve una regla: el sistema propone, la persona declara.',
                  },
          };
        },
      );
    },
  );
}

/**
 * Qué provee cada afectación, en los mismos términos que `proveerVinculacion`
 * del tax-engine.
 *
 * Se replica la tabla y no se importa la función porque acá no hay un
 * `DeclaracionDeAfectacion` armado —hace falta la operación fiscal entera— y
 * porque lo que se devuelve es una explicación para una persona, no el hecho
 * que consume el motor. Hay un test que comprueba que las dos coinciden.
 */
function efectoSobreElHecho(afectacion: string): {
  estado: 'PROVISTO' | 'REQUIERE_REVISION' | 'AUSENTE';
  valor?: boolean;
  motivo?: string;
  explicacion: string;
} {
  switch (afectacion) {
    case 'GRAVADAS':
      return {
        estado: 'PROVISTO',
        valor: true,
        explicacion:
          'El hecho queda provisto en verdadero. No significa que el crédito fiscal sea ' +
          'computable: eso lo decide una regla, y hoy no hay ninguna ACTIVE.',
      };
    case 'EXENTAS':
    case 'NO_GRAVADAS':
      return {
        estado: 'PROVISTO',
        valor: false,
        explicacion: 'El hecho queda provisto en falso: la operación no se vincula con gravadas.',
      };
    case 'MIXTA':
      return {
        estado: 'REQUIERE_REVISION',
        motivo: 'MIXTA_SIN_PRORRATEO',
        explicacion:
          'La operación está afectada en parte a operaciones gravadas. El art. 12 se cumple, pero ' +
          'la medida del cómputo la fija el prorrateo del art. 13, que no está relevado.',
      };
    default:
      return {
        estado: 'AUSENTE',
        motivo: 'NO_DETERMINADA',
        explicacion:
          'Se declaró que todavía no se pudo determinar. Es una respuesta válida y deja el hecho ' +
          'ausente, no falso.',
      };
  }
}
