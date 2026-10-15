-- ============================================================================
-- 0134 — Recuperar la contraseña: la acción de auditoría
-- ============================================================================
--
-- Hasta ahora NEXO no tenía «olvidé mi contraseña»: quien perdía la contraseña no tenía salida por su cuenta, y los dos
-- scripts de reseteo del repositorio están atados a una cuenta de demostración y a la base local. Las rutas
-- `POST /auth/recuperar` y `POST /auth/restablecer` lo resuelven con el código por correo.
--
-- La tabla `email_verifications` ya preveía el propósito `RECUPERACION` (0103) y la bandeja `email_outbox` el tipo
-- `RECUPERACION`, así que el esquema no cambia. Lo único que falta es **registrar la acción de bitácora**: desde la 0091
-- las acciones válidas son filas de `audit_actions` y una acción desconocida se rechaza.
--
-- ## Por qué exige motivo
--
-- Cambiar la contraseña de una cuenta es el acto que da acceso a una empresa. Sin el motivo escrito («contraseña elegida
-- con un código enviado por correo»), seis meses después una auditoría no puede distinguir una recuperación legítima de
-- un cambio hecho por otra vía. La ruta lo escribe siempre; que el motivo sea obligatorio impide que un cambio futuro
-- lo olvide.
--
-- La contraseña nueva **nunca** se escribe en la bitácora: la fila lleva quién (`system:recuperacion`), sobre qué usuario
-- y por qué, y nada más.

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('RESTABLECER_CONTRASENA', 'identidad', true);
