-- ============================================================================
-- 0065 — Los cheques entran a la capa de decisión
-- ============================================================================
--
-- La 0064 construyó el módulo y lo integró con terceros, bancos, asientos y la
-- bandeja. Lo que **no** hizo fue alimentar la capa de decisión: la cartera no
-- aparecía en ninguna señal ni en ninguna proyección consolidada, así que el
-- sistema sabía que tenía novecientos mil pesos en cheques y no los usaba para
-- contestar «¿cuánta plata entra en los próximos treinta días?».
--
-- Un módulo que registra y no alimenta la decisión es un archivo. Esta
-- migración cierra ese hueco y ADR-018 lo convierte en regla para los que
-- vengan.
--
-- ## El problema real de sumar dos series
--
-- La 0064 dejó el flujo de cheques deliberadamente separado de la proyección de
-- cobranzas «porque sumarlos contaría la misma plata dos veces». Esa afirmación
-- era prudente y **demasiado gruesa**: el doble conteo no ocurre siempre, ocurre
-- bajo una condición precisa, y esa condición se puede derivar.
--
-- Si un cheque se recibió en cancelación de una factura y la imputación se
-- registró, el pendiente de esa factura ya bajó. Sumar la factura pendiente
-- (que ahora es cero) más el cheque da el número correcto: **no hay doble
-- conteo**.
--
-- El doble conteo aparece cuando el cheque está en la cartera y la factura
-- sigue figurando pendiente — es decir, cuando el cobro **no llegó al Mayor**.
-- Y eso es exactamente lo que dice `checks.journal_entry_id IS NULL`.
--
-- Entonces:
--
--   · cheque **con asiento**  → el crédito ya se redujo → sumarlo es correcto
--   · cheque **sin asiento**  → el crédito sigue entero → sumarlo lo contaría
--                                dos veces, y se informa aparte
--
-- No se elige por el usuario ni se estima: se deriva de un hecho que ya está en
-- la base. Y la porción no sumable se muestra con su motivo, en vez de omitirse
-- —una cifra que falta y una que se decidió no sumar se ven igual si nadie las
-- distingue—.
--
-- ## La señal de rechazos
--
-- Un cheque rechazado es un cobro que se dio por hecho y no ocurrió. Que haya
-- rechazos es un hecho; que sean *muchos* es un juicio, y por eso el umbral se
-- declara como todos los demás (0058): sin umbral, el sistema informa la
-- proporción y no la llama desvío.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · Un umbral más, y sigue siendo opcional
-- ---------------------------------------------------------------------------
ALTER TABLE analysis_thresholds
  ADD COLUMN rechazo_cheques_pct numeric(5, 2)
    CHECK (rechazo_cheques_pct IS NULL
           OR (rechazo_cheques_pct > 0 AND rechazo_cheques_pct <= 100));

COMMENT ON COLUMN analysis_thresholds.rechazo_cheques_pct IS
  'Qué porción de los cheques recibidos puede terminar rechazada antes de que '
  'la empresa lo considere un problema. NULL: se informa la proporción y no se '
  'la juzga.';

-- ---------------------------------------------------------------------------
-- 2 · El flujo de fondos consolidado
-- ---------------------------------------------------------------------------
-- Una sola pregunta —cuánta plata entra y cuándo— contestada con las dos
-- fuentes que hoy la tienen: los comprobantes pendientes y los cheques en
-- cartera. Ni una cifra almacenada.
CREATE VIEW analytics_flujo_de_fondos WITH (security_invoker = true) AS
WITH entradas AS (
  -- a · Lo que deben los clientes, por su vencimiento. Con plan de cuotas, la
  --     unidad es la cuota; sin plan, el comprobante entero (0060).
  SELECT s.company_id,
         'COBRANZAS'::text                       AS fuente,
         s.pendiente                             AS importe,
         s.vencimiento                           AS fecha,
         s.vencimiento_declarado                 AS con_fecha,
         true                                    AS sumable,
         NULL::text                              AS motivo_no_sumable
    FROM invoice_settlement s
   WHERE s.direction = 'VENTAS' AND s.pendiente > 0 AND NOT s.plan_declarado

  UNION ALL

  SELECT i.company_id, 'COBRANZAS'::text, i.pendiente, i.vencimiento, true, true, NULL::text
    FROM installment_settlement i
   WHERE i.direction = 'VENTAS' AND i.pendiente > 0

  UNION ALL

  -- b · Los cheques en cartera, por su fecha de pago declarada.
  --
  --     `sumable` sale del asiento y no de una opción: con asiento, el crédito
  --     que lo originó ya bajó y sumarlo es correcto; sin asiento, el crédito
  --     sigue entero y sumarlo contaría la misma plata dos veces.
  SELECT c.company_id,
         'CHEQUES'::text,
         c.importe,
         c.fecha_pago,
         true,
         c.journal_entry_id IS NOT NULL,
         CASE WHEN c.journal_entry_id IS NULL
              THEN 'El cheque no cita ningún asiento: el crédito que lo originó sigue '
                   'figurando pendiente, así que sumarlo contaría la misma plata dos veces.'
         END
    FROM check_status c
   WHERE c.en_cartera
)
SELECT company_id,
       fuente,
       count(*)::int                                                    AS partidas,
       sum(importe) FILTER (WHERE sumable)                              AS total,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha <= current_date)                AS vencido,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha > current_date
                              AND fecha <= current_date + 30)           AS proximos_30,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha > current_date + 30
                              AND fecha <= current_date + 60)           AS de_31_a_60,
       sum(importe) FILTER (WHERE sumable AND con_fecha
                              AND fecha > current_date + 60)            AS mas_de_60,
       -- Lo que no entra al total, con su motivo. Se muestra: una cifra que
       -- falta y una que se decidió no sumar se ven igual si nadie las separa.
       coalesce(sum(importe) FILTER (WHERE NOT sumable), 0)             AS no_sumable,
       coalesce(sum(importe) FILTER (WHERE sumable AND NOT con_fecha), 0) AS sin_fecha,
       max(motivo_no_sumable) FILTER (WHERE NOT sumable)                AS motivo_no_sumable
  FROM entradas
 GROUP BY company_id, fuente;

COMMENT ON VIEW analytics_flujo_de_fondos IS
  'Qué entra y cuándo, por fuente. Un cheque sin asiento no suma al total '
  'porque el crédito que lo originó sigue pendiente: el doble conteo se evita '
  'por un hecho derivable, no por una regla de dedo.';

-- ---------------------------------------------------------------------------
-- 3 · La señal
-- ---------------------------------------------------------------------------
-- Se renombra y se envuelve, en vez de copiar las cien líneas del cuerpo. Es el
-- mismo recurso que usó la 0051 con `work_queue` → `work_queue_nucleo`: una
-- copia del cuerpo es una copia que hay que mantener sincronizada, y la primera
-- vez que alguien la desactualice las dos vistas dirán cosas distintas.
ALTER VIEW analysis_signals RENAME TO analysis_signals_base;

-- ⚠ `WITH (security_invoker = true)` va escrito de nuevo: la vista es nueva y
-- sin esa cláusula se evaluaría con los permisos de su dueño, salteando el RLS
-- de todas las tablas de abajo. Pasó una vez en la 0058.
CREATE VIEW analysis_signals WITH (security_invoker = true) AS
SELECT * FROM analysis_signals_base
UNION ALL
-- E · Qué proporción de los cheques recibidos terminó rechazada.
--     Un rechazo es un cobro que se dio por hecho y no ocurrió. Que haya
--     rechazos es un hecho; que sean *muchos* es un juicio, y por eso el umbral
--     se declara.
--
--     Se ancla en el ejercicio, como `MORA_DE_CARTERA`: es una señal de toda la
--     empresa y no de un cheque, así que colgarla de uno cualquiera sería
--     elegirlo por nada.
SELECT c.company_id,
       'RECHAZO_DE_CHEQUES'::text                        AS tipo,
       'fiscal_years'::text                              AS entidad,
       fy.id                                             AS entity_id,
       NULL::uuid                                        AS party_id,
       'Cheques recibidos'::text                         AS sujeto,
       c.pct_rechazado                                   AS valor,
       '%'::text                                         AS unidad,
       c.rechazados                                      AS referencia,
       c.recibidos                                       AS comparado_con,
       t.rechazo_cheques_pct                             AS umbral,
       CASE WHEN t.rechazo_cheques_pct IS NULL THEN NULL
            ELSE c.pct_rechazado >= t.rechazo_cheques_pct
       END                                               AS supera_umbral,
       'Cheques de terceros que alguna vez fueron rechazados, sobre el total de '
       'cheques de terceros cargados. Cuenta el rechazo aunque después se haya '
       'vuelto a depositar y acreditado: lo que mide es el riesgo de la cartera, '
       'no su saldo.'::text                              AS metodologia
  FROM (
        SELECT k.company_id,
               count(*)::numeric                                        AS recibidos,
               count(*) FILTER (WHERE r.hubo)::numeric                  AS rechazados,
               round(count(*) FILTER (WHERE r.hubo)::numeric * 100
                     / count(*), 2)::numeric(10, 2)                     AS pct_rechazado
          FROM checks k
          CROSS JOIN LATERAL (
                SELECT EXISTS (
                         SELECT 1 FROM check_movements m
                          WHERE m.check_id = k.id AND m.company_id = k.company_id
                            AND m.tipo = 'RECHAZADO') AS hubo
               ) r
         WHERE k.tipo = 'RECIBIDO'
         GROUP BY k.company_id
       ) c
  -- Sin ejercicio no hay dónde anclar la señal. Es el mismo criterio que la
  -- mora: una empresa sin ejercicio abierto todavía no tiene qué analizar.
  JOIN fiscal_years fy
    ON fy.company_id = c.company_id AND fy.status <> 'CERRADO'
  LEFT JOIN analysis_thresholds t ON t.company_id = c.company_id;

-- Sin un solo cheque cargado la subconsulta no devuelve fila, así que la señal
-- no existe. Es deliberado: un 0 % sobre cero cheques diría «ninguno rebotó»,
-- que es cierto y engañoso.

COMMENT ON VIEW analysis_signals IS
  'Las cuatro señales de la 0058 más el rechazo de cheques. `supera_umbral` es '
  'NULL cuando la empresa no declaró contra qué comparar: distinto de false, '
  'que sería afirmar que está bien.';

-- La bandeja leía `analysis_signals`, y después del renombre esa referencia
-- quedó apuntando a `analysis_signals_base` —PostgreSQL resuelve por OID, no por
-- nombre—. Sin esto, la rama nueva nunca llegaría a la bandeja: el umbral se
-- declararía, la señal lo superaría, y nadie se enteraría.
CREATE OR REPLACE VIEW work_queue_senales WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (
SELECT s.company_id,
       'DESVIO_DECLARADO'::text                     AS rama,
       'REQUIERE_REVISION'::text                    AS categoria,
       s.entidad,
       s.entity_id,
       s.tipo                                       AS estado,
       s.sujeto || ': ' || s.valor || s.unidad ||
         ', contra un umbral declarado de ' || s.umbral || s.unidad AS motivo,
       false                                        AS bloquea,
       NULL::text[]                                 AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'INFORMATIVO'::text                          AS disponibilidad,
       now()                                        AS creado_en,
       now()                                        AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       CASE WHEN s.party_id IS NOT NULL
            THEN '/parties/' || s.party_id || '/saldo'
            WHEN s.tipo = 'RECHAZO_DE_CHEQUES' THEN '/checks'
            ELSE '/analytics/resumen'
       END                                          AS traza_ref
  FROM analysis_signals s
 WHERE s.supera_umbral IS TRUE
) q;

GRANT SELECT ON analysis_signals_base TO aai_app;
GRANT SELECT ON analysis_signals TO aai_app;
GRANT SELECT ON analytics_flujo_de_fondos TO aai_app;
GRANT SELECT ON work_queue_senales TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
