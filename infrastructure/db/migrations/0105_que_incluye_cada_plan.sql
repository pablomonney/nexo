-- ============================================================================
-- 0105 — Qué incluye cada plan
-- ============================================================================
--
-- Los planes que había —GRATUITO, PYME, PROFESIONAL, EMPRESA, CONTADOR— eran
-- una estructura de ejemplo: cinco filas con nombre y orden, sin precio, sin
-- topes y **sin ninguna forma de decir qué incluye cada uno**. Servían para
-- probar que la tabla existía y no para vender.
--
-- Esta migración pone las tres piezas que faltaban:
--
--   1. los cinco planes comerciales de B-1;
--   2. un catálogo de funcionalidades **derivado de lo que el sistema hace**;
--   3. qué funcionalidad incluye cada plan.
--
-- ## Los planes viejos no se borran: se discontinúan
--
-- `subscription_plans.status` ya tenía `DISCONTINUADO` para esto. Borrarlos
-- dejaría a cualquier suscripción histórica apuntando a una fila que no está, y
-- el día que alguien mire por qué una empresa pagaba lo que pagaba no va a
-- encontrar el plan que tenía.
--
-- Hoy no hay ninguna suscripción, así que borrar sería inocuo — y esa es
-- exactamente la clase de razonamiento que deja el sistema sin historia el día
-- que sí la haya.
--
-- ## El catálogo de funcionalidades sale del código, no de un folleto
--
-- Cada fila de `plan_features` nombra un módulo que **existe y corre**. No hay
-- ninguna que describa algo por venir: una funcionalidad futura en la matriz de
-- planes es una promesa de venta que el producto no puede cumplir, y se
-- descubre el primer día de uso.
--
-- Lo que todavía no existe —RRHH, por ejemplo— simplemente no está en el
-- catálogo. Cuando exista, se agrega con su migración.
--
-- ## Qué plan incluye qué es una HIPÓTESIS, y está dicho en la fila
--
-- El reparto de funcionalidades entre planes es una decisión comercial que
-- **nadie tomó todavía**. Lo que se carga acá es la hipótesis de B-1, con
-- `declarado_por = 'hipotesis-b1'` para que se pueda distinguir de una decisión
-- tomada, y con `motivo` en cada declaración.
--
-- El precio **no** se carga acá. Va por `npm run precios:b1`, que lo declara con
-- vigencia y motivo, porque un precio cambia y la migración no.
--
-- ## Fail-open, y hay que decirlo
--
-- El guard que usa esta tabla deja pasar **todo dominio que no esté en el
-- catálogo** y toda empresa sin suscripción. Es una puerta comercial, no de
-- seguridad: el error caro de una puerta comercial es dejar afuera a alguien
-- que paga, no dejar entrar a alguien que no. El aislamiento entre empresas no
-- depende de esto en absoluto — lo sostienen el RLS y los permisos.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Catálogo de funcionalidades
-- ---------------------------------------------------------------------------

CREATE TABLE product_features (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9-]{2,40}$'),
  nombre      text NOT NULL CHECK (length(btrim(nombre)) > 0),
  descripcion text NOT NULL CHECK (length(btrim(descripcion)) > 10),
  -- El primer segmento de las rutas que cubre. `NULL` = no gobierna ninguna
  -- ruta y sirve solo para la matriz comercial.
  dominios    text[] NOT NULL DEFAULT '{}',
  orden       integer NOT NULL CHECK (orden > 0),
  -- Un módulo esencial no se puede excluir de ningún plan: sin contabilidad no
  -- hay producto. El `CHECK` de más abajo lo hace cumplir.
  esencial    boolean NOT NULL DEFAULT false
);

GRANT SELECT ON product_features TO aai_app;
REVOKE INSERT, UPDATE, DELETE ON product_features FROM aai_app;

COMMENT ON TABLE product_features IS
  'Qué sabe hacer el producto, derivado de lo que corre. Ninguna fila describe '
  'algo por venir: una funcionalidad futura en la matriz de planes es una '
  'promesa de venta que el producto no puede cumplir.';

INSERT INTO product_features (code, nombre, descripcion, dominios, orden, esencial) VALUES
  ('contabilidad', 'Contabilidad',
   'Plan de cuentas, asientos, Diario, Mayor, períodos, cierre y estados contables',
   '{accounts,journal-entries,books,statements,periods,closures,notes,mapeo-contable}', 1, true),
  ('fiscal', 'Fiscal y comprobantes',
   'Comprobantes, IVA, subdiarios, afectaciones y libros fiscales',
   '{comprobantes,vat,afectaciones,imputaciones}', 2, true),
  ('terceros', 'Clientes y proveedores',
   'Maestro de terceros, cuentas corrientes, imputaciones y antigüedad de saldos',
   '{parties}', 3, true),
  ('documentos', 'Documentos',
   'Ingesta, OCR, extracción de datos, versiones y detección de duplicados',
   '{documents}', 4, true),
  ('auditoria', 'Auditoría y trazabilidad',
   'Bitácora encadenada por hash, linaje de datos y verificación del Mayor',
   '{audit,linaje}', 5, true),
  ('comercial', 'Ventas',
   'Presupuestos, pedidos, remitos, facturas, cobranzas y notas de crédito',
   '{comercial}', 6, false),
  ('compras', 'Compras',
   'Solicitudes, órdenes, recepciones, facturas de proveedor y órdenes de pago',
   '{solicitudes-de-compra,recepciones,ordenes-de-pago}', 7, false),
  ('stock', 'Stock',
   'Movimientos, depósitos, recuentos, valuación y costo promedio ponderado',
   '{stock,recuentos,valuacion,activos}', 8, false),
  ('tesoreria', 'Tesorería',
   'Caja, bancos, cheques y conciliación bancaria',
   '{caja,banks,cheques}', 9, false),
  ('precios', 'Productos y listas de precios',
   'Catálogo de productos, listas de precios y asignación por tercero',
   '{products,precios}', 10, false),
  ('sucursales', 'Sucursales y centros de costo',
   'Sucursales, puntos de venta, centros de costo y de beneficio',
   '{sucursales}', 11, false),
  ('proyectos', 'Proyectos',
   'Proyectos, tareas, horas y tarifas por proyecto',
   '{proyectos}', 12, false),
  ('comisiones', 'Comisiones',
   'Esquemas de comisión, vendedores y liquidación',
   '{comisiones}', 13, false),
  ('crm', 'CRM',
   'Oportunidades, etapas, pipeline y actividades comerciales',
   '{crm}', 14, false),
  ('analitica', 'Analítica',
   'Resumen del negocio, operaciones por mes, productos, terceros y flujo bancario',
   '{analytics}', 15, false),
  ('analisis', 'Análisis y decisiones',
   'Señales, umbrales, alertas, escenarios, riesgos y registro de decisiones',
   '{analysis,decision-records}', 16, false),
  ('inteligencia', 'Inteligencia',
   'Preguntas sobre el propio negocio, panorama y propuestas de clasificación',
   '{intelligence,predictions}', 17, false),
  ('integraciones', 'Integraciones',
   'Canales de venta y orígenes de datos externos, con su registro de sincronización',
   '{integraciones}', 18, false),
  ('arca', 'ARCA',
   'Consulta de padrón, constatación de comprobantes y capacidades del contribuyente',
   '{arca}', 19, false);

-- ---------------------------------------------------------------------------
-- Los planes comerciales
-- ---------------------------------------------------------------------------
--
-- Los cinco de B-1. Se agregan; los anteriores se discontinúan más abajo.

INSERT INTO subscription_plans (code, name, descripcion, orden, status) VALUES
  ('CONTABLE', 'NEXO Contable',
   'Para llevar los libros de una empresa: contabilidad, fiscal, documentos y auditoría',
   10, 'DISPONIBLE'),
  ('GESTION', 'NEXO Gestión',
   'La operación completa de una empresa: ventas, compras, stock y tesorería',
   20, 'DISPONIBLE'),
  ('ESTUDIO', 'NEXO Estudio',
   'Para un estudio contable: la cartera de clientes bajo un mismo techo',
   30, 'DISPONIBLE'),
  ('EMPRESA_B1', 'NEXO Empresa',
   'Varias sucursales, proyectos, comisiones y analítica del negocio',
   40, 'DISPONIBLE'),
  ('COMPLETO', 'NEXO Completo',
   'Todo lo anterior más análisis, decisiones, inteligencia e integraciones',
   50, 'DISPONIBLE')
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, descripcion = EXCLUDED.descripcion,
      orden = EXCLUDED.orden, status = EXCLUDED.status;

-- Los de ejemplo salen del catálogo comercial y **no se borran**: una
-- suscripción histórica que los cite tiene que seguir encontrando su plan.
UPDATE subscription_plans SET status = 'DISCONTINUADO'
 WHERE code IN ('GRATUITO', 'PYME', 'PROFESIONAL', 'EMPRESA', 'CONTADOR');

-- ---------------------------------------------------------------------------
-- Qué incluye cada plan
-- ---------------------------------------------------------------------------

CREATE TABLE plan_features (
  plan_id       uuid NOT NULL REFERENCES subscription_plans (id),
  feature_code  text NOT NULL REFERENCES product_features (code),
  declarado_por text NOT NULL,
  declarado_el  timestamptz NOT NULL DEFAULT now(),
  motivo        text NOT NULL CHECK (length(btrim(motivo)) >= 10),

  PRIMARY KEY (plan_id, feature_code)
);

GRANT SELECT ON plan_features TO aai_app;
REVOKE INSERT, UPDATE, DELETE ON plan_features FROM aai_app;

COMMENT ON TABLE plan_features IS
  'Qué funcionalidad incluye cada plan. El reparto es una HIPÓTESIS comercial: '
  'declarado_por dice quién lo decidió, y hasta que lo decida alguien vale '
  'hipotesis-b1.';

/**
 * Un plan sin las funcionalidades esenciales no es un plan: es un producto
 * distinto. Esto lo impide desde la base, no desde el código que las carga.
 */
CREATE FUNCTION plan_incluye_las_esenciales(plan uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM product_features f
     WHERE f.esencial
       AND NOT EXISTS (
         SELECT 1 FROM plan_features pf
          WHERE pf.plan_id = plan AND pf.feature_code = f.code)
  )
$$;

COMMENT ON FUNCTION plan_incluye_las_esenciales(uuid) IS
  'Sin contabilidad, fiscal, terceros, documentos y auditoría no hay producto. '
  'Se comprueba después de cargar, no con un trigger por fila: durante la carga '
  'el plan está incompleto por definición.';

-- La hipótesis B-1. Cada `INSERT` dice quién la declaró y por qué.
WITH asignacion(plan_code, feature_code) AS (VALUES
  -- Contable: llevar los libros. Sin operación comercial.
  ('CONTABLE','contabilidad'), ('CONTABLE','fiscal'), ('CONTABLE','terceros'),
  ('CONTABLE','documentos'), ('CONTABLE','auditoria'), ('CONTABLE','arca'),

  -- Gestión: la operación completa de una empresa.
  ('GESTION','contabilidad'), ('GESTION','fiscal'), ('GESTION','terceros'),
  ('GESTION','documentos'), ('GESTION','auditoria'), ('GESTION','arca'),
  ('GESTION','comercial'), ('GESTION','compras'), ('GESTION','stock'),
  ('GESTION','tesoreria'), ('GESTION','precios'),

  -- Estudio: Contable con la cartera de clientes y analítica para reportarles.
  ('ESTUDIO','contabilidad'), ('ESTUDIO','fiscal'), ('ESTUDIO','terceros'),
  ('ESTUDIO','documentos'), ('ESTUDIO','auditoria'), ('ESTUDIO','arca'),
  ('ESTUDIO','analitica'),

  -- Empresa: varias sucursales y el negocio medido.
  ('EMPRESA_B1','contabilidad'), ('EMPRESA_B1','fiscal'), ('EMPRESA_B1','terceros'),
  ('EMPRESA_B1','documentos'), ('EMPRESA_B1','auditoria'), ('EMPRESA_B1','arca'),
  ('EMPRESA_B1','comercial'), ('EMPRESA_B1','compras'), ('EMPRESA_B1','stock'),
  ('EMPRESA_B1','tesoreria'), ('EMPRESA_B1','precios'), ('EMPRESA_B1','sucursales'),
  ('EMPRESA_B1','proyectos'), ('EMPRESA_B1','comisiones'), ('EMPRESA_B1','crm'),
  ('EMPRESA_B1','analitica'),

  -- Completo: todo lo que el sistema sabe hacer hoy.
  ('COMPLETO','contabilidad'), ('COMPLETO','fiscal'), ('COMPLETO','terceros'),
  ('COMPLETO','documentos'), ('COMPLETO','auditoria'), ('COMPLETO','arca'),
  ('COMPLETO','comercial'), ('COMPLETO','compras'), ('COMPLETO','stock'),
  ('COMPLETO','tesoreria'), ('COMPLETO','precios'), ('COMPLETO','sucursales'),
  ('COMPLETO','proyectos'), ('COMPLETO','comisiones'), ('COMPLETO','crm'),
  ('COMPLETO','analitica'), ('COMPLETO','analisis'), ('COMPLETO','inteligencia'),
  ('COMPLETO','integraciones')
)
INSERT INTO plan_features (plan_id, feature_code, declarado_por, motivo)
SELECT p.id, a.feature_code, 'hipotesis-b1',
       'Reparto de funcionalidades propuesto en B-1. Requiere confirmación del fundador.'
  FROM asignacion a
  JOIN subscription_plans p ON p.code = a.plan_code
ON CONFLICT DO NOTHING;

-- Se comprueba después de cargar. Si alguna faltara, la migración se cae y no
-- queda un plan vendible sin contabilidad.
DO $$
DECLARE incompleto text;
BEGIN
  SELECT string_agg(p.code, ', ') INTO incompleto
    FROM subscription_plans p
   WHERE p.status = 'DISPONIBLE'
     AND NOT plan_incluye_las_esenciales(p.id);
  IF incompleto IS NOT NULL THEN
    RAISE EXCEPTION 'Estos planes no incluyen las funcionalidades esenciales: %', incompleto;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Vista: la matriz de producto
-- ---------------------------------------------------------------------------

CREATE VIEW plan_matrix WITH (security_invoker = true) AS
SELECT
  p.code   AS plan_code,
  p.name   AS plan,
  p.orden  AS plan_orden,
  p.status,
  f.code   AS feature_code,
  f.nombre AS feature,
  f.orden  AS feature_orden,
  f.esencial,
  (pf.plan_id IS NOT NULL) AS incluida
FROM subscription_plans p
CROSS JOIN product_features f
LEFT JOIN plan_features pf ON pf.plan_id = p.id AND pf.feature_code = f.code
WHERE p.status = 'DISPONIBLE';

GRANT SELECT ON plan_matrix TO aai_app;

COMMENT ON VIEW plan_matrix IS
  'La matriz de producto: cada plan contra cada funcionalidad. Es el producto '
  'cruzado a propósito — una funcionalidad ausente tiene que aparecer como '
  'ausente y no como una fila que falta.';
