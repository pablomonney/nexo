-- ============================================================================
-- 0113 — Cargar un archivo no dejaba rastro
-- ============================================================================
--
-- La 0111 declaró cinco acciones de bitácora para las migraciones: crear,
-- mapear, validar, importar y revertir. Falta la que más importa para responder
-- «¿de dónde salió este dato?».
--
-- `POST /migraciones/:id/origen` es el momento exacto en que un archivo de un
-- sistema ajeno entra a la empresa. Después de ese paso hay filas crudas en la
-- base, y hasta hoy la bitácora saltaba de «se creó una migración» a «se declaró
-- un mapeo» sin decir qué archivo apareció en el medio, quién lo subió ni
-- cuándo. El dato existía —`migrations.archivo_nombre` y `archivo_hash`— pero
-- vivía en una fila que se sobrescribe, fuera de la cadena encadenada por hash.
--
-- La diferencia entre las dos cosas es la que hace útil a una bitácora: la fila
-- dice cuál es el archivo **ahora**; la bitácora dice qué pasó y en qué orden, y
-- no se puede editar sin romper la cadena.
--
-- `requiere_motivo` en false: subir un archivo todavía no escribe nada en la
-- empresa. El motivo se exige donde se deshace algo, que es revertir.

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('CARGAR_ORIGEN', 'migracion', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
