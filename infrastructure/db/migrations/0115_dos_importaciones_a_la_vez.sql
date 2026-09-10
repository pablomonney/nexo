-- ============================================================================
-- 0115 — Dos importaciones a la vez
-- ============================================================================
--
-- Alguien aprieta «Importar» dos veces. O la consola larga la segunda vuelta
-- antes de que vuelva la primera. O dos personas abren la misma migración.
--
-- Medido: las dos corridas planifican, las dos ven las mismas tandas pendientes
-- y las dos las corren. Los datos **no se duplican** —el `UNIQUE` de
-- `migration_links` los frena— pero la segunda choca contra ese UNIQUE con un
-- 23505 que aborta la tanda entera, y el usuario recibe:
--
--     Una migración en COMPLETADA_CON_ADVERTENCIAS no puede pasar a IMPORTANDO.
--
-- que no es lo que pasó, no dice qué hacer, y aparece después de que la otra
-- corrida ya terminó bien. La integridad estaba a salvo; lo que fallaba era
-- poder explicarlo.
--
-- ## Por qué una columna y no un lock de PostgreSQL
--
-- Un `pg_advisory_lock` vive en la conexión, y la importación por tandas usa
-- **una conexión por tanda** —es lo que hace que cada tanda sea un punto de
-- control—. El candado tiene que sobrevivir al cambio de conexión, así que vive
-- en la fila.
--
-- ## Por qué se vence solo
--
-- Un candado que solo suelta quien lo tomó deja la migración trabada para
-- siempre si el proceso se muere. Con vencimiento, una corrida abandonada se
-- puede retomar sola pasado el plazo, que es exactamente lo que pide no dejar
-- nada en «ejecutando» indefinidamente. El plazo se renueva al cerrar cada
-- tanda: mientras algo avance, nadie se lo saca.

ALTER TABLE migrations
  ADD COLUMN importando_desde timestamptz;

COMMENT ON COLUMN migrations.importando_desde IS
  'Cuándo tomó el candado la corrida que está importando. NULL es «nadie». Se '
  'renueva al cerrar cada tanda y se vence solo, para que una corrida muerta no '
  'deje la migración trabada.';

-- El índice sirve a la consulta que busca migraciones trabadas, que es la que
-- contesta «¿hay algo colgado?» sin recorrer la tabla entera.
CREATE INDEX migrations_importando_idx ON migrations (company_id, importando_desde)
  WHERE importando_desde IS NOT NULL;
