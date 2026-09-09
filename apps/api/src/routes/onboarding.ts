/**
 * El camino desde «me registré» hasta «puedo trabajar».
 *
 * Es el único lugar del sistema donde alguien crea una empresa **sin que nadie
 * lo haya autorizado antes**: en el alta desde el estudio, quien crea la empresa
 * ya administra el estudio. Acá no hay estudio todavía.
 *
 * ## Las tres cosas que pasan de una vez, y por qué juntas
 *
 *     estudio  →  empresa  →  rol de administrador  →  prueba de 14 días
 *
 * Las cuatro en una transacción. Partirlas en cuatro llamadas dejaría a alguien
 * con un estudio y sin empresa si se le corta la conexión en el medio, y el
 * sistema no tendría forma de saber si eso es un alta a medias o un estudio que
 * todavía no cargó su primera empresa.
 *
 * ## Una empresa por alta, y una prueba por empresa
 *
 * Quien ya administra un estudio no pasa por acá: usa el alta normal, que sabe
 * a qué estudio agregar la empresa. Y `iniciarPrueba` se niega si la empresa ya
 * tuvo una — cancelar y volver a empezar sería producto gratis indefinido.
 *
 * ## Lo que este flujo NO hace
 *
 * No cobra. La prueba arranca sin pedir un medio de pago y **eso es a
 * propósito**: pedir la tarjeta antes de que alguien vea el producto es la
 * forma más rápida de no tener clientes. Al día catorce la suscripción queda
 * suspendida, que conserva todo y se levanta contratando.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withCompany, withoutCompany, recordAudit } from '@aai/db';
import { cuitCheckDigit } from '@aai/shared';
import { requireAuth, requireCompany } from '../http/context.js';
import { badRequest, conflict } from '../http/errors.js';
import { iniciarPrueba, pruebaDe, DIAS_DE_PRUEBA } from '../billing/prueba.js';
import { olvidarPlanDe } from '../planes/alcance.js';

/** Los mismos valores que acepta `create_company`. */
const alta = z.object({
  estudio: z.string().min(2).max(200),
  razonSocial: z.string().min(2).max(200),
  cuit: z
    .string()
    .regex(/^\d{11}$/u, 'El CUIT son once dígitos, sin guiones')
    .refine(
      (c) => cuitCheckDigit(c.slice(0, 10)) === Number(c[10]),
      'El dígito verificador del CUIT no cierra',
    ),
  tipoEntidad: z.enum(['SA', 'SRL', 'SAS', 'UNIPERSONAL', 'ASOCIACION', 'COOPERATIVA', 'OTRO']),
  jurisdiccion: z.string().min(2).max(10),
  organismo: z.string().max(40).optional(),
  cierreEjercicio: z.string().regex(/^\d{2}-\d{2}$/u, 'Mes y día: 12-31'),
  plan: z.string().min(2).max(40),
});

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Qué planes se pueden elegir, con su precio y lo que incluyen.
   *
   * **Sin sesión**: es la página de precios. Quien todavía no se registró tiene
   * que poder ver qué va a contratar, y esconderlo detrás del login es pedirle
   * que se registre para averiguar cuánto sale.
   */
  app.get('/planes', async () => {
    return withoutCompany('system:catalogo', async (tx) => {
      const { rows } = await tx.query(
        `SELECT p.code, p.name AS nombre, p.descripcion, p.orden,
                (SELECT json_build_object(
                          'moneda', pr.moneda, 'importe', pr.importe::text,
                          'periodicidad', pr.periodicidad,
                          'incluyeImpuestos', pr.incluye_impuestos)
                   FROM plan_prices pr
                  WHERE pr.plan_id = p.id AND pr.periodicidad = 'MENSUAL'
                    AND pr.vigente_desde <= CURRENT_DATE
                    AND (pr.vigente_hasta IS NULL OR pr.vigente_hasta > CURRENT_DATE)
                  ORDER BY pr.vigente_desde DESC LIMIT 1)      AS precio,
                coalesce((SELECT json_agg(json_build_object('code', f.code, 'nombre', f.nombre)
                                          ORDER BY f.orden)
                            FROM plan_features pf
                            JOIN product_features f ON f.code = pf.feature_code
                           WHERE pf.plan_id = p.id), '[]'::json) AS incluye,
                coalesce((SELECT json_agg(json_build_object('recurso', l.recurso, 'tope', l.tope)
                                          ORDER BY l.recurso)
                            FROM plan_limits l WHERE l.plan_id = p.id), '[]'::json) AS topes
           FROM subscription_plans p
          WHERE p.status = 'DISPONIBLE'
          ORDER BY p.orden`,
      );

      return {
        planes: rows,
        prueba: {
          dias: DIAS_DE_PRUEBA,
          pideTarjeta: false,
          alTerminar:
            'La suscripción queda suspendida. Los datos, la contabilidad y el historial ' +
            'quedan intactos, y se recupera el acceso contratando un plan.',
        },
        alcance:
          'Los importes son NETOS: la lista dice «+ IVA». Un plan sin precio es un plan ' +
          'cuyo precio nadie declaró, no un plan gratis. Los topes miden y avisan: no ' +
          'bloquean, porque un sistema contable que se niega a registrar un hecho por una ' +
          'cuestión comercial deja los libros incompletos.',
      };
    });
  });

  /**
   * Crea el estudio, la empresa, el rol y la prueba.
   *
   * Pide sesión y **no** pide `x-company-id`: quien llama todavía no tiene
   * empresa. Es la única ruta con esa forma, y por eso no pasa por
   * `requireCompany`.
   */
  app.post('/onboarding/empresa', async (request, reply) => {
    const auth = requireAuth(request);
    const body = alta.parse(request.body);

    const actorId = `user:${auth.user.userId}`;

    /**
     * Un CUIT que ya existe no es una falla del servidor.
     *
     * `organizations.tax_id` y `companies.cuit` son únicos, y con razón: dos
     * estudios con el mismo CUIT serían dos verdades sobre el mismo
     * contribuyente. Lo que estaba mal era cómo se contestaba — la violación de
     * unicidad salía como **500 «Error interno»**, en la primera pantalla que ve
     * un cliente. Lo vio la auditoría del 2026-09-09 al reusar un CUIT.
     *
     * Y es un caso que va a pasar seguido: el contador que ya registró el
     * estudio y no se acuerda, o el socio que se adelantó. Esa persona necesita
     * saber que la cuenta existe y a quién preguntarle, no «Error interno».
     */
    const seCruzaConUnoQueYaEstaba = (error: unknown): boolean =>
      typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

    const resultado = await withoutCompany(actorId, async (tx) => {
      // Quien ya administra un estudio no pasa por acá: el alta normal sabe a
      // qué estudio agregar la empresa, y esta ruta crearía un segundo estudio
      // con el mismo dueño sin que nadie lo haya pedido.
      const yaTiene = await tx.query(
        `SELECT 1 FROM organization_members WHERE user_id = $1 AND level IN ('OWNER', 'ADMIN')`,
        [auth.user.userId],
      );
      if (yaTiene.rowCount !== null && yaTiene.rowCount > 0) {
        return { estado: 'YA_TIENE_ESTUDIO' as const };
      }

      const plan = await tx.query<{ code: string }>(
        `SELECT code FROM subscription_plans WHERE code = $1 AND status = 'DISPONIBLE'`,
        [body.plan],
      );
      if (plan.rows[0] === undefined) {
        return { estado: 'PLAN_DESCONOCIDO' as const };
      }

      let organizationId: string;
      let companyId: string;
      try {
        const org = await tx.query<{ create_organization: string }>(
          'SELECT create_organization($1, $2, $3)',
          [body.estudio, body.cuit, auth.user.userId],
        );
        organizationId = org.rows[0]!.create_organization;

        const empresa = await tx.query<{ create_company: string }>(
          'SELECT create_company($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            auth.user.userId,
            organizationId,
            body.razonSocial,
            body.cuit,
            body.tipoEntidad,
            body.jurisdiccion,
            body.organismo ?? '',
            body.cierreEjercicio,
          ],
        );
        companyId = empresa.rows[0]!.create_company;
      } catch (error) {
        if (seCruzaConUnoQueYaEstaba(error)) return { estado: 'CUIT_REPETIDO' as const };
        throw error;
      }

      // Quien crea la empresa la administra. Sin esto quedaría una empresa a la
      // que nadie puede entrar, incluido quien la creó.
      await tx.query('SELECT grant_company_role($1, $2, $3, $4)', [
        auth.user.userId,
        companyId,
        auth.user.userId,
        'ADMINISTRADOR',
      ]);

      return { estado: 'CREADA' as const, organizationId, companyId, plan: plan.rows[0].code };
    });

    if (resultado.estado === 'YA_TIENE_ESTUDIO') {
      throw conflict(
        'Ya administrás un estudio. Para agregar otra empresa usá el alta desde el estudio, ' +
          'que la crea dentro del que ya tenés en vez de abrir uno nuevo.',
      );
    }
    if (resultado.estado === 'PLAN_DESCONOCIDO') {
      throw badRequest(`No hay un plan disponible con el código ${body.plan}.`);
    }
    if (resultado.estado === 'CUIT_REPETIDO') {
      // No se dice quién lo registró: sería un oráculo para averiguar en qué
      // estudio está un CUIT cualquiera. Se dice qué pasó y a quién preguntar.
      throw conflict(
        `El CUIT ${body.cuit} ya está registrado en NEXO. Si es tu empresa, pedile acceso a ` +
          'quien la dio de alta; si creés que es un error, escribinos.',
      );
    }

    // La prueba se inicia con la empresa en contexto: `company_subscriptions`
    // está bajo RLS, y sin contexto el `INSERT` no pasaría la política.
    const prueba = await withCompany(
      { companyId: resultado.companyId, actorId },
      async (tx) => {
        const hoy = new Date().toISOString().slice(0, 10) as never;
        const r = await iniciarPrueba(tx, {
          companyId: resultado.companyId,
          planCode: resultado.plan,
          desde: hoy,
          actorId,
        });

        await recordAudit(tx, resultado.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CREAR_EMPRESA_DESDE_ALTA',
          objectType: 'company',
          objectId: resultado.companyId,
          newValue: {
            estudio: body.estudio,
            razonSocial: body.razonSocial,
            plan: resultado.plan,
            prueba: r.estado,
          },
        });

        return r;
      },
    );

    // El plan de esta empresa acaba de nacer: el cache del alcance todavía no la
    // conoce, y sin esto el primer pedido esperaría hasta un minuto.
    olvidarPlanDe(resultado.companyId);

    reply.code(201);
    return {
      companyId: resultado.companyId,
      organizationId: resultado.organizationId,
      plan: resultado.plan,
      prueba:
        prueba.estado === 'INICIADA'
          ? { desde: prueba.prueba.desde, hasta: prueba.prueba.hasta, dias: DIAS_DE_PRUEBA }
          : null,
      siguiente:
        'Entrá con la empresa creada. Lo primero es el ejercicio y el plan de cuentas: sin ' +
        'un período abierto no se puede asentar nada, y el sistema te lo va a decir en cada ' +
        'operación hasta que lo hagas.',
    };
  });

  /**
   * En qué anda la prueba de esta empresa.
   *
   * Pasa por `requireCompany` como cualquier otra ruta con alcance de empresa.
   * La primera versión leía `x-company-id` a mano —para no depender del guard
   * en un flujo de alta— y contestaba 200 sobre **cualquier** empresa: si está
   * en prueba o no es poco, y sigue siendo un dato de alguien más. Lo encontró
   * el barrido de aislamiento, que le pega a cada endpoint con una empresa
   * ajena.
   */
  app.get('/onboarding/prueba', async (request) => {
    const auth = requireAuth(request);
    const tenant = await requireCompany(request);
    const companyId = tenant.companyId;

    return withCompany(
      { companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const prueba = await pruebaDe(tx, companyId);
        if (prueba === null) {
          return {
            enPrueba: false,
            alcance: 'Esta empresa no está en prueba: o nunca lo estuvo, o ya se definió.',
          };
        }
        return {
          enPrueba: true,
          plan: prueba.plan,
          planCode: prueba.planCode,
          empezo: prueba.empezo,
          termina: prueba.termina,
          diasRestantes: prueba.diasRestantes,
          situacion: prueba.situacion,
          alcance:
            prueba.situacion === 'VENCIDA'
              ? 'La prueba llegó a su fecha. El ciclo la va a suspender: los datos, la ' +
                'contabilidad y el historial quedan intactos, y el acceso vuelve contratando.'
              : 'Al terminar, la suscripción queda suspendida y no se borra nada.',
        };
      },
    );
  });
}
