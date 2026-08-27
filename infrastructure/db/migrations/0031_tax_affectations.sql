-- 0031_tax_affectations.sql — el hecho que ningún módulo puede calcular.
--
-- El art. 12 de la Ley 23.349 condiciona el cómputo del crédito fiscal a que la
-- operación **se vincule con operaciones gravadas**. Ese dato no está en el
-- comprobante: la misma factura de nafta es crédito para la empresa de fletes y
-- no lo es para el auto del socio, y los dos papeles son idénticos.
--
-- Esta tabla no lo calcula. Lo **registra como declaración**, con autor, fecha y
-- evidencia — igual que una aprobación de regla. La diferencia entre "el sistema
-- dedujo" y "una persona declaró" es la razón entera por la que existe.
--
-- ## La inversión, otra vez
--
-- El motor normativo no lee esta tabla: lee `tax_affectations_declaradas`, que
-- solo expone las filas que **prueban** ser declaraciones profesionales. Una
-- sugerencia por precedente no es invisible por estar marcada como sospechosa,
-- sino porque no cumple la condición para aparecer.
--
-- Es el mismo patrón que el candado de emisión y el del sandbox: filtrar lo malo
-- falla abierto —basta que aparezca una categoría nueva que nadie filtró—;
-- exigir la prueba de lo bueno falla cerrado.
--
-- ## Lo que NO hace
--
-- No implementa el prorrateo del art. 13. `MIXTA` se puede declarar porque es un
-- hecho real del negocio, pero el motor no la resuelve: la deja en revisión. Que
-- el hecho sea representable y que la consecuencia sea calculable son dos cosas
-- distintas, y confundirlas produciría un crédito computado a ojo.

-- ---------------------------------------------------------------------------
-- La declaración
-- ---------------------------------------------------------------------------
CREATE TABLE tax_affectations (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id          uuid NOT NULL REFERENCES companies (id),

  -- Se afecta la OPERACIÓN FISCAL, no el documento. Un mismo PDF puede
  -- respaldar más de una operación, y es la operación la que se vincula —o no—
  -- con las gravadas.
  tax_transaction_id  uuid NOT NULL REFERENCES tax_transactions (id),

  afectacion          text NOT NULL CHECK (afectacion IN
                        ('GRAVADAS', 'EXENTAS', 'NO_GRAVADAS', 'MIXTA', 'NO_DETERMINADA')),

  -- Proporción vinculada con gravadas, en partes por diez mil. Entero y no
  -- `numeric` por la misma razón por la que el dinero es `bigint`: un 33,33%
  -- guardado en punto flotante deja de sumar 100 al tercer prorrateo.
  proporcion_gravada  integer CHECK (proporcion_gravada BETWEEN 0 AND 10000),

  -- Evidencia estructurada. El CHECK de forma vive en `assert_affectation_shape`
  -- y la existencia de cada referencia la verifica `assert_evidence_exists`.
  evidencia           jsonb NOT NULL DEFAULT '[]'::jsonb,

  origen              text NOT NULL CHECK (origen IN
                        ('DECLARACION_PROFESIONAL', 'SUGERIDA_POR_PRECEDENTE')),

  declarada_por       text,
  declarada_at        timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- Una operación fiscal tiene UNA afectación vigente. Las anteriores no se
  -- borran: quedan en `audit_logs` con su valor viejo y su valor nuevo.
  UNIQUE (tax_transaction_id),

  -- CANDADO — una declaración profesional necesita autor y fecha. Sin eso no es
  -- una declaración: es un dato que apareció.
  CONSTRAINT affectation_declaration_requires_author
    CHECK (origen <> 'DECLARACION_PROFESIONAL'
           OR (declarada_por IS NOT NULL AND declarada_at IS NOT NULL)),

  -- CANDADO — la proporción solo tiene sentido en MIXTA, y en MIXTA es
  -- obligatoria. Una mixta sin proporción no dice nada que se pueda usar.
  CONSTRAINT affectation_proportion_only_when_mixed
    CHECK ((afectacion = 'MIXTA' AND proporcion_gravada IS NOT NULL)
           OR (afectacion <> 'MIXTA' AND proporcion_gravada IS NULL))
);

CREATE INDEX tax_affectations_company_idx ON tax_affectations (company_id, afectacion);

-- ---------------------------------------------------------------------------
-- Forma de la evidencia
-- ---------------------------------------------------------------------------
-- Cada ítem apunta a algo que existe en el sistema. `NOTA` es el único tipo con
-- texto libre, y **no puede ir solo**: una explicación sin nada que la respalde
-- es exactamente lo que un modelo de lenguaje produce mejor, y no es evidencia.
CREATE OR REPLACE FUNCTION assert_affectation_shape() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  tipo text;
  con_referencia integer := 0;
BEGIN
  IF jsonb_typeof(NEW.evidencia) <> 'array' THEN
    RAISE EXCEPTION 'La evidencia debe ser un arreglo, y llegó %', jsonb_typeof(NEW.evidencia)
      USING ERRCODE = 'check_violation';
  END IF;

  -- Una declaración profesional sin evidencia es una afirmación sin respaldo.
  -- Una sugerencia por precedente puede no tenerla: no pretende ser prueba.
  IF NEW.origen = 'DECLARACION_PROFESIONAL'
     AND NEW.afectacion <> 'NO_DETERMINADA'
     AND jsonb_array_length(NEW.evidencia) = 0 THEN
    RAISE EXCEPTION 'Una declaración profesional de % necesita al menos un ítem de evidencia',
      NEW.afectacion USING ERRCODE = 'check_violation';
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(NEW.evidencia) LOOP
    tipo := item ->> 'tipo';
    IF tipo IS NULL THEN
      RAISE EXCEPTION 'Un ítem de evidencia no declara tipo: %', item
        USING ERRCODE = 'check_violation';
    END IF;
    IF tipo NOT IN ('COMPROBANTE', 'CUENTA', 'CENTRO_DE_COSTO', 'DOCUMENTO',
                    'ASIENTO', 'DECLARACION_PROFESIONAL', 'NOTA') THEN
      RAISE EXCEPTION 'Tipo de evidencia desconocido: %', tipo
        USING ERRCODE = 'check_violation';
    END IF;

    IF tipo = 'NOTA' THEN
      IF coalesce(length(trim(item ->> 'texto')), 0) < 10 THEN
        RAISE EXCEPTION 'Una NOTA necesita texto de al menos 10 caracteres'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF (item ->> 'id') IS NULL THEN
        RAISE EXCEPTION 'La evidencia de tipo % debe referenciar un id', tipo
          USING ERRCODE = 'check_violation';
      END IF;
      con_referencia := con_referencia + 1;
    END IF;
  END LOOP;

  IF NEW.origen = 'DECLARACION_PROFESIONAL'
     AND NEW.afectacion <> 'NO_DETERMINADA'
     AND con_referencia = 0 THEN
    RAISE EXCEPTION 'La evidencia no puede ser solo notas: hace falta al menos una referencia a un objeto del sistema'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_affectations_shape
  BEFORE INSERT OR UPDATE ON tax_affectations
  FOR EACH ROW EXECUTE FUNCTION assert_affectation_shape();

-- ---------------------------------------------------------------------------
-- Existencia de las referencias
-- ---------------------------------------------------------------------------
-- Un id que no apunta a nada es peor que ninguna evidencia: se ve como respaldo.
-- Se verifica **dentro de la misma empresa**: una cuenta de otra compañía no es
-- evidencia, es una fuga.
CREATE OR REPLACE FUNCTION assert_evidence_exists() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  tipo text;
  ref  uuid;
  hay  boolean;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.evidencia) LOOP
    tipo := item ->> 'tipo';
    CONTINUE WHEN tipo = 'NOTA';

    BEGIN
      ref := (item ->> 'id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'La evidencia % no tiene un id válido: %', tipo, item ->> 'id'
        USING ERRCODE = 'check_violation';
    END;

    hay := CASE tipo
      WHEN 'COMPROBANTE' THEN EXISTS (SELECT 1 FROM tax_transactions t
                                       WHERE t.id = ref AND t.company_id = NEW.company_id)
      WHEN 'CUENTA' THEN EXISTS (SELECT 1 FROM accounts a
                                  WHERE a.id = ref AND a.company_id = NEW.company_id)
      WHEN 'CENTRO_DE_COSTO' THEN EXISTS (SELECT 1 FROM cost_centers c
                                           WHERE c.id = ref AND c.company_id = NEW.company_id)
      WHEN 'DOCUMENTO' THEN EXISTS (SELECT 1 FROM documents d
                                     WHERE d.id = ref AND d.company_id = NEW.company_id)
      WHEN 'ASIENTO' THEN EXISTS (SELECT 1 FROM journal_entries e
                                   WHERE e.id = ref AND e.company_id = NEW.company_id)
      WHEN 'DECLARACION_PROFESIONAL' THEN EXISTS (SELECT 1 FROM tax_affectations x
                                                   WHERE x.id = ref AND x.company_id = NEW.company_id)
      ELSE false
    END;

    IF NOT hay THEN
      RAISE EXCEPTION 'La evidencia % apunta a % , que no existe en esta empresa', tipo, ref
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER tax_affectations_evidence_exists
  AFTER INSERT OR UPDATE ON tax_affectations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_evidence_exists();

-- ---------------------------------------------------------------------------
-- La operación fiscal tiene que ser de la misma empresa
-- ---------------------------------------------------------------------------
-- El FK garantiza que la operación existe; no que sea de quien declara. Sin este
-- control, una empresa podría afectar la operación de otra y el RLS no lo vería:
-- la fila es suya.
CREATE OR REPLACE FUNCTION assert_affectation_tenant() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dueno uuid;
BEGIN
  SELECT company_id INTO dueno FROM tax_transactions WHERE id = NEW.tax_transaction_id;
  IF dueno IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'La operación fiscal % pertenece a otra empresa', NEW.tax_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_affectations_tenant
  BEFORE INSERT OR UPDATE ON tax_affectations
  FOR EACH ROW EXECUTE FUNCTION assert_affectation_tenant();

-- ---------------------------------------------------------------------------
-- Auditoría de toda modificación
-- ---------------------------------------------------------------------------
-- No hay cambios silenciosos: cada INSERT y cada UPDATE deja su fila en la
-- bitácora encadenada, con el valor anterior y el nuevo. El trigger la escribe
-- desde la base y no desde la aplicación, así que un `UPDATE` a mano por consola
-- también queda registrado.
CREATE OR REPLACE FUNCTION audit_tax_affectation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_logs
    (company_id, actor_type, actor_id, action, object_type, object_id,
     old_value, new_value, motivo, prev_hash, hash)
  VALUES (
    NEW.company_id,
    'USER',
    coalesce(NEW.declarada_por, current_user),
    CASE TG_OP WHEN 'INSERT' THEN 'AFFECTATION_DECLARED' ELSE 'AFFECTATION_CHANGED' END,
    'tax_affectations',
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE'
      THEN jsonb_build_object('afectacion', OLD.afectacion, 'origen', OLD.origen,
                              'proporcion_gravada', OLD.proporcion_gravada,
                              'evidencia', OLD.evidencia)
      ELSE NULL END,
    jsonb_build_object('afectacion', NEW.afectacion, 'origen', NEW.origen,
                       'proporcion_gravada', NEW.proporcion_gravada,
                       'evidencia', NEW.evidencia,
                       'tax_transaction_id', NEW.tax_transaction_id),
    NULL, '', ''
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER tax_affectations_audit
  AFTER INSERT OR UPDATE ON tax_affectations
  FOR EACH ROW EXECUTE FUNCTION audit_tax_affectation();

CREATE TRIGGER tax_affectations_no_delete
  BEFORE DELETE ON tax_affectations
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE tax_affectations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_affectations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_affectations
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON tax_affectations TO aai_app;

-- ---------------------------------------------------------------------------
-- La vista que el motor normativo puede leer
-- ---------------------------------------------------------------------------
-- Solo aparece acá lo que **prueba** ser una declaración profesional completa.
-- No hay filtro por origen sospechoso: hay una condición que cumplir.
--
-- `NO_DETERMINADA` queda afuera a propósito. Es una declaración válida —alguien
-- miró y dijo "no lo puedo determinar"— y su lugar es la bandeja de revisión,
-- no la resolución de una regla. Para el motor tiene que ser indistinguible de
-- la ausencia, porque significa lo mismo: nadie lo determinó.
-- `security_invoker = true` NO es opcional. Por defecto una vista de PostgreSQL
-- se ejecuta con los privilegios de **su dueño**, así que atraviesa el RLS del
-- que consulta: la tabla aísla y la vista filtra. Se descubrió con el test de
-- aislamiento de esta misma migración, y resultó que una vista anterior del
-- esquema tenía el mismo agujero (ver 0032).
CREATE VIEW tax_affectations_declaradas WITH (security_invoker = true) AS
SELECT a.id,
       a.company_id,
       a.tax_transaction_id,
       a.afectacion,
       a.proporcion_gravada,
       a.evidencia,
       a.declarada_por,
       a.declarada_at
  FROM tax_affectations a
  JOIN tax_transactions t ON t.id = a.tax_transaction_id AND t.company_id = a.company_id
 WHERE a.origen = 'DECLARACION_PROFESIONAL'
   AND a.declarada_por IS NOT NULL
   AND a.declarada_at IS NOT NULL
   AND a.afectacion IN ('GRAVADAS', 'EXENTAS', 'NO_GRAVADAS', 'MIXTA');

GRANT SELECT ON tax_affectations_declaradas TO aai_app;

COMMENT ON VIEW tax_affectations_declaradas IS
  'Única fuente admitida para el hecho vinculadaConOperacionesGravadas. '
  'Excluye sugerencias por precedente y NO_DETERMINADA: para el motor normativo '
  'ambas son ausencia de hecho, y la ausencia NO es false.';

COMMENT ON TABLE tax_affectations IS
  'Declaración profesional de la afectación de una operación fiscal. El sistema '
  'no la calcula: la registra con autor, fecha y evidencia referida a objetos '
  'existentes. Ver art. 12 de la Ley 23.349 y AR-IVA-CF-VINCULACION-001.';
