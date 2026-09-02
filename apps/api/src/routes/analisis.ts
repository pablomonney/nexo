/**
 * Señales, proyección y simulación (§29, §30).
 *
 * ## Esto no es inteligencia artificial, y conviene decirlo
 *
 * Detectar un desvío es una comparación. Proyectar una cobranza es sumar
 * vencimientos declarados. Simular un cambio de precio es multiplicar. **Ninguna
 * de las tres necesita un modelo, y hacerlas con uno las volvería peores**: una
 * cuenta determinista se audita y se reproduce; la aritmética de un modelo de
 * lenguaje no.
 *
 * Lo que sí puede hacer un modelo —explicar en palabras lo que esta capa
 * encontró, sobre las cifras que esta capa le entrega— ya tiene su lugar:
 * `ai_predictions` con agente `FINANCIAL_ANALYSIS`, su política de confianza y
 * su revisión humana. Acá no se duplica nada de eso.
 *
 * ## Cada respuesta muestra la cuenta
 *
 * §29 pide datos, período, metodología y limitaciones. Van en cada fila y en
 * cada respuesta, no en la documentación: quien mira el número tiene que poder
 * rehacerlo a mano.
 *
 * ## El umbral se declara
 *
 * Sin umbral declarado, el hecho se informa y **no se lo llama desvío**.
 * `superaUmbral` viene en `null` —distinto de `false`, que sería afirmar que
 * está bien—. Es el mismo criterio que `diasDePago` y que `stockMinimo`.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest } from '../http/errors.js';

const porcentaje = z.number().min(-100).max(1000);

export async function analisisRoutes(app: FastifyInstance): Promise<void> {
  app.get('/analysis/signals', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z
      .object({ soloDesvios: z.enum(['si', 'no']).default('no') })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT tipo, sujeto, party_id AS "terceroId",
                  valor::text, unidad,
                  referencia::text, comparado_con::text AS "comparadoCon",
                  umbral::text, supera_umbral AS "superaUmbral",
                  metodologia
             FROM analysis_signals
            WHERE company_id = $1
              AND ($2::bool IS NOT TRUE OR supera_umbral IS TRUE)
            ORDER BY (supera_umbral IS TRUE) DESC, tipo, valor DESC`,
          [tenant.companyId, query.soloDesvios === 'si'],
        );

        const sinUmbral = r.rows.filter(
          (f) => (f as { superaUmbral: boolean | null }).superaUmbral === null,
        ).length;

        return {
          senales: r.rows,
          alcance:
            'Cuentas deterministas sobre los hechos, no inferencias de un modelo: cada fila ' +
            'trae en `metodologia` la cuenta exacta para rehacerla a mano. ' +
            `${sinUmbral} señales vienen con \`superaUmbral\` en null porque la empresa no ` +
            'declaró contra qué compararlas — el sistema informa el hecho y no lo juzga.',
        };
      },
    );
  });

  app.get('/analysis/thresholds', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT caida_ventas_pct::text AS "caidaVentasPct",
                  concentracion_cliente_pct::text AS "concentracionClientePct",
                  dias_cliente_inactivo AS "diasClienteInactivo",
                  mora_pct::text AS "moraPct",
                  updated_at AS "actualizadoEn", updated_by AS "actualizadoPor"
             FROM analysis_thresholds WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          umbrales: r.rows[0] ?? null,
          alcance:
            'Un umbral en null significa que el sistema informa el hecho y no lo llama ' +
            'desvío. No hay valores por defecto: escribir que una caída del 20% es una ' +
            'alerta sería inventar una regla que ninguna empresa acordó, y lo que en una ' +
            'es catástrofe en otra es estacionalidad.',
        };
      },
    );
  });

  app.put('/analysis/thresholds', async (request) => {
    const tenant = await requireCompany(request);
    // Declarar un umbral cambia qué se le informa a la empresa como problema.
    requirePermission(tenant, 'analysis:configure');
    const auth = requireAuth(request);

    const body = z
      .object({
        caidaVentasPct: z.number().gt(0).max(100).nullable(),
        concentracionClientePct: z.number().gt(0).max(100).nullable(),
        diasClienteInactivo: z.number().int().gt(0).nullable(),
        moraPct: z.number().min(0).max(100).nullable(),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query(
          'SELECT * FROM analysis_thresholds WHERE company_id = $1',
          [tenant.companyId],
        );

        await tx.query(
          `INSERT INTO analysis_thresholds
             (company_id, caida_ventas_pct, concentracion_cliente_pct,
              dias_cliente_inactivo, mora_pct, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (company_id) DO UPDATE SET
             caida_ventas_pct = EXCLUDED.caida_ventas_pct,
             concentracion_cliente_pct = EXCLUDED.concentracion_cliente_pct,
             dias_cliente_inactivo = EXCLUDED.dias_cliente_inactivo,
             mora_pct = EXCLUDED.mora_pct,
             updated_by = EXCLUDED.updated_by`,
          [
            tenant.companyId, body.caidaVentasPct, body.concentracionClientePct,
            body.diasClienteInactivo, body.moraPct, `user:${auth.user.userId}`,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'DECLARAR_UMBRALES_DE_ANALISIS',
          objectType: 'analysis_thresholds',
          objectId: tenant.companyId,
          ...(antes.rowCount === 0 ? {} : { oldValue: antes.rows[0] }),
          newValue: body,
          motivo: 'Se declara a partir de qué cifras el sistema informa un desvío',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return { umbrales: body };
      },
    );
  });

  /**
   * Qué se espera cobrar y cuándo.
   *
   * Solo proyecta comprobantes cuyo tercero tiene condición de pago declarada:
   * sin plazo acordado no hay fecha que proyectar, y ponerle una sería inventar
   * el acuerdo. La respuesta dice qué porción del pendiente queda afuera, para
   * que la proyección no se lea como si fuera toda la cartera.
   */
  app.get('/analysis/proyeccion-de-cobranzas', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'allocation:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        // Con plan de pagos, una factura en tres cuotas tiene tres fechas
        // distintas y **no se puede ubicar en un solo tramo**: proyectarla
        // entera al vencimiento de la primera —o de la última— era el defecto
        // que arregló la 0060. Así que el universo son las cuotas cuando hay
        // plan, y el comprobante entero cuando no.
        const r = await tx.query(
          `WITH pendientes AS (
             SELECT pendiente, vencimiento, dias_de_mora, vencimiento_declarado
               FROM invoice_settlement
              WHERE company_id = $1 AND direction = 'VENTAS'
                AND pendiente > 0 AND NOT plan_declarado
             UNION ALL
             SELECT s.pendiente, s.vencimiento, s.dias_de_mora, true
               FROM installment_settlement s
              WHERE s.company_id = $1 AND s.direction = 'VENTAS' AND s.pendiente > 0
           )
           SELECT
             coalesce(sum(pendiente) FILTER (WHERE vencimiento_declarado AND dias_de_mora > 0), 0)::text
               AS "vencido",
             coalesce(sum(pendiente) FILTER (WHERE vencimiento_declarado AND dias_de_mora = 0
                                             AND vencimiento <= current_date + 30), 0)::text
               AS "proximos30",
             coalesce(sum(pendiente) FILTER (WHERE vencimiento_declarado AND dias_de_mora = 0
                                             AND vencimiento > current_date + 30
                                             AND vencimiento <= current_date + 60), 0)::text
               AS "de31a60",
             coalesce(sum(pendiente) FILTER (WHERE vencimiento_declarado AND dias_de_mora = 0
                                             AND vencimiento > current_date + 60), 0)::text
               AS "masDe60",
             coalesce(sum(pendiente) FILTER (WHERE NOT vencimiento_declarado), 0)::text
               AS "sinPlazoAcordado",
             coalesce(sum(pendiente), 0)::text AS "pendienteTotal",
             -- La resta se hace en \`numeric\` acá y no con \`Number\` allá: plata
             -- que sale de la base como decimal exacto y vuelve convertida a
             -- IEEE 754 ya no es la misma plata. \`check:no-float\` lo cazó.
             coalesce(sum(pendiente) FILTER (WHERE vencimiento_declarado), 0)::text
               AS "cubierto",
             coalesce(sum(pendiente), 0) > 0 AS "hayPendiente"
             FROM pendientes`,
          [tenant.companyId],
        );

        const { cubierto, hayPendiente, ...proyeccion } = r.rows[0] as Record<string, string> & {
          cubierto: string;
          hayPendiente: boolean;
        };

        return {
          proyeccion,
          cubre: hayPendiente ? `${cubierto} de ${proyeccion.pendienteTotal}` : null,
          metodologia:
            'Cada pendiente ubicado en el tramo de su vencimiento. Con plan de pagos ' +
            'declarado, la unidad es **la cuota** y no el comprobante: una factura en tres ' +
            'cuotas tiene tres fechas y ubicarla entera en una sola daría una proyección ' +
            'equivocada (migración 0060). Sin plan, el vencimiento se deriva de la fecha del ' +
            'comprobante más los días de pago declarados del tercero (migración 0053).',
          alcance:
            'No proyecta los comprobantes de terceros sin condición de pago declarada: sin ' +
            'plazo acordado no hay fecha que proyectar, y ponerle una sería inventar el ' +
            'acuerdo. `sinPlazoAcordado` dice cuánto queda afuera.',
        };
      },
    );
  });

  /**
   * Simulación de un escenario.
   *
   * Es una función pura de parámetros explícitos sobre cifras reales, y **no se
   * guarda**: guardarla sería almacenar un número derivado, que es justo lo que
   * el resto del sistema evita. La respuesta lleva la base, los supuestos y las
   * limitaciones para que se pueda rehacer y verificar.
   *
   * Los supuestos van impresos porque son la parte frágil: una simulación de
   * precio a volumen constante ignora la elasticidad, y decirlo es la
   * diferencia entre una herramienta y un número que engaña.
   */
  app.post('/analysis/simulate', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    const body = z
      .object({
        meses: z.number().int().min(1).max(36).default(12),
        variacionDePrecio: porcentaje.default(0),
        variacionDeVolumen: porcentaje.default(0),
      })
      .parse(request.body);

    if (body.variacionDePrecio === 0 && body.variacionDeVolumen === 0) {
      throw badRequest(
        'La simulación necesita al menos un cambio: sin variación el resultado es la base.',
      );
    }

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        // Toda la aritmética ocurre en `numeric`, del lado de la base. Es la
        // única forma de que el resultado sea reproducible: un `Number` de por
        // medio convierte a IEEE 754 y el mismo escenario simulado dos veces
        // puede diferir en el último centavo. `check:no-float` rechazó la
        // primera versión de este bloque, que multiplicaba en JavaScript.
        const base = await tx.query<{
          neto: string;
          comprobantes: string;
          meses: string;
          proyectado: string;
          diferencia: string;
          variacionTotalPct: string;
        }>(
          `WITH b AS (
             SELECT coalesce(sum(neto), 0) AS neto,
                    coalesce(sum(comprobantes), 0) AS comprobantes,
                    count(*) AS meses
               FROM analytics_operaciones_mensuales
              WHERE company_id = $1 AND direccion = 'VENTAS'
                AND mes >= date_trunc('month', current_date - make_interval(months => $2))::date
           ), f AS (
             SELECT (1 + $3::numeric / 100) * (1 + $4::numeric / 100) AS factor
           )
           SELECT round(b.neto, 2)::text AS neto,
                  b.comprobantes::text AS comprobantes,
                  b.meses::text AS meses,
                  round(b.neto * f.factor, 2)::text AS proyectado,
                  round(b.neto * f.factor - b.neto, 2)::text AS diferencia,
                  round((f.factor - 1) * 100, 4)::text AS "variacionTotalPct"
             FROM b CROSS JOIN f`,
          [tenant.companyId, body.meses, body.variacionDePrecio, body.variacionDeVolumen],
        );

        const fila = base.rows[0]!;

        return {
          base: {
            netoFacturado: fila.neto,
            comprobantes: Number(fila.comprobantes),
            mesesConDatos: Number(fila.meses),
            mesesPedidos: body.meses,
          },
          escenario: {
            variacionDePrecio: body.variacionDePrecio,
            variacionDeVolumen: body.variacionDeVolumen,
          },
          resultado: {
            netoProyectado: fila.proyectado,
            diferencia: fila.diferencia,
            // Decimal exacto y no número: 8% de precio con 5% de volumen da
            // 13.4%, y un `Number` redondeado esconde justo el resto que
            // permitiría rehacer la cuenta.
            variacionTotalPct: fila.variacionTotalPct,
          },
          // Lo frágil, impreso. Una simulación cuyos supuestos no se ven es un
          // número que engaña.
          supuestos: [
            'El volumen no reacciona al precio: no se modela elasticidad de demanda.',
            'La composición de lo vendido no cambia.',
            'Los meses sin datos cuentan como cero, no se interpolan.',
            'Es una proyección aritmética sobre lo facturado, no un pronóstico.',
          ],
          limitaciones: [
            'No calcula margen ni rentabilidad: exigen el costo de lo vendido, y el stock ' +
              'lleva cantidades, no valores.',
            'No considera inflación, estacionalidad ni capacidad instalada.',
            'No se guarda: es una función de los parámetros y de la base informada acá, ' +
              'que se puede rehacer con esos mismos números.',
          ],
          metodologia:
            'Neto facturado de VENTAS de los últimos ' + body.meses + ' meses, multiplicado ' +
            'por (1 + variación de precio) y por (1 + variación de volumen).',
        };
      },
    );
  });
}
