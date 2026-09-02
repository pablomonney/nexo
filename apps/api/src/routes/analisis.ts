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
