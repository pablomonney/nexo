-- ---------------------------------------------------------------------------
-- De qué plantilla salió este plan de cuentas
-- ---------------------------------------------------------------------------
--
-- NEXO va a ofrecer un plan de cuentas modelo —`NEXO_PYME_AR`— y a copiarlo
-- dentro de la empresa que lo elija. La copia es por valor y a propósito: las
-- cuentas quedan siendo de la empresa, se editan, se archivan y se usan sin
-- pedirle permiso a nadie.
--
-- Pero una copia sin procedencia no se puede acompañar. El día que el modelo
-- tenga una versión 2 —una cuenta nueva, un nombre corregido— la pregunta es
-- **a quién ofrecérsela**, y sin estas dos columnas la única respuesta posible
-- sería "a todos" o "a nadie". Las dos son igual de malas: la primera le ofrece
-- un cambio a quien armó su plan a mano, y la segunda abandona a quien eligió
-- el modelo.
--
-- ## Por qué no hay tabla de plantillas
--
-- La alternativa era `chart_templates` + `chart_template_accounts`, con las 185
-- cuentas sembradas como filas. Se descartó: la definición del catálogo vive en
-- `packages/shared/src/plan-de-cuentas.ts`, tipada y con sus controles, y
-- sembrarla además en la base crearía **una segunda copia de la misma
-- definición** — que es exactamente el defecto que este repositorio viene
-- corrigiendo desde la lista de organismos de contralor.
--
-- Lo que hace falta persistir no es el catálogo: es **qué empresa salió de qué
-- versión de qué plantilla**. Eso son dos columnas.
--
-- ## Por qué nullable, y por qué juntas
--
-- `NULL` es el caso normal y no es una carencia: un plan importado desde un
-- sistema anterior, o escrito a mano cuenta por cuenta, no viene de ninguna
-- plantilla y decir lo contrario sería inventarle un origen. Lo que no puede
-- pasar es media procedencia —plantilla sin versión, o al revés—, y eso lo
-- impide el CHECK.
-- ---------------------------------------------------------------------------

ALTER TABLE account_charts
  ADD COLUMN template_id      text,
  ADD COLUMN template_version integer;

ALTER TABLE account_charts
  ADD CONSTRAINT account_charts_plantilla_completa
    CHECK ((template_id IS NULL) = (template_version IS NULL));

ALTER TABLE account_charts
  ADD CONSTRAINT account_charts_version_de_plantilla_positiva
    CHECK (template_version IS NULL OR template_version > 0);

COMMENT ON COLUMN account_charts.template_id IS
  'De qué plantilla modelo salió este plan, si salió de alguna. NULL es el caso '
  'normal: un plan importado o hecho a mano no tiene plantilla, y ponerle una '
  'sería inventarle un origen.';

COMMENT ON COLUMN account_charts.template_version IS
  'Qué versión de esa plantilla se materializó. Es lo que permite ofrecer una '
  'versión nueva solo a quien salió de la anterior.';

CREATE INDEX account_charts_plantilla_idx
  ON account_charts (template_id, template_version)
  WHERE template_id IS NOT NULL;
