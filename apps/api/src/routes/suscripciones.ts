/**
 * Suscripciones del propio NEXO.
 *
 * ## Los precios se declaran; acá no se inventan
 *
 * Desde la 0096 hay dónde declarar el precio de un plan, y esta ruta lo devuelve
 * **si alguien lo declaró**. Mientras no, el arreglo viene vacío, que es «nadie
 * declaró el precio» y no «gratis»: la misma distinción que entre un tope sin
 * declarar y un plan ilimitado, y confundirlas regala el producto.
 *
 * Sigue sin haber medio de pago acá: cobrar es tarea de un proveedor externo, y
 * lo único que este sistema guarda de un cobro es el identificador opaco que ese
 * proveedor devuelve. Lo que se le cobró a la empresa vive en
 * `routes/facturacion.ts`, y **solo se lee**.
 *
 * ## El importe no lo elige quien paga
 *
 * `POST /subscription/convertir` cierra la prueba y fija las condiciones, y
 * **no acepta un importe en el cuerpo**. Lo resuelve contra `plan_prices`, que
 * es donde el precio vive con su vigencia y su motivo. La alternativa —recibirlo
 * del cliente— le dejaría al administrador de una empresa elegir cuánto paga,
 * que es una frase que no hace falta terminar.
 *
 * Que un contrato pueda diferir de la lista sigue siendo cierto: `convertirPrueba`
 * conserva el parámetro y lo usa quien convierte del lado del operador. Lo que
 * cambia es que por esta puerta entra siempre el precio declarado.
 *
 * ## La referencia de la pasarela ya no se escribe a mano
 *
 * `POST /subscription` aceptaba `referenciaExterna` y la escribía sola. Desde la
 * 0118 eso es imposible: `cs_pasarela_completa` exige que la referencia, el
 * proveedor y el ambiente estén los tres o ninguno, porque una referencia sin
 * dueño ni cuenta apunta a un recurso que nadie puede consultar —y un 404 de la
 * cuenta equivocada se lee como «el cliente nunca autorizó nada»—.
 *
 * El campo se sacó del cuerpo en vez de completarlo con supuestos. Quien escribe
 * las tres columnas es `pagos/suscripcion.ts`, en un solo `UPDATE`, con lo que
 * el proveedor devolvió. No hay otra forma de obtener una referencia válida:
 * inventarla a mano era escribir un identificador que no existe del otro lado.
 *
 * ## El límite avisa, no bloquea
 *
 * Exceder el plan no impide registrar una factura ni cerrar un ejercicio. Un
 * sistema contable que se niega a asentar un hecho por una cuestión comercial
 * deja los libros incompletos, y eso no se arregla pagando después: el hecho ya
 * pasó y quedó sin asentar.
 *
 * ## Lo que no se declaró no limita
 *
 * Un tope ausente es «nadie lo escribió», no «ilimitado». El uso se informa
 * igual, y no se lo llama exceso — la misma disciplina de los umbrales de
 * análisis (0058).
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, conflictoTipado, notFound } from '../http/errors.js';
import { convertirPrueba } from '../billing/prueba.js';
import { precioVigenteDe } from '../billing/precios.js';
import { conectarConLaPasarela, sincronizarEstadoConLaPasarela } from '../pagos/suscripcion.js';
import type { PasarelaInyectada } from '../pagos/inyeccion.js';
import { parseCalendarDate } from '@aai/shared';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

/** Un recurso medido, con su uso y su tope declarado (o la falta de él). */
interface Recurso {
  readonly recurso: string;
  readonly uso: number | null;
  readonly tope: number | null;
  readonly estado: 'DENTRO_DEL_TOPE' | 'EXCEDIDO' | 'SIN_TOPE_DECLARADO' | 'SIN_TOPE' | 'USO_NO_MEDIBLE';
}

/**
 * Los cinco estados de un recurso, y por qué son cinco.
 *
 * Los tres de siempre siguen significando lo mismo. Los dos nuevos separan
 * cosas que antes se confundían con ellos:
 *
 *   `SIN_TOPE_DECLARADO`  no hay fila: **nadie lo escribió**. No es ilimitado.
 *   `SIN_TOPE`            hay fila y dice ilimitado: **se decidió**. No se
 *                         puede exceder, y no cuenta como sin declarar.
 *   `USO_NO_MEDIBLE`      el uso vino en `null`. Pasa solo fuera de un contexto
 *                         de empresa —`empresas` lo devuelve así para el
 *                         operador— y por esta ruta no ocurre, porque siempre
 *                         hay empresa. Se contempla igual: un `null` tratado
 *                         como cero diría «no usás nada» sobre algo que no se
 *                         midió, y ningún tope se excedería jamás.
 *
 * La distinción entre los dos primeros es la que permite vender un plan con
 * integraciones ilimitadas sin que la consola muestre un hueco.
 */
function medir(
  recurso: string,
  uso: number | null,
  tope: number | null,
  ilimitado: boolean,
): Recurso {
  if (ilimitado) return { recurso, uso, tope: null, estado: 'SIN_TOPE' };
  if (uso === null) return { recurso, uso: null, tope, estado: 'USO_NO_MEDIBLE' };
  if (tope === null) return { recurso, uso, tope: null, estado: 'SIN_TOPE_DECLARADO' };
  return { recurso, uso, tope, estado: uso > tope ? 'EXCEDIDO' : 'DENTRO_DEL_TOPE' };
}

/**
 * Se volvió una fábrica por lo mismo que el webhook: para poder ejercitar el
 * camino entero con un proveedor de pagos doble. En producción no se le pasa
 * nada y todo sale de `config.pagos`.
 */
export function suscripcionRoutes(pasarela: PasarelaInyectada = {}) {
  return async function registrar(app: FastifyInstance): Promise<void> {
    await declararRutas(app, pasarela);
  };
}

async function declararRutas(app: FastifyInstance, pasarela: PasarelaInyectada): Promise<void> {
  /** El catálogo, sin precios. */
  app.get('/subscription-plans', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT p.id, p.code AS codigo, p.name AS nombre, p.descripcion, p.orden, p.status,
                  coalesce(
                    (SELECT json_agg(json_build_object('recurso', l.recurso, 'tope', l.tope, 'ilimitado', l.ilimitado)
                                     ORDER BY l.recurso)
                       FROM plan_limits l WHERE l.plan_id = p.id),
                    '[]'::json)                     AS topes,
                  -- Los precios vigentes hoy, si alguien los declaró. Un arreglo
                  -- vacío es «nadie declaró el precio de este plan», no «gratis»:
                  -- la diferencia es la misma que entre un tope sin declarar y un
                  -- plan ilimitado, y confundirlas regala el producto.
                  coalesce(
                    (SELECT json_agg(json_build_object(
                              'periodicidad', pr.periodicidad,
                              'moneda', pr.moneda,
                              'importe', pr.importe::text,
                              'incluyeImpuestos', pr.incluye_impuestos)
                                     ORDER BY pr.periodicidad, pr.moneda)
                       FROM plan_prices pr
                      WHERE pr.plan_id = p.id
                        AND pr.vigente_desde <= CURRENT_DATE
                        AND (pr.vigente_hasta IS NULL OR pr.vigente_hasta > CURRENT_DATE)),
                    '[]'::json)                     AS precios
             FROM subscription_plans p
            ORDER BY p.orden`,
        );

        return {
          planes: r.rows,
          alcance:
            'Un plan sin precios no es gratis: es un plan cuyo precio nadie declaró, y ' +
            'lo mismo vale para los topes. Devolver cero en cualquiera de los dos casos ' +
            'haría que un tablero mostrara facturación inventada o un plan ilimitado.',
        };
      },
    );
  });

  /** El plan de esta empresa y su uso. */
  app.get('/subscription', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{
          subscription_id: string | null;
          plan_codigo: string | null;
          plan_nombre: string | null;
          estado: string | null;
          vigencia_desde: string | null;
          vigencia_hasta: string | null;
          motivo: string | null;
          usuarios: number;
          comprobantes_mes: number;
          documentos_mes: number;
          integraciones: number;
          tope_usuarios: number | null;
          tope_comprobantes_mes: number | null;
          tope_documentos_mes: number | null;
          tope_integraciones: number | null;
          empresas: number | null;
          tope_empresas: number | null;
          topes_ilimitados: string[];
        }>(
          `SELECT subscription_id, plan_codigo, plan_nombre, estado,
                  vigencia_desde::text, vigencia_hasta::text, motivo,
                  usuarios, comprobantes_mes, documentos_mes, integraciones,
                  tope_usuarios, tope_comprobantes_mes, tope_documentos_mes,
                  tope_integraciones, empresas, tope_empresas, topes_ilimitados
             FROM subscription_status WHERE company_id = $1`,
          [tenant.companyId],
        );
        if (r.rowCount === 0) throw notFound('Empresa no encontrada');
        const f = r.rows[0]!;
        const sinTope = (recurso: string): boolean =>
          (f.topes_ilimitados ?? []).includes(recurso);

        const recursos: Recurso[] = [
          // `EMPRESAS` primero porque es la que distingue a los planes entre sí.
          // Hasta la 0122 se podía declarar y no se medía: el número estaba en
          // la tabla y ninguna vista lo evaluaba.
          medir('EMPRESAS', f.empresas, f.tope_empresas, sinTope('EMPRESAS')),
          medir('USUARIOS', f.usuarios, f.tope_usuarios, sinTope('USUARIOS')),
          medir('COMPROBANTES_MES', f.comprobantes_mes, f.tope_comprobantes_mes, sinTope('COMPROBANTES_MES')),
          medir('DOCUMENTOS_MES', f.documentos_mes, f.tope_documentos_mes, sinTope('DOCUMENTOS_MES')),
          medir('INTEGRACIONES', f.integraciones, f.tope_integraciones, sinTope('INTEGRACIONES')),
        ];

        const historial = await tx.query(
          `SELECT s.id, p.code AS "planCodigo", s.estado,
                  s.vigencia_desde::text AS "vigenciaDesde",
                  s.vigencia_hasta::text AS "vigenciaHasta",
                  s.motivo, s.created_by AS "declaradoPor"
             FROM company_subscriptions s
             JOIN subscription_plans p ON p.id = s.plan_id
            WHERE s.company_id = $1
            ORDER BY s.vigencia_desde DESC`,
          [tenant.companyId],
        );

        return {
          plan:
            f.subscription_id === null
              ? null
              : {
                  id: f.subscription_id,
                  codigo: f.plan_codigo,
                  nombre: f.plan_nombre,
                  estado: f.estado,
                  vigenciaDesde: f.vigencia_desde,
                  vigenciaHasta: f.vigencia_hasta,
                  motivo: f.motivo,
                },
          recursos,
          historial: historial.rows,
          alcance:
            'Exceder un tope **no bloquea nada**: un sistema contable que se niega a ' +
            'registrar un hecho por una cuestión comercial deja los libros incompletos, y ' +
            'eso no se arregla pagando — el hecho ya pasó y quedó sin asentar. ' +
            '`SIN_TOPE_DECLARADO` no es «ilimitado»: es que nadie escribió el tope, así ' +
            'que el uso se informa y no se lo llama exceso.',
        };
      },
    );
  });

  /**
   * Declarar el plan de la empresa, con su vigencia.
   *
   * No hay `PATCH`: cambiar de plan es un hecho con fecha, así que se registra
   * uno nuevo y el anterior se cierra. Así el histórico dice qué plan regía
   * cuando se hizo cada cosa.
   */
  app.post('/subscription', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        plan: z.string().min(1).max(40),
        estado: z.enum(['PRUEBA', 'ACTIVA']).default('ACTIVA'),
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
        // `referenciaExterna` **no está**, y no es un olvido. Ver el encabezado:
        // desde la 0118 una referencia sin proveedor ni ambiente viola
        // `cs_pasarela_completa`, y completarlos con supuestos sería peor —
        // apuntaría a un recurso de otra cuenta—. Las tres columnas las escribe
        // `pagos/suscripcion.ts` con lo que devolvió el proveedor.
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const plan = await tx.query<{ id: string }>(
            `SELECT id FROM subscription_plans
              WHERE code = $1 AND status = 'DISPONIBLE'`,
            [body.plan],
          );
          if (plan.rowCount === 0) throw notFound(`No existe el plan ${body.plan}`);

          const r = await tx.query<{ id: string }>(
            `INSERT INTO company_subscriptions
               (company_id, plan_id, estado, vigencia_desde, vigencia_hasta, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, plan.rows[0]!.id, body.estado, body.vigenciaDesde,
              body.vigenciaHasta ?? null,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_PLAN',
            objectType: 'company_subscriptions',
            objectId: r.rows[0]!.id,
            newValue: {
              plan: body.plan,
              estado: body.estado,
              vigenciaDesde: body.vigenciaDesde,
            },
            motivo: 'Se declara el plan de la empresa y desde cuándo rige',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirSuscripcion(error);
    }
  });

  /**
   * Convertir la prueba en una suscripción paga.
   *
   * ## Las cuatro columnas que nadie escribía
   *
   * `periodicidad`, `moneda`, `importe_acordado` y `proxima_facturacion` van
   * juntas o no va ninguna (`company_subscriptions_condiciones_completas`,
   * 0096), y el ciclo de facturación **solo levanta suscripciones que las
   * tengan**. `convertirPrueba` era la única función que las escribía y no la
   * llamaba nadie: sin esta ruta, una empresa podía contratar y no ser
   * facturada nunca.
   *
   * ## El importe sale de la lista, no del cuerpo
   *
   * Ver el encabezado del archivo. Sin precio vigente esto contesta 409 con
   * `SIN_PRECIO_VIGENTE` y no convierte: cobrar cero sería inventar una decisión
   * comercial que nadie tomó.
   *
   * ## Convertir no conecta la pasarela
   *
   * Son dos pasos y a propósito. Convertir fija **lo que se debe**; conectar la
   * pasarela decide **cómo se paga**, y una instalación sin pasarela cobra por
   * transferencia con la conversión hecha igual. Juntarlos haría imposible
   * contratar donde no hay pasarela — que es donde está NEXO hoy.
   */
  app.post('/subscription/convertir', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:write');
    const auth = requireAuth(request);

    const body = z
      .object({
        plan: z.string().min(1).max(40),
        periodicidad: z.enum(['MENSUAL', 'ANUAL']),
        moneda: z
          .string()
          .regex(/^[A-Z]{3}$/u, 'La moneda es un código ISO de tres letras, por ejemplo ARS'),
        // `importe` **no está**: lo resuelve `plan_prices`. Ver el encabezado.
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const busqueda = await precioVigenteDe(tx, {
          planCode: body.plan,
          periodicidad: body.periodicidad,
          moneda: body.moneda,
        });

        if (!busqueda.hay) {
          if (busqueda.motivo === 'PLAN_DESCONOCIDO') throw notFound(busqueda.detalle);
          // Tipado porque la consola lo distingue: sin precio no es un error del
          // cliente, es una lista que falta cargar de este lado.
          throw conflictoTipado(busqueda.motivo, busqueda.detalle);
        }
        const precio = busqueda.precio;

        // «Hoy» según la base, no según `new Date()`. Argentina es UTC−3 y
        // después de las nueve de la noche una fecha calculada acá ya es la de
        // mañana: ese defecto dejó a los planes sin precio el 2026-09-09 a las
        // 22:07. Se le pregunta a la base porque es la base la que compara.
        const { rows } = await tx.query<{ hoy: string }>('SELECT CURRENT_DATE::text AS hoy');
        const hoy = parseCalendarDate(rows[0]!.hoy);

        const salida = await convertirPrueba(tx, {
          companyId: tenant.companyId,
          planCode: body.plan,
          periodicidad: body.periodicidad,
          moneda: precio.moneda,
          importe: precio.importe,
          desde: hoy,
          actorId: `user:${auth.user.userId}`,
        });

        if (salida.estado === 'NO_HAY_PRUEBA') {
          throw conflict(
            'Esta empresa no tiene una prueba ni una suscripción suspendida que convertir. ' +
              'Si ya está ACTIVA no hay nada que hacer; si está CANCELADA, de ahí no se ' +
              'vuelve: se declara una suscripción nueva.',
          );
        }
        if (salida.estado === 'NO_SE_PUEDE') throw conflict(salida.detalle);

        return {
          subscriptionId: salida.subscriptionId,
          plan: body.plan,
          condiciones: {
            periodicidad: precio.periodicidad,
            moneda: precio.moneda,
            importe: precio.importe,
            incluyeImpuestos: precio.incluyeImpuestos,
            proximaFacturacion: hoy,
          },
          alcance:
            'El importe quedó **congelado** en la suscripción: declarar una lista de precios ' +
            'nueva no altera lo acordado con quien ya está. El cargo lo emite el ciclo de ' +
            'facturación; conectar la pasarela es un paso aparte y sin ella se cobra por ' +
            'transferencia.',
        };
      },
    );
  });

  /**
   * Conectar la suscripción con la pasarela y devolver dónde autoriza el cliente.
   *
   * Lo que vuelve en `urlDeAutorizacion` es una URL **del proveedor**: ahí se
   * cargan los datos de la tarjeta, de ese lado. NEXO no los ve, no los recibe y
   * no los guarda — lo único que cruza para acá es un identificador opaco.
   *
   * Es idempotente por diseño: la fila se bloquea antes de mirar y, si ya había
   * referencia, no se vuelve a llamar al proveedor. Crear un segundo
   * `preapproval` sería dos débitos mensuales a la misma empresa.
   */
  app.post('/subscription/pasarela', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:write');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const salida = await conectarConLaPasarela(
          tx,
          {
            companyId: tenant.companyId,
            // El correo de quien está contratando. El proveedor lo exige para
            // identificar al pagador; la clave del vínculo es el `id` de la
            // suscripción, así que cambiar de correo después no rompe nada.
            correoDelPagador: auth.user.email,
            actorId: `user:${auth.user.userId}`,
          },
          {
            ...(pasarela.proveedor === undefined ? {} : { proveedor: pasarela.proveedor }),
            ...(pasarela.ambiente === undefined ? {} : { ambienteConfigurado: pasarela.ambiente }),
            ...(pasarela.urlDeRetorno === undefined
              ? {}
              : { urlDeRetorno: pasarela.urlDeRetorno }),
          },
        );

        if (salida.estado === 'NO_SE_PUDO') {
          if (salida.motivo === 'SUSCRIPCION_INEXISTENTE') throw notFound(salida.detalle);
          // Tipado: la consola muestra cada motivo con su propia indicación, y
          // «falta declarar el plan en la pasarela» lo resuelve el operador
          // mientras que «la suscripción está en PRUEBA» lo resuelve el cliente.
          throw conflictoTipado(salida.motivo, salida.detalle);
        }

        return {
          ...salida,
          alcance:
            'Los datos de la tarjeta se cargan **en el sitio del proveedor**, no acá: NEXO no ' +
            'los ve ni los guarda. Hasta que el cliente autorice, la suscripción del proveedor ' +
            'queda pendiente y no debita nada.',
        };
      },
    );
  });

  /**
   * Suspender, cancelar o reactivar. Los tres con motivo, y sin tocar ningún
   * dato del cliente.
   *
   * ## Primero se le avisa a la pasarela, y recién después se escribe
   *
   * Esta ruta escribía el estado en la base y no le avisaba a nadie. Con una
   * pasarela conectada eso significa un cliente que se da de baja, ve
   * «CANCELADA» en la consola y **sigue viendo el débito en su resumen todos
   * los meses**. Ver `pagos/suscripcion.ts`: la llamada va antes del `UPDATE`
   * justamente para que un fallo deje todo como estaba.
   *
   * Si la pasarela no confirma, la ruta devuelve 409 y **no cambia nada**. Suena
   * mal —una pasarela caída impide cancelar— y es lo correcto: entre «probá de
   * nuevo» y «te dimos de baja y te seguimos cobrando», la segunda es un cargo
   * indebido.
   */
  app.post('/subscription/:subscriptionId/estado', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'subscription:write');
    const auth = requireAuth(request);
    const { subscriptionId } = z
      .object({ subscriptionId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({
        estado: z.enum(['SUSPENDIDA', 'CANCELADA', 'ACTIVA']),
        motivo: z.string().min(3).max(500),
        vigenciaHasta: fecha.nullish(),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const antes = await tx.query<{ estado: string }>(
            'SELECT estado FROM company_subscriptions WHERE id = $1 AND company_id = $2',
            [subscriptionId, tenant.companyId],
          );
          if (antes.rowCount === 0) throw notFound('Suscripción no encontrada');
          if (antes.rows[0]!.estado === 'CANCELADA') {
            throw conflict('Una suscripción cancelada no vuelve: se declara una nueva.');
          }

          // La pasarela primero. Ver el encabezado de la ruta: el orden es lo
          // que impide que NEXO diga «cancelada» sobre algo que sigue debitando.
          const pasarelaDice = await sincronizarEstadoConLaPasarela(
            tx,
            { subscriptionId, hacia: body.estado },
            {
              ...(pasarela.proveedor === undefined ? {} : { proveedor: pasarela.proveedor }),
              ...(pasarela.ambiente === undefined
                ? {}
                : { ambienteConfigurado: pasarela.ambiente }),
            },
          );

          if (pasarelaDice.estado === 'NO_SE_PUDO') {
            throw conflictoTipado(pasarelaDice.motivo, pasarelaDice.detalle);
          }

          await tx.query(
            `UPDATE company_subscriptions
                SET estado = $3, motivo = $4,
                    vigencia_hasta = coalesce($5::date, vigencia_hasta)
              WHERE id = $1 AND company_id = $2`,
            [
              subscriptionId, tenant.companyId, body.estado, body.motivo,
              body.vigenciaHasta ?? null,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'CAMBIAR_ESTADO_DE_PLAN',
            objectType: 'company_subscriptions',
            objectId: subscriptionId,
            oldValue: { estado: antes.rows[0]!.estado },
            // Qué dijo la pasarela queda en la bitácora junto al cambio. Es lo
            // único que, dentro de un año, distingue «se canceló y la pasarela
            // lo confirmó» de «se canceló y no había pasarela»: dos hechos que
            // se ven iguales en la fila de la suscripción y no lo son.
            newValue: { estado: body.estado, pasarela: pasarelaDice.estado },
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            subscriptionId,
            estado: body.estado,
            pasarela: { resultado: pasarelaDice.estado, detalle: pasarelaDice.detalle },
            alcance:
              'Cambiar el estado del plan **no toca ni un dato del cliente**: sus ' +
              'comprobantes, sus asientos y sus documentos siguen donde estaban, y siguen ' +
              'pudiendo registrarse. Cortar el servicio es una decisión de producto con ' +
              'consecuencias sobre la conservación de esa documentación, y no se toma acá.',
          };
        },
      );
    } catch (error) {
      throw traducirSuscripcion(error);
    }
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirSuscripcion(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_SUB_SUPERPUESTA')) {
    return conflict(
      'Esa empresa ya tiene una suscripción vigente en esas fechas. Con dos, el tope ' +
        'aplicable saldría por orden de carga, que es azar disfrazado de regla: cerrá la ' +
        'anterior y declará la nueva desde el día siguiente.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('cs_baja_con_motivo')) {
    return conflict('Suspender o cancelar exige decir por qué');
  }
  if (fallo.code === '23503') {
    return notFound('El plan o la suscripción no existen');
  }
  return error;
}
