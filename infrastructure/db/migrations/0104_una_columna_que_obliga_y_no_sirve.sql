-- ============================================================================
-- 0104 — Una columna que obliga y no sirve
-- ============================================================================
--
-- La 0103 le puso `company_id` a `email_outbox` pensando en el aviso de
-- cobranza, que sí es de una empresa. No lo usa nadie: el alta autoservicio lo
-- deja en `NULL` —todavía no hay empresa— y no hay ninguna consulta que filtre
-- por él, porque la aplicación **no puede leer esta tabla**.
--
-- Lo encontró el invariante de aislamiento: «toda tabla con `company_id` tiene
-- RLS forzado y su política». Es una regla del sistema entero y no admite
-- excepciones cómodas, así que la columna dejaba dos salidas y las dos malas:
--
--   · **Ponerle RLS.** La política sería `company_id = app_company_id()`, y el
--     alta —que corre sin empresa en contexto y escribe `NULL`— dejaría de
--     poder encolar. Una regla de aislamiento rompiendo un registro que todavía
--     no tiene nada que aislar.
--   · **Declararla excepción.** Aflojar el invariante más importante del
--     sistema por una columna que no lee nadie.
--
-- La tercera salida es la correcta: **la columna se va**. El día que un aviso de
-- cobranza necesite alcance por empresa, se agrega con su RLS y su política —y
-- ahí la regla va a valer para algo, porque va a haber algo que aislar.
--
-- Nota de despliegue: esto borra una columna, que es lo único que este
-- repositorio evita hacer. Se admite porque la columna nació en la 0103, no
-- llegó a ningún despliegue y no la lee ninguna consulta. Con la columna en
-- producción, el paso correcto habría sido dejar de escribirla primero y
-- borrarla en la versión siguiente.
-- ============================================================================

ALTER TABLE email_outbox DROP COLUMN company_id;

COMMENT ON TABLE email_outbox IS
  'Correo saliente. La aplicación INSERTA y no LEE: el cuerpo de un mensaje de '
  'verificación contiene el token, y poder leer la bandeja sería poder '
  'verificar la cuenta de cualquiera. No tiene company_id: no hay nada que '
  'aislar todavía, y una columna sin lector que obliga a poner RLS es peor que '
  'no tenerla (0104).';
