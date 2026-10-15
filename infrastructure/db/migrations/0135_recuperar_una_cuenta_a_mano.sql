-- ============================================================================
-- 0135 — Recuperar una cuenta a mano: las acciones de auditoría del operador
-- ============================================================================
--
-- La 0134 dio la recuperación por correo («olvidé mi contraseña»). Quedan dos casos que el correo no resuelve y que
-- hoy sólo se podían tocar con SQL a mano o con dos scripts atados a una cuenta de demostración y a la base local:
--
--   · la persona **perdió el segundo factor** (y los códigos de recuperación): sin el segundo factor no entra, y la
--     pantalla de alta de MFA no vuelve a mostrar el secreto, a propósito;
--   · la persona **perdió el acceso al correo** de la cuenta: el código de recuperación llega a una bandeja que ya no es suya.
--
-- Los dos son actos de identidad: dejan a alguien entrar a una empresa. Por eso las dos acciones EXIGEN motivo, y el
-- script del operador (`scripts/recuperar-cuenta.mjs`) exige además escribir cómo se verificó la identidad. Sin eso, seis
-- meses después nadie puede decir por qué una cuenta cambió de segundo factor o de correo.

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES
  ('RESETEAR_SEGUNDO_FACTOR', 'identidad', true),
  ('CAMBIAR_CORREO_DE_CUENTA', 'identidad', true);
