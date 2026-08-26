-- 0029_comentarios_de_tablas_destrabadas.sql — corregir dos comentarios que quedaron mintiendo.
--
-- Los `COMMENT ON TABLE` de este repositorio no son adorno: declaran el estado de
-- los datos, y hay tests que los leen. Dos de ellos afirmaban que una tabla estaba
-- vacía porque faltaba archivar una norma. Las normas se archivaron y las tablas
-- dejaron de estar vacías; el comentario quedó igual.
--
-- Un comentario desactualizado es peor que ninguno. El que abre `\d+ tax_rates`
-- para entender por qué el motor no le da una alícuota va a leer que falta la Ley
-- 23.349, va a ir a buscarla, y la va a encontrar archivada — y no va a saber si
-- el problema es otro o si el sistema se contradice.

COMMENT ON TABLE tax_rates IS
  'Alícuotas con su norma, desde el art. 28 de la Ley de IVA (t.o. 1997). Se siembran con `npm run tax:seed`. Antes del 18/11/2002 no hay ninguna vigente: el T.O. archivado no transcribe sus antecedentes, y el motor responde SIN_ALICUOTAS_RELEVADAS en vez de suponer 21%.';

COMMENT ON TABLE statement_templates IS
  'Estructura de los estados contables, versionada y con su norma. La Ley 19.550 ya está sembrada; transcribir sus arts. 63 y 64 al árbol es trabajo profesional con revisión humana, no una corrida de script.';

-- La ventana del 19% del Decreto 2312/2002 es el único tramo histórico que el
-- texto archivado permite afirmar, y es también la fila más fácil de "limpiar" por
-- prolijidad dentro de unos años: es vieja, es rara, y nadie liquida IVA de 2002.
--
-- Borrarla no dejaría un hueco visible. Dejaría al 21% empezando el 18/01/2003 sin
-- ninguna razón aparente, y la próxima persona que lo mire va a "corregir" esa
-- fecha hacia atrás. El comentario existe para que esa fila se entienda antes de
-- que a alguien le moleste.
COMMENT ON COLUMN tax_rates.valid_from IS
  'Desde cuándo rige, según el documento archivado y no según cuándo se cargó. La ventana 2002-11-18/2003-01-17 (19%) no es folclore: es lo que ancla el inicio del 21%.';
