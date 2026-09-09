-- ============================================================================
-- 0109 — El permiso que no le quitaste a nadie
-- ============================================================================
--
-- La 0108 revocó `EXECUTE` a `aai_app` sobre las cinco funciones peligrosas.
-- Se corrió la prueba adversarial otra vez y **las tres siguieron pasando**:
--
--     company_organization(empresa ajena)        → devolvió el estudio
--     rebuild_account_balances(empresa ajena)    → 2 filas
--     recalcular_ppp_de_producto(empresa ajena)  → sin error
--
-- El motivo está en la lista de permisos de cualquiera de ellas:
--
--     company_organization   =X/postgres | postgres=X/postgres
--     create_company         =X/postgres | postgres=X/postgres | aai_app=X/postgres
--
-- Esa primera entrada, la que no tiene nombre a la izquierda del `=`, es
-- **PUBLIC**. PostgreSQL le da `EXECUTE` a PUBLIC sobre toda función nueva, sin
-- que nadie lo escriba. Así que `aai_app` podía ejecutarlas por ser parte de
-- todos, y el `GRANT ... TO aai_app` que aparecía en las migraciones viejas
-- nunca le dio nada que no tuviera. Quitárselo tampoco le quitó nada.
--
-- ## Es la tercera vez, y siempre la misma forma
--
-- La 0097 se llamó «un GRANT no quita nada»: la 0096 escribía
-- `GRANT SELECT` creyendo que dejaba las tablas de facturación en solo lectura,
-- mientras `ALTER DEFAULT PRIVILEGES` de la 0009 ya les había dado INSERT y
-- UPDATE. La 0098 arregló lo que la 0097 se había salteado.
--
-- Ahora es al revés y da igual: **un REVOKE a un rol no quita lo que tiene
-- PUBLIC**. Las tres veces el error fue el mismo: escribir el permiso que uno
-- quería y no comprobar el permiso que había. El sistema de privilegios de
-- PostgreSQL es acumulativo y tiene un default implícito; leerlo es la única
-- forma de saber, y `has_function_privilege` contesta en una línea.
--
-- Por eso este arreglo no termina en el `REVOKE`. La prueba adversarial se
-- vuelve a correr, y la S-32 —el control nuevo— **no lee migraciones: le
-- pregunta al catálogo quién puede ejecutar qué**, que es lo único que después
-- se cumple en producción.
--
-- ## El arreglo
--
-- Sacarle `EXECUTE` a PUBLIC sobre **todas** las funciones `SECURITY DEFINER`, y
-- devolvérselo explícitamente a `aai_app` solo sobre las cuatro que comprueban
-- al que llama. Después de esto la lista de permisos deja de ser un accidente y
-- pasa a ser una declaración: si `aai_app` figura, alguien lo decidió.
--
-- Las cuatro que se quedan y por qué se pueden quedar:
--
--     create_organization  — exige que el actor sea dueño del estudio
--     create_company       — exige nivel en el estudio
--     grant_company_role   — exige nivel en el estudio
--     user_companies       — no recibe parámetros: lee `app.actor_id`
--
-- Ninguna acepta un identificador de empresa ajeno y actúa sobre él sin mirar
-- quién es el que pregunta. Esa es exactamente la propiedad que les faltaba a
-- las otras cinco.
-- ============================================================================

-- PUBLIC no ejecuta ninguna función privilegiada. Ninguna.
REVOKE EXECUTE ON FUNCTION company_organization(uuid)             FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rebuild_account_balances(uuid)         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION recalcular_ppp_de_producto(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION project_ledger_movements()             FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION proyectar_ppp()                        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_organization(text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION grant_company_role(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION user_companies()                       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_company(
  uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;

-- Y la aplicación recupera, por escrito, solo las cuatro que la comprueban.
GRANT EXECUTE ON FUNCTION create_organization(text, text, uuid) TO aai_app;
GRANT EXECUTE ON FUNCTION grant_company_role(uuid, uuid, uuid, text) TO aai_app;
GRANT EXECUTE ON FUNCTION user_companies()                      TO aai_app;
GRANT EXECUTE ON FUNCTION create_company(
  uuid, uuid, text, text, text, text, text, text) TO aai_app;
