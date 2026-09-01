-- 0057_analitica.sql — la capa que convierte operación en información.
--
-- ## Ni una cifra almacenada
--
-- Toda la analítica son vistas. No hay una sola tabla de agregados, y no es
-- pereza: un acumulado que la aplicación mantiene al día es la segunda verdad
-- de siempre, con el agravante de que en analítica **nadie la contrasta**. Un
-- saldo mal se nota cuando el cliente reclama; un total de ventas mal puede
-- vivir años en un tablero que todos miran y nadie verifica.
--
-- §63 pide no castigar la operación con consultas analíticas pesadas. A esta
-- escala las vistas no la castigan. Cuando dejen de alcanzar, la respuesta es
-- una vista **materializada con refresco explícito** —que dice cuándo se
-- calculó— y no un contador que la aplicación incrementa a mano.
--
-- ## Lo que esta capa NO mide, y por qué
--
-- **Margen y rentabilidad.** Todo el mundo los quiere y son justo lo que no se
-- puede calcular hoy: exigen el **costo** de lo vendido, y el stock de NEXO
-- lleva cantidades, no valores. Elegir PPP, FIFO o costo de reposición es una
-- decisión contable con norma detrás, no un detalle de implementación.
--
-- Poner acá un «margen» calculado contra el precio de lista sería inventar el
-- número más importante del tablero. No está, y cada respuesta de la API lo
-- dice. Cuando exista la valuación de existencias, el margen se deriva de la
-- misma manera que todo lo demás.
--
-- ## Cada cifra se puede abrir
--
-- §64: un número importante tiene que poder rastrearse hasta su origen. Estas
-- vistas conservan siempre las claves que permiten volver a las filas —período,
-- producto, tercero— y la API devuelve, junto a cada total, el filtro exacto
-- que muestra los comprobantes que lo formaron. Un tablero cuyos números no se
-- pueden abrir es un tablero en el que hay que creer.

-- ---------------------------------------------------------------------------
-- 1 · Ventas y compras por mes
-- ---------------------------------------------------------------------------
-- El mes sale de la fecha del comprobante, no de cuándo se cargó: una factura
-- de marzo asentada en abril es de marzo.
CREATE VIEW analytics_operaciones_mensuales WITH (security_invoker = true) AS
SELECT t.company_id,
       t.direction                                   AS direccion,
       date_trunc('month', t.cbte_fecha)::date       AS mes,
       count(*)::int                                 AS comprobantes,
       sum(t.neto)::numeric(18, 2)                   AS neto,
       sum(t.iva)::numeric(18, 2)                    AS iva,
       sum(t.exento)::numeric(18, 2)                 AS exento,
       sum(t.no_gravado)::numeric(18, 2)             AS no_gravado,
       sum(t.percepciones)::numeric(18, 2)           AS percepciones,
       sum(t.total)::numeric(18, 2)                  AS total,
       count(DISTINCT t.party_id)::int               AS terceros,
       -- Cuántos de esos comprobantes todavía no están resueltos contra el
       -- maestro. Es la medida de cuánto de este total es anónimo.
       count(*) FILTER (WHERE t.party_id IS NULL)::int AS sin_tercero
  FROM tax_transactions t
 GROUP BY t.company_id, t.direction, date_trunc('month', t.cbte_fecha);

COMMENT ON VIEW analytics_operaciones_mensuales IS
  'Ventas y compras por mes, por fecha del comprobante. `sin_tercero` dice '
  'cuánto del total no está resuelto contra el maestro.';

-- ---------------------------------------------------------------------------
-- 2 · Qué se vende
-- ---------------------------------------------------------------------------
-- Solo cuenta lo que tiene renglones. Un comprobante sin detalle suma al total
-- del mes y no a ningún producto, y `analytics_cobertura_de_detalle` dice
-- cuánto es — para que la diferencia entre los dos informes se explique en vez
-- de parecer un error.
CREATE VIEW analytics_por_producto WITH (security_invoker = true) AS
SELECT l.company_id,
       t.direction                                   AS direccion,
       l.product_id,
       p.code                                        AS producto_codigo,
       p.name                                        AS producto_nombre,
       p.unit                                        AS unidad,
       count(DISTINCT t.id)::int                     AS comprobantes,
       sum(l.cantidad)::numeric(18, 4)               AS cantidad,
       sum(l.neto)::numeric(18, 2)                   AS neto,
       min(t.cbte_fecha)                             AS primera,
       max(t.cbte_fecha)                             AS ultima
  FROM tax_transaction_lines l
  JOIN tax_transactions t ON t.id = l.tax_transaction_id AND t.company_id = l.company_id
  JOIN products p         ON p.id = l.product_id        AND p.company_id = l.company_id
 GROUP BY l.company_id, t.direction, l.product_id, p.code, p.name, p.unit;

COMMENT ON VIEW analytics_por_producto IS
  'Cantidades e importes por producto. NO incluye margen: el costo de lo '
  'vendido exige valuación de existencias, que todavía no existe.';

-- ---------------------------------------------------------------------------
-- 3 · Con quién se opera
-- ---------------------------------------------------------------------------
CREATE VIEW analytics_por_tercero WITH (security_invoker = true) AS
SELECT t.company_id,
       t.direction                                   AS direccion,
       t.party_id,
       p.razon_social,
       p.tipo_documento,
       p.numero_documento,
       count(*)::int                                 AS comprobantes,
       sum(t.neto)::numeric(18, 2)                   AS neto,
       sum(t.total)::numeric(18, 2)                  AS total,
       min(t.cbte_fecha)                             AS primera,
       max(t.cbte_fecha)                             AS ultima,
       (current_date - max(t.cbte_fecha))            AS dias_sin_operar
  FROM tax_transactions t
  JOIN parties p ON p.id = t.party_id AND p.company_id = t.company_id
 GROUP BY t.company_id, t.direction, t.party_id, p.razon_social,
          p.tipo_documento, p.numero_documento;

COMMENT ON VIEW analytics_por_tercero IS
  'Volumen por cliente y por proveedor. Solo comprobantes resueltos contra el '
  'maestro: los anónimos no tienen a quién sumarse.';

-- ---------------------------------------------------------------------------
-- 4 · Cuánta de la información está completa
-- ---------------------------------------------------------------------------
-- La medida de confianza del propio tablero. Sin esto, un informe por producto
-- que cubre el 30% de las ventas se lee igual que uno que cubre el 100%, y las
-- decisiones se toman sobre una muestra que nadie sabe que es una muestra.
CREATE VIEW analytics_cobertura_de_detalle WITH (security_invoker = true) AS
SELECT t.company_id,
       t.direction                                   AS direccion,
       count(*)::int                                 AS comprobantes,
       count(*) FILTER (WHERE d.renglones > 0)::int  AS con_detalle,
       sum(t.neto)::numeric(18, 2)                   AS neto_total,
       coalesce(sum(t.neto) FILTER (WHERE d.renglones > 0), 0)::numeric(18, 2)
                                                     AS neto_con_detalle,
       count(*) FILTER (WHERE t.party_id IS NOT NULL)::int AS con_tercero
  FROM tax_transactions t
  LEFT JOIN LATERAL (
        SELECT count(*)::int AS renglones
          FROM tax_transaction_lines l
         WHERE l.tax_transaction_id = t.id AND l.company_id = t.company_id
       ) d ON true
 GROUP BY t.company_id, t.direction;

COMMENT ON VIEW analytics_cobertura_de_detalle IS
  'Qué porción de los comprobantes tiene detalle y tercero resuelto. Es la '
  'medida de confianza de los informes por producto y por tercero.';

-- ---------------------------------------------------------------------------
-- 5 · Flujo de las cuentas bancarias declaradas
-- ---------------------------------------------------------------------------
-- Mide el Mayor de las cuentas que la empresa declaró como bancarias en
-- `bank_accounts`. **El efectivo en caja no entra**: ninguna tabla dice qué
-- cuenta es la caja, y suponerlo por el nombre —«Caja», «Efectivo»— sería
-- adivinar con el plan de cuentas de cada empresa.
CREATE VIEW analytics_flujo_bancario WITH (security_invoker = true) AS
SELECT l.company_id,
       date_trunc('month', e.entry_date)::date       AS mes,
       b.id                                          AS bank_account_id,
       b.bank_name                                   AS banco,
       a.code                                        AS cuenta_codigo,
       sum(l.debit)::numeric(18, 2)                  AS ingresos,
       sum(l.credit)::numeric(18, 2)                 AS egresos,
       (sum(l.debit) - sum(l.credit))::numeric(18, 2) AS neto,
       count(*)::int                                 AS movimientos
  FROM journal_entry_lines l
  JOIN journal_entries e ON e.id = l.entry_id AND e.company_id = l.company_id
  JOIN bank_accounts b   ON b.account_id = l.account_id AND b.company_id = l.company_id
  JOIN accounts a        ON a.id = l.account_id AND a.company_id = l.company_id
 WHERE e.status = 'APROBADO'
 GROUP BY l.company_id, date_trunc('month', e.entry_date), b.id, b.bank_name, a.code;

COMMENT ON VIEW analytics_flujo_bancario IS
  'Movimiento mensual de las cuentas bancarias DECLARADAS. El efectivo en caja '
  'no entra: ninguna tabla dice cuál es la cuenta de caja y adivinarla por el '
  'nombre sería inventar el dato.';

-- ---------------------------------------------------------------------------
-- 6 · El resumen que abre el día
-- ---------------------------------------------------------------------------
-- Todo derivado de vistas que ya existen. Ni un número nuevo: es una lectura
-- distinta de los mismos hechos.
CREATE VIEW analytics_resumen WITH (security_invoker = true) AS
SELECT c.id                                          AS company_id,
       coalesce(v.neto, 0)::numeric(18, 2)           AS ventas_mes,
       coalesce(v.comprobantes, 0)                   AS ventas_comprobantes,
       coalesce(k.neto, 0)::numeric(18, 2)           AS compras_mes,
       coalesce(k.comprobantes, 0)                   AS compras_comprobantes,
       coalesce(cc.a_cobrar, 0)::numeric(18, 2)      AS a_cobrar,
       coalesce(cc.vencido_a_cobrar, 0)::numeric(18, 2) AS vencido_a_cobrar,
       coalesce(cp.a_pagar, 0)::numeric(18, 2)       AS a_pagar,
       coalesce(st.bajo_minimo, 0)                   AS productos_bajo_minimo,
       coalesce(st.negativos, 0)                     AS productos_en_negativo,
       coalesce(wq.pendientes, 0)                    AS pendientes,
       coalesce(wq.bloqueantes, 0)                   AS pendientes_bloqueantes
  FROM companies c
  LEFT JOIN LATERAL (
        SELECT neto, comprobantes FROM analytics_operaciones_mensuales m
         WHERE m.company_id = c.id AND m.direccion = 'VENTAS'
           AND m.mes = date_trunc('month', current_date)::date
       ) v ON true
  LEFT JOIN LATERAL (
        SELECT neto, comprobantes FROM analytics_operaciones_mensuales m
         WHERE m.company_id = c.id AND m.direccion = 'COMPRAS'
           AND m.mes = date_trunc('month', current_date)::date
       ) k ON true
  LEFT JOIN LATERAL (
        SELECT sum(g.pendiente) AS a_cobrar, sum(g.vencido) AS vencido_a_cobrar
          FROM party_aging g
         WHERE g.company_id = c.id AND g.direction = 'VENTAS'
       ) cc ON true
  LEFT JOIN LATERAL (
        SELECT sum(g.pendiente) AS a_pagar
          FROM party_aging g
         WHERE g.company_id = c.id AND g.direction = 'COMPRAS'
       ) cp ON true
  LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE s.bajo_minimo)::int      AS bajo_minimo,
               count(*) FILTER (WHERE s.existencia < 0)::int   AS negativos
          FROM stock_by_product s WHERE s.company_id = c.id
       ) st ON true
  LEFT JOIN LATERAL (
        SELECT count(*)::int                          AS pendientes,
               count(*) FILTER (WHERE w.bloquea)::int AS bloqueantes
          FROM work_queue w WHERE w.company_id = c.id
       ) wq ON true;

COMMENT ON VIEW analytics_resumen IS
  'El estado de la empresa en una fila, derivado de las vistas que ya existen. '
  'No incluye margen ni rentabilidad: exigen costo, y el stock lleva cantidades.';

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
-- La analítica cruza información comercial y contable, así que no alcanza con
-- `report:read`: cada consulta pide además el permiso del dominio que expone.
-- Quien no puede ver el maestro de productos tampoco ve qué se vendió de cada
-- uno por otra puerta.
INSERT INTO permissions (code, description) VALUES
  ('analytics:read', 'Consultar la analítica del negocio');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'analytics:read';

-- ---------------------------------------------------------------------------
-- 8 · Permisos de lectura sobre las vistas
-- ---------------------------------------------------------------------------
-- Las seis llevan `security_invoker`: se evalúan con los permisos de quien
-- consulta y el RLS de las tablas de abajo sigue valiendo. Sin eso, un tablero
-- mostraría las ventas de todas las empresas del estudio.
GRANT SELECT ON analytics_operaciones_mensuales TO aai_app;
GRANT SELECT ON analytics_por_producto TO aai_app;
GRANT SELECT ON analytics_por_tercero TO aai_app;
GRANT SELECT ON analytics_cobertura_de_detalle TO aai_app;
GRANT SELECT ON analytics_flujo_bancario TO aai_app;
GRANT SELECT ON analytics_resumen TO aai_app;
