-- 0028_res_p_and_adoptions.sql — un tipo de norma que faltaba y un candado sobre las adopciones.
--
-- Esta migración existe por un documento: la **Resolución P. N° 460/2024 del
-- CPCECABA**, que adopta la RT 54 (T.O. RT 59) en la jurisdicción de la Ciudad
-- Autónoma de Buenos Aires. Es el acto que hasta ahora faltaba y que hacía que el
-- motor respondiera `ADOPCION_NO_RELEVADA` para CABA.
--
-- ## Por qué RES_P y no RES_CD
--
-- El catálogo de `norms.tipo` de la 0006 tiene `RES_JG` (Junta de Gobierno de la
-- FACPCE), `RES_MD` (Mesa Directiva) y `RES_CD` (Consejo Directivo). No tiene el
-- tipo del documento que efectivamente firma esta resolución: **Presidencia**.
--
-- La tentación era cargarla como `RES_CD` — el Consejo Directivo la trató, el
-- campo existe, nadie se daría cuenta. Sería falso: el documento dice
-- *"Resolución P. N° 460/2024"*, lo firma la Presidenta, y su art. 8° ordena
-- *"elévese al Consejo Directivo"*, que es lo contrario de haber sido dictada por
-- él. Un tipo de norma mal asignado no se ve mal: se ve como una norma, y la cita
-- que el sistema produzca va a nombrar un órgano que no la dictó.
--
-- Es más barato agregar un valor al CHECK que explicar, dentro de tres años, por
-- qué el sistema atribuye al Consejo Directivo un acto de Presidencia.

ALTER TABLE norms DROP CONSTRAINT norms_tipo_check;

ALTER TABLE norms ADD CONSTRAINT norms_tipo_check CHECK (tipo IN (
  'CONSTITUCION', 'LEY', 'DECRETO', 'RG', 'RESOLUCION', 'DISPOSICION',
  'RT', 'RES_JG', 'RES_MD', 'RES_CD', 'RES_P',
  'INTERPRETACION', 'MANUAL', 'PARAMETRO'));

-- Que el CHECK viejo se haya ido no alcanza: lo que importa es que el nuevo valor
-- entre. Un CHECK duplicado con la lista anterior seguiría rechazando RES_P y la
-- migración habría "pasado". Es el mismo modo de falla del INSERT ... SELECT que
-- insertaba cero filas en la 0022.
DO $verificar_tipo$
BEGIN
  INSERT INTO norms (organismo, tipo, numero, anio, titulo, jurisdiccion, hierarchy_level)
  VALUES ('CPCE_CABA', 'RES_P', '__probe__', 1, 'sonda de migración', 'AR', 3);
  DELETE FROM norms WHERE numero = '__probe__' AND anio = 1;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'El CHECK de norms.tipo sigue rechazando RES_P: quedó otra restricción con la lista anterior.';
END
$verificar_tipo$;

COMMENT ON COLUMN norms.tipo IS
  'Tipo del acto, tal como lo nombra el documento. RES_P es Presidencia del consejo profesional: no es sinónimo de RES_CD.';

-- ---------------------------------------------------------------------------
-- Una adopción sin el acto archivado no es una adopción
-- ---------------------------------------------------------------------------
-- `norm_adoptions.evidence_document_id` era nullable desde la 0006, y con eso la
-- tabla admitía la fila que este sistema no puede permitirse: *"en CABA la RT 54
-- rige desde 2025"* sin ningún documento detrás.
--
-- Es exactamente la distinción del §11 aplicada a la vigencia: **que la FACPCE
-- haya aprobado una norma y que un consejo la haya adoptado son dos hechos
-- distintos**, y el segundo solo existe si alguien archivó el acto. Ahora que el
-- acto existe, se puede exigir.
ALTER TABLE norm_adoptions
  ALTER COLUMN evidence_document_id SET NOT NULL;

-- La aplicación anticipada viene en pares o no viene. Una fecha sin ancla no se
-- puede evaluar —¿ejercicios iniciados o finalizados desde esa fecha?— y un ancla
-- sin fecha no dice nada.
ALTER TABLE norm_adoptions
  ADD CONSTRAINT adopcion_anticipada_completa
    CHECK ((early_from IS NULL) = (early_anchor IS NULL));

-- La anticipada nunca puede ser posterior a la obligatoria: si lo fuera, no sería
-- anticipada.
ALTER TABLE norm_adoptions
  ADD CONSTRAINT adopcion_anticipada_anterior
    CHECK (early_from IS NULL OR early_from <= valid_from);

-- El artículo del que sale la adopción. Sin esto, `evidence_document_id` prueba
-- que hay un PDF, no dónde adentro dice lo que la fila afirma.
ALTER TABLE norm_adoptions
  ADD COLUMN articulo text;

UPDATE norm_adoptions SET articulo = 'PENDIENTE_DE_RELEVAMIENTO' WHERE articulo IS NULL;

ALTER TABLE norm_adoptions
  ALTER COLUMN articulo SET NOT NULL,
  ADD CONSTRAINT adopcion_articulo_no_vacio CHECK (length(btrim(articulo)) > 0);

COMMENT ON TABLE norm_adoptions IS
  'Qué jurisdicción adoptó qué versión de norma, con qué acto y desde cuándo. Cada fila exige el documento archivado y el artículo: la vigencia FACPCE y la del consejo son hechos distintos.';
