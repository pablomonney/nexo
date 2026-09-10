-- ============================================================================
-- 0112 — Un hallazgo no es una prueba
-- ============================================================================
--
-- La 0111 le revocó el DELETE a la aplicación sobre las cinco tablas de
-- migración, con un argumento que sigue siendo cierto para cuatro de ellas: la
-- fila cruda es la prueba de lo que el sistema anterior tenía, y borrarla la
-- deja de ser prueba.
--
-- Con `migration_findings` el argumento no aplica, y aplicarlo igual dejó al
-- validador sin poder correr: `validarMigracion` empieza borrando los hallazgos
-- de la corrida anterior, y esa sentencia moría con «permiso denegado» antes de
-- validar nada. Una migración no se podía validar. El test de integración lo
-- encontró en la primera corrida.
--
-- ## Por qué acá el borrado sí corresponde
--
-- Un hallazgo no es un dato del origen: es **lo que el validador opina hoy**
-- sobre una fila cruda, dado el mapeo declarado hoy. Cambiar el mapeo —que es
-- exactamente lo que alguien hace cuando la vista previa le muestra 40 errores—
-- cambia los hallazgos, y los de la corrida anterior pasan a describir una
-- decisión que ya no está vigente.
--
-- Conservarlos no agregaría auditoría: agregaría dos listas contradictorias sin
-- forma de saber cuál corresponde al mapeo actual. La alternativa —numerar las
-- corridas y filtrar por la última— guarda lo mismo que se puede recalcular en
-- cualquier momento a partir de la fila cruda, que sí es inmutable.
--
-- Lo que queda registrado de cada validación es el evento en la bitácora, con
-- sus conteos. Eso es lo que responde «qué se decidió y cuándo». Los hallazgos
-- responden «qué pasa si importo ahora», y esa pregunta solo tiene una respuesta
-- vigente.
--
-- ## Lo que NO se concede
--
-- `migrations`, `migration_tables`, `migration_rows` y `migration_links` siguen
-- sin DELETE. En particular `migration_tables`: borrarla arrastra por cascada
-- las filas crudas, que es la única manera que le quedaba a la aplicación de
-- sacarlas. Volver a cargar un archivo sobre una migración ya cargada dejó de
-- estar permitido por eso mismo — se hace una migración nueva, que no cuesta
-- nada, en vez de destruir la prueba de la anterior.

GRANT DELETE ON migration_findings TO aai_app;

COMMENT ON TABLE migration_findings IS
  'Lo que el validador observa sobre las filas crudas con el mapeo vigente. Se '
  'recalcula entero en cada validación: es derivado, no es prueba. La prueba de '
  'lo que el origen traía está en migration_rows, que no se borra ni se edita.';
