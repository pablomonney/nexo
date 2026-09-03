/**
 * Por qué cambió el margen.
 *
 * El sistema ya sabía decir **cuánto** cambió. «Cayó 6,4 puntos» es un hecho
 * verificable y también es donde terminaba la respuesta. La pregunta que sigue
 * —*por qué*— no necesita un modelo: es una descomposición aritmética que se
 * hace desde hace décadas en análisis de variaciones, y que acá se puede hacer
 * porque desde la 0081 existe el margen por producto y por mes.
 *
 * ## La descomposición, y por qué cierra exactamente
 *
 * Para un producto que estuvo en los dos períodos, con precio medio `p`, costo
 * medio `c` y cantidad `q`:
 *
 *     margen = (p − c) · q
 *
 *     Δmargen = (p₁ − c₁)·q₁ − (p₀ − c₀)·q₀
 *
 * que se abre en tres efectos:
 *
 *     precio   = (p₁ − p₀) · q₁
 *     costo    = −(c₁ − c₀) · q₁
 *     volumen  = (p₀ − c₀) · (q₁ − q₀)
 *
 * La suma de los tres es **idénticamente** igual a Δmargen: no es una
 * aproximación ni un reparto proporcional. Se puede verificar desarrollando los
 * productos, y el endpoint además lo comprueba en cada respuesta.
 *
 * Los productos que están en un solo período no tienen contra qué compararse, y
 * su margen entero es el efecto: `altas` los que aparecieron, `bajas` los que
 * dejaron de venderse. Repartirlos entre precio y volumen sería inventar un
 * precio anterior que no existió.
 *
 * ## Qué queda afuera, y por qué importa decirlo
 *
 * Solo entran los renglones con **margen afirmable** en su período: los que
 * tienen costo, sin salidas sin costear, y con lo facturado coincidiendo con lo
 * que salió del depósito. Un producto afirmable en un mes y no en el otro no
 * entra en la comparación —no hay contra qué—, y su venta se informa aparte.
 *
 * Sin eso, la descomposición explicaría una variación que no es la que el
 * usuario vio en la pantalla de margen.
 */

import type { Tx } from '@aai/db';

export interface VariacionDeMargen {
  readonly desde: string;
  readonly hasta: string;
  readonly margenAnterior: string;
  readonly margenActual: string;
  readonly variacion: string;
  readonly efectos: {
    readonly precio: string;
    readonly costo: string;
    readonly volumen: string;
    readonly altas: string;
    readonly bajas: string;
  };
  /** La suma de los efectos contra la variación. Si no cierra, la cuenta está mal. */
  readonly comprobacion: { readonly suma: string; readonly cierra: boolean };
  readonly porProducto: readonly {
    readonly codigo: string;
    readonly nombre: string;
    readonly efecto: string;
    readonly precio: string;
    readonly costo: string;
    readonly volumen: string;
    readonly situacion: string;
  }[];
  readonly productosComparables: number;
  readonly metodologia: string;
  readonly noIncluye: string | null;
}

/**
 * La descomposición entre dos meses.
 *
 * Toda la aritmética ocurre en `numeric`: es plata, y el mismo cálculo tiene que
 * dar lo mismo dos veces.
 */
export async function variacionDeMargen(
  tx: Tx,
  companyId: string,
  desde: string,
  hasta: string,
): Promise<VariacionDeMargen> {
  const r = await tx.query<{
    producto_codigo: string; producto_nombre: string;
    efecto_precio: string; efecto_costo: string; efecto_volumen: string;
    efecto_alta: string; efecto_baja: string; efecto: string; situacion: string;
  }>(
    `WITH periodos AS (
       SELECT product_id, producto_codigo, producto_nombre,
              mes,
              unidades_vendidas AS q,
              venta,
              costo,
              margen
         FROM analytics_margen_por_producto
        WHERE company_id = $1
          AND mes IN (($2 || '-01')::date, ($3 || '-01')::date)
          AND margen IS NOT NULL
          AND unidades_vendidas <> 0
     ),
     a AS (SELECT * FROM periodos WHERE mes = ($2 || '-01')::date),
     b AS (SELECT * FROM periodos WHERE mes = ($3 || '-01')::date),
     j AS (
       SELECT coalesce(a.product_id, b.product_id)             AS product_id,
              coalesce(a.producto_codigo, b.producto_codigo)   AS producto_codigo,
              coalesce(a.producto_nombre, b.producto_nombre)   AS producto_nombre,
              a.q AS q0, b.q AS q1,
              -- Precio y costo medios del período. Es la única lectura posible
              -- con lo que hay: el detalle por comprobante no distingue una
              -- venta con descuento de otra sin él.
              a.venta / nullif(a.q, 0) AS p0,
              b.venta / nullif(b.q, 0) AS p1,
              a.costo / nullif(a.q, 0) AS c0,
              b.costo / nullif(b.q, 0) AS c1,
              a.margen AS m0, b.margen AS m1
         FROM a FULL OUTER JOIN b ON b.product_id = a.product_id
     )
     SELECT producto_codigo, producto_nombre,
            round(coalesce(CASE WHEN q0 IS NOT NULL AND q1 IS NOT NULL
                           THEN (p1 - p0) * q1 END, 0), 2)::text        AS efecto_precio,
            round(coalesce(CASE WHEN q0 IS NOT NULL AND q1 IS NOT NULL
                           THEN -(c1 - c0) * q1 END, 0), 2)::text       AS efecto_costo,
            round(coalesce(CASE WHEN q0 IS NOT NULL AND q1 IS NOT NULL
                           THEN (p0 - c0) * (q1 - q0) END, 0), 2)::text AS efecto_volumen,
            round(coalesce(CASE WHEN q0 IS NULL THEN m1 END, 0), 2)::text  AS efecto_alta,
            round(coalesce(CASE WHEN q1 IS NULL THEN -m0 END, 0), 2)::text AS efecto_baja,
            round(coalesce(m1, 0) - coalesce(m0, 0), 2)::text           AS efecto,
            CASE
              WHEN q0 IS NULL THEN 'Apareció en el período: no hay contra qué comparar su precio.'
              WHEN q1 IS NULL THEN 'Dejó de venderse: su margen anterior desaparece entero.'
              ELSE 'Comparable: se abre en precio, costo y volumen.'
            END                                                          AS situacion
       FROM j
      ORDER BY abs(coalesce(m1, 0) - coalesce(m0, 0)) DESC`,
    [companyId, desde, hasta],
  );

  const totales = await tx.query<{
    margen0: string; margen1: string; variacion: string;
    precio: string; costo: string; volumen: string; altas: string; bajas: string;
    suma: string; comparables: number; venta_no_afirmable: string;
  }>(
    `WITH periodos AS (
       SELECT product_id, mes, unidades_vendidas AS q, venta, costo, margen
         FROM analytics_margen_por_producto
        WHERE company_id = $1
          AND mes IN (($2 || '-01')::date, ($3 || '-01')::date)
          AND margen IS NOT NULL
          AND unidades_vendidas <> 0
     ),
     a AS (SELECT * FROM periodos WHERE mes = ($2 || '-01')::date),
     b AS (SELECT * FROM periodos WHERE mes = ($3 || '-01')::date),
     j AS (
       SELECT a.q AS q0, b.q AS q1,
              a.venta / nullif(a.q, 0) AS p0, b.venta / nullif(b.q, 0) AS p1,
              a.costo / nullif(a.q, 0) AS c0, b.costo / nullif(b.q, 0) AS c1,
              a.margen AS m0, b.margen AS m1
         FROM a FULL OUTER JOIN b ON b.product_id = a.product_id
     ),
     e AS (
       SELECT coalesce(sum(m0), 0)                                        AS margen0,
              coalesce(sum(m1), 0)                                        AS margen1,
              coalesce(sum(CASE WHEN q0 IS NOT NULL AND q1 IS NOT NULL
                           THEN (p1 - p0) * q1 END), 0)                   AS precio,
              coalesce(sum(CASE WHEN q0 IS NOT NULL AND q1 IS NOT NULL
                           THEN -(c1 - c0) * q1 END), 0)                  AS costo,
              coalesce(sum(CASE WHEN q0 IS NOT NULL AND q1 IS NOT NULL
                           THEN (p0 - c0) * (q1 - q0) END), 0)            AS volumen,
              coalesce(sum(CASE WHEN q0 IS NULL THEN m1 END), 0)          AS altas,
              coalesce(sum(CASE WHEN q1 IS NULL THEN -m0 END), 0)         AS bajas,
              count(*) FILTER (WHERE q0 IS NOT NULL AND q1 IS NOT NULL)   AS comparables
         FROM j
     ),
     fuera AS (
       SELECT coalesce(sum(venta), 0) AS venta
         FROM analytics_margen_por_producto
        WHERE company_id = $1
          AND mes IN (($2 || '-01')::date, ($3 || '-01')::date)
          AND margen IS NULL
     )
     SELECT round(e.margen0, 2)::text                        AS margen0,
            round(e.margen1, 2)::text                        AS margen1,
            round(e.margen1 - e.margen0, 2)::text            AS variacion,
            round(e.precio, 2)::text                         AS precio,
            round(e.costo, 2)::text                          AS costo,
            round(e.volumen, 2)::text                        AS volumen,
            round(e.altas, 2)::text                          AS altas,
            round(e.bajas, 2)::text                          AS bajas,
            round(e.precio + e.costo + e.volumen + e.altas + e.bajas, 2)::text AS suma,
            e.comparables::int                               AS comparables,
            round(fuera.venta, 2)::text                      AS venta_no_afirmable
       FROM e CROSS JOIN fuera`,
    [companyId, desde, hasta],
  );

  const t = totales.rows[0]!;

  return {
    desde,
    hasta,
    margenAnterior: t.margen0,
    margenActual: t.margen1,
    variacion: t.variacion,
    efectos: {
      precio: t.precio,
      costo: t.costo,
      volumen: t.volumen,
      altas: t.altas,
      bajas: t.bajas,
    },
    // La descomposición es exacta por construcción. Se comprueba igual: una
    // identidad algebraica mal escrita se ve como un número plausible.
    comprobacion: { suma: t.suma, cierra: t.suma === t.variacion },
    porProducto: r.rows.map((f) => ({
      codigo: f.producto_codigo,
      nombre: f.producto_nombre,
      efecto: f.efecto,
      precio: f.efecto_precio,
      costo: f.efecto_costo,
      volumen: f.efecto_volumen,
      situacion: f.situacion,
    })),
    productosComparables: t.comparables,
    metodologia:
      'Δmargen = (p₁−c₁)·q₁ − (p₀−c₀)·q₀, abierto en efecto precio (p₁−p₀)·q₁, efecto costo ' +
      '−(c₁−c₀)·q₁ y efecto volumen (p₀−c₀)·(q₁−q₀). Los tres suman exactamente la variación: ' +
      'no hay reparto proporcional ni residuo. Precio y costo son los medios del período, que ' +
      'es la única lectura posible con el detalle disponible.',
    noIncluye:
      Number(t.venta_no_afirmable) === 0
        ? null
        : `${t.venta_no_afirmable} de venta de los dos meses queda afuera: su margen no se ` +
          'puede afirmar, y explicar una variación que incluyera esa venta sin su costo ' +
          'sería explicar otra cosa que la que muestra la pantalla de margen.',
  };
}
