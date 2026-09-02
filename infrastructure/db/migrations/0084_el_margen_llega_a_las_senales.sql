-- ============================================================================
-- 0084 — El margen llega a la capa de decisión
-- ============================================================================
--
-- La 0081 dejó el margen real calculado por producto, con su honestidad puesta
-- en el lugar correcto: no lo afirma cuando no puede. Pero se quedó en una
-- pantalla. ADR-018 dice que un módulo que registra y no alimenta la decisión
-- está sin terminar.
--
-- Se agregan dos señales, y la diferencia entre las dos es el punto de todo el
-- módulo de análisis:
--
-- ## Vender por debajo del costo es un hecho
--
-- No hace falta que nadie declare nada para saber que un producto que se vendió
-- a menos de lo que costó dio pérdida. El signo no es una opinión. Por eso
-- `VENTA_BAJO_COSTO` no tiene umbral: existe cuando existe, y no existe cuando
-- el margen es positivo —no hay nada que señalar—.
--
-- ## Que un margen del 12 % sea poco es un juicio
--
-- Y ahí sí hace falta que la empresa lo diga. `MARGEN_INSUFICIENTE` compara el
-- margen general contra `margen_minimo_pct`, que se declara. Sin declararlo, el
-- sistema informa el margen y **no lo llama desvío**: un mayorista de 4 % y una
-- consultora de 60 % no tienen el mismo piso, y escribir uno por defecto sería
-- inventar una regla que ninguna empresa acordó.
--
-- ## Las dos solo hablan de lo que se puede afirmar
--
-- Las dos leen `analytics_margen_por_producto` y toman **únicamente** las filas
-- con margen afirmable. Un producto cuyas unidades facturadas no coinciden con
-- las que salieron del depósito no entra: su margen aparente es más grande que
-- el real y señalar sobre eso sería señalar sobre un número inventado.
--
-- ## El motivo de la bandeja, cuando no hay umbral
--
-- `work_queue_senales` armaba el texto concatenando el umbral. Con una señal
-- sin umbral —la primera— esa concatenación daría **NULL entero**: un renglón
-- en la bandeja sin motivo, por una regla de SQL. Se arregla acá, y de paso
-- para cualquier señal futura que sea un hecho y no un juicio.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El piso que la empresa declara
-- ---------------------------------------------------------------------------
ALTER TABLE analysis_thresholds ADD COLUMN margen_minimo_pct numeric(5, 2)
  CHECK (margen_minimo_pct IS NULL OR (margen_minimo_pct > -100 AND margen_minimo_pct <= 100));

COMMENT ON COLUMN analysis_thresholds.margen_minimo_pct IS
  'Debajo de qué porcentaje de margen la empresa quiere que se le avise. En '
  'NULL el sistema informa el margen y no lo llama desvío. Admite negativos: '
  'una empresa puede declarar que tolera vender a pérdida hasta cierto punto, '
  'y eso es una decisión suya, no del sistema.';

-- ---------------------------------------------------------------------------
-- 2 · Las dos señales
-- ---------------------------------------------------------------------------
-- Se renombra y se envuelve, igual que la 0065: copiar el cuerpo sería copiar
-- algo que hay que mantener sincronizado, y la primera vez que alguien lo
-- desactualice las dos vistas dirán cosas distintas.
ALTER VIEW analysis_signals RENAME TO analysis_signals_con_cheques;

-- ⚠ `WITH (security_invoker = true)` escrito de nuevo: la vista es nueva y sin
-- esa cláusula correría con los permisos de su dueño, salteando el RLS.
CREATE VIEW analysis_signals WITH (security_invoker = true) AS
SELECT * FROM analysis_signals_con_cheques

UNION ALL

-- F · Un producto que se vendió por debajo de su costo.
--
--     Sin umbral: el signo del margen no es una opinión. La señal cuelga del
--     producto porque es donde se resuelve —revisar el precio o revisar el
--     costo— y no de la empresa entera.
--
--     Solo el último mes con margen afirmable de cada producto: repetir la
--     misma pérdida doce veces no agrega información, y el mes viejo ya no se
--     puede corregir.
SELECT m.company_id,
       'VENTA_BAJO_COSTO'::text                          AS tipo,
       'products'::text                                  AS entidad,
       m.product_id                                      AS entity_id,
       NULL::uuid                                        AS party_id,
       (m.producto_codigo || ' · ' || m.producto_nombre)  AS sujeto,
       m.margen_pct                                      AS valor,
       '%'::text                                         AS unidad,
       m.venta                                           AS referencia,
       m.costo                                           AS comparado_con,
       NULL::numeric                                     AS umbral,
       -- Sin umbral y en TRUE: el hecho se señala solo. `supera_umbral` dice
       -- «esta señal está encendida», y acá lo que la enciende es el signo.
       true                                              AS supera_umbral,
       'Venta neta del mes menos el costo de las unidades que salieron, valuadas '
       'al promedio vigente al salir. Solo se toma el último mes con margen '
       'afirmable: si las unidades facturadas no coinciden con las que salieron '
       'del depósito, el producto no entra en esta señal.'::text
                                                         AS metodologia
  FROM (
        SELECT DISTINCT ON (x.company_id, x.product_id)
               x.company_id, x.product_id, x.producto_codigo, x.producto_nombre,
               x.mes, x.venta, x.costo, x.margen, x.margen_pct
          FROM analytics_margen_por_producto x
         WHERE x.margen IS NOT NULL
         ORDER BY x.company_id, x.product_id, x.mes DESC
       ) m
 WHERE m.margen < 0

UNION ALL

-- G · El margen general contra el piso que la empresa declaró.
--
--     Es de toda la empresa, así que se ancla en el ejercicio abierto, como la
--     mora de cartera y el rechazo de cheques. Colgarla de un producto
--     cualquiera sería elegirlo por nada.
--
--     El total suma **solo** lo afirmable, de los dos lados. Mezclar ventas sin
--     costo con márgenes afirmados daría un margen inflado con apariencia de
--     total: es el mismo criterio del endpoint de la 0081.
SELECT g.company_id,
       'MARGEN_INSUFICIENTE'::text                       AS tipo,
       'fiscal_years'::text                              AS entidad,
       fy.id                                             AS entity_id,
       NULL::uuid                                        AS party_id,
       'Margen de los últimos doce meses'::text          AS sujeto,
       g.margen_pct                                      AS valor,
       '%'::text                                         AS unidad,
       g.venta                                           AS referencia,
       g.costo                                           AS comparado_con,
       t.margen_minimo_pct                               AS umbral,
       CASE WHEN t.margen_minimo_pct IS NULL THEN NULL
            ELSE g.margen_pct < t.margen_minimo_pct
       END                                               AS supera_umbral,
       'Suma del margen afirmable de los últimos doce meses sobre la venta de '
       'esos mismos renglones. Los productos cuyo margen no se puede afirmar '
       'quedan afuera de las dos puntas: contar su venta sin su costo daría un '
       'margen más alto que el real.'::text              AS metodologia
  FROM (
        SELECT x.company_id,
               sum(x.venta)                                          AS venta,
               sum(x.costo)                                          AS costo,
               round(sum(x.margen) * 100 / nullif(sum(x.venta), 0), 2)::numeric(10, 2)
                                                                     AS margen_pct
          FROM analytics_margen_por_producto x
         WHERE x.margen IS NOT NULL
           AND x.mes >= date_trunc('month', current_date - interval '12 months')::date
         GROUP BY x.company_id
        HAVING sum(x.venta) <> 0
       ) g
  JOIN fiscal_years fy
    ON fy.company_id = g.company_id AND fy.status <> 'CERRADO'
  LEFT JOIN analysis_thresholds t ON t.company_id = g.company_id;

COMMENT ON VIEW analysis_signals IS
  'Las señales de la 0058 y la 0065, más el margen. `supera_umbral` es NULL '
  'cuando la empresa no declaró contra qué comparar —distinto de false, que '
  'sería afirmar que está bien— y es TRUE sin umbral cuando lo que enciende la '
  'señal es un hecho y no un juicio: vender por debajo del costo.';

-- ---------------------------------------------------------------------------
-- 3 · La bandeja, y el motivo que se volvía NULL
-- ---------------------------------------------------------------------------
-- Dos cosas acá. Una: `work_queue_senales` seguía apuntando al OID de la vista
-- vieja después del renombre —PostgreSQL resuelve por OID, no por nombre—, así
-- que sin recrearla las señales nuevas nunca llegarían a la bandeja. Es la
-- misma trampa que documentó la 0065.
--
-- La otra: el motivo concatenaba el umbral, y con una señal sin umbral la
-- concatenación entera daba NULL. Un renglón de bandeja sin texto, por una
-- regla de SQL. Ahora el umbral se nombra solo si existe.
CREATE OR REPLACE VIEW work_queue_senales WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

SELECT s.company_id,
       'DESVIO_DECLARADO'::text                          AS rama,
       'REQUIERE_REVISION'::text                         AS categoria,
       s.entidad,
       s.entity_id,
       s.tipo                                            AS estado,
       s.sujeto || ': ' || s.valor || s.unidad ||
         CASE WHEN s.umbral IS NULL
              THEN ' — es un hecho, no un umbral declarado'
              ELSE ', contra un umbral declarado de ' || s.umbral || s.unidad
         END                                             AS motivo,
       false                                             AS bloquea,
       NULL::text[]                                      AS evidencia_faltante,
       'SISTEMA'::text                                   AS origen,
       'INFORMATIVO'::text                               AS disponibilidad,
       now()                                             AS creado_en,
       now()                                             AS actualizado_en,
       NULL::date                                        AS fecha_limite,
       CASE
         WHEN s.party_id IS NOT NULL THEN '/parties/' || s.party_id || '/saldo'
         WHEN s.tipo = 'RECHAZO_DE_CHEQUES' THEN '/checks'
         -- Las dos del margen mandan a donde se puede rehacer la cuenta.
         WHEN s.tipo IN ('VENTA_BAJO_COSTO', 'MARGEN_INSUFICIENTE') THEN '/analysis/margen'
         ELSE '/analytics/resumen'
       END                                               AS traza_ref
  FROM analysis_signals s
 WHERE s.supera_umbral IS TRUE

) q;

COMMENT ON VIEW work_queue_senales IS
  'Las señales encendidas. Ninguna bloquea: son informativas por definición. El '
  'motivo nombra el umbral solo cuando hay uno — una señal que es un hecho no '
  'tiene contra qué compararse.';

GRANT SELECT ON analysis_signals_con_cheques TO aai_app;
GRANT SELECT ON analysis_signals TO aai_app;
GRANT SELECT ON work_queue_senales TO aai_app;
