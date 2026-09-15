-- ---------------------------------------------------------------------------
-- Una notificación no mueve plata
-- ---------------------------------------------------------------------------
--
-- Dos cosas, y la segunda corrige a la migración anterior.
--
-- ## 1 · Por dónde entra un webhook, y por qué no entra directo al cobro
--
-- La tentación es escribir un endpoint que reciba la notificación de la pasarela
-- y actualice el cobro ahí mismo. **No se puede, y es una buena noticia.**
--
-- `aai_app` —el rol con el que corre la API— tiene `SELECT` y nada más sobre
-- `payment_intents`, y sobre `payment_events` no tiene ni eso (0096, S-29). Esa
-- restricción no es un obstáculo administrativo: es lo que hace imposible que
-- el administrador de una empresa cliente se marque un cargo como pagado. Darle
-- `INSERT` para que el webhook funcione se lo daría también a **todas las demás
-- rutas**, y con eso cualquier defecto en cualquier endpoint pasaría a poder
-- escribir en la contabilidad de cobros de NEXO.
--
-- Así que el webhook hace lo mismo que hace el alta con el correo: **deja la
-- notificación en una bandeja y no aplica nada**. Quien la aplica es un proceso
-- del operador, que conecta con otros permisos, y que antes de aplicar nada
-- **le pregunta a la pasarela qué pasó de verdad**.
--
--     pasarela → POST /webhooks/pagos → payment_webhook_inbox   (la API, aai_app)
--     bandeja  → consultar a la pasarela → procesarEventoDePago (el operador)
--
-- El rodeo compra tres cosas que el camino directo no da:
--
--   · una notificación **nunca** puede mover un cobro por sí misma. Lo que lo
--     mueve es la respuesta de la pasarela a una pregunta que hizo NEXO con su
--     propia credencial;
--   · el invariante de la 0096 queda intacto;
--   · queda registro de lo que llegó, aunque después resulte que no
--     correspondía a nada.
--
-- El precio es la latencia: un cobro se registra cuando corre el proceso, no en
-- el instante del webhook. Para una suscripción mensual, eso es irrelevante.
--
-- ## Solo entra lo que viene firmado
--
-- La ruta es pública —no puede no serlo— así que **cualquiera puede llamarla**.
-- Por eso se inserta únicamente lo que pasó la verificación de firma: sin ese
-- filtro, la tabla sería un buzón abierto que se llena desde internet.
--
-- Lo que no verifica no se guarda. Se rechaza y no deja fila: guardar los
-- intentos fallidos convertiría el control en el propio vector.
--
-- ## 2 · Corrección de la 0118
--
-- La 0118 declaró `payment_plan_map` como «solo lectura para la aplicación» y
-- escribió `GRANT SELECT`. No alcanzaba: la 0009 deja
-- `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE`, así que toda tabla
-- nueva **nace escribible** y un `GRANT SELECT` no quita nada. El comentario
-- decía una cosa y la base hacía otra.
--
-- Es exactamente el defecto que S-29 existe para atrapar, y no lo atrapó por un
-- motivo que vale la pena anotar: **ese control comprueba lo declarado, y nadie
-- había declarado esta tabla**. Se corrigen las dos mitades — el `REVOKE` acá,
-- la declaración en `tests/security/solo-lectura-de-verdad.test.ts`— porque
-- arreglar solo la base dejaría el mismo agujero abierto para la próxima.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1 · La corrección
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE ON payment_plan_map FROM aai_app;
GRANT SELECT ON payment_plan_map TO aai_app;

-- ---------------------------------------------------------------------------
-- 2 · La bandeja de entrada
-- ---------------------------------------------------------------------------

CREATE TABLE payment_webhook_inbox (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),

  proveedor      text NOT NULL CHECK (length(btrim(proveedor)) > 0),

  -- Contra qué cuenta llegó. Una notificación de la cuenta de prueba aplicada
  -- con las credenciales de producción consultaría un recurso que allá no
  -- existe, y el 404 se leería como «ese cobro no existe».
  ambiente       text NOT NULL CHECK (ambiente IN ('sandbox', 'production')),

  -- El identificador de la **notificación**, no el del recurso. Es lo que hace
  -- que reprocesar sea imposible en vez de improbable: las pasarelas reenvían.
  evento_externo text NOT NULL CHECK (length(btrim(evento_externo)) > 0),

  -- De qué habla: un pago, una suscripción. Se guarda tal como vino, en
  -- minúsculas y sin interpretar: el vocabulario es del proveedor.
  tipo           text NOT NULL CHECK (length(btrim(tipo)) > 0),
  accion         text,

  -- **Lo único que se usa de verdad.** Con esto se le pregunta a la pasarela
  -- qué pasó. El resto del cuerpo de la notificación no se guarda: no aporta
  -- nada que no se pueda preguntar, y guardar un cuerpo ajeno entero es meter
  -- en la base lo que un tercero haya decidido mandar.
  recurso_id     text NOT NULL CHECK (length(btrim(recurso_id)) > 0),

  estado         text NOT NULL DEFAULT 'PENDIENTE'
                 CHECK (estado IN ('PENDIENTE', 'APLICADO', 'SIN_EFECTO', 'FALLIDO')),

  -- Qué dijo el proceso que la aplicó. `SIN_EFECTO` cubre los desenlaces
  -- legítimos que no cambian nada —repetido, atrasado, desconocido— y `FALLIDO`
  -- los que hay que mirar.
  detalle        text,
  intentos       integer NOT NULL DEFAULT 0 CHECK (intentos >= 0),

  recibido_el    timestamptz NOT NULL DEFAULT now(),
  procesado_el   timestamptz,

  CONSTRAINT inbox_procesado_con_fecha
    CHECK (estado = 'PENDIENTE' OR procesado_el IS NOT NULL),
  -- Un fallo sin motivo no se puede diagnosticar, y el que lo mire dentro de una
  -- semana no va a tener otra fuente.
  CONSTRAINT inbox_fallo_con_detalle
    CHECK (estado <> 'FALLIDO' OR detalle IS NOT NULL)
);

-- La misma notificación no se guarda dos veces. Con `ON CONFLICT DO NOTHING` en
-- la ruta, un reenvío contesta 200 sin efecto — que es lo que una pasarela
-- necesita para dejar de reenviar.
CREATE UNIQUE INDEX payment_webhook_inbox_unico
  ON payment_webhook_inbox (proveedor, evento_externo);

CREATE INDEX payment_webhook_inbox_pendientes
  ON payment_webhook_inbox (recibido_el)
  WHERE estado = 'PENDIENTE';

-- **Insertar sí, leer no.** Igual que `email_outbox` (0103), y por un motivo
-- parecido: una ruta que pudiera leer la bandeja podría enumerar los
-- identificadores de cobro de todas las empresas. Insertar es todo lo que el
-- webhook necesita.
--
-- El `REVOKE ALL` primero no es ceremonia: sin él, la 0009 ya concedió
-- `SELECT, INSERT, UPDATE` y el `GRANT` de abajo no quitaría nada. Es el mismo
-- error que esta migración corrige más arriba.
REVOKE ALL ON payment_webhook_inbox FROM aai_app;
GRANT INSERT ON payment_webhook_inbox TO aai_app;

COMMENT ON TABLE payment_webhook_inbox IS
  'Notificaciones de la pasarela, ya verificadas. La aplicación INSERTA y no '
  'LEE. Una fila acá no mueve ningún cobro: la aplica el operador, y antes de '
  'aplicarla le pregunta a la pasarela qué pasó de verdad.';

COMMENT ON COLUMN payment_webhook_inbox.recurso_id IS
  'Sobre qué recurso avisa la pasarela. Es lo que se le pregunta después: el '
  'cuerpo de la notificación no se cree, se usa para saber qué consultar.';
