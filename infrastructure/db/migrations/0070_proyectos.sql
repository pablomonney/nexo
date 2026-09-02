-- ============================================================================
-- 0070 — Proyectos: horas, costos del Mayor y la rentabilidad que se puede afirmar
-- ============================================================================
--
-- Un estudio contable, una consultora, una constructora y una agencia venden lo
-- mismo: horas contra un trabajo con nombre. Hoy NEXO sabe facturar ese trabajo
-- y sabe imputarle gastos —el centro de costo existe desde el núcleo— pero no
-- tiene dónde decir «esto es el proyecto Reforma del galpón» ni cuántas horas
-- se le fueron.
--
-- ## La rentabilidad no se inventa: se arma de lo que ya está asentado
--
-- Los ingresos y los costos del proyecto **no se cargan acá**. Salen del Mayor,
-- por el centro de costo que el proyecto cita: cuentas de INGRESO de un lado,
-- de COSTO y GASTO del otro. Un módulo que además guardara sus propios totales
-- crearía una segunda contabilidad, y cuando dos contabilidades no coinciden la
-- que gana es la que alguien tipeó.
--
-- ## La hora vale lo que la empresa declaró, o no vale nada afirmable
--
-- El costo de una hora sale de la liquidación de sueldos, y RRHH está bloqueado
-- por decisiones que no son técnicas (ADR-012 §8). Inventar un costo horario
-- sería inventar el sueldo de alguien. Así que la tarifa se **declara** por
-- proyecto y con vigencia, igual que una lista de precios (0061): si hay tarifa
-- vigente para la fecha de la hora, esa hora se costea; si no, la hora se
-- informa y **el margen queda en NULL**, con las horas sin tarifa contadas
-- aparte para que se vea por qué.
--
-- NULL no es cero. Un margen en cero diría «este proyecto no dejó nada»; NULL
-- dice «todavía no se puede afirmar cuánto dejó», que es lo que pasa.
--
-- ## Lo que aporta a la decisión (ADR-018)
--
-- `analytics_proyectos` contesta la pregunta que ningún estado contable
-- contesta: **cuál de los trabajos deja plata**. Y contesta con trazabilidad
-- —cada cifra abre los asientos y los partes de horas que la formaron— y con la
-- honestidad de decir cuándo no puede contestar.
-- ============================================================================

-- El centro de costo entra en claves compuestas desde acá: sin la empresa
-- adentro, un proyecto podría citar el centro de costo de otra (las FK se
-- verifican con privilegios del sistema y no las frena el RLS).
ALTER TABLE cost_centers ADD CONSTRAINT cc_id_empresa UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 1 · El proyecto
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),

  code           text NOT NULL CHECK (length(btrim(code)) > 0),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),

  -- Para quién. Nulo es válido: un proyecto interno —mudanza, implementación,
  -- desarrollo propio— también consume horas y también conviene medirlo.
  party_id       uuid,

  -- Por dónde se lo mide contra el Mayor. Es lo que convierte al proyecto en
  -- algo comparable con la contabilidad en vez de una planilla al costado.
  cost_center_id uuid,

  fecha_inicio        date NOT NULL,
  fecha_fin_estimada  date,
  -- Declarado y opcional. Sin él nadie puede decir que el proyecto se pasó:
  -- pasarse es contra un plan, y si no hay plan no hay exceso.
  presupuesto_horas   numeric(10, 2) CHECK (presupuesto_horas IS NULL OR presupuesto_horas > 0),

  status         text NOT NULL DEFAULT 'ABIERTO'
                   CHECK (status IN ('ABIERTO', 'CERRADO', 'CANCELADO')),
  cerrado_el     date,
  motivo_cierre  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pj_cierre_completo
    CHECK (status = 'ABIERTO'
           OR (cerrado_el IS NOT NULL
               AND motivo_cierre IS NOT NULL AND length(btrim(motivo_cierre)) > 2)),
  CONSTRAINT pj_fin_no_anterior
    CHECK (fecha_fin_estimada IS NULL OR fecha_fin_estimada >= fecha_inicio),
  CONSTRAINT pj_code_unico UNIQUE (company_id, code),
  CONSTRAINT pj_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT pj_centro_fk
    FOREIGN KEY (company_id, cost_center_id) REFERENCES cost_centers (company_id, id),
  CONSTRAINT pj_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY pj_por_empresa ON projects
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON projects TO aai_app;

-- Un proyecto con horas cargadas no se borra: se cierra o se cancela, con
-- motivo. Borrarlo dejaría partes de horas colgando de nada.
CREATE FUNCTION projects_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'E_PROY_NO_BORRA: un proyecto se cierra o se cancela con motivo, no se borra.'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER projects_no_delete BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_no_delete();

COMMENT ON COLUMN projects.cost_center_id IS
  'Por dónde se mide el proyecto contra el Mayor. Sin él, las horas se pueden '
  'cargar pero los ingresos y los costos no se pueden atribuir, y la bandeja '
  'lo avisa.';

-- ---------------------------------------------------------------------------
-- 2 · Las tareas
-- ---------------------------------------------------------------------------
CREATE TABLE project_tasks (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  project_id     uuid NOT NULL,

  code           text NOT NULL CHECK (length(btrim(code)) > 0),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  estimado_horas numeric(10, 2) CHECK (estimado_horas IS NULL OR estimado_horas > 0),

  status         text NOT NULL DEFAULT 'ABIERTA'
                   CHECK (status IN ('ABIERTA', 'TERMINADA')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT pjt_code_unico UNIQUE (company_id, project_id, code),
  CONSTRAINT pjt_proyecto_fk
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id),
  CONSTRAINT pjt_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY pjt_por_empresa ON project_tasks
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON project_tasks TO aai_app;

-- ---------------------------------------------------------------------------
-- 3 · Los partes de horas
-- ---------------------------------------------------------------------------
-- Append-only, como todos los libros del sistema. Una hora cargada y después
-- borrada deja un proyecto que parece más rentable de lo que fue.
CREATE TABLE time_entries (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  project_id     uuid NOT NULL,
  task_id        uuid,

  fecha          date NOT NULL,
  horas          numeric(8, 2) NOT NULL CHECK (horas > 0 AND horas <= 24),
  -- Quién las hizo. Es un texto declarado y no un `user_id` a propósito: quien
  -- carga las horas del equipo no siempre es quien las trabajó, y el sistema no
  -- tiene legajos —RRHH está bloqueado— así que inventar una identidad de
  -- empleado sería inventar la mitad de un módulo que no existe.
  persona        text NOT NULL CHECK (length(btrim(persona)) > 1),
  detalle        text NOT NULL CHECK (length(btrim(detalle)) > 2),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT te_proyecto_fk
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id),
  CONSTRAINT te_tarea_fk
    FOREIGN KEY (company_id, task_id) REFERENCES project_tasks (company_id, id)
);

ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY te_por_empresa ON time_entries
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON time_entries TO aai_app;

CREATE INDEX te_por_proyecto ON time_entries (company_id, project_id, fecha);

CREATE TRIGGER te_no_update BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER te_no_delete BEFORE DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Un proyecto cerrado no recibe horas nuevas: cambiarían el resultado contra el
-- que se cerró, igual que un movimiento nuevo en una caja ya arqueada (0068).
CREATE FUNCTION assert_proyecto_abierto() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  estado text;
  tarea_de uuid;
BEGIN
  SELECT p.status INTO estado
    FROM projects p
   WHERE p.id = NEW.project_id AND p.company_id = NEW.company_id;

  IF estado <> 'ABIERTO' THEN
    RAISE EXCEPTION
      'E_PROY_CERRADO: el proyecto está % y ya no recibe horas.', estado
      USING ERRCODE = 'check_violation';
  END IF;

  -- Y la tarea tiene que ser de ese proyecto. La FK sola no alcanza: garantiza
  -- que la tarea existe en la empresa, no que pertenezca a este proyecto.
  IF NEW.task_id IS NOT NULL THEN
    SELECT t.project_id INTO tarea_de
      FROM project_tasks t
     WHERE t.id = NEW.task_id AND t.company_id = NEW.company_id;

    IF tarea_de <> NEW.project_id THEN
      RAISE EXCEPTION
        'E_PROY_TAREA_AJENA: la tarea pertenece a otro proyecto.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER te_proyecto_abierto
  AFTER INSERT ON time_entries
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_proyecto_abierto();

-- ---------------------------------------------------------------------------
-- 4 · La tarifa horaria declarada
-- ---------------------------------------------------------------------------
-- El costo de una hora sale de la liquidación de sueldos, y RRHH está bloqueado
-- (ADR-012 §8). Inventar un costo horario sería inventar el sueldo de alguien,
-- así que se declara — y sin declararla el margen no se afirma.
CREATE TABLE project_hour_rates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  project_id     uuid NOT NULL,

  tarifa         numeric(18, 2) NOT NULL CHECK (tarifa > 0),
  moneda         text NOT NULL DEFAULT 'ARS',
  vigencia_desde date NOT NULL,
  vigencia_hasta date,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT phr_vigencia_coherente
    CHECK (vigencia_hasta IS NULL OR vigencia_hasta >= vigencia_desde),
  CONSTRAINT phr_proyecto_fk
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id)
);

ALTER TABLE project_hour_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_hour_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY phr_por_empresa ON project_hour_rates
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON project_hour_rates TO aai_app;

-- Dos tarifas vigentes el mismo día dejan al sistema sin criterio, y elegir por
-- orden de carga sería azar disfrazado de regla. Mismo candado que las listas
-- de precios (0061).
CREATE FUNCTION assert_una_tarifa_por_fecha() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM project_hour_rates r
     WHERE r.company_id = NEW.company_id
       AND r.project_id = NEW.project_id
       AND r.id <> NEW.id
       AND daterange(r.vigencia_desde, r.vigencia_hasta, '[]')
           && daterange(NEW.vigencia_desde, NEW.vigencia_hasta, '[]')
  ) THEN
    RAISE EXCEPTION
      'E_PROY_TARIFA_SUPERPUESTA: ya hay una tarifa vigente para ese proyecto en esas fechas.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER phr_una_por_fecha
  AFTER INSERT OR UPDATE ON project_hour_rates
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_una_tarifa_por_fecha();

-- ---------------------------------------------------------------------------
-- 5 · Las horas, valuadas cuando se puede
-- ---------------------------------------------------------------------------
CREATE VIEW project_time_valuation WITH (security_invoker = true) AS
SELECT e.company_id,
       e.project_id,
       e.id                                        AS entry_id,
       e.task_id,
       e.fecha,
       e.horas,
       e.persona,
       r.tarifa,
       -- NULL cuando no hay tarifa vigente para esa fecha. Costear a cero diría
       -- que esa hora salió gratis.
       CASE WHEN r.tarifa IS NULL THEN NULL ELSE round(e.horas * r.tarifa, 2) END
                                                   AS costo
  FROM time_entries e
  LEFT JOIN LATERAL (
        SELECT r.tarifa
          FROM project_hour_rates r
         WHERE r.company_id = e.company_id
           AND r.project_id = e.project_id
           AND r.vigencia_desde <= e.fecha
           AND (r.vigencia_hasta IS NULL OR r.vigencia_hasta >= e.fecha)
         LIMIT 1
       ) r ON true;

COMMENT ON VIEW project_time_valuation IS
  'Cada parte de horas con la tarifa que regía **el día en que se trabajó**, no '
  'la de hoy. El costo es NULL cuando no había tarifa declarada: costear a cero '
  'diría que esa hora salió gratis.';

-- ---------------------------------------------------------------------------
-- 6 · El estado del proyecto, derivado
-- ---------------------------------------------------------------------------
CREATE VIEW project_status WITH (security_invoker = true) AS
SELECT p.company_id,
       p.id                                        AS project_id,
       p.code                                      AS proyecto_codigo,
       p.name                                      AS proyecto_nombre,
       p.party_id,
       t.razon_social                              AS cliente,
       p.cost_center_id,
       cc.code                                     AS centro_codigo,
       p.status,
       p.fecha_inicio,
       p.fecha_fin_estimada,
       p.presupuesto_horas,
       p.cerrado_el,
       p.motivo_cierre,

       coalesce(h.horas, 0)                        AS horas,
       coalesce(h.partes, 0)                       AS partes,
       -- Cuántas horas no se pueden costear, y por eso el margen no se afirma.
       coalesce(h.horas_sin_tarifa, 0)             AS horas_sin_tarifa,
       CASE WHEN h.horas_sin_tarifa > 0 THEN NULL ELSE coalesce(h.costo, 0) END
                                                   AS costo_horas,

       CASE WHEN p.presupuesto_horas IS NULL THEN NULL
            ELSE round(coalesce(h.horas, 0) * 100 / p.presupuesto_horas, 2)
       END                                         AS avance_pct,

       -- Del Mayor, por el centro de costo que el proyecto cita. No se guardan
       -- acá: guardarlos sería una segunda contabilidad.
       coalesce(m.ingresos, 0)                     AS ingresos,
       coalesce(m.costos, 0)                       AS costos,

       -- El margen exige las tres cosas: centro de costo para atribuir, y
       -- ninguna hora sin tarifa. Si falta una, no se afirma.
       CASE WHEN p.cost_center_id IS NULL OR coalesce(h.horas_sin_tarifa, 0) > 0 THEN NULL
            ELSE coalesce(m.ingresos, 0) - coalesce(m.costos, 0) - coalesce(h.costo, 0)
       END                                         AS margen,

       p.created_at
  FROM projects p
  LEFT JOIN parties t ON t.id = p.party_id AND t.company_id = p.company_id
  LEFT JOIN cost_centers cc ON cc.id = p.cost_center_id AND cc.company_id = p.company_id
  LEFT JOIN LATERAL (
        SELECT sum(v.horas)                                    AS horas,
               count(*)::int                                   AS partes,
               sum(v.horas) FILTER (WHERE v.costo IS NULL)     AS horas_sin_tarifa,
               sum(v.costo)                                    AS costo
          FROM project_time_valuation v
         WHERE v.project_id = p.id AND v.company_id = p.company_id
       ) h ON true
  LEFT JOIN LATERAL (
        SELECT sum(lm.credit - lm.debit) FILTER (WHERE a.type = 'INGRESO')      AS ingresos,
               sum(lm.debit - lm.credit) FILTER (WHERE a.type IN ('COSTO', 'GASTO'))
                                                                                AS costos
          FROM ledger_movements lm
          JOIN journal_entry_lines jel
            ON jel.id = lm.entry_line_id AND jel.company_id = lm.company_id
          JOIN accounts a ON a.id = lm.account_id AND a.company_id = lm.company_id
         WHERE lm.company_id = p.company_id
           AND jel.cost_center_id = p.cost_center_id
       ) m ON true;

COMMENT ON VIEW project_status IS
  'El proyecto con sus horas, su avance contra el presupuesto declarado, y los '
  'ingresos y costos que salen del Mayor por su centro de costo. El margen es '
  'NULL cuando falta el centro de costo o hay horas sin tarifa: NULL es «no se '
  'puede afirmar», que no es lo mismo que cero.';

-- ---------------------------------------------------------------------------
-- 7 · La capa de decisión (ADR-018)
-- ---------------------------------------------------------------------------
CREATE VIEW analytics_proyectos WITH (security_invoker = true) AS
SELECT s.company_id,
       s.project_id,
       s.proyecto_codigo,
       s.proyecto_nombre,
       s.cliente,
       s.status,
       s.horas,
       s.costo_horas,
       s.ingresos,
       s.costos,
       s.margen,
       CASE WHEN s.margen IS NULL OR s.ingresos = 0 THEN NULL
            ELSE round(s.margen * 100 / s.ingresos, 2)
       END                                         AS margen_pct,
       CASE
         WHEN s.cost_center_id IS NULL
           THEN 'Sin centro de costo declarado: las horas se registran pero los ingresos '
                'y los costos no se pueden atribuir a este proyecto.'
         WHEN s.horas_sin_tarifa > 0
           THEN 'Hay ' || s.horas_sin_tarifa || ' hora(s) sin tarifa declarada para su '
                'fecha: costearlas a cero diría que salieron gratis, así que el margen '
                'no se afirma.'
         WHEN s.ingresos = 0
           THEN 'Ingresos del Mayor por el centro de costo, todavía en cero: el margen '
                'está calculado pero no hay base para expresarlo en porcentaje.'
         ELSE 'Ingresos menos costos del Mayor por el centro de costo, menos las horas '
              'valuadas a la tarifa declarada vigente el día en que se trabajaron.'
       END::text                                   AS metodologia
  FROM project_status s;

COMMENT ON VIEW analytics_proyectos IS
  'Cuál de los trabajos deja plata. Contesta con trazabilidad —cada cifra abre '
  'los asientos y los partes de horas que la formaron— y dice cuándo no puede '
  'contestar, en vez de contestar cero.';

-- ---------------------------------------------------------------------------
-- 8 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_proyectos WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · Abierto y sin centro de costo. No es una preferencia: sin él, ningún
--     ingreso ni ningún gasto se puede atribuir, y el proyecto es una planilla
--     de horas al costado de la contabilidad.
SELECT s.company_id,
       'PROYECTO_SIN_CENTRO_DE_COSTO'::text          AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'projects'::text                              AS entidad,
       s.project_id                                  AS entity_id,
       s.status                                      AS estado,
       'El proyecto ' || s.proyecto_codigo || ' no cita centro de costo: sus ' ||
         'ingresos y sus gastos no se pueden atribuir'
                                                     AS motivo,
       false                                         AS bloquea,
       ARRAY['CENTRO_DE_COSTO']::text[]              AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/projects/' || s.project_id                  AS traza_ref
  FROM project_status s
 WHERE s.status = 'ABIERTO' AND s.cost_center_id IS NULL

UNION ALL

-- 2 · Horas cargadas sin tarifa vigente para su fecha. Es el motivo por el que
--     el margen viene en NULL, y decirlo es más útil que mostrar un guion.
SELECT s.company_id,
       'HORAS_SIN_TARIFA'::text                      AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'projects'::text                              AS entidad,
       s.project_id                                  AS entity_id,
       s.status                                      AS estado,
       'El proyecto ' || s.proyecto_codigo || ' tiene ' || s.horas_sin_tarifa ||
         ' hora(s) sin tarifa declarada para su fecha, y por eso su margen no ' ||
         'se puede afirmar'                          AS motivo,
       false                                         AS bloquea,
       ARRAY['TARIFA_HORARIA']::text[]               AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/projects/' || s.project_id                  AS traza_ref
  FROM project_status s
 WHERE s.horas_sin_tarifa > 0

UNION ALL

-- 3 · Se pasó del presupuesto **declarado**. Sin presupuesto esta rama no
--     produce nada: pasarse es contra un plan, y si no hay plan no hay exceso.
SELECT s.company_id,
       'PROYECTO_EXCEDIDO'::text                     AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'projects'::text                              AS entidad,
       s.project_id                                  AS entity_id,
       s.status                                      AS estado,
       'El proyecto ' || s.proyecto_codigo || ' lleva ' || s.horas ||
         ' horas contra un presupuesto declarado de ' || s.presupuesto_horas
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/projects/' || s.project_id                  AS traza_ref
  FROM project_status s
 WHERE s.status = 'ABIERTO'
   AND s.presupuesto_horas IS NOT NULL
   AND s.horas > s.presupuesto_horas

UNION ALL

-- 4 · La fecha estimada de fin pasó y sigue abierto. Una fecha que venció es un
--     hecho: la puso quien planificó el trabajo.
SELECT s.company_id,
       'PROYECTO_VENCIDO'::text                      AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'projects'::text                              AS entidad,
       s.project_id                                  AS entity_id,
       s.status                                      AS estado,
       'El proyecto ' || s.proyecto_codigo || ' estimaba terminar el ' ||
         s.fecha_fin_estimada || ' y sigue abierto'  AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.created_at                                  AS creado_en,
       s.created_at                                  AS actualizado_en,
       s.fecha_fin_estimada                          AS fecha_limite,
       '/projects/' || s.project_id                  AS traza_ref
  FROM project_status s
 WHERE s.status = 'ABIERTO' AND s.fecha_fin_estimada < current_date

) q;

COMMENT ON VIEW work_queue_proyectos IS
  'Ramas de proyectos. Dos avisan de algo sin declarar —el centro de costo y la '
  'tarifa— y las otras dos son hechos contra algo que alguien declaró: un '
  'presupuesto de horas y una fecha de fin.';

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
UNION ALL SELECT * FROM work_queue_proyectos;

-- ---------------------------------------------------------------------------
-- 9 · Permisos
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
  ('project:read',  'Consultar proyectos, horas y rentabilidad'),
  ('project:write', 'Crear proyectos y tareas, cargar horas y declarar tarifas');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
   AND p.code = 'project:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA', 'CARGADOR')
   AND p.code = 'project:write';

GRANT SELECT ON project_time_valuation TO aai_app;
GRANT SELECT ON project_status TO aai_app;
GRANT SELECT ON analytics_proyectos TO aai_app;
GRANT SELECT ON work_queue_proyectos TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
