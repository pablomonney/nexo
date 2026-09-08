-- ============================================================================
-- 0098 — Lo que la lista se olvidó
-- ============================================================================
--
-- La 0097 revocó la escritura sobre las siete tablas de facturación y se olvidó
-- de dos objetos: la vista `billing_account_status` y el `SELECT` de
-- `payment_events`, que la 0096 había declarado fuera del alcance de la
-- aplicación y el `ALTER DEFAULT PRIVILEGES` de la 0009 le concedió igual.
--
-- Que la corrección de un olvido tenga su propio olvido **es el argumento**: una
-- lista escrita a mano falla exactamente así, y va a fallar de nuevo con la
-- próxima tabla. Por eso lo que queda de esto no es esta migración, es
-- `tests/security/solo-lectura-de-verdad.test.ts`, que recorre los objetos
-- declarados de solo lectura y compara contra el catálogo de PostgreSQL en vez
-- de contra una lista.
--
-- Escribir en la vista no era explotable —`security_invoker` la hace correr con
-- los privilegios de quien consulta, y debajo el `INSERT` ya estaba revocado—,
-- pero un privilegio que no se usa es un privilegio que alguien puede empezar a
-- usar el día que la vista deje de ser `security_invoker`.
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE ON billing_account_status FROM aai_app;

-- El diario de integración es del operador. La 0096 no le dio `SELECT` y lo
-- tenía igual: no conceder no es lo mismo que revocar.
REVOKE SELECT, INSERT, UPDATE, DELETE ON payment_events FROM aai_app;
