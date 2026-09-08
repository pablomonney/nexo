-- ============================================================================
-- 0103 — Un alta que nadie autorizó
-- ============================================================================
--
-- Hasta acá, para tener un usuario en NEXO alguien tenía que darlo de alta:
-- `/auth/register-first-admin` crea el primero y después el alta la hace el
-- estudio. Eso funciona para instalar el sistema y **no** para venderlo: una
-- empresa que quiere probarlo tiene que poder registrarse sola.
--
-- El problema de que cualquiera pueda registrarse es exactamente ese: cualquiera
-- puede. Esta migración pone lo que hace falta para que un alta sin autorización
-- previa no sea una puerta abierta.
--
-- ## Quién nace verificado y quién no
--
-- **Un usuario que da de alta un administrador nace `ACTIVE`.** Alguien con
-- autoridad respondió por él, y eso es una verificación más fuerte que un correo:
-- pedirle además que confirme una dirección sería teatro.
--
-- **Un usuario que se registra solo nace `PENDIENTE`** y no entra hasta
-- confirmar que la dirección es suya. Sin eso, cualquiera podría registrarse con
-- el correo de otro y quedarse esperando a que esa persona intente entrar.
--
-- El estado cuarto existe para poder decir la diferencia. Reusar `DISABLED`
-- —que significa «un administrador lo deshabilitó»— habría hecho que el mensaje
-- de login mintiera en uno de los dos casos.
--
-- ## El token no se guarda: se guarda su hash
--
-- Igual que la sesión (S-11). Quien pueda leer la tabla no puede usar los
-- tokens, y por eso una filtración de la base no es una filtración de cuentas.
--
-- ## El correo saliente es una tabla, y la aplicación NO la puede leer
--
-- No hay proveedor de correo contratado. En vez de fingir un envío, los mensajes
-- se encolan en `email_outbox` y ahí quedan, con el estado `SIN_PROVEEDOR` y el
-- motivo escrito.
--
-- **`aai_app` puede insertar y no puede leer.** Es la propiedad importante de
-- esta migración: el cuerpo de un mensaje de verificación **contiene el token**,
-- así que una ruta que pudiera leer la bandeja podría verificar la cuenta de
-- cualquiera. Escribir sí, leer no.
--
-- La consecuencia práctica es honesta y conviene decirla: **mientras no haya
-- proveedor de correo, un alta autoservicio no se completa sola.** El operador
-- lee la bandeja con `npm run correo:bandeja` y hace llegar el mensaje. No es un
-- flujo comercial; es el flujo que existe, dicho con esas palabras.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- El cuarto estado
-- ---------------------------------------------------------------------------

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('ACTIVE', 'PENDIENTE', 'SUSPENDED', 'DISABLED'));

COMMENT ON COLUMN users.status IS
  'ACTIVE: entra. PENDIENTE: se registró solo y todavía no confirmó su correo. '
  'SUSPENDED y DISABLED: un administrador lo cortó. Los cuatro son distintos '
  'porque el mensaje de login tiene que poder decir cuál es.';

-- ---------------------------------------------------------------------------
-- Verificaciones
-- ---------------------------------------------------------------------------

CREATE TABLE email_verifications (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES users (id),

  -- El hash, nunca el token. Quien lea esta tabla no puede usar lo que hay.
  token_hash   text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  proposito    text NOT NULL CHECK (proposito IN ('ALTA', 'RECUPERACION')),

  expira_el    timestamptz NOT NULL,
  consumido_el timestamptz,
  creado_el    timestamptz NOT NULL DEFAULT now(),
  creado_desde text,

  CONSTRAINT ev_vence_despues CHECK (expira_el > creado_el)
);

CREATE INDEX email_verifications_por_usuario
  ON email_verifications (user_id, creado_el DESC);

-- Un solo token vivo por usuario y propósito. Pedir el correo de nuevo
-- **invalida el anterior**: dos tokens vivos duplican la superficie por la que
-- se puede tomar una cuenta, y el segundo se pide justamente cuando el primero
-- pudo haber ido a parar a otro lado.
CREATE UNIQUE INDEX email_verifications_uno_vivo
  ON email_verifications (user_id, proposito)
  WHERE consumido_el IS NULL;

GRANT SELECT, INSERT, UPDATE ON email_verifications TO aai_app;

COMMENT ON TABLE email_verifications IS
  'Tokens de verificación, guardados por su hash. Uno vivo por usuario y '
  'propósito: pedir el correo de nuevo invalida el anterior.';

-- ---------------------------------------------------------------------------
-- Correo saliente
-- ---------------------------------------------------------------------------

CREATE TABLE email_outbox (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Nulo en el alta: todavía no hay empresa. No es un descuido — es que el
  -- registro pasa antes de que exista nada a lo que pertenecer.
  company_id   uuid REFERENCES companies (id),

  destinatario text NOT NULL CHECK (position('@' IN destinatario) > 1),
  asunto       text NOT NULL CHECK (length(btrim(asunto)) > 0),
  -- **Puede contener un token.** Por eso `aai_app` no tiene `SELECT` sobre esta
  -- tabla: una ruta que pudiera leer la bandeja podría verificar cualquier
  -- cuenta.
  cuerpo       text NOT NULL CHECK (length(btrim(cuerpo)) > 0),
  tipo         text NOT NULL CHECK (tipo IN ('VERIFICACION_DE_ALTA', 'RECUPERACION',
                                             'AVISO_DE_COBRANZA', 'AVISO')),

  estado       text NOT NULL DEFAULT 'PENDIENTE'
               CHECK (estado IN ('PENDIENTE', 'ENVIADO', 'SIN_PROVEEDOR', 'FALLIDO')),
  proveedor    text,
  referencia_externa text,
  detalle      text,
  intentos     integer NOT NULL DEFAULT 0 CHECK (intentos >= 0),

  creado_el    timestamptz NOT NULL DEFAULT now(),
  enviado_el   timestamptz,

  CONSTRAINT outbox_enviado_con_fecha
    CHECK (estado <> 'ENVIADO' OR (enviado_el IS NOT NULL AND proveedor IS NOT NULL)),
  -- Un fallo sin motivo no se puede diagnosticar, y el que lo mire dentro de
  -- una semana no va a tener otra fuente.
  CONSTRAINT outbox_fallo_con_detalle
    CHECK (estado NOT IN ('FALLIDO', 'SIN_PROVEEDOR') OR detalle IS NOT NULL)
);

CREATE INDEX email_outbox_pendientes ON email_outbox (creado_el)
  WHERE estado IN ('PENDIENTE', 'SIN_PROVEEDOR');

-- **Insertar sí, leer no.** Es lo más importante de esta migración. La 0009
-- concede `SELECT, INSERT, UPDATE` sobre toda tabla nueva, así que hay que
-- revocar lo que sobra: sin esto, cualquier ruta podría leer un token de
-- verificación de otra persona.
REVOKE ALL ON email_outbox FROM aai_app;
GRANT INSERT ON email_outbox TO aai_app;

COMMENT ON TABLE email_outbox IS
  'Correo saliente. La aplicación INSERTA y no LEE: el cuerpo de un mensaje de '
  'verificación contiene el token, y poder leer la bandeja sería poder '
  'verificar la cuenta de cualquiera. Lo lee el operador.';

-- ---------------------------------------------------------------------------
-- Acciones auditadas
-- ---------------------------------------------------------------------------
--
-- El alta autoservicio se registra sin empresa —todavía no hay—, así que no
-- entra en `audit_logs`, que es por empresa. Queda en `email_verifications` con
-- su fecha y su origen, que es donde alguien la va a buscar.
--
-- Lo que sí se audita es cuando ese usuario crea su empresa: ahí ya hay a quién
-- atribuirlo, y es la acción con consecuencias.

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('CREAR_EMPRESA_DESDE_ALTA', 'identidad', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
