-- 0039_alcance_de_los_estados.sql — qué cuentas le corresponden a cada estado.
--
-- ## Los dos defectos que esto cierra
--
-- **1. `CUENTA_SIN_RUBRO` evaluaba el plan entero.** El control recorre todas las
-- cuentas imputables con saldo y marca como huérfana a la que ningún renglón
-- captura. Pero un ESP no tiene —ni debe tener— renglones para cuentas de
-- resultado, así que toda cuenta de ingresos o gastos con saldo salía huérfana y
-- el estado quedaba `emisible = false`. El ER tenía el problema espejo.
--
-- Consecuencia medida: **ninguna empresa con un plan de cuentas completo podía
-- emitir un estado**. No se había notado porque los tests de integración
-- insertan las filas de `financial_statements` por SQL y los unitarios usan un
-- plan hecho a medida de la plantilla — el endpoint nunca se ejercitó entero.
--
-- **2. La ecuación patrimonial se declaraba en la ruta, con códigos que la
-- plantilla no tiene.** `ECUACION_ESP = { activo: 'A', pasivo: 'P', ... }` vivía
-- en `routes/statements.ts`; la plantilla sembrada usa `ACTIVO`, `PASIVO` y `PN`.
-- El control detectaba los nodos faltantes y fallaba —bien: no correr en
-- silencio hubiera sido peor— pero fallaba **siempre**.
--
-- ## Lo que se agrega, y por qué acá y no en el código
--
-- Las dos cosas son propiedades de **la plantilla**, no del motor ni de la ruta:
--
--   * qué tipos de cuenta le corresponden al estado, y de qué artículo sale eso;
--   * qué nodos forman la ecuación patrimonial, si la tiene.
--
-- Ponerlas en el código las volvería una convención global, y la premisa del
-- subsistema es la contraria: cada empresa puede tener su plantilla
-- (`statement_templates.company_id` es nullable) con sus códigos y su jerarquía.
-- Una empresa que llame `AC` a su activo declara `AC` en su plantilla y el motor
-- no se entera.
--
-- ## Lo que NO se agrega
--
-- Ninguna tabla de clasificación cuenta → rubro. Ya existe: son los `selector`
-- de los renglones de la plantilla, versionados con ella y fundados en su
-- artículo. Duplicarlos en una tabla por empresa daría dos respuestas a la misma
-- pregunta y la primera vez que difirieran nadie sabría cuál vale.

ALTER TABLE statement_templates
  -- Los tipos de `accounts.type` sobre los que este estado se pronuncia. Una
  -- cuenta cuyo tipo no está acá no es huérfana: es ajena, y el estado lo dice.
  ADD COLUMN scope_types text[],
  -- De dónde sale ese alcance. Un alcance sin artículo sería una convención
  -- nuestra presentada como estructura normativa.
  ADD COLUMN scope_fundamento text,
  -- `{activo, pasivo, patrimonioNeto}` con códigos de nodo DE ESTA plantilla.
  -- NULL en los estados que no tienen ecuación patrimonial que verificar.
  ADD COLUMN equation jsonb;

-- ---------------------------------------------------------------------------
-- Backfill de las plantillas ya publicadas
-- ---------------------------------------------------------------------------
-- No es una reescritura: es completar el registro con lo que la norma que la
-- plantilla ya cita dice. El art. 63 de la ley 19.550 es el balance —activo,
-- pasivo y patrimonio neto, con las cuentas de orden al pie— y el art. 64 es el
-- estado de resultados. No se está decidiendo nada nuevo acá; se está escribiendo
-- lo que ya estaba implícito en qué renglones tiene cada plantilla.
UPDATE statement_templates
   SET scope_types = ARRAY['ACTIVO', 'PASIVO', 'PN', 'ORDEN'],
       scope_fundamento = 'Ley 19.550 (T.O. 1984), art. 63: activo, pasivo, patrimonio neto y cuentas de orden',
       equation = '{"activo":"ACTIVO","pasivo":"PASIVO","patrimonioNeto":"PN"}'::jsonb
 WHERE statement_kind = 'ESP';

UPDATE statement_templates
   SET scope_types = ARRAY['INGRESO', 'COSTO', 'GASTO'],
       scope_fundamento = 'Ley 19.550 (T.O. 1984), art. 64: resultados del ejercicio',
       equation = NULL
 WHERE statement_kind = 'ER';

-- Toda plantilla tiene que declarar su alcance. Una que no lo haga volvería al
-- comportamiento anterior —evaluar el plan entero— sin que nada lo diga.
ALTER TABLE statement_templates
  ALTER COLUMN scope_types SET NOT NULL,
  ALTER COLUMN scope_fundamento SET NOT NULL,
  ADD CONSTRAINT st_alcance_no_vacio CHECK (cardinality(scope_types) > 0),
  ADD CONSTRAINT st_alcance_tipos_validos
    CHECK (scope_types <@ ARRAY['ACTIVO','PASIVO','PN','INGRESO','COSTO','GASTO','ORDEN']);

-- ---------------------------------------------------------------------------
-- El alcance es tan inmutable como la estructura
-- ---------------------------------------------------------------------------
-- Cambiarle el alcance a una plantilla publicada cambia qué cuentas se
-- consideran huérfanas, y con eso qué estados eran emisibles. Es el §6 aplicado
-- a la presentación, igual que con `structure`: se cierra con `valid_to` y se
-- publica la versión siguiente.
CREATE OR REPLACE FUNCTION forbid_template_rewrite() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.structure        IS DISTINCT FROM OLD.structure
  OR NEW.version          IS DISTINCT FROM OLD.version
  OR NEW.norm_version_id  IS DISTINCT FROM OLD.norm_version_id
  OR NEW.scope_types      IS DISTINCT FROM OLD.scope_types
  OR NEW.scope_fundamento IS DISTINCT FROM OLD.scope_fundamento
  OR NEW.equation         IS DISTINCT FROM OLD.equation THEN
    RAISE EXCEPTION 'Una plantilla publicada no se reescribe: cerrala con valid_to y cargá la versión siguiente. Reescribirla cambiaría los estados ya emitidos con ella.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN statement_templates.scope_types IS
  'Tipos de cuenta sobre los que este estado se pronuncia. Una cuenta fuera del '
  'alcance no es huérfana: es ajena al estado, y se informa como tal.';

COMMENT ON COLUMN statement_templates.equation IS
  'Códigos de nodo DE ESTA plantilla que forman Activo = Pasivo + PN. NULL si el '
  'estado no tiene ecuación que verificar. Vivía en la ruta con códigos que la '
  'plantilla no tenía, así que el control fallaba siempre.';
