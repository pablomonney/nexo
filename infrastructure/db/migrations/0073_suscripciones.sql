-- ============================================================================
-- 0073 — Suscripciones del propio NEXO: qué plan tiene cada empresa
-- ============================================================================
--
-- Es el único módulo que no habla del negocio del cliente sino del propio: qué
-- plan tiene contratada cada empresa, desde cuándo, y cuánto está usando.
--
-- ## Sin precios, y no por olvido
--
-- Acá no hay ninguna columna de precio, moneda ni importe. El precio de cada
-- plan es una decisión comercial que **no está tomada**, y escribir un número
-- —aunque fuera de ejemplo— haría que un tablero mostrara facturación inventada
-- (§15). Cuando la decisión exista, entra con su propia migración, con su
-- moneda y con su vigencia, como cualquier otro precio del sistema.
--
-- ## Sin datos de tarjeta, y eso no cambia nunca
--
-- No hay columnas para medio de pago, y no las va a haber: cobrar es tarea de
-- un proveedor de pagos, y lo único que este esquema podría guardar alguna vez
-- es un identificador opaco de ese proveedor. Número, vencimiento y código de
-- seguridad no se almacenan bajo ninguna circunstancia.
--
-- ## Los topes se declaran, y lo que no se declaró no limita
--
-- Un plan no tiene «usuarios ilimitados» ni «hasta 5 empresas» escritos en el
-- código: cada tope es una fila declarada. La ausencia de una fila significa
-- **sin tope declarado**, y se informa así — no como «ilimitado», que sería
-- afirmar una política comercial que nadie escribió.
--
-- ## Y el límite avisa: no bloquea
--
-- Esta es la decisión importante del módulo. Exceder el plan **no impide**
-- registrar una factura, cerrar un ejercicio ni emitir un comprobante. Un
-- sistema contable que se niega a registrar un hecho por una cuestión comercial
-- deja los libros incompletos, y los libros incompletos no se arreglan
-- pagando: el hecho ya pasó y quedó sin asentar.
--
-- Lo que hace el módulo es **medir y avisar**. Cortar el servicio —si alguna
-- vez corresponde— es una decisión de producto con consecuencias legales sobre
-- la conservación de la documentación del cliente, y no se toma acá.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · El catálogo de planes
-- ---------------------------------------------------------------------------
-- Global, no por empresa: es la oferta del producto, no un dato del cliente.
CREATE TABLE subscription_plans (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  code         text NOT NULL UNIQUE CHECK (length(btrim(code)) > 0),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  descripcion  text,
  orden        int  NOT NULL CHECK (orden > 0),
  status       text NOT NULL DEFAULT 'DISPONIBLE'
                 CHECK (status IN ('DISPONIBLE', 'DISCONTINUADO')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON subscription_plans TO aai_app;

COMMENT ON TABLE subscription_plans IS
  'La oferta del producto. Sin columnas de precio: el precio de cada plan es '
  'una decisión comercial que no está tomada, y escribir un número de ejemplo '
  'haría que un tablero mostrara facturación inventada.';

-- Los cinco planes nombrados en la definición del producto. Se cargan como
-- catálogo —igual que los tipos de comprobante— porque son parte de la oferta y
-- no algo que cada instalación invente.
INSERT INTO subscription_plans (code, name, descripcion, orden) VALUES
  ('GRATUITO',    'Gratuito / Demo', 'Para probar el producto con datos propios', 1),
  ('PYME',        'Pyme',            'Una empresa con su operación completa',     2),
  ('PROFESIONAL', 'Profesional',     'Varias empresas y más volumen',             3),
  ('EMPRESA',     'Empresa',         'Volumen alto y múltiples usuarios',         4),
  ('CONTADOR',    'Contador',        'Estudio con la cartera de sus clientes',    5);

-- ---------------------------------------------------------------------------
-- 2 · Los topes, declarados uno por uno
-- ---------------------------------------------------------------------------
CREATE TABLE plan_limits (
  plan_id      uuid NOT NULL REFERENCES subscription_plans (id),
  recurso      text NOT NULL
                 CHECK (recurso IN ('EMPRESAS', 'USUARIOS', 'COMPROBANTES_MES',
                                    'DOCUMENTOS_MES', 'INTEGRACIONES')),
  tope         int  NOT NULL CHECK (tope > 0),
  declarado_por text NOT NULL,
  declarado_el timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (plan_id, recurso)
);

GRANT SELECT ON plan_limits TO aai_app;

COMMENT ON TABLE plan_limits IS
  'Un tope por plan y por recurso. La ausencia de fila significa SIN TOPE '
  'DECLARADO y se informa así: decir «ilimitado» sería afirmar una política '
  'comercial que nadie escribió.';

-- A propósito **no se siembra ningún tope**: cuántos usuarios entran en el plan
-- Pyme es una decisión comercial, y ponerle un número acá la tomaría por quien
-- corresponde. Sin topes declarados el sistema mide el uso y no llama exceso a
-- nada, que es exactamente lo mismo que hace con los umbrales de análisis.

-- ---------------------------------------------------------------------------
-- 3 · Qué plan tiene cada empresa, con vigencia
-- ---------------------------------------------------------------------------
CREATE TABLE company_subscriptions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  plan_id        uuid NOT NULL REFERENCES subscription_plans (id),

  estado         text NOT NULL DEFAULT 'ACTIVA'
                   CHECK (estado IN ('PRUEBA', 'ACTIVA', 'SUSPENDIDA', 'CANCELADA')),

  vigencia_desde date NOT NULL,
  vigencia_hasta date,
  motivo         text,

  -- Identificador opaco del proveedor de pagos, si alguna vez hay uno. Nunca un
  -- número de tarjeta, un vencimiento ni un código de seguridad.
  referencia_externa text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT cs_vigencia_coherente
    CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT cs_baja_con_motivo
    CHECK (estado NOT IN ('SUSPENDIDA', 'CANCELADA')
           OR (motivo IS NOT NULL AND length(btrim(motivo)) > 2))
);

ALTER TABLE company_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY csu_por_empresa ON company_subscriptions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON company_subscriptions TO aai_app;

CREATE INDEX csu_por_empresa_fecha
  ON company_subscriptions (company_id, vigencia_desde DESC);

COMMENT ON COLUMN company_subscriptions.referencia_externa IS
  'Identificador opaco del proveedor de pagos. Nunca número de tarjeta, '
  'vencimiento ni código de seguridad: eso no se guarda bajo ninguna '
  'circunstancia.';

-- Una empresa tiene un plan por vez. Con dos, el tope aplicable saldría por
-- orden de carga, que es azar disfrazado de regla — el mismo candado que las
-- listas de precios (0061) y los esquemas de comisión (0071).
CREATE FUNCTION assert_una_suscripcion_por_fecha() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM company_subscriptions s
     WHERE s.company_id = NEW.company_id
       AND s.id <> NEW.id
       AND s.estado <> 'CANCELADA'
       AND daterange(s.vigencia_desde, s.vigencia_hasta, '[]')
           && daterange(NEW.vigencia_desde, NEW.vigencia_hasta, '[]')
  ) THEN
    RAISE EXCEPTION
      'E_SUB_SUPERPUESTA: esa empresa ya tiene una suscripción vigente en esas fechas.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER csu_una_por_fecha
  AFTER INSERT OR UPDATE ON company_subscriptions
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_una_suscripcion_por_fecha();

-- ---------------------------------------------------------------------------
-- 4 · El uso, derivado
-- ---------------------------------------------------------------------------
-- Ni una cifra almacenada: contar filas es barato y guardar contadores es la
-- forma más segura de que digan algo distinto de lo que hay.
CREATE VIEW subscription_usage WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,
       (SELECT count(DISTINCT ucr.user_id)::int
          FROM user_company_roles ucr
         WHERE ucr.company_id = c.id
           AND ucr.valid_from <= current_date
           AND (ucr.valid_to IS NULL OR ucr.valid_to >= current_date))
                                                   AS usuarios,
       (SELECT count(*)::int FROM tax_transactions t
         WHERE t.company_id = c.id
           AND t.cbte_fecha >= date_trunc('month', current_date)::date)
                                                   AS comprobantes_mes,
       (SELECT count(*)::int FROM documents d
         WHERE d.company_id = c.id
           AND d.received_at >= date_trunc('month', current_date))
                                                   AS documentos_mes,
       (SELECT count(*)::int FROM company_integrations i
         WHERE i.company_id = c.id AND i.status = 'CONECTADA')
                                                   AS integraciones
  FROM companies c;

COMMENT ON VIEW subscription_usage IS
  'Cuánto usa cada empresa, contado en el momento. No hay contadores '
  'guardados: un contador que se desincroniza dice algo distinto de lo que hay '
  'y nadie se entera.';

-- ---------------------------------------------------------------------------
-- 5 · Plan vigente, uso y topes en una sola lectura
-- ---------------------------------------------------------------------------
CREATE VIEW subscription_status WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,
       s.id                                        AS subscription_id,
       p.code                                      AS plan_codigo,
       p.name                                      AS plan_nombre,
       s.estado,
       s.vigencia_desde,
       s.vigencia_hasta,
       s.motivo,
       u.usuarios,
       u.comprobantes_mes,
       u.documentos_mes,
       u.integraciones,
       -- Los topes, o NULL cuando no se declararon. NULL no es «cero» ni
       -- «ilimitado»: es «nadie lo escribió».
       lu.tope                                     AS tope_usuarios,
       lc.tope                                     AS tope_comprobantes_mes,
       ld.tope                                     AS tope_documentos_mes,
       li.tope                                     AS tope_integraciones,
       -- Cuántos topes declarados están excedidos hoy. Se cuenta en la vista
       -- para que la bandeja y la API digan lo mismo sin repetir la cuenta.
       (CASE WHEN lu.tope IS NOT NULL AND u.usuarios > lu.tope THEN 1 ELSE 0 END
      + CASE WHEN lc.tope IS NOT NULL AND u.comprobantes_mes > lc.tope THEN 1 ELSE 0 END
      + CASE WHEN ld.tope IS NOT NULL AND u.documentos_mes > ld.tope THEN 1 ELSE 0 END
      + CASE WHEN li.tope IS NOT NULL AND u.integraciones > li.tope THEN 1 ELSE 0 END)
                                                   AS topes_excedidos,
       (CASE WHEN lu.tope IS NULL THEN 1 ELSE 0 END
      + CASE WHEN lc.tope IS NULL THEN 1 ELSE 0 END
      + CASE WHEN ld.tope IS NULL THEN 1 ELSE 0 END
      + CASE WHEN li.tope IS NULL THEN 1 ELSE 0 END)
                                                   AS topes_sin_declarar
  FROM companies c
  JOIN subscription_usage u ON u.company_id = c.id
  LEFT JOIN LATERAL (
        SELECT s.*
          FROM company_subscriptions s
         WHERE s.company_id = c.id
           AND s.estado <> 'CANCELADA'
           AND s.vigencia_desde <= current_date
           AND (s.vigencia_hasta IS NULL OR s.vigencia_hasta >= current_date)
         ORDER BY s.vigencia_desde DESC
         LIMIT 1
       ) s ON true
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
  LEFT JOIN plan_limits lu ON lu.plan_id = s.plan_id AND lu.recurso = 'USUARIOS'
  LEFT JOIN plan_limits lc ON lc.plan_id = s.plan_id AND lc.recurso = 'COMPROBANTES_MES'
  LEFT JOIN plan_limits ld ON ld.plan_id = s.plan_id AND ld.recurso = 'DOCUMENTOS_MES'
  LEFT JOIN plan_limits li ON li.plan_id = s.plan_id AND li.recurso = 'INTEGRACIONES';

COMMENT ON VIEW subscription_status IS
  'Plan vigente, uso del mes y topes declarados. Exceder un tope NO impide '
  'registrar nada: un sistema contable que se niega a asentar un hecho por una '
  'cuestión comercial deja los libros incompletos, y eso no se arregla pagando.';

-- ---------------------------------------------------------------------------
-- 6 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_suscripcion WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · La empresa no tiene plan vigente. No bloquea nada —a propósito— pero es
--     un hecho que alguien tiene que resolver.
SELECT s.company_id,
       'EMPRESA_SIN_PLAN'::text                      AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.company_id                                  AS entity_id,
       'SIN_PLAN'::text                              AS estado,
       'Esta empresa no tiene un plan vigente. No se le impide operar: los ' ||
         'libros no se dejan incompletos por una cuestión comercial'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['PLAN']::text[]                         AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.subscription_id IS NULL

UNION ALL

-- 2 · Se pasó de un tope **declarado**. Sin topes declarados esta rama no
--     produce nada: el uso se informa y no se lo llama exceso.
SELECT s.company_id,
       'PLAN_EXCEDIDO'::text                         AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.subscription_id                             AS entity_id,
       s.estado                                      AS estado,
       'El uso supera ' || s.topes_excedidos || ' tope(s) declarado(s) del plan ' ||
         s.plan_codigo || '. Se informa: no se bloquea ninguna operación'
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'INFORMATIVO'::text                           AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.topes_excedidos > 0

UNION ALL

-- 3 · La suscripción está suspendida. También informativo: quien resuelve esto
--     no está adentro del sistema contable.
SELECT s.company_id,
       'SUSCRIPCION_SUSPENDIDA'::text                AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text               AS categoria,
       'company_subscriptions'::text                 AS entidad,
       s.subscription_id                             AS entity_id,
       s.estado                                      AS estado,
       'La suscripción está suspendida: ' || coalesce(s.motivo, 'sin motivo registrado')
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'INFORMATIVO'::text                           AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       s.vigencia_hasta                              AS fecha_limite,
       '/subscription'::text                         AS traza_ref
  FROM subscription_status s
 WHERE s.estado = 'SUSPENDIDA'

) q;

COMMENT ON VIEW work_queue_suscripcion IS
  'Ramas de suscripción. Ninguna bloquea: registrar un hecho contable no '
  'depende de una cuestión comercial, y los libros incompletos no se arreglan '
  'pagando.';

-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la bandeja de una empresa aparecería en la de otra.
CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios
UNION ALL SELECT * FROM work_queue_cheques
UNION ALL SELECT * FROM work_queue_lotes
UNION ALL SELECT * FROM work_queue_caja
UNION ALL SELECT * FROM work_queue_crm
UNION ALL SELECT * FROM work_queue_proyectos
UNION ALL SELECT * FROM work_queue_comisiones
UNION ALL SELECT * FROM work_queue_sucursales
UNION ALL SELECT * FROM work_queue_suscripcion;

-- ---------------------------------------------------------------------------
-- 7 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('subscription:read',  'Consultar el plan de la empresa y su uso'),
  ('subscription:write', 'Cambiar el plan de la empresa');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR')
   AND p.code = 'subscription:read';

-- Cambiar de plan es una decisión comercial de quien administra la empresa.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'ADMINISTRADOR'
   AND p.code = 'subscription:write';

GRANT SELECT ON subscription_usage TO aai_app;
GRANT SELECT ON subscription_status TO aai_app;
GRANT SELECT ON work_queue_suscripcion TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
