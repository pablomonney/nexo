import type { Tx } from '@aai/db';

/**
 * La simulación de un escenario.
 *
 * Vive acá y no adentro de la ruta porque la usan dos: el escenario que se
 * arma al vuelo y el que quedó guardado. Copiarla en los dos lugares habría
 * dejado dos simuladores que se desincronizan a la primera semana — y el
 * segundo sería el que nadie recuerda actualizar.
 *
 * No guarda nada. Es una función de sus parámetros sobre las cifras que la
 * empresa tiene hoy, y por eso el mismo escenario contesta distinto en marzo
 * y en junio: en el medio la empresa vendió.
 */
export interface ParametrosDeEscenario {
  readonly meses: number;
  readonly variacionDePrecio: number;
  readonly variacionDeVolumen: number;
  readonly variacionDeCosto: number;
}

export async function simular(
  tx: Tx,
  companyId: string,
  params: ParametrosDeEscenario,
): Promise<Record<string, unknown>> {
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
      [companyId, params.meses, params.variacionDePrecio, params.variacionDeVolumen],
    );

    const fila = base.rows[0]!;

    /**
     * El margen proyectado, cuando hay margen que proyectar.
     *
     * Toma **solo** los renglones con margen afirmable: los que tienen
     * costo, sin salidas sin costear, y con lo facturado coincidiendo con
     * lo que salió del depósito. Proyectar sobre una venta cuyo costo no se
     * conoce daría un margen más alto que el real, que es el error más
     * peligroso de los dos porque parece bueno.
     *
     * La venta que queda afuera se informa: sin eso, el margen proyectado
     * parecería ser el de toda la empresa.
     */
    const margen = await tx.query<{
      venta: string; costo: string; margen: string; margen_pct: string | null;
      venta_proyectada: string; costo_proyectado: string;
      margen_proyectado: string; margen_pct_proyectado: string | null;
      venta_sin_afirmar: string; renglones: string;
    }>(
      `WITH b AS (
         SELECT coalesce(sum(venta) FILTER (WHERE margen IS NOT NULL), 0) AS venta,
                coalesce(sum(costo) FILTER (WHERE margen IS NOT NULL), 0) AS costo,
                coalesce(sum(margen), 0) AS margen,
                coalesce(sum(venta) FILTER (WHERE margen IS NULL), 0) AS venta_sin_afirmar,
                count(*) FILTER (WHERE margen IS NOT NULL) AS renglones
           FROM analytics_margen_por_producto
          WHERE company_id = $1
            AND mes >= date_trunc('month', current_date - make_interval(months => $2))::date
       ), f AS (
         SELECT (1 + $3::numeric / 100) * (1 + $4::numeric / 100) AS venta,
                (1 + $5::numeric / 100) * (1 + $4::numeric / 100) AS costo
       )
       SELECT round(b.venta, 2)::text                                  AS venta,
              round(b.costo, 2)::text                                  AS costo,
              round(b.margen, 2)::text                                 AS margen,
              round(b.margen * 100 / nullif(b.venta, 0), 2)::text      AS margen_pct,
              round(b.venta * f.venta, 2)::text                        AS venta_proyectada,
              round(b.costo * f.costo, 2)::text                        AS costo_proyectado,
              round(b.venta * f.venta - b.costo * f.costo, 2)::text    AS margen_proyectado,
              round((b.venta * f.venta - b.costo * f.costo) * 100
                    / nullif(b.venta * f.venta, 0), 2)::text           AS margen_pct_proyectado,
              round(b.venta_sin_afirmar, 2)::text                      AS venta_sin_afirmar,
              b.renglones::text                                        AS renglones
         FROM b CROSS JOIN f`,
      [
        companyId, params.meses,
        params.variacionDePrecio, params.variacionDeVolumen, params.variacionDeCosto,
      ],
    );

    const m = margen.rows[0]!;
    const hayMargen = Number(m.renglones) > 0;

    return {
      base: {
        netoFacturado: fila.neto,
        comprobantes: Number(fila.comprobantes),
        mesesConDatos: Number(fila.meses),
        mesesPedidos: params.meses,
      },
      escenario: {
        variacionDePrecio: params.variacionDePrecio,
        variacionDeVolumen: params.variacionDeVolumen,
        variacionDeCosto: params.variacionDeCosto,
      },
      resultado: {
        netoProyectado: fila.proyectado,
        diferencia: fila.diferencia,
        // Decimal exacto y no número: 8% de precio con 5% de volumen da
        // 13.4%, y un `Number` redondeado esconde justo el resto que
        // permitiría rehacer la cuenta.
        variacionTotalPct: fila.variacionTotalPct,
      },
      margen: hayMargen
        ? {
            base: {
              venta: m.venta, costo: m.costo, margen: m.margen, margenPct: m.margen_pct,
            },
            proyectado: {
              venta: m.venta_proyectada,
              costo: m.costo_proyectado,
              margen: m.margen_proyectado,
              margenPct: m.margen_pct_proyectado,
            },
            renglonesAfirmables: Number(m.renglones),
            ventaSinMargenAfirmable: m.venta_sin_afirmar,
            motivo: null,
          }
        : {
            base: null,
            proyectado: null,
            renglonesAfirmables: 0,
            ventaSinMargenAfirmable: m.venta_sin_afirmar,
            motivo:
              'No hay ningún renglón con margen afirmable en el período: sin costo no hay ' +
              'margen que proyectar. Proyectar sobre la venta sola daría un margen más ' +
              'alto que el real.',
          },
      // Lo frágil, impreso. Una simulación cuyos supuestos no se ven es un
      // número que engaña.
      supuestos: [
        'El volumen no reacciona al precio: no se modela elasticidad de demanda.',
        'La composición de lo vendido no cambia.',
        'Los meses sin datos cuentan como cero, no se interpolan.',
        'Es una proyección aritmética sobre lo facturado, no un pronóstico.',
        // El supuesto más fuerte del bloque de margen, y el que más fácil se
        // olvida al leer el resultado.
        'El costo se mueve con el volumen: se lo trata como enteramente variable. Una ' +
          'empresa con costos fijos adentro del costo de ventas verá un margen proyectado ' +
          'peor que el real cuando el volumen baja, y mejor cuando sube.',
      ],
      limitaciones: [
        hayMargen
          ? 'El margen se proyecta solo sobre los renglones donde se puede afirmar: ' +
            m.venta_sin_afirmar +
            ' de venta quedan afuera porque su costo no se conoce.'
          : 'No hay margen que proyectar: ningún renglón del período tiene costo afirmable.',
        'No considera inflación, estacionalidad ni capacidad instalada.',
        'No se guarda: es una función de los parámetros y de la base informada acá, ' +
          'que se puede rehacer con esos mismos números.',
      ],
      metodologia:
        'Neto facturado de VENTAS de los últimos ' + params.meses + ' meses, multiplicado ' +
        'por (1 + variación de precio) y por (1 + variación de volumen). El margen sale ' +
        'de los renglones con margen afirmable del mismo período: la venta se mueve con ' +
        'precio y volumen, el costo con costo y volumen.',
    };
}
