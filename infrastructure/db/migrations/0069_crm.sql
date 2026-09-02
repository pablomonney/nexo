-- ============================================================================
-- 0069 — CRM: oportunidades, embudo declarado y el paso a presupuesto
-- ============================================================================
--
-- El ciclo comercial arranca en el presupuesto, y antes del presupuesto no hay
-- nada registrado. Todo lo que pasa antes —a quién se está por visitar, qué se
-- ofreció y no se aceptó, por qué se perdió— vive hoy en la cabeza del vendedor
-- o en una planilla. Es el módulo que más piden las pymes y el que más fácil se
-- construye mal.
--
-- ## Las etapas las declara la empresa
--
-- NEXO **no trae un embudo por defecto**. No es prudencia decorativa: un embudo
-- es cómo vende una empresa, y sembrar «Contacto → Demo → Negociación» haría que
-- todos los tableros hablaran de una realidad que nadie acordó. Sin etapas
-- declaradas el módulo no funciona, y eso es correcto: primero se dice cómo se
-- vende.
--
-- ## La probabilidad también, y por eso el ponderado puede no existir
--
-- `crm_stages.probabilidad` es **declarada y opcional**. Un embudo ponderado con
-- probabilidades inventadas produce un número que parece plata y no lo es. Sin
-- declararla, el sistema informa el importe estimado y **no** calcula ningún
-- valor ponderado: es la misma disciplina de los umbrales de la 0058.
--
-- ## La etapa actual se deriva del libro
--
-- No hay columna `stage_id` en la oportunidad. Hay un libro append-only de
-- transiciones, y la etapa actual es la última — igual que el estado de un
-- cheque (0064). Guardar la etapa además del libro permitiría que digan cosas
-- distintas, y el que gana en ese empate siempre es el que alguien tipeó.
--
-- ## Y el embudo NO entra al flujo de fondos
--
-- Una oportunidad no es un crédito. Sumar el pipeline a `analytics_flujo_de_fondos`
-- metería plata que nadie debe todavía en la proyección con la que se decide si
-- se paga un sueldo. El aporte de este módulo a la capa de decisión (ADR-018) es
-- el embudo con su valor ponderado —cuando hay probabilidad declarada— y el
-- seguimiento que se está cayendo, no un peso más en la caja proyectada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · Las etapas: cómo vende esta empresa
-- ---------------------------------------------------------------------------
CREATE TABLE crm_stages (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies (id),

  code          text NOT NULL CHECK (length(btrim(code)) > 0),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  orden         int  NOT NULL CHECK (orden > 0),

  -- Una etapa abierta sigue en juego; las otras dos terminan la oportunidad.
  tipo          text NOT NULL CHECK (tipo IN ('ABIERTA', 'GANADA', 'PERDIDA')),

  -- Declarada, opcional, y con consecuencias: sin ella no hay valor ponderado.
  -- Inventar un 60% produce un número que parece plata y no lo es.
  probabilidad  numeric(5, 2) CHECK (probabilidad IS NULL
                                     OR (probabilidad >= 0 AND probabilidad <= 100)),

  status        text NOT NULL DEFAULT 'ACTIVA' CHECK (status IN ('ACTIVA', 'ARCHIVADA')),

  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,

  CONSTRAINT cst_code_unico UNIQUE (company_id, code),
  CONSTRAINT cst_orden_unico UNIQUE (company_id, orden),
  CONSTRAINT cst_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE crm_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY cst_por_empresa ON crm_stages
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON crm_stages TO aai_app;

COMMENT ON COLUMN crm_stages.probabilidad IS
  'Declarada por la empresa y opcional. Sin ella el embudo informa el importe '
  'estimado y no calcula ningún ponderado: inventar la probabilidad produce un '
  'número que parece plata y no lo es.';

-- ---------------------------------------------------------------------------
-- 2 · La oportunidad
-- ---------------------------------------------------------------------------
CREATE TABLE crm_opportunities (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),

  titulo         text NOT NULL CHECK (length(btrim(titulo)) > 2),

  -- De quién. Un prospecto todavía no es un tercero: el maestro exige documento
  -- —o la declaración explícita de que no lo tiene (0047)— y llenarlo de gente
  -- que nunca compró lo vuelve inservible para lo que existe, que es facturar.
  -- Así que se admite un nombre suelto hasta que la venta lo justifique.
  party_id       uuid,
  prospecto      text,

  importe_estimado numeric(18, 2) CHECK (importe_estimado IS NULL OR importe_estimado > 0),
  moneda         text NOT NULL DEFAULT 'ARS',
  fecha_estimada_cierre date,

  -- El presupuesto que salió de acá. CRM lo **cita**: el documento comercial lo
  -- crea el circuito de siempre, con su numeración y su máquina de estados.
  commercial_document_id uuid,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT co_alguien
    CHECK (party_id IS NOT NULL OR (prospecto IS NOT NULL AND length(btrim(prospecto)) > 2)),
  CONSTRAINT co_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT co_documento_fk
    FOREIGN KEY (company_id, commercial_document_id)
      REFERENCES commercial_documents (company_id, id),
  CONSTRAINT co_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE crm_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_opportunities FORCE ROW LEVEL SECURITY;
CREATE POLICY co_por_empresa ON crm_opportunities
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON crm_opportunities TO aai_app;

-- Una oportunidad no se borra: se pierde, con motivo. Borrarla haría que el
-- embudo del mes que viene no se pueda comparar con el de este.
CREATE FUNCTION crm_opportunities_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'E_CRM_NO_BORRA: una oportunidad se pierde con motivo, no se borra.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER crm_opportunities_no_delete BEFORE DELETE ON crm_opportunities
  FOR EACH ROW EXECUTE FUNCTION crm_opportunities_no_delete();

-- ---------------------------------------------------------------------------
-- 3 · El libro de etapas
-- ---------------------------------------------------------------------------
-- La etapa actual es la última transición. No hay columna que mantener, así que
-- no puede contradecir al libro.
CREATE TABLE crm_stage_transitions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  opportunity_id uuid NOT NULL,
  stage_id       uuid NOT NULL,

  fecha          date NOT NULL,
  -- Obligatorio al pasar a una etapa PERDIDA: por qué se perdió es la única
  -- información que un embudo deja para la próxima vez.
  motivo         text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT cstr_oportunidad_fk
    FOREIGN KEY (company_id, opportunity_id) REFERENCES crm_opportunities (company_id, id),
  CONSTRAINT cstr_etapa_fk
    FOREIGN KEY (company_id, stage_id) REFERENCES crm_stages (company_id, id)
);

ALTER TABLE crm_stage_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_stage_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY cstr_por_empresa ON crm_stage_transitions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON crm_stage_transitions TO aai_app;

CREATE INDEX cstr_por_oportunidad
  ON crm_stage_transitions (company_id, opportunity_id, created_at DESC);

CREATE TRIGGER cstr_no_update BEFORE UPDATE ON crm_stage_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER cstr_no_delete BEFORE DELETE ON crm_stage_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Dos reglas, y las dos son sobre lo que se puede afirmar:
--
--   · perder sin decir por qué deja el embudo sin la única información que
--     sirve para la próxima vez;
--   · mover una oportunidad ya cerrada reabriría un hecho terminado sin que
--     nadie lo declare. Se registra una oportunidad nueva.
CREATE FUNCTION assert_transicion_de_etapa() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tipo_nuevo   text;
  tipo_anterior text;
BEGIN
  SELECT s.tipo INTO tipo_nuevo
    FROM crm_stages s
   WHERE s.id = NEW.stage_id AND s.company_id = NEW.company_id;

  IF tipo_nuevo = 'PERDIDA' AND (NEW.motivo IS NULL OR length(btrim(NEW.motivo)) = 0) THEN
    RAISE EXCEPTION
      'E_CRM_SIN_MOTIVO: perder una oportunidad exige decir por qué.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.tipo INTO tipo_anterior
    FROM crm_stage_transitions t
    JOIN crm_stages s ON s.id = t.stage_id AND s.company_id = t.company_id
   WHERE t.opportunity_id = NEW.opportunity_id
     AND t.company_id = NEW.company_id
     AND t.id <> NEW.id
   ORDER BY t.created_at DESC, t.id DESC
   LIMIT 1;

  IF tipo_anterior IN ('GANADA', 'PERDIDA') THEN
    RAISE EXCEPTION
      'E_CRM_CERRADA: la oportunidad ya está % y no se reabre; se registra una nueva.',
      tipo_anterior
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cstr_transicion
  AFTER INSERT ON crm_stage_transitions
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_de_etapa();

-- ---------------------------------------------------------------------------
-- 4 · Las actividades
-- ---------------------------------------------------------------------------
CREATE TABLE crm_activities (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  opportunity_id uuid NOT NULL,

  tipo           text NOT NULL
                   CHECK (tipo IN ('LLAMADA', 'REUNION', 'EMAIL', 'VISITA', 'OTRA')),
  fecha          date NOT NULL,
  detalle        text NOT NULL CHECK (length(btrim(detalle)) > 2),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT cac_oportunidad_fk
    FOREIGN KEY (company_id, opportunity_id) REFERENCES crm_opportunities (company_id, id)
);

ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY cac_por_empresa ON crm_activities
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON crm_activities TO aai_app;

CREATE INDEX cac_por_oportunidad ON crm_activities (company_id, opportunity_id, fecha DESC);

-- Lo que se hizo, se hizo. Una visita registrada y después borrada deja un
-- seguimiento que parece mejor de lo que fue.
CREATE TRIGGER cac_no_update BEFORE UPDATE ON crm_activities
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER cac_no_delete BEFORE DELETE ON crm_activities
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 5 · El estado, derivado
-- ---------------------------------------------------------------------------
CREATE VIEW crm_opportunity_status WITH (security_invoker = true) AS
SELECT o.company_id,
       o.id                                       AS opportunity_id,
       o.titulo,
       o.party_id,
       p.razon_social,
       o.prospecto,
       coalesce(p.razon_social, o.prospecto)      AS quien,
       o.importe_estimado,
       o.moneda,
       o.fecha_estimada_cierre,
       o.commercial_document_id,
       t.stage_id,
       s.code                                     AS etapa_codigo,
       s.name                                     AS etapa_nombre,
       s.orden                                    AS etapa_orden,
       s.tipo                                     AS estado,
       s.probabilidad,
       -- El ponderado existe solo si la empresa declaró la probabilidad. NULL
       -- no es cero: es «no se puede afirmar», que es distinto de «vale nada».
       CASE WHEN s.probabilidad IS NULL OR o.importe_estimado IS NULL THEN NULL
            ELSE round(o.importe_estimado * s.probabilidad / 100, 2)
       END                                        AS valor_ponderado,
       t.fecha                                    AS en_etapa_desde,
       (current_date - t.fecha)                   AS dias_en_etapa,
       t.motivo                                   AS motivo_cierre,
       a.ultima_actividad,
       CASE WHEN a.ultima_actividad IS NULL THEN NULL
            ELSE (current_date - a.ultima_actividad)
       END                                        AS dias_sin_actividad,
       -- Hace cuánto no pasa **nada**: ni un contacto registrado ni un cambio
       -- de etapa. Mover una oportunidad es actividad tanto como llamar, y
       -- medir solo contra `crm_activities` diría que está abandonada una que
       -- se movió ayer. El alta es el último recurso, no el criterio.
       (current_date - coalesce(a.ultima_actividad, t.fecha, o.created_at::date))
                                                  AS dias_sin_movimiento,
       coalesce(a.cantidad, 0)                    AS actividades,
       o.created_at,
       o.created_by
  FROM crm_opportunities o
  LEFT JOIN parties p ON p.id = o.party_id AND p.company_id = o.company_id
  -- La etapa actual es la última transición: derivada, no guardada.
  LEFT JOIN LATERAL (
        SELECT tr.stage_id, tr.fecha, tr.motivo
          FROM crm_stage_transitions tr
         WHERE tr.opportunity_id = o.id AND tr.company_id = o.company_id
         ORDER BY tr.created_at DESC, tr.id DESC
         LIMIT 1
       ) t ON true
  LEFT JOIN crm_stages s ON s.id = t.stage_id AND s.company_id = o.company_id
  LEFT JOIN LATERAL (
        SELECT max(ac.fecha) AS ultima_actividad, count(*)::int AS cantidad
          FROM crm_activities ac
         WHERE ac.opportunity_id = o.id AND ac.company_id = o.company_id
       ) a ON true;

COMMENT ON VIEW crm_opportunity_status IS
  'La oportunidad con su etapa actual derivada del libro de transiciones. El '
  'valor ponderado es NULL cuando la empresa no declaró la probabilidad de la '
  'etapa: NULL es «no se puede afirmar», que no es lo mismo que cero.';

-- ---------------------------------------------------------------------------
-- 6 · El embudo (ADR-018)
-- ---------------------------------------------------------------------------
CREATE VIEW analytics_embudo WITH (security_invoker = true) AS
SELECT s.company_id,
       s.id                                        AS stage_id,
       s.code                                      AS etapa_codigo,
       s.name                                      AS etapa_nombre,
       s.orden,
       s.tipo,
       s.probabilidad,
       count(o.opportunity_id)::int                AS cantidad,
       coalesce(sum(o.importe_estimado), 0)        AS importe_estimado,
       -- Si falta la probabilidad de la etapa, no se pondera: el total sería un
       -- número que parece plata sin que nadie haya dicho de dónde sale.
       CASE WHEN s.probabilidad IS NULL THEN NULL
            ELSE coalesce(sum(o.valor_ponderado), 0)
       END                                         AS valor_ponderado,
       CASE WHEN s.probabilidad IS NULL
            THEN 'Sin probabilidad declarada para esta etapa: se informa el importe '
                 'estimado y no se pondera.'
            ELSE 'Importe estimado por la probabilidad declarada de la etapa.'
       END::text                                   AS metodologia
  FROM crm_stages s
  LEFT JOIN crm_opportunity_status o
    ON o.stage_id = s.id AND o.company_id = s.company_id
 WHERE s.status = 'ACTIVA'
 GROUP BY s.company_id, s.id, s.code, s.name, s.orden, s.tipo, s.probabilidad;

COMMENT ON VIEW analytics_embudo IS
  'El embudo por etapa. NO alimenta analytics_flujo_de_fondos: una oportunidad '
  'no es un crédito, y sumarla metería plata que nadie debe todavía en la '
  'proyección con la que se decide si se paga un sueldo.';

-- ---------------------------------------------------------------------------
-- 7 · La bandeja
-- ---------------------------------------------------------------------------
-- Un umbral declarado para el seguimiento. Como todos los de la 0058: sin él,
-- el sistema informa hace cuánto no se toca una oportunidad y **no lo llama
-- abandono**, porque cuánto es mucho depende de qué se venda.
ALTER TABLE analysis_thresholds ADD COLUMN crm_dias_sin_actividad int
  CHECK (crm_dias_sin_actividad IS NULL OR crm_dias_sin_actividad > 0);

COMMENT ON COLUMN analysis_thresholds.crm_dias_sin_actividad IS
  'Desde cuántos días sin actividad la empresa considera abandonada una '
  'oportunidad. Sin declarar: el sistema informa los días y no avisa. Vender '
  'un galpón y vender café no tienen el mismo ritmo.';

CREATE VIEW work_queue_crm WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · La fecha estimada de cierre pasó y sigue abierta. Es una fecha que venció,
--     no un criterio: la puso quien cargó la oportunidad.
SELECT o.company_id,
       'OPORTUNIDAD_VENCIDA'::text                   AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'crm_opportunities'::text                     AS entidad,
       o.opportunity_id                              AS entity_id,
       o.etapa_codigo                                AS estado,
       'La oportunidad «' || o.titulo || '» de ' || o.quien ||
         ' estimaba cerrar el ' || o.fecha_estimada_cierre || ' y sigue abierta'
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       o.created_at                                  AS creado_en,
       o.created_at                                  AS actualizado_en,
       o.fecha_estimada_cierre                       AS fecha_limite,
       '/crm/opportunities/' || o.opportunity_id     AS traza_ref
  FROM crm_opportunity_status o
 WHERE o.estado = 'ABIERTA' AND o.fecha_estimada_cierre < current_date

UNION ALL

-- 2 · Se ganó y no hay presupuesto que lo muestre. La venta ganada que no entró
--     al circuito comercial es plata que el embudo cuenta y el Diario no.
SELECT o.company_id,
       'GANADA_SIN_PRESUPUESTO'::text                AS rama,
       'REQUIERE_CORRECCION'::text                   AS categoria,
       'crm_opportunities'::text                     AS entidad,
       o.opportunity_id                              AS entity_id,
       o.etapa_codigo                                AS estado,
       'La oportunidad «' || o.titulo || '» está ganada y no cita ningún ' ||
         'presupuesto: el embudo la cuenta y el circuito comercial no la tiene'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['PRESUPUESTO']::text[]                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       o.created_at                                  AS creado_en,
       o.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/crm/opportunities/' || o.opportunity_id     AS traza_ref
  FROM crm_opportunity_status o
 WHERE o.estado = 'GANADA' AND o.commercial_document_id IS NULL

UNION ALL

-- 3 · Sin seguimiento, y **solo si la empresa declaró desde cuándo**. Sin el
--     umbral esta rama no produce nada: informar los días es un hecho, llamarlo
--     abandono es un criterio de negocio.
SELECT o.company_id,
       'OPORTUNIDAD_SIN_SEGUIMIENTO'::text           AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'crm_opportunities'::text                     AS entidad,
       o.opportunity_id                              AS entity_id,
       o.etapa_codigo                                AS estado,
       'La oportunidad «' || o.titulo || '» de ' || o.quien || ' lleva ' ||
         o.dias_sin_movimiento || ' días sin contacto ni cambio de etapa, y la ' ||
         'empresa declaró ' || t.crm_dias_sin_actividad || ' como abandono'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['CONTACTO']::text[]                     AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       o.created_at                                  AS creado_en,
       o.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/crm/opportunities/' || o.opportunity_id     AS traza_ref
  FROM crm_opportunity_status o
  JOIN analysis_thresholds t ON t.company_id = o.company_id
 WHERE o.estado = 'ABIERTA'
   AND t.crm_dias_sin_actividad IS NOT NULL
   AND o.dias_sin_movimiento >= t.crm_dias_sin_actividad

) q;

COMMENT ON VIEW work_queue_crm IS
  'Ramas de CRM. Dos son hechos —una fecha que pasó y una venta ganada sin '
  'presupuesto—; la tercera exige umbral declarado, porque cuánto silencio es '
  'abandono depende de qué se venda.';

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
UNION ALL SELECT * FROM work_queue_crm;

-- ---------------------------------------------------------------------------
-- 8 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('crm:read',  'Consultar oportunidades, etapas y embudo'),
  ('crm:write', 'Cargar oportunidades, moverlas de etapa y registrar actividades');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
   AND p.code = 'crm:read';

-- Cargar una oportunidad es trabajo comercial, no contable: sigue a
-- `commercial:write` y no a `journal_entry:write`.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA', 'CARGADOR')
   AND p.code = 'crm:write';

GRANT SELECT ON crm_opportunity_status TO aai_app;
GRANT SELECT ON analytics_embudo TO aai_app;
GRANT SELECT ON work_queue_crm TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
