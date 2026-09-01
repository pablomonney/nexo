-- 0058_senales_y_umbrales.sql — detectar desvíos sin inventar el umbral.
--
-- ## La decisión de fondo: la IA no hace aritmética
--
-- «Detección de desvíos» suena a inteligencia artificial y no lo es. Un desvío
-- es una comparación; una proyección es una extrapolación declarada; una
-- simulación es una función de parámetros explícitos. **Ninguna necesita un
-- modelo, y hacerlas con uno las volvería peores**: una cuenta determinista se
-- audita y se reproduce, la aritmética de un modelo de lenguaje no.
--
-- Así que esta capa es aritmética, y lo dice. Lo que sí puede hacer un modelo
-- —explicar en palabras lo que esta capa encontró, sobre las cifras que esta
-- capa le entrega— tiene su lugar desde la 0018: `ai_predictions` con agente
-- `FINANCIAL_ANALYSIS`, su política de confianza y su revisión humana. No se
-- duplica nada de eso acá.
--
-- ## El umbral se declara, o no hay desvío
--
-- Es la tercera vez que aparece el mismo criterio, y por algo:
--
--   `parties.dias_de_pago`   sin plazo acordado, nada está vencido      (0053)
--   `products.stock_minimo`  sin mínimo declarado, nada está bajo       (0054)
--   `analysis_thresholds`    sin umbral declarado, nada es un desvío
--
-- Escribir «una caída de ventas mayor al 20% es una alerta» sería inventar una
-- regla de negocio que ninguna empresa acordó. Un 20% puede ser catástrofe en
-- una y estacionalidad normal en otra.
--
-- Entonces: **el hecho se calcula siempre**, y se informa siempre. Lo que
-- depende de la declaración es si además se lo llama desvío y entra a la
-- bandeja. Un tablero que muestra «ventas del mes: −38% contra el promedio de
-- los tres anteriores» dice algo verdadero sin afirmar que esté mal.
--
-- ## Cada señal muestra cómo se calculó
--
-- §29 pide que una recomendación muestre datos, período, metodología y
-- limitaciones. `metodologia` viaja en cada fila con la cuenta exacta, en texto,
-- para que quien la lea pueda rehacerla a mano.

-- ---------------------------------------------------------------------------
-- 1 · Los umbrales declarados
-- ---------------------------------------------------------------------------
CREATE TABLE analysis_thresholds (
  company_id                 uuid PRIMARY KEY REFERENCES companies (id),

  -- Caída de ventas del mes contra el promedio de los tres anteriores, en
  -- puntos porcentuales. NULL: el sistema informa la variación y no la juzga.
  caida_ventas_pct           numeric(5, 2)
                               CHECK (caida_ventas_pct IS NULL
                                      OR (caida_ventas_pct > 0 AND caida_ventas_pct <= 100)),

  -- Qué porción de las ventas puede concentrar un solo cliente.
  concentracion_cliente_pct  numeric(5, 2)
                               CHECK (concentracion_cliente_pct IS NULL
                                      OR (concentracion_cliente_pct > 0
                                          AND concentracion_cliente_pct <= 100)),

  -- A partir de cuántos días sin comprar un cliente se considera inactivo.
  dias_cliente_inactivo      integer
                               CHECK (dias_cliente_inactivo IS NULL
                                      OR dias_cliente_inactivo > 0),

  -- Qué porción de lo pendiente de cobro puede estar vencida.
  mora_pct                   numeric(5, 2)
                               CHECK (mora_pct IS NULL
                                      OR (mora_pct >= 0 AND mora_pct <= 100)),

  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 text NOT NULL
);

COMMENT ON TABLE analysis_thresholds IS
  'Umbrales declarados por la empresa. NULL en cualquiera significa que el '
  'sistema informa el hecho y NO lo llama desvío: el umbral no se inventa.';

CREATE TRIGGER analysis_thresholds_updated_at
  BEFORE UPDATE ON analysis_thresholds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE analysis_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_thresholds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON analysis_thresholds
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- ---------------------------------------------------------------------------
-- 2 · Las señales
-- ---------------------------------------------------------------------------
-- Cuatro cuentas. Todas se calculan siempre; `supera_umbral` es NULL cuando la
-- empresa no declaró contra qué compararlas — distinto de `false`, que sería
-- afirmar que está bien.
CREATE VIEW analysis_signals WITH (security_invoker = true) AS

-- A · Variación de las ventas del mes contra el promedio de los tres previos.
SELECT v.company_id,
       'VARIACION_DE_VENTAS'::text                       AS tipo,
       'fiscal_years'::text                              AS entidad,
       fy.id                                             AS entity_id,
       NULL::uuid                                        AS party_id,
       'Ventas del mes'::text                            AS sujeto,
       round(
         CASE WHEN v.promedio_previo = 0 THEN 0
              ELSE (v.mes_actual - v.promedio_previo) / v.promedio_previo * 100
         END, 2)::numeric(10, 2)                         AS valor,
       '%'::text                                         AS unidad,
       v.mes_actual                                      AS referencia,
       v.promedio_previo                                 AS comparado_con,
       t.caida_ventas_pct                                AS umbral,
       CASE WHEN t.caida_ventas_pct IS NULL THEN NULL
            ELSE (v.promedio_previo > 0
                  AND (v.promedio_previo - v.mes_actual) / v.promedio_previo * 100
                      >= t.caida_ventas_pct)
       END                                               AS supera_umbral,
       'Neto facturado del mes en curso dividido por el promedio de los tres meses '
       'anteriores, menos uno. Solo comprobantes de VENTAS, por fecha de comprobante.'::text
                                                         AS metodologia
  FROM (
        SELECT c.id AS company_id,
               coalesce((SELECT m.neto FROM analytics_operaciones_mensuales m
                          WHERE m.company_id = c.id AND m.direccion = 'VENTAS'
                            AND m.mes = date_trunc('month', current_date)::date), 0)
                 AS mes_actual,
               coalesce((SELECT avg(m.neto) FROM analytics_operaciones_mensuales m
                          WHERE m.company_id = c.id AND m.direccion = 'VENTAS'
                            AND m.mes >= date_trunc('month', current_date - interval '3 months')::date
                            AND m.mes <  date_trunc('month', current_date)::date), 0)
                 AS promedio_previo
          FROM companies c
       ) v
  JOIN fiscal_years fy ON fy.company_id = v.company_id AND fy.status <> 'CERRADO'
  LEFT JOIN analysis_thresholds t ON t.company_id = v.company_id

UNION ALL

-- B · Cuánto de las ventas del último año depende de un solo cliente.
SELECT x.company_id,
       'CONCENTRACION_DE_CLIENTES'::text,
       'parties'::text,
       x.party_id,
       x.party_id,
       x.razon_social,
       round(x.neto / nullif(x.total_empresa, 0) * 100, 2)::numeric(10, 2),
       '%'::text,
       x.neto,
       x.total_empresa,
       t.concentracion_cliente_pct,
       CASE WHEN t.concentracion_cliente_pct IS NULL THEN NULL
            ELSE (x.neto / nullif(x.total_empresa, 0) * 100) >= t.concentracion_cliente_pct
       END,
       'Neto facturado a este cliente en los últimos doce meses sobre el neto total '
       'de VENTAS del mismo período. Solo comprobantes resueltos contra el maestro.'::text
  FROM (
        SELECT p.company_id, p.party_id, p.razon_social, p.neto,
               sum(p.neto) OVER (PARTITION BY p.company_id) AS total_empresa
          FROM analytics_por_tercero p
         WHERE p.direccion = 'VENTAS'
           AND p.ultima >= (current_date - interval '12 months')::date
       ) x
  LEFT JOIN analysis_thresholds t ON t.company_id = x.company_id
 WHERE x.total_empresa > 0

UNION ALL

-- C · Clientes que dejaron de comprar.
SELECT p.company_id,
       'CLIENTE_INACTIVO'::text,
       'parties'::text,
       p.party_id,
       p.party_id,
       p.razon_social,
       p.dias_sin_operar::numeric(10, 2),
       'días'::text,
       NULL::numeric,
       NULL::numeric,
       t.dias_cliente_inactivo::numeric(5, 2),
       CASE WHEN t.dias_cliente_inactivo IS NULL THEN NULL
            ELSE p.dias_sin_operar >= t.dias_cliente_inactivo
       END,
       'Días entre hoy y la fecha del último comprobante de VENTAS emitido a este '
       'cliente. No mira el volumen: un cliente grande y uno chico cuentan igual.'::text
  FROM analytics_por_tercero p
  LEFT JOIN analysis_thresholds t ON t.company_id = p.company_id
 WHERE p.direccion = 'VENTAS'

UNION ALL

-- D · Qué porción de la cartera está vencida.
--     Solo cuenta lo vencido con fundamento: exige condición de pago declarada
--     (0053). Sin eso el numerador es cero y la señal dice cero, no «sano».
SELECT g.company_id,
       'MORA_DE_CARTERA'::text,
       'fiscal_years'::text,
       fy.id,
       NULL::uuid,
       'Cartera de clientes'::text,
       round(sum(g.vencido) / nullif(sum(g.pendiente), 0) * 100, 2)::numeric(10, 2),
       '%'::text,
       sum(g.vencido),
       sum(g.pendiente),
       max(t.mora_pct),
       CASE WHEN max(t.mora_pct) IS NULL THEN NULL
            ELSE (sum(g.vencido) / nullif(sum(g.pendiente), 0) * 100) >= max(t.mora_pct)
       END,
       'Pendiente vencido sobre pendiente total de VENTAS. Vencido solo cuenta '
       'comprobantes de terceros con condición de pago declarada: sin plazo acordado '
       'el sistema no afirma mora, y el numerador queda en cero.'::text
  FROM party_aging g
  JOIN fiscal_years fy ON fy.company_id = g.company_id AND fy.status <> 'CERRADO'
  LEFT JOIN analysis_thresholds t ON t.company_id = g.company_id
 WHERE g.direction = 'VENTAS'
 GROUP BY g.company_id, fy.id
HAVING sum(g.pendiente) > 0;

COMMENT ON VIEW analysis_signals IS
  'Cuatro cuentas deterministas sobre los hechos. `supera_umbral` es NULL '
  'cuando la empresa no declaró contra qué comparar: distinto de false, que '
  'sería afirmar que está bien. `metodologia` trae la cuenta exacta en texto.';

-- ---------------------------------------------------------------------------
-- 3 · La rama de desvíos en la bandeja
-- ---------------------------------------------------------------------------
-- Solo entra lo que supera un umbral **declarado**. Una señal informativa se
-- consulta, no se convierte en trabajo pendiente: llenar la bandeja de cosas
-- que nadie pidió medir es la forma más rápida de que se deje de mirar.
CREATE VIEW work_queue_senales WITH (security_invoker = true) AS
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
       -- No se resuelve con un botón: es una decisión de negocio. Se informa.
       'INFORMATIVO'::text                          AS disponibilidad,
       now()                                        AS creado_en,
       now()                                        AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       CASE WHEN s.party_id IS NOT NULL
            THEN '/parties/' || s.party_id || '/saldo'
            ELSE '/analytics/resumen'
       END                                          AS traza_ref
  FROM analysis_signals s
 WHERE s.supera_umbral IS TRUE
) q;

COMMENT ON VIEW work_queue_senales IS
  'Solo lo que supera un umbral DECLARADO. Una señal informativa se consulta y '
  'no ocupa la bandeja: llenarla de cosas que nadie pidió medir es la forma más '
  'rápida de que se deje de mirar.';

-- `CREATE OR REPLACE` y no `DROP` + `CREATE`, por un motivo que apareció al
-- intentarlo: desde la 0057 `analytics_resumen` lee la bandeja, y tirarla exige
-- tirar también a quien depende de ella y volver a escribirla — treinta líneas
-- copiadas, que es exactamente el problema que la 0051 vino a resolver.
--
-- El reemplazo en el lugar funciona porque agregar una rama a la unión **no
-- cambia las columnas**, y esa es justamente la propiedad que hace extensible a
-- la bandeja. De acá en adelante, sumar un dominio es una línea.
--
-- ⚠ La cláusula `WITH (security_invoker = true)` va repetida a propósito, y es
-- lo más importante de este bloque. `CREATE OR REPLACE` **no conserva las
-- reloptions**: omitirla las borra, la vista pasa a evaluarse con los permisos
-- de su dueño y saltea el RLS de las veinte tablas de abajo — la bandeja
-- mostraría el trabajo pendiente de todas las empresas. Es la misma fuga que
-- la 0032 encontró y cerró. Se comprobó con `pg_class.reloptions` después de
-- aplicar, no se dio por hecho.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales;

COMMENT ON VIEW work_queue IS
  'La bandeja completa: la unión de las vistas por dominio. Agregar un módulo '
  'es agregar su vista y un renglón acá, sin tocar lo que ya funciona.';

-- ---------------------------------------------------------------------------
-- 4 · Permisos
-- ---------------------------------------------------------------------------
-- Declarar un umbral cambia qué se le informa a la empresa como problema. Es
-- una decisión de dirección, no de operación.
INSERT INTO permissions (code, description) VALUES
  ('analysis:read',      'Consultar señales, proyecciones y simulaciones'),
  ('analysis:configure', 'Declarar los umbrales a partir de los cuales algo es un desvío');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'analysis:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR') AND p.code = 'analysis:configure';

GRANT SELECT, INSERT, UPDATE ON analysis_thresholds TO aai_app;
GRANT SELECT ON analysis_signals TO aai_app;
GRANT SELECT ON work_queue_senales TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
