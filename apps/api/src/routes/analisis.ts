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
import { badRequest, conflict, notFound, unprocessable } from '../http/errors.js';
import { simular } from '../intelligence/simulacion.js';
import { radarDeRiesgos } from '../intelligence/riesgos.js';

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
                  rechazo_cheques_pct::text AS "rechazoChequesPct",
                  crm_dias_sin_actividad AS "crmDiasSinActividad",
                  margen_minimo_pct::text AS "margenMinimoPct",
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
        // Agregado por la 0065. Como todos: opcional, y sin él el sistema informa
        // la proporción de rechazos y no la llama desvío.
        rechazoChequesPct: z.number().gt(0).max(100).nullable().default(null),
        // Agregado por la 0069. Sin él, el sistema informa hace cuántos días no
        // se toca una oportunidad y **no lo llama abandono**: vender un galpón
        // y vender café no tienen el mismo ritmo.
        crmDiasSinActividad: z.number().int().gt(0).nullable().default(null),
        // Agregado por la 0084. Admite negativos: una empresa puede declarar
        // que tolera vender a pérdida hasta cierto punto, y esa es una decisión
        // suya. Sin declararlo, el sistema informa el margen y no lo llama
        // desvío — un mayorista de 4 % y una consultora de 60 % no tienen el
        // mismo piso.
        margenMinimoPct: z.number().gt(-100).max(100).nullable().default(null),
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
              dias_cliente_inactivo, mora_pct, rechazo_cheques_pct,
              crm_dias_sin_actividad, margen_minimo_pct, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (company_id) DO UPDATE SET
             caida_ventas_pct = EXCLUDED.caida_ventas_pct,
             concentracion_cliente_pct = EXCLUDED.concentracion_cliente_pct,
             dias_cliente_inactivo = EXCLUDED.dias_cliente_inactivo,
             mora_pct = EXCLUDED.mora_pct,
             rechazo_cheques_pct = EXCLUDED.rechazo_cheques_pct,
             crm_dias_sin_actividad = EXCLUDED.crm_dias_sin_actividad,
             margen_minimo_pct = EXCLUDED.margen_minimo_pct,
             updated_by = EXCLUDED.updated_by`,
          [
            tenant.companyId, body.caidaVentasPct, body.concentracionClientePct,
            body.diasClienteInactivo, body.moraPct, body.rechazoChequesPct,
            body.crmDiasSinActividad, body.margenMinimoPct,
            `user:${auth.user.userId}`,
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
  /**
   * Umbrales **propuestos** a partir de la propia serie de la empresa.
   *
   * Hoy el umbral se declara o el sistema no llama desvío a nada, y eso está
   * bien: escribir que una caída del 20 % es una alerta sería inventar una
   * regla que ninguna empresa acordó. Pero deja a quien empieza frente a cuatro
   * campos vacíos sin ninguna referencia, y esa fricción es la razón por la que
   * en la práctica quedan vacíos para siempre.
   *
   * Esto no inventa un criterio: **mide lo que esta empresa hizo** y lo ofrece
   * como punto de partida. Es la forma que ADR-001 admite —propone, una persona
   * confirma— y la misma que las imputaciones sugeridas.
   *
   * ## Sin historia suficiente no se propone
   *
   * Un umbral calculado sobre dos meses es ruido disfrazado de análisis. Cada
   * propuesta declara cuántos períodos miró, y cuando no alcanzan devuelve
   * `SIN_HISTORIA_SUFICIENTE` en vez de un número que parecería fundado.
   *
   * ## Cada propuesta dice qué encendería hoy
   *
   * Un umbral no se evalúa en abstracto: se evalúa por lo que marcaría. Por eso
   * cada uno viene con el valor que la empresa tiene **ahora** en esa medida, y
   * quien decide puede ver si adoptarlo llenaría la bandeja o no diría nada.
   */
  app.get('/analysis/thresholds/sugeridos', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    /** Cuántos meses de historia hacen falta para que una serie diga algo. */
    const MINIMO_MESES = 6;

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        // La caída mes contra mes que esta empresa tuvo de verdad. Se propone la
        // mediana de las caídas: la máxima convertiría en normal al peor mes de
        // la historia, y el promedio lo arrastra un solo outlier.
        const ventas = await tx.query<{
          meses: string;
          caida_mediana: string | null;
          caida_maxima: string | null;
        }>(
          `WITH serie AS (
             SELECT mes, neto,
                    lag(neto) OVER (ORDER BY mes) AS anterior
               FROM analytics_operaciones_mensuales
              WHERE company_id = $1 AND direccion = 'VENTAS'
           ), caidas AS (
             SELECT round((anterior - neto) * 100 / anterior, 2) AS pct
               FROM serie
              WHERE anterior IS NOT NULL AND anterior > 0 AND neto < anterior
           )
           SELECT (SELECT count(*)::text FROM serie) AS meses,
                  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pct)::numeric(5,2)::text
                     FROM caidas) AS caida_mediana,
                  (SELECT max(pct)::text FROM caidas) AS caida_maxima`,
          [tenant.companyId],
        );

        const concentracion = await tx.query<{ actual: string | null; terceros: string }>(
          `SELECT max(participacion)::numeric(5,2)::text AS actual,
                  count(*)::text AS terceros
             FROM (
               SELECT round(sum(neto) * 100 / nullif(sum(sum(neto)) OVER (), 0), 2) AS participacion
                 FROM analytics_por_tercero
                WHERE company_id = $1 AND direccion = 'VENTAS'
                GROUP BY party_id
             ) p`,
          [tenant.companyId],
        );

        const inactividad = await tx.query<{ p90: string | null; terceros: string }>(
          `SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY dias_sin_operar)::int::text AS p90,
                  count(*)::text AS terceros
             FROM analytics_por_tercero
            WHERE company_id = $1 AND direccion = 'VENTAS'`,
          [tenant.companyId],
        );

        const mora = await tx.query<{ actual: string | null }>(
          `SELECT round(
                    sum(pendiente) FILTER (WHERE vencimiento_declarado AND dias_de_mora > 0)
                    * 100 / nullif(sum(pendiente), 0), 2)::text AS actual
             FROM invoice_settlement
            WHERE company_id = $1 AND direction = 'VENTAS' AND pendiente > 0`,
          [tenant.companyId],
        );

        const meses = Number(ventas.rows[0]!.meses);
        const hayHistoria = meses >= MINIMO_MESES;

        return {
          periodosMirados: meses,
          minimoRequerido: MINIMO_MESES,
          sugerencias: {
            caidaVentasPct: hayHistoria
              ? {
                  valor: ventas.rows[0]!.caida_mediana,
                  actual: null,
                  como:
                    'Mediana de las caídas mes contra mes que esta empresa tuvo de verdad. Se ' +
                    'usa la mediana y no el máximo, que volvería normal al peor mes de la ' +
                    'historia, ni el promedio, que lo arrastra un solo mes atípico. La caída ' +
                    `más grande observada fue ${ventas.rows[0]!.caida_maxima ?? 'ninguna'}%.`,
                }
              : {
                  valor: null,
                  actual: null,
                  como: `SIN_HISTORIA_SUFICIENTE: ${String(meses)} período(s) de ${String(MINIMO_MESES)}. Un umbral calculado sobre dos meses es ruido disfrazado de análisis.`,
                },
            concentracionClientePct: {
              valor: concentracion.rows[0]!.actual,
              actual: concentracion.rows[0]!.actual,
              como:
                `Participación del cliente más grande sobre ${concentracion.rows[0]!.terceros} ` +
                'tercero(s) con operaciones. Proponerlo igual al valor actual es deliberado: ' +
                'declararlo así no enciende nada hoy y avisa si la concentración empeora.',
            },
            diasClienteInactivo: {
              valor: inactividad.rows[0]!.p90,
              actual: null,
              como:
                'Percentil 90 de los días sin operar de la cartera: el 10 % que hace más que ' +
                'no compra. Es una foto de esta cartera, no un estándar de la industria.',
            },
            moraPct: {
              valor: mora.rows[0]!.actual,
              actual: mora.rows[0]!.actual,
              como:
                'Mora actual de la cartera, contando solo los comprobantes con vencimiento ' +
                'declarado. Los que no lo tienen no cuentan como vencidos y no entran acá.',
            },
          },
          alcance:
            'Son **propuestas**, no umbrales. Nada de esto quedó guardado: se declaran con PUT ' +
            '/analysis/thresholds y esa declaración es la que queda firmada. El sistema mide lo ' +
            'que esta empresa hizo y no afirma que sea lo que deba pasar: qué es un desvío es ' +
            'una decisión del negocio y no de un cálculo.',
        };
      },
    );
  });

  /**
   * Cuánta plata entra y cuándo, de todas las fuentes que hoy la tienen.
   *
   * Es la pregunta que una persona hace de verdad —«¿llego a fin de mes?»— y que
   * hasta ahora había que armar sumando a mano dos endpoints.
   *
   * ## Por qué se puede sumar sin contar dos veces
   *
   * El riesgo era real: un cheque recibido en cancelación de una factura y esa
   * misma factura pendiente son la misma plata. Pero **el doble conteo tiene una
   * condición precisa y derivable**: ocurre cuando el cobro no llegó al Mayor.
   * Si el cheque cita un asiento, el crédito ya bajó y sumar es correcto; si no
   * lo cita, el crédito sigue entero y sumarlo lo duplicaría.
   *
   * Lo que no suma se informa aparte con su motivo, en vez de omitirse: una
   * cifra que falta y una que se decidió no sumar se ven igual si nadie las
   * separa.
   */
  app.get('/analysis/flujo-de-fondos', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'allocation:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{ fuente: string; no_sumable: string }>(
          `SELECT sentido, fuente, partidas,
                  coalesce(total, 0)::text        AS total,
                  coalesce(vencido, 0)::text      AS vencido,
                  coalesce(proximos_30, 0)::text  AS "proximos30",
                  coalesce(de_31_a_60, 0)::text   AS "de31a60",
                  coalesce(mas_de_60, 0)::text    AS "masDe60",
                  no_sumable::text                AS "noSumable",
                  sin_fecha::text                 AS "sinFecha",
                  motivo_no_sumable               AS "motivoNoSumable"
             FROM analytics_flujo_de_fondos
            WHERE company_id = $1
            ORDER BY sentido DESC, fuente`,
          [tenant.companyId],
        );

        // El total consolidado se suma en `numeric`, del lado de la base: plata
        // que sale como decimal exacto y vuelve por IEEE 754 ya no es la misma.
        const consolidado = await tx.query(
          `SELECT sentido,
                  coalesce(sum(total), 0)::text        AS total,
                  coalesce(sum(vencido), 0)::text      AS vencido,
                  coalesce(sum(proximos_30), 0)::text  AS "proximos30",
                  coalesce(sum(de_31_a_60), 0)::text   AS "de31a60",
                  coalesce(sum(mas_de_60), 0)::text    AS "masDe60",
                  coalesce(sum(no_sumable), 0)::text   AS "noSumable"
             FROM analytics_flujo_de_fondos WHERE company_id = $1
            GROUP BY sentido`,
          [tenant.companyId],
        );

        // ADR-018: caja (0068) entra a la decisión por acá. «Entra 100 y sale
        // 80» no contesta «¿llego a fin de mes?» si no se sabe que había 5.
        // Sin `cash:read` no se devuelve un saldo a medias —bancos sin caja
        // sería un punto de partida falso, no uno incompleto— pero tampoco un
        // 403: la respuesta es más corta y dice por qué.
        // Las notas de crédito pendientes de aplicar. Desde la 0080 restan en
        // la cuenta corriente, pero **no entran en COBRANZAS**: esa vista
        // sostiene que los importes son siempre positivos y que el signo viaja
        // en `sentido`, y un negativo adentro sería una invitación a sumarlo
        // sin mirar. Se informan aparte para que la proyección no se lea como
        // si ya estuvieran descontadas.
        const creditos = await tx.query<{ total: string; comprobantes: number }>(
          `SELECT coalesce(-sum(pendiente), 0)::text AS total, count(*)::int AS comprobantes
             FROM invoice_settlement
            WHERE company_id = $1 AND direction = 'VENTAS' AND pendiente < 0`,
          [tenant.companyId],
        );

        const veCaja = tenant.permissions.has('cash:read');
        const proyeccion = veCaja
          ? await tx.query(
              `WITH inicial AS (
                 SELECT coalesce(sum(saldo), 0) AS saldo
                   FROM analytics_disponible WHERE company_id = $1
               ),
               neto AS (
                 SELECT
                   coalesce(sum(vencido)     FILTER (WHERE sentido = 'ENTRA'), 0)
                     - coalesce(sum(vencido)     FILTER (WHERE sentido = 'SALE'), 0) AS t0,
                   coalesce(sum(proximos_30) FILTER (WHERE sentido = 'ENTRA'), 0)
                     - coalesce(sum(proximos_30) FILTER (WHERE sentido = 'SALE'), 0) AS t1,
                   coalesce(sum(de_31_a_60)  FILTER (WHERE sentido = 'ENTRA'), 0)
                     - coalesce(sum(de_31_a_60)  FILTER (WHERE sentido = 'SALE'), 0) AS t2,
                   coalesce(sum(mas_de_60)   FILTER (WHERE sentido = 'ENTRA'), 0)
                     - coalesce(sum(mas_de_60)   FILTER (WHERE sentido = 'SALE'), 0) AS t3
                   FROM analytics_flujo_de_fondos WHERE company_id = $1
               )
               SELECT t.tramo, t.neto::text AS neto,
                      (i.saldo + t.acumulado)::text AS saldo,
                      (i.saldo + t.acumulado) < 0   AS "quedaEnRojo"
                 FROM inicial i, neto n,
                      LATERAL (VALUES
                        (1, 'VENCIDO',     n.t0, n.t0),
                        (2, 'PROXIMOS_30', n.t1, n.t0 + n.t1),
                        (3, 'DE_31_A_60',  n.t2, n.t0 + n.t1 + n.t2),
                        (4, 'MAS_DE_60',   n.t3, n.t0 + n.t1 + n.t2 + n.t3)
                      ) AS t(orden, tramo, neto, acumulado)
                ORDER BY t.orden`,
              [tenant.companyId],
            )
          : null;

        const partida = veCaja
          ? await tx.query(
              `SELECT fuente, saldo::text, partidas
                 FROM analytics_disponible WHERE company_id = $1 ORDER BY fuente`,
              [tenant.companyId],
            )
          : null;

        return {
          porFuente: r.rows,
          // Por sentido, no un único número: un neto solo —entradas menos
          // salidas— esconde que la plata entra en marzo y sale en enero.
          consolidado: consolidado.rows,
          // Lo que la proyección **no** tiene descontado, dicho con su importe.
          creditosPendientes: creditos.rows[0],
          puntoDePartida: partida === null ? null : partida.rows,
          // El saldo tramo a tramo: de acá sale «¿llego a fin de mes?».
          saldoProyectado: proyeccion === null ? null : proyeccion.rows,
          sinPuntoDePartida: veCaja
            ? null
            : 'Falta el permiso `cash:read`. El saldo proyectado no se calcula con bancos ' +
              'solos: sería un punto de partida falso, no uno incompleto.',
          metodologia:
            'ENTRA — COBRANZAS: el pendiente de cada comprobante de venta, o de cada cuota si ' +
            'hay plan, en el tramo de su vencimiento. CHEQUES: los que están en cartera, por su ' +
            'fecha de pago declarada. SALE — PAGOS: lo mismo del lado de compras. COMPROMETIDO: ' +
            'órdenes de compra aceptadas y todavía sin facturar. ' +
            'Ninguna fuente se pisa con otra, y en los dos casos por la misma razón: el ' +
            'solapamiento tiene una condición derivable. Un cheque que cita un asiento ya ' +
            'redujo el crédito que lo originó; una orden facturada deja de ser compromiso y ' +
            'pasa a ser deuda, y ese estado lo pone el circuito al vincular la factura.',
          alcance:
            '`noSumable` es lo que quedó afuera del total y por qué. `sinFecha` es lo que suma ' +
            'al total y no se puede ubicar en ningún tramo porque nadie declaró su vencimiento: ' +
            'las órdenes comprometidas son todas así, porque una orden aceptada no dice cuándo ' +
            'se paga e inventarle una fecha sería inventar el acuerdo. ' +
            'No hay un neto de entradas menos salidas: un solo número escondería que la plata ' +
            'entra en marzo y sale en enero, que es justo lo que hay que ver. ' +
            '`saldoProyectado` sí acumula, y arranca del `puntoDePartida` —efectivo en cajas ' +
            'abiertas más saldo contable de bancos—; **deja afuera lo de `sinFecha`**, que ' +
            'suma al total pero no se puede ubicar en ningún tramo. ' +
            'COBRANZAS **no tiene descontadas** las notas de crédito sin aplicar: esta vista ' +
            'sostiene que los importes son siempre positivos y que el signo viaja en el ' +
            'sentido, así que van aparte en `creditosPendientes` en vez de meterse como un ' +
            'negativo que alguien sumaría sin mirar. ' +
            'Es una proyección de lo que **debería** moverse, no un pronóstico.',
        };
      },
    );
  });

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
        // Agregada cuando el margen pasó a ser calculable (0081). Antes no
        // tenía sentido preguntarla: no había contra qué proyectarla.
        variacionDeCosto: porcentaje.default(0),
      })
      .parse(request.body);

    if (
      body.variacionDePrecio === 0 &&
      body.variacionDeVolumen === 0 &&
      body.variacionDeCosto === 0
    ) {
      throw badRequest(
        'La simulación necesita al menos un cambio: sin variación el resultado es la base.',
      );
    }

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        // La cuenta la hace `simular`, que también usa el escenario guardado:
        // dos copias se desincronizan a la primera semana.
        return simular(tx, tenant.companyId, {
          meses: body.meses,
          variacionDePrecio: body.variacionDePrecio,
          variacionDeVolumen: body.variacionDeVolumen,
          variacionDeCosto: body.variacionDeCosto,
        });
      },
    );
  });

  /**
   * Guarda un escenario: la pregunta, no la respuesta.
   *
   * «¿Qué pasaba si subía diez por ciento?» se pregunta en marzo y se vuelve a
   * preguntar en junio, y la respuesta **tiene que ser distinta** — en el medio
   * la empresa vendió. Por eso se guardan los parámetros y el resultado se
   * recalcula cada vez que se mira.
   */
  app.post('/analysis/scenarios', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    const body = z
      .object({
        nombre: z.string().min(3).max(120),
        pregunta: z.string().min(5).max(500),
        meses: z.number().int().min(1).max(36).default(12),
        variacionDePrecio: porcentaje.default(0),
        variacionDeVolumen: porcentaje.default(0),
        variacionDeCosto: porcentaje.default(0),
      })
      .parse(request.body);

    try {
      const id = await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO analysis_scenarios
               (company_id, nombre, pregunta, meses, variacion_precio,
                variacion_volumen, variacion_costo, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id`,
            [
              tenant.companyId, body.nombre, body.pregunta, body.meses,
              body.variacionDePrecio, body.variacionDeVolumen, body.variacionDeCosto,
              `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'GUARDAR_ESCENARIO',
            objectType: 'analysis_scenarios',
            objectId: r.rows[0]!.id,
            newValue: { nombre: body.nombre, meses: body.meses },
            motivo: 'Se guardan los parámetros. El resultado se recalcula al mirarlo.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return r.rows[0]!.id;
        },
      );
      reply.code(201);
      return { id };
    } catch (error) {
      throw traducirEscenario(error);
    }
  });

  /**
   * Los escenarios guardados, cada uno con su resultado de hoy.
   *
   * Es la comparación: los mismos parámetros de siempre contra las cifras de
   * ahora. Un escenario cuyo resultado hubiera quedado congelado diría hoy lo
   * que era cierto cuando se guardó, y nadie tendría cómo saberlo.
   */
  app.get('/analysis/scenarios', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z
      .object({ incluirArchivados: z.enum(['si', 'no']).default('no') })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const guardados = await tx.query<{
          id: string; nombre: string; pregunta: string; meses: number;
          precio: string; volumen: string; costo: string; status: string;
          motivo_archivo: string | null; created_by: string; created_at: Date;
        }>(
          `SELECT id, nombre, pregunta, meses,
                  variacion_precio::text AS precio,
                  variacion_volumen::text AS volumen,
                  variacion_costo::text AS costo,
                  status, motivo_archivo, created_by, created_at
             FROM analysis_scenarios
            WHERE company_id = $1 AND ($2::bool OR status = 'ACTIVO')
            ORDER BY created_at DESC`,
          [tenant.companyId, query.incluirArchivados === 'si'],
        );

        const escenarios = [];
        for (const e of guardados.rows) {
          const resultado = await simular(tx, tenant.companyId, {
            meses: e.meses,
            variacionDePrecio: Number(e.precio),
            variacionDeVolumen: Number(e.volumen),
            variacionDeCosto: Number(e.costo),
          });
          escenarios.push({
            id: e.id,
            nombre: e.nombre,
            pregunta: e.pregunta,
            estado: e.status,
            motivoArchivo: e.motivo_archivo,
            guardadoPor: e.created_by,
            guardadoEn: e.created_at,
            parametros: {
              meses: e.meses,
              variacionDePrecio: e.precio,
              variacionDeVolumen: e.volumen,
              variacionDeCosto: e.costo,
            },
            resultadoDeHoy: resultado,
          });
        }

        return {
          escenarios,
          alcance:
            'Lo guardado son los parámetros. El resultado se recalcula cada vez que se mira, ' +
            'así que el mismo escenario contesta distinto en marzo y en junio — en el medio ' +
            'la empresa vendió. Un resultado congelado diría hoy lo que era cierto entonces, ' +
            'y quien lo lee no tendría cómo saberlo.',
        };
      },
    );
  });

  /**
   * Dos o más escenarios, uno al lado del otro (S-23).
   *
   * Guardar escenarios sirve para compararlos, y hasta acá había que abrir la
   * lista y restar a ojo. Esta ruta los recalcula a todos **contra las cifras de
   * hoy** y pone las diferencias.
   *
   * ## La comparación que se niega a hacer
   *
   * Dos escenarios con distinta cantidad de meses **no comparan la misma base**:
   * uno proyecta sobre lo facturado en seis meses y el otro sobre doce. Los dos
   * números son correctos y ponerlos en la misma tabla como si midieran lo mismo
   * es el error. Cuando pasa, `baseComparable` es `false` y la respuesta dice
   * por qué — no se normaliza a la ventana más corta, porque eso descartaría
   * datos que alguien eligió mirar.
   *
   * ## Y la que no hace
   *
   * No dice cuál conviene. Elegir exige un objetivo declarado por la empresa
   * —maximizar margen, sostener volumen, cuidar la caja— y eso es una decisión
   * de producto anotada en `NEXO_DECISION_ENGINE.md`. Poner un ganador acá sería
   * inventarla.
   */
  app.get('/analysis/scenarios/compare', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        /** Dos a cinco escenarios guardados. Comparar uno solo no es comparar. */
        ids: z
          .string()
          .min(36)
          .transform((s) => s.split(',').map((x) => x.trim()))
          .pipe(z.array(z.string().uuid()).min(2).max(5)),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const guardados = await tx.query<{
          id: string;
          nombre: string;
          pregunta: string;
          meses: number;
          precio: string;
          volumen: string;
          costo: string;
          status: string;
        }>(
          `SELECT id, nombre, pregunta, meses,
                  variacion_precio::text  AS precio,
                  variacion_volumen::text AS volumen,
                  variacion_costo::text   AS costo,
                  status
             FROM analysis_scenarios
            WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [tenant.companyId, query.ids],
        );

        if (guardados.rowCount !== query.ids.length) {
          const encontrados = new Set(guardados.rows.map((e) => e.id));
          throw notFound(
            'No existen en esta empresa: ' +
              query.ids.filter((id) => !encontrados.has(id)).join(', '),
          );
        }

        const escenarios = [];
        for (const e of guardados.rows) {
          const resultado = (await simular(tx, tenant.companyId, {
            meses: e.meses,
            variacionDePrecio: Number(e.precio),
            variacionDeVolumen: Number(e.volumen),
            variacionDeCosto: Number(e.costo),
          })) as {
            base: { netoFacturado: string };
            resultado: { netoProyectado: string; diferencia: string };
            margen: { proyectado: { margen: string } | null; motivo: string | null };
          };

          escenarios.push({
            id: e.id,
            nombre: e.nombre,
            pregunta: e.pregunta,
            estado: e.status,
            parametros: {
              meses: e.meses,
              variacionDePrecio: e.precio,
              variacionDeVolumen: e.volumen,
              variacionDeCosto: e.costo,
            },
            base: resultado.base.netoFacturado,
            netoProyectado: resultado.resultado.netoProyectado,
            diferenciaContraLaBase: resultado.resultado.diferencia,
            margenProyectado: resultado.margen.proyectado?.margen ?? null,
            motivoSinMargen: resultado.margen.motivo,
          });
        }

        // Dos escenarios comparten base si miran la misma cantidad de meses. Si
        // no, cada uno proyecta sobre otra cosa.
        const ventanas = new Set(escenarios.map((e) => e.parametros.meses));
        const baseComparable = ventanas.size === 1;

        // Las diferencias entre escenarios se calculan en `numeric`, del lado
        // de la base: restar dos importes en JavaScript es exactamente lo que
        // `check:no-float` prohíbe, y acá el resultado se muestra como cifra.
        const contra = [];
        if (baseComparable) {
          const primero = escenarios[0]!;
          for (const otro of escenarios.slice(1)) {
            const delta = await tx.query<{ neto: string; margen: string | null }>(
              `SELECT ($1::numeric - $2::numeric)::text AS neto,
                      CASE WHEN $3::text IS NULL OR $4::text IS NULL THEN NULL
                           ELSE ($3::numeric - $4::numeric)::text END AS margen`,
              [
                otro.netoProyectado,
                primero.netoProyectado,
                otro.margenProyectado,
                primero.margenProyectado,
              ],
            );
            contra.push({
              escenario: otro.nombre,
              contra: primero.nombre,
              diferenciaDeNeto: delta.rows[0]!.neto,
              diferenciaDeMargen: delta.rows[0]!.margen,
            });
          }
        }

        return {
          escenarios,
          comparacion: contra,
          baseComparable,
          motivoNoComparable: baseComparable
            ? null
            : `Los escenarios miran ventanas distintas (${[...ventanas].sort().join(', ')} meses), ` +
              'así que cada uno proyecta sobre una base distinta. Las cifras de cada uno son ' +
              'correctas; restarlas entre sí no significa nada. No se normalizan a la ventana ' +
              'más corta porque eso descartaría datos que alguien eligió mirar.',
          alcance:
            'Cada escenario se recalcula contra las cifras de hoy: lo guardado son los ' +
            'parámetros. Esta respuesta no dice cuál conviene — elegir exige un objetivo ' +
            'declarado por la empresa, y ponerlo acá sería inventarlo.',
        };
      },
    );
  });

  /**
   * Declara que un escenario se aplicó, citando el acto.
   *
   * Es el puente que le faltaba al ciclo de decisión. La predicción existía —un
   * escenario guardado es exactamente eso— y el resultado real lo tiene el ERP;
   * lo que no había era manera de decir que este escenario llevó a este acto.
   * Sin eso, comparar el escenario contra lo que pasó después atribuiría a una
   * decisión un resultado que pudo venir de cualquier otra cosa.
   *
   * **NEXO no lo deduce: lo declara una persona.** El acto se cita por su fila
   * de la bitácora, que está encadenada por hash y no se puede reescribir
   * después para que encaje con el resultado. Es el mismo criterio del ADR-021.
   *
   * Al declarar se **congela la predicción de ese día**. La 0087 decidió lo
   * contrario para el escenario —se guarda la pregunta, no la respuesta— y ese
   * argumento sigue en pie; esto es otra cosa: lo que se esperaba cuando se
   * tomó la decisión es un hecho histórico, y es justamente lo que se pone a
   * prueba. Un pronóstico que se recalcula solo nunca se equivoca.
   */
  app.post('/analysis/scenarios/:escenarioId/applied', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    // Y un permiso de escritura, que lo distingue de guardar un escenario: esto
    // deja un registro inmutable que después se usa para juzgar una decisión, y
    // un usuario de solo lectura no debería poder plantar una predicción. Se usa
    // `analysis:configure` —el que ya tienen ADMINISTRADOR y CONTADOR para
    // declarar los umbrales— y no uno nuevo: si esto merece permiso propio es
    // parte de la misma decisión pendiente que la de guardar un escenario
    // (NEXO_ROADMAP.md), y crear el permiso obligaría a decidir qué rol lo
    // tiene, que es justamente lo que no se inventa acá.
    requirePermission(tenant, 'analysis:configure');
    const auth = requireAuth(request);
    const { escenarioId } = z.object({ escenarioId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        /** La fila de la bitácora que registra el acto. No un texto que lo describa. */
        auditLogId: z.string().uuid(),
        aplicadoDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        motivo: z.string().min(10).max(500),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const escenario = await tx.query<{
          meses: number;
          precio: string;
          volumen: string;
          costo: string;
          nombre: string;
        }>(
          `SELECT nombre, meses, variacion_precio::text AS precio,
                  variacion_volumen::text AS volumen, variacion_costo::text AS costo
             FROM analysis_scenarios
            WHERE id = $1 AND company_id = $2`,
          [escenarioId, tenant.companyId],
        );
        const e = escenario.rows[0];
        if (e === undefined) throw notFound('Escenario no encontrado en esta empresa');

        // El acto tiene que existir y ser de esta empresa. Un id de otra
        // empresa no llega —el RLS ya lo cortó—, pero un id inventado sí
        // llegaría hasta la clave foránea, y ahí el error diría «viola una
        // restricción» en vez de qué pasó.
        const acto = await tx.query<{ action: string; object_type: string; occurred_at: string }>(
          `SELECT action, object_type, occurred_at::text
             FROM audit_logs WHERE id = $1 AND company_id = $2`,
          [body.auditLogId, tenant.companyId],
        );
        if (acto.rowCount === 0) {
          throw notFound(
            'Ese acto no está en la bitácora de esta empresa. La aplicación de un escenario ' +
              'se cita por el acto que la ejecutó, no se describe.',
          );
        }

        const resultado = (await simular(tx, tenant.companyId, {
          meses: e.meses,
          variacionDePrecio: Number(e.precio),
          variacionDeVolumen: Number(e.volumen),
          variacionDeCosto: Number(e.costo),
        })) as {
          base: { netoFacturado: string; mesesConDatos: number };
          resultado: { netoProyectado: string };
          margen: { proyectado: { margen: string } | null; motivo: string | null };
        };

        // Sin un mes de datos no hay predicción que poner a prueba. Declarar la
        // aplicación igual dejaría una fila que promete una medición imposible.
        if (resultado.base.mesesConDatos < 1) {
          throw badRequest(
            'El escenario proyecta sobre una base vacía: la empresa no tiene ningún mes con ' +
              'ventas. Una predicción sobre nada no se puede medir contra nada.',
          );
        }

        const insertado = await tx.query<{ id: string }>(
          `INSERT INTO scenario_applications
             (company_id, scenario_id, audit_log_id, aplicado_desde, motivo,
              base_neto, base_meses, esperado_neto, esperado_margen, motivo_sin_margen,
              meses, variacion_precio, variacion_volumen, variacion_costo, declarado_por)
           VALUES ($1,$2,$3,$4::date,$5,$6::numeric,$7,$8::numeric,$9::numeric,$10,
                   $11,$12::numeric,$13::numeric,$14::numeric,$15)
           RETURNING id`,
          [
            tenant.companyId,
            escenarioId,
            body.auditLogId,
            body.aplicadoDesde,
            body.motivo,
            resultado.base.netoFacturado,
            resultado.base.mesesConDatos,
            resultado.resultado.netoProyectado,
            resultado.margen.proyectado?.margen ?? null,
            resultado.margen.proyectado === null
              ? (resultado.margen.motivo ?? 'El margen no se pudo proyectar')
              : null,
            e.meses,
            e.precio,
            e.volumen,
            e.costo,
            `user:${auth.user.userId}`,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'DECLARAR_ESCENARIO_APLICADO',
          objectType: 'scenario_applications',
          objectId: insertado.rows[0]!.id,
          newValue: {
            escenario: e.nombre,
            actoCitado: { id: body.auditLogId, accion: acto.rows[0]!.action },
            esperadoNeto: resultado.resultado.netoProyectado,
          },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          id: insertado.rows[0]!.id,
          escenario: e.nombre,
          actoCitado: {
            id: body.auditLogId,
            accion: acto.rows[0]!.action,
            objeto: acto.rows[0]!.object_type,
            ocurridoEn: acto.rows[0]!.occurred_at,
          },
          esperado: {
            base: resultado.base.netoFacturado,
            baseEnMeses: resultado.base.mesesConDatos,
            neto: resultado.resultado.netoProyectado,
            margen: resultado.margen.proyectado?.margen ?? null,
          },
          alcance:
            'La predicción queda congelada: es lo que se esperaba el día que se aplicó, y es ' +
            'lo que se va a poner a prueba. Esta declaración no afirma que el escenario vaya ' +
            'a causar lo que pase después.',
        };
      },
    );
  });

  /**
   * Qué se esperaba, qué pasó, y cuál fue la diferencia.
   *
   * La otra mitad del ciclo. Compara la predicción congelada contra lo que el
   * ERP registró desde que el escenario se aplicó.
   *
   * **Compara ritmos mensuales, no totales.** El escenario proyecta sobre una
   * ventana de `meses`, y desde que se aplicó pasó otra cantidad de meses:
   * restar los dos totales compararía una proyección de doce meses contra dos
   * meses de realidad y daría un desvío enorme que no significa nada.
   *
   * **No dice que la diferencia la causó la decisión.** Atribuirla exigiría que
   * nada más hubiera cambiado en el período, y eso es falso en general.
   */
  app.get('/analysis/scenarios/:escenarioId/result', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const { escenarioId } = z.object({ escenarioId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{
          nombre: string;
          pregunta: string;
          aplicadoDesde: string;
          motivo: string;
          declaradoPor: string;
          declaradoAt: string;
          auditLogId: string;
          accion: string;
          meses: number;
          baseNeto: string;
          baseMeses: number;
          esperadoNeto: string;
          esperadoMargen: string | null;
          motivoSinMargen: string | null;
          realNeto: string;
          mesesTranscurridos: string;
        }>(
          // Toda la aritmética en `numeric`, del lado de la base: los importes
          // no pasan por JavaScript ni para restarse (`check:no-float`).
          `SELECT s.nombre, s.pregunta,
                  a.aplicado_desde::text        AS "aplicadoDesde",
                  a.motivo, a.declarado_por     AS "declaradoPor",
                  a.declarado_at::text          AS "declaradoAt",
                  a.audit_log_id                AS "auditLogId",
                  l.action                      AS accion,
                  a.meses,
                  a.base_neto::text             AS "baseNeto",
                  a.base_meses                  AS "baseMeses",
                  a.esperado_neto::text         AS "esperadoNeto",
                  a.esperado_margen::text       AS "esperadoMargen",
                  a.motivo_sin_margen           AS "motivoSinMargen",
                  coalesce(real.neto, 0)::text  AS "realNeto",
                  coalesce(real.meses, 0)::text AS "mesesTranscurridos"
             FROM scenario_applications a
             JOIN analysis_scenarios s
               ON s.id = a.scenario_id AND s.company_id = a.company_id
             JOIN audit_logs l ON l.id = a.audit_log_id
             LEFT JOIN LATERAL (
                   SELECT sum(m.neto) AS neto, count(*) AS meses
                     FROM analytics_operaciones_mensuales m
                    WHERE m.company_id = a.company_id
                      AND m.direccion = 'VENTAS'
                      AND m.mes >= date_trunc('month', a.aplicado_desde)::date
                  ) real ON true
            WHERE a.company_id = $1 AND a.scenario_id = $2`,
          [tenant.companyId, escenarioId],
        );

        const f = r.rows[0];
        if (f === undefined) {
          return {
            estado: 'SIN_APLICAR',
            motivo:
              'Este escenario no está declarado como aplicado. Sin esa declaración, comparar ' +
              'la proyección contra lo que pasó después le atribuiría a la decisión un ' +
              'resultado que pudo venir de cualquier otra cosa.',
          };
        }

        const transcurridos = Number(f.mesesTranscurridos);

        // Sin un mes completo de datos no hay con qué comparar, y decirlo es
        // distinto de mostrar un desvío del cien por ciento.
        if (transcurridos === 0) {
          return {
            estado: 'SIN_EVIDENCIA_TODAVIA',
            escenario: { nombre: f.nombre, pregunta: f.pregunta },
            aplicacion: {
              desde: f.aplicadoDesde,
              motivo: f.motivo,
              declaradoPor: f.declaradoPor,
              actoCitado: { id: f.auditLogId, accion: f.accion },
            },
            esperado: { neto: f.esperadoNeto, ventanaEnMeses: f.meses },
            motivo:
              'Todavía no hay un mes cerrado desde que se aplicó. Comparar contra cero diría ' +
              'que la decisión falló, y lo que pasa es que no pasó el tiempo.',
          };
        }

        // Ritmo mensual esperado contra ritmo mensual real. Los dos salen de
        // dividir en la base, con la precisión de `numeric`.
        //
        // El esperado se divide por **los meses que la base cubría**, no por la
        // ventana que el escenario pidió mirar. Una empresa con un mes de vida
        // proyecta sobre un mes aunque el escenario diga doce, y dividir por
        // doce daría un esperado doce veces más chico que lo real: el sistema
        // informaría que la decisión superó el pronóstico siempre.
        const ritmos = await tx.query<{
          esperadoMensual: string;
          realMensual: string;
          diferencia: string;
          desvioPct: string;
        }>(
          `SELECT ($1::numeric / $2::numeric)::numeric(18, 2)      AS "esperadoMensual",
                  ($3::numeric / $4::numeric)::numeric(18, 2)      AS "realMensual",
                  (($3::numeric / $4::numeric) - ($1::numeric / $2::numeric))::numeric(18, 2)
                                                                   AS diferencia,
                  CASE WHEN $1::numeric = 0 THEN NULL
                       ELSE ((($3::numeric / $4::numeric) - ($1::numeric / $2::numeric))
                             / ($1::numeric / $2::numeric) * 100)::numeric(7, 2)
                  END                                              AS "desvioPct"`,
          [f.esperadoNeto, f.baseMeses, f.realNeto, transcurridos],
        );
        const d = ritmos.rows[0]!;

        return {
          estado: 'MEDIDO',
          escenario: { nombre: f.nombre, pregunta: f.pregunta },
          aplicacion: {
            desde: f.aplicadoDesde,
            motivo: f.motivo,
            declaradoPor: f.declaradoPor,
            declaradoEl: f.declaradoAt,
            actoCitado: { id: f.auditLogId, accion: f.accion },
          },
          esperado: {
            base: f.baseNeto,
            baseEnMeses: f.baseMeses,
            neto: f.esperadoNeto,
            ventanaEnMeses: f.meses,
            porMes: d.esperadoMensual,
            margen: f.esperadoMargen,
            motivoSinMargen: f.motivoSinMargen,
          },
          real: {
            neto: f.realNeto,
            mesesTranscurridos: transcurridos,
            porMes: d.realMensual,
          },
          diferencia: { porMes: d.diferencia, desvioPct: d.desvioPct },
          metodologia:
            'Se comparan ritmos mensuales y no totales: la proyección se hizo sobre ' +
            `${f.baseMeses} mes(es) de base y desde que se aplicó pasaron ${transcurridos}. ` +
            'Restar los totales compararía dos ventanas distintas y daría un desvío que no ' +
            'significa nada. El esperado por mes divide la proyección por los meses que la ' +
            `base cubría (${f.baseMeses}), no por la ventana que el escenario pidió mirar ` +
            `(${f.meses}). Lo real sale de los comprobantes de VENTAS por mes, fechados por ` +
            'el comprobante.',
          // Sin asteriscos: esto se muestra tal cual, escapado, y un `**` en
          // pantalla es ruido. La negrita es del documento, no de la respuesta.
          alcance:
            'Esto no dice que la diferencia la haya causado la decisión. Atribuírsela ' +
            'exigiría que nada más hubiera cambiado en el período —el mercado, los costos, la ' +
            'estacionalidad—, y eso es falso en general. Dice qué se esperaba, qué pasó, y ' +
            'cuánto se separaron.',
        };
      },
    );
  });

  /** Archiva un escenario, con motivo. No se borra: la comparación en la que aparecía queda. */
  app.post('/analysis/scenarios/:escenarioId/archive', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const { escenarioId } = z
      .object({ escenarioId: z.string().uuid() })
      .parse(request.params);
    const { motivo } = z.object({ motivo: z.string().min(5).max(500) }).parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const r = await tx.query(
            `UPDATE analysis_scenarios
                SET status = 'ARCHIVADO', motivo_archivo = $3
              WHERE id = $1 AND company_id = $2 AND status = 'ACTIVO'
              RETURNING nombre`,
            [escenarioId, tenant.companyId, motivo],
          );
          if (r.rowCount === 0) throw notFound('Escenario no encontrado o ya archivado');

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'ARCHIVAR_ESCENARIO',
            objectType: 'analysis_scenarios',
            objectId: escenarioId,
            newValue: { estado: 'ARCHIVADO' },
            motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { estado: 'ARCHIVADO' };
        },
      );
    } catch (error) {
      throw traducirEscenario(error);
    }
  });

  /**
   * El radar: seis frentes, cada uno con sus hechos y con qué le falta.
   *
   * Un frente que no se puede evaluar **no** se informa como «sin riesgo».
   * Un tablero en verde por falta de datos es peor que no tener tablero.
   */
  app.get('/analysis/riesgos', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'analysis:read');
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const frentes = await radarDeRiesgos(tx, tenant.companyId);
        return {
          frentes,
          sinEvaluar: frentes.filter((f) => !f.evaluable).map((f) => f.frente),
          alcance:
            'Cada frente trae los hechos que lo componen y, si no se puede medir, qué falta ' +
            'declarar para poder hacerlo. No hay una nota global: sumar frentes que se miden ' +
            'en días, pesos y porcentajes exigiría ponderarlos, y esa ponderación sería una ' +
            'opinión sin dueño.',
        };
      },
    );
  });
}

/** Del candado de la base al error del dominio. */
function traducirEscenario(error: unknown): unknown {
  const fallo = error as { code?: string; message?: string; constraint?: string };
  const mensaje = fallo.message ?? '';

  if (mensaje.includes('E_ESC_INMUTABLE')) {
    return unprocessable(
      'ESCENARIO_INMUTABLE',
      'Los parámetros de un escenario no se editan: cambiarlos lo convertiría en otro con el ' +
        'mismo nombre, y la comparación de la semana pasada pasaría a hablar de algo distinto ' +
        'sin avisar. Archivalo y guardá uno nuevo.',
    );
  }
  if (mensaje.includes('E_ESC_NO_SE_BORRA')) {
    return unprocessable(
      'ESCENARIO_NO_SE_BORRA',
      'Un escenario se archiva con motivo, no se borra.',
    );
  }
  if (fallo.code === '23514' && mensaje.includes('sc_algo_cambia')) {
    return unprocessable(
      'ESCENARIO_SIN_CAMBIOS',
      'Un escenario sin ninguna variación es la base: no es un escenario.',
    );
  }
  if (fallo.code === '23505') {
    return conflict('Ya hay un escenario con ese nombre en esta empresa.');
  }
  return error;
}
