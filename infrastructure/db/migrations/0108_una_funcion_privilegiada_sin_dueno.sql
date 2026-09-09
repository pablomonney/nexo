-- ============================================================================
-- 0108 — Una función privilegiada sin dueño
-- ============================================================================
--
-- La auditoría determinística encontró esto, y ninguna anterior lo había visto
-- porque **el aislamiento se ve intacto desde afuera**: 118 tablas con RLS
-- forzado, cero con `company_id` sin política, y el barrido de endpoints en
-- verde.
--
-- El agujero no está en las tablas. Está en tres funciones `SECURITY DEFINER`
-- que la aplicación puede ejecutar y que **no comprueban quién llama**:
--
--     company_organization(company)          → devuelve el estudio de cualquier empresa
--     rebuild_account_balances(company)      → BORRA y rehace sus saldos contables
--     recalcular_ppp_de_producto(emp, prod)  → BORRA y rehace su costo promedio
--
-- `SECURITY DEFINER` significa «corré con los privilegios de quien la creó», y
-- quien las creó es el dueño del esquema. Adentro de esas funciones **no hay
-- RLS**: el `WHERE company_id = ...` que protege todo lo demás no participa.
--
-- ## Lo que se midió, con el rol de la aplicación puesto
--
--     leer account_balances de otra empresa por SQL     → 0 filas   (RLS)
--     escribir stock_movement_ppp de otra empresa       → 42501     (revoke 0086)
--     rebuild_account_balances(otra empresa)            → 2 filas   ← pasó
--     recalcular_ppp_de_producto(otra empresa, ...)     → sin error ← pasó
--     company_organization(otra empresa)                → devolvió  ← pasó
--
-- Las dos primeras líneas son la prueba de que las defensas de siempre andan.
-- Las tres últimas son la prueba de que hay un camino que las rodea.
--
-- ## Lo más incómodo
--
-- La 0086 **revocó a propósito** `INSERT, UPDATE, DELETE` sobre
-- `stock_movement_ppp`, y dejó escrito por qué: «que la API pudiera escribirla
-- haría una segunda verdad sobre el costo, capaz de contradecir al libro».
--
-- `recalcular_ppp_de_producto` es `SECURITY DEFINER` y borra esa misma tabla.
-- El revoke se lee como un candado y para ese camino no lo es. **Una defensa
-- que otra pieza deshace no es una defensa a medias: es ninguna**, porque el
-- que la lee cree que está protegido.
--
-- ## Qué tan grave es
--
-- Hoy **no se puede llegar desde la API**: ninguna ruta le pasa a estas
-- funciones un identificador de empresa que venga del pedido, y todas las
-- consultas van parametrizadas. No es una fuga abierta.
--
-- Es una primitiva. Convierte cualquier inyección SQL futura, o cualquier ruta
-- nueva escrita sin cuidado, en **borrado de datos contables de otra empresa**.
-- Eso es exactamente lo que el aislamiento existe para hacer imposible, no
-- improbable.
--
-- ## El arreglo
--
-- Quitarles el privilegio de ejecución a la aplicación. Ninguna la llama:
-- `rebuild_account_balances` solo aparece en un test —que corre como dueño— y
-- las otras dos **no tienen ni un llamador en todo el repositorio**.
--
-- No se borran: `rebuild_account_balances` es la herramienta con la que un
-- operador rehace los saldos si algo se corrompe, y `recalcular_ppp_de_producto`
-- la equivalente para el costo. Siguen existiendo para quien corre como
-- operador. Lo que deja de existir es que las pueda llamar la aplicación.
--
-- Las funciones de trigger van en el mismo lote y por otro motivo: un trigger
-- corre con los privilegios de su dueño **sin importar** quién tenga `EXECUTE`,
-- así que ese permiso no habilitaba nada y llamarlas a mano falla igual. Se
-- quita porque un privilegio que no se usa es uno que alguien puede empezar a
-- usar.
--
-- ## Las que se quedan, y por qué
--
-- `create_organization`, `create_company`, `grant_company_role` y
-- `user_companies` siguen ejecutables, porque **comprueban al que llama**: las
-- tres primeras verifican el nivel del actor en el estudio, y la cuarta no
-- recibe parámetros —lee `app.actor_id`— así que no hay identificador ajeno que
-- pasarle. Ese es el patrón correcto, y es la diferencia con las tres de arriba.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION company_organization(uuid) FROM aai_app;
REVOKE EXECUTE ON FUNCTION rebuild_account_balances(uuid) FROM aai_app;
REVOKE EXECUTE ON FUNCTION recalcular_ppp_de_producto(uuid, uuid) FROM aai_app;

-- Trigger: el `EXECUTE` no las dispara y llamarlas a mano falla igual.
REVOKE EXECUTE ON FUNCTION project_ledger_movements() FROM aai_app;
REVOKE EXECUTE ON FUNCTION proyectar_ppp() FROM aai_app;

COMMENT ON FUNCTION rebuild_account_balances(uuid) IS
  'Rehace los saldos de una empresa desde ledger_movements. SECURITY DEFINER: '
  'no evalúa RLS, así que acepta CUALQUIER empresa. Por eso la aplicación no la '
  'puede ejecutar (0108) — es una herramienta del operador.';

COMMENT ON FUNCTION recalcular_ppp_de_producto(uuid, uuid) IS
  'Rehace el costo promedio de un producto. SECURITY DEFINER: rodea el REVOKE '
  'que la 0086 puso sobre stock_movement_ppp, así que la aplicación no la puede '
  'ejecutar (0108).';

COMMENT ON FUNCTION company_organization(uuid) IS
  'El estudio de una empresa. SECURITY DEFINER sin comprobar al que llama: '
  'contestaría por cualquier empresa. Sin llamadores; revocada a la aplicación '
  '(0108).';
