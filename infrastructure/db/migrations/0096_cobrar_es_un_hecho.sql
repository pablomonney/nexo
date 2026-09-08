-- ============================================================================
-- 0096 — Cobrar es un hecho, no una intención
-- ============================================================================
--
-- Hasta acá NEXO sabía **qué plan tiene cada empresa** y **cuánto está usando**
-- (0067), y no sabía nada de plata: no había precio, ni período, ni documento,
-- ni cobro. La consecuencia práctica es que el sistema no se podía vender: se
-- podía dar de alta a un cliente y no se le podía cobrar.
--
-- Esta migración pone la cadena entera. Lo que **no** pone es una sola cifra.
--
-- ## Lo que no se decide acá
--
-- **Ningún precio.** `plan_prices` nace vacía. Cuánto sale cada plan es una
-- decisión comercial que no está tomada, y un número de ejemplo en una
-- migración se ve exactamente igual que uno decidido: aparecería en un tablero
-- de facturación y nadie sabría de dónde salió. Sin precio vigente una
-- suscripción no se factura, y el motor lo dice con esas palabras en vez de
-- cobrar cero.
--
-- **Ninguna política de cobranza.** `collection_policies` también nace vacía.
-- Cuántas veces reintentar y cuánta gracia dar depende de cuánto se cobra y de
-- a quién. Sin política declarada, un pago fallido **se registra y no dispara
-- nada**: eso no es «cero reintentos», es que nadie dijo cuántos. Es la misma
-- disciplina de los cupos de IA (0094) y de los topes de plan (0067).
--
-- ## Por qué no se llama `invoices`
--
-- Un documento de cobro de NEXO a una empresa **no es un comprobante fiscal**
-- todavía. Emitir factura electrónica exige CAE, y la emisión está fuera del
-- MVP y aislada por el lint (`packages/arca-emision` no es alcanzable desde
-- `apps/`). Llamar `invoice` a esto haría que un tablero lo sumara como
-- facturación emitida y que un contador lo buscara en el Libro IVA Ventas.
--
-- Se llama `billing_documents`, tiene `es_comprobante_fiscal boolean` en falso,
-- y las columnas de CAE existen vacías esperando el día que se emita de verdad.
-- Por el mismo motivo su numeración **admite huecos**: un comprobante fiscal no
-- puede tenerlos, y que esta numeración sí pueda es la señal de que no lo es.
--
-- ## Quién escribe y quién lee
--
-- La empresa **lee** lo que se le cobra: sus documentos, sus intentos de pago,
-- su estado. No escribe ninguno. No hay endpoint que cree un cargo, y no es una
-- omisión: el administrador de una empresa cliente no tiene por qué poder
-- emitirse a sí mismo un cargo ni marcarlo pagado.
--
-- Por eso `aai_app` recibe **solo `SELECT`** sobre estas tablas, con la política
-- de siempre. Quien emite es el ciclo de facturación, que corre como operador
-- de la instalación —igual que `norms:seed` o `catalog:seed`—, no como usuario
-- de ninguna empresa.
--
-- ## Lo que sigue bloqueado, y por qué igual se construye
--
-- No hay pasarela de pago contratada. `payment_intents` y `payment_events`
-- existen igual, con el proveedor como texto y la referencia externa opaca:
-- cuando haya una, se escribe el adaptador y ninguna fila se migra. Es la misma
-- forma que resolvió el proveedor de modelo (0093) y las referencias de
-- secretos (0095): la estructura del lado de acá, el vendor del otro lado de la
-- interfaz.
--
-- **Ninguna columna guarda datos de tarjeta.** No hay número, ni titular, ni
-- vencimiento, ni código. Lo único que se guarda de un medio de pago es el
-- identificador opaco que devuelve el proveedor, y los últimos cuatro dígitos
-- que ese mismo proveedor informa para que el cliente reconozca cuál usó.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Precios
-- ---------------------------------------------------------------------------

CREATE TABLE plan_prices (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  plan_id        uuid NOT NULL REFERENCES subscription_plans (id),

  periodicidad   text NOT NULL CHECK (periodicidad IN ('MENSUAL', 'ANUAL')),
  moneda         text NOT NULL CHECK (length(moneda) = 3),
  importe        numeric(18, 2) NOT NULL CHECK (importe >= 0),

  -- Si el importe ya lleva los impuestos adentro. **No tiene valor por
  -- defecto**: es parte de declarar el precio, y suponerlo mal cambia lo que se
  -- cobra en un 21 %.
  incluye_impuestos boolean NOT NULL,

  vigente_desde  date NOT NULL,
  vigente_hasta  date,

  declarado_por  text NOT NULL,
  declarado_el   timestamptz NOT NULL DEFAULT now(),
  motivo         text NOT NULL CHECK (length(btrim(motivo)) >= 5),

  CONSTRAINT plan_prices_vigencia CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde)
);

-- Un precio por plan, periodicidad, moneda y fecha de inicio. Dos vigentes a la
-- vez dejarían al motor eligiendo, y la elección sería por orden de inserción:
-- es decir, por azar.
CREATE UNIQUE INDEX plan_prices_vigente_idx
  ON plan_prices (plan_id, periodicidad, moneda, vigente_desde);

-- El precio es del proveedor, no de una empresa: sin RLS por inquilino, igual
-- que `ai_pricing`. Es público para quien pueda ver el catálogo de planes.
GRANT SELECT ON plan_prices TO aai_app;

COMMENT ON TABLE plan_prices IS
  'Precio de un plan por periodicidad y moneda, con vigencia. Nace vacía a '
  'propósito: sin precio vigente una suscripción no se factura, y eso se '
  'informa. Cobrar cero sería inventar una decisión comercial.';

-- ---------------------------------------------------------------------------
-- Política de cobranza
-- ---------------------------------------------------------------------------

-- Un `CHECK` no admite subconsultas, y las reglas de abajo miran un arreglo
-- entero. Se envuelven en funciones inmutables: es la forma que PostgreSQL deja,
-- y de paso les pone nombre a las dos preguntas que hace la restricción.
CREATE FUNCTION maximo_de_dias(dias integer[]) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
  $$ SELECT max(d) FROM unnest(dias) AS d $$;

CREATE FUNCTION minimo_de_dias(dias integer[]) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
  $$ SELECT min(d) FROM unnest(dias) AS d $$;

CREATE TABLE collection_policies (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),

  -- Días **desde el fallo original**, no desde el reintento anterior: con
  -- offsets relativos, agregar un reintento en el medio corre todos los
  -- siguientes y le cambia el calendario a quien ya estaba en curso.
  reintentos_en_dias integer[] NOT NULL,
  aviso_en_dias      integer NOT NULL CHECK (aviso_en_dias >= 0),
  dias_de_gracia     integer NOT NULL CHECK (dias_de_gracia >= 0),

  vigente_desde      date NOT NULL,
  vigente_hasta      date,
  declarado_por      text NOT NULL,
  declarado_el       timestamptz NOT NULL DEFAULT now(),
  motivo             text NOT NULL CHECK (length(btrim(motivo)) >= 5),

  CONSTRAINT collection_policies_vigencia
    CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
  -- Suspender antes del último reintento haría que el reintento corriera sobre
  -- una suscripción ya suspendida: cobraría bien y el cliente seguiría afuera.
  CONSTRAINT collection_policies_gracia_despues_del_ultimo_reintento
    CHECK (dias_de_gracia >= COALESCE(maximo_de_dias(reintentos_en_dias), 0)),
  CONSTRAINT collection_policies_aviso_antes_de_suspender
    CHECK (aviso_en_dias <= dias_de_gracia),
  CONSTRAINT collection_policies_sin_dias_negativos
    CHECK (COALESCE(minimo_de_dias(reintentos_en_dias), 0) >= 0)
);

CREATE UNIQUE INDEX collection_policies_una_vigente
  ON collection_policies (vigente_desde);

GRANT SELECT ON collection_policies TO aai_app;

COMMENT ON TABLE collection_policies IS
  'Qué pasa cuando un pago falla: reintentos, aviso y gracia. Nace vacía: sin '
  'política declarada un fallo se registra y no dispara nada, que no es lo '
  'mismo que cero reintentos.';

-- ---------------------------------------------------------------------------
-- Condiciones de la suscripción
-- ---------------------------------------------------------------------------
--
-- Se agregan a `company_subscriptions` en vez de crear una tabla nueva: son
-- atributos de la suscripción, no otra entidad, y separarlos obligaría a un
-- JOIN en cada lectura para reconstruir algo que siempre viaja junto.
--
-- Todas anulables, porque una suscripción en PRUEBA legítimamente no tiene
-- precio acordado todavía. Lo que no es legítimo es tener importe sin moneda o
-- moneda sin periodicidad: el `CHECK` exige que estén las cuatro o ninguna.

ALTER TABLE company_subscriptions
  ADD COLUMN periodicidad        text CHECK (periodicidad IN ('MENSUAL', 'ANUAL')),
  ADD COLUMN moneda              text CHECK (length(moneda) = 3),
  ADD COLUMN importe_acordado    numeric(18, 2) CHECK (importe_acordado >= 0),
  ADD COLUMN proxima_facturacion date,
  ADD COLUMN suspendida_el       date;

ALTER TABLE company_subscriptions
  ADD CONSTRAINT company_subscriptions_condiciones_completas CHECK (
    (periodicidad IS NULL AND moneda IS NULL AND importe_acordado IS NULL
       AND proxima_facturacion IS NULL)
    OR
    (periodicidad IS NOT NULL AND moneda IS NOT NULL AND importe_acordado IS NOT NULL
       AND proxima_facturacion IS NOT NULL)
  );

COMMENT ON COLUMN company_subscriptions.importe_acordado IS
  'Lo pactado con esta empresa, que puede diferir del precio de lista: un '
  'contrato enterprise es exactamente eso. Se congela al alta para que un '
  'cambio de lista no altere lo ya acordado.';

-- ---------------------------------------------------------------------------
-- Períodos
-- ---------------------------------------------------------------------------

CREATE TABLE billing_periods (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  subscription_id uuid NOT NULL REFERENCES company_subscriptions (id),

  -- Cerrado en los dos extremos: `hasta` está incluido. Es lo que se imprime en
  -- el documento, y «del 1 al 31 de enero» es lo que alguien espera leer.
  desde           date NOT NULL,
  hasta           date NOT NULL,

  estado          text NOT NULL DEFAULT 'ABIERTO'
                  CHECK (estado IN ('ABIERTO', 'FACTURADO', 'CANCELADO')),

  moneda          text NOT NULL CHECK (length(moneda) = 3),
  importe         numeric(18, 2) NOT NULL CHECK (importe >= 0),

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,

  CONSTRAINT billing_periods_orden CHECK (hasta >= desde),
  -- Dos períodos que arrancan el mismo día para la misma suscripción son el
  -- mismo período contado dos veces, y el cliente lo pagaría dos veces.
  CONSTRAINT billing_periods_unico UNIQUE (subscription_id, desde)
);

CREATE INDEX billing_periods_por_empresa ON billing_periods (company_id, desde DESC);

ALTER TABLE billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_periods FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_periods_lee_su_empresa ON billing_periods
  FOR SELECT TO aai_app
  USING (company_id = app_company_id());

GRANT SELECT ON billing_periods TO aai_app;

COMMENT ON TABLE billing_periods IS
  'El tramo de servicio que un documento cobra. La empresa lo lee; escribirlo '
  'es del ciclo de facturación, que no corre como usuario de ninguna empresa.';

-- ---------------------------------------------------------------------------
-- Documentos de cobro
-- ---------------------------------------------------------------------------

-- La numeración admite huecos, y eso es información: un comprobante fiscal no
-- puede tenerlos. Que esta pueda es la señal de que todavía no lo es.
CREATE SEQUENCE billing_documents_numero_seq;

CREATE TABLE billing_documents (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id      uuid NOT NULL REFERENCES companies (id),
  subscription_id uuid NOT NULL REFERENCES company_subscriptions (id),
  period_id       uuid REFERENCES billing_periods (id),

  numero          bigint NOT NULL DEFAULT nextval('billing_documents_numero_seq') UNIQUE,
  tipo            text NOT NULL CHECK (tipo IN ('CARGO', 'NOTA_DE_CREDITO')),

  moneda          text NOT NULL CHECK (length(moneda) = 3),
  -- Lo que se cobra. Los impuestos van aparte y **anulables**: `NULL` no es
  -- cero, es que no se discriminaron. Discriminarlos exige decidir la condición
  -- de IVA de NEXO, que es un dato de la empresa NEXO y no está cargado.
  importe_total   numeric(18, 2) NOT NULL CHECK (importe_total >= 0),
  impuestos       numeric(18, 2) CHECK (impuestos >= 0),

  estado          text NOT NULL DEFAULT 'BORRADOR'
                  CHECK (estado IN ('BORRADOR', 'EMITIDO', 'PAGADO', 'ANULADO', 'INCOBRABLE')),

  emitido_el      date,
  vence_el        date,
  pagado_el       date,

  -- Falso mientras no haya emisión fiscal habilitada. Con CAE pasa a verdadero,
  -- y recién ahí este documento entra en un Libro IVA.
  es_comprobante_fiscal boolean NOT NULL DEFAULT false,
  cae             text,
  cae_vence_el    date,

  motivo_anulacion text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,

  CONSTRAINT billing_documents_emitido_con_fecha
    CHECK (estado = 'BORRADOR' OR emitido_el IS NOT NULL),
  CONSTRAINT billing_documents_pagado_con_fecha
    CHECK (estado <> 'PAGADO' OR pagado_el IS NOT NULL),
  CONSTRAINT billing_documents_anulado_con_motivo
    CHECK (estado <> 'ANULADO' OR (motivo_anulacion IS NOT NULL AND length(btrim(motivo_anulacion)) >= 5)),
  -- Un comprobante fiscal sin CAE no es un comprobante fiscal. El `CHECK` lo
  -- impide en vez de confiar en que el emisor lo complete.
  CONSTRAINT billing_documents_fiscal_con_cae
    CHECK (NOT es_comprobante_fiscal OR (cae IS NOT NULL AND cae_vence_el IS NOT NULL)),
  CONSTRAINT billing_documents_vencimiento
    CHECK (vence_el IS NULL OR emitido_el IS NULL OR vence_el >= emitido_el)
);

CREATE INDEX billing_documents_por_empresa ON billing_documents (company_id, created_at DESC);
CREATE INDEX billing_documents_impagos ON billing_documents (vence_el)
  WHERE estado = 'EMITIDO';

ALTER TABLE billing_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_documents_lee_su_empresa ON billing_documents
  FOR SELECT TO aai_app
  USING (company_id = app_company_id());

GRANT SELECT ON billing_documents TO aai_app;

COMMENT ON TABLE billing_documents IS
  'Lo que NEXO le cobra a una empresa. NO es un comprobante fiscal: sin CAE, '
  'es_comprobante_fiscal queda en falso y no entra en ningún Libro IVA. Su '
  'numeración admite huecos, que es justamente lo que un comprobante no puede.';

CREATE TABLE billing_document_lines (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  document_id  uuid NOT NULL REFERENCES billing_documents (id) ON DELETE CASCADE,
  company_id   uuid NOT NULL REFERENCES companies (id),

  orden        integer NOT NULL CHECK (orden > 0),
  concepto     text NOT NULL CHECK (length(btrim(concepto)) > 0),

  -- El uso medido, congelado al emitir. **No se guarda en una tabla de uso
  -- aparte**: el uso se deriva de los hechos que ya están registrados —las
  -- respuestas de IA, los documentos, los comprobantes—, y un segundo número
  -- sobre el mismo hecho se desincroniza sin que nadie sepa cuál miente
  -- (ADR-022). Acá la cantidad es una **cita**: el documento cita el hecho tal
  -- como estaba al emitirse, que es lo que hace un documento (ADR-021).
  cantidad     numeric(18, 4) NOT NULL CHECK (cantidad >= 0),
  medido_hasta timestamptz,

  precio_unitario numeric(18, 4) NOT NULL CHECK (precio_unitario >= 0),
  importe         numeric(18, 2) NOT NULL,

  CONSTRAINT billing_document_lines_orden_unico UNIQUE (document_id, orden)
);

CREATE INDEX billing_document_lines_por_documento ON billing_document_lines (document_id, orden);

ALTER TABLE billing_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_document_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_document_lines_lee_su_empresa ON billing_document_lines
  FOR SELECT TO aai_app
  USING (company_id = app_company_id());

GRANT SELECT ON billing_document_lines TO aai_app;

COMMENT ON COLUMN billing_document_lines.cantidad IS
  'El uso medido al momento de emitir, congelado. Es una cita del hecho, no un '
  'segundo registro del hecho: el uso vive en las tablas que lo generan.';

-- ---------------------------------------------------------------------------
-- Intentos de pago
-- ---------------------------------------------------------------------------

CREATE TABLE payment_intents (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  document_id    uuid NOT NULL REFERENCES billing_documents (id),

  -- El nombre del proveedor como texto y no como enum: agregar uno no debería
  -- ser una migración, y el enum obligaría a que el dominio conozca la lista.
  proveedor      text NOT NULL CHECK (length(btrim(proveedor)) > 0),
  -- El identificador del proveedor. Opaco: conocerlo no da acceso a nada.
  referencia_externa text,

  moneda         text NOT NULL CHECK (length(moneda) = 3),
  importe        numeric(18, 2) NOT NULL CHECK (importe > 0),

  estado         text NOT NULL DEFAULT 'PENDIENTE'
                 CHECK (estado IN ('PENDIENTE', 'AUTORIZADO', 'PAGADO', 'FALLIDO',
                                   'REEMBOLSADO', 'CONTRACARGO')),

  -- La clave de idempotencia. Sin ella, un reintento de red cobra dos veces.
  -- Es UNIQUE y NOT NULL: no hay forma de crear un intento sin declararla.
  idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) >= 8),

  -- Lo único que se guarda de un medio de pago. **No hay número de tarjeta, ni
  -- titular, ni vencimiento, ni código de seguridad, y no hay columna donde
  -- ponerlos.**
  medio_referencia text,
  medio_ultimos4   text CHECK (medio_ultimos4 IS NULL OR medio_ultimos4 ~ '^[0-9]{4}$'),

  -- El motivo del fallo tal como lo informa el proveedor, para poder decirle al
  -- cliente qué pasó. Nunca lleva datos del medio de pago: lo que se guarda es
  -- el código y el texto del proveedor, y el adaptador los limpia antes.
  detalle_error  text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_intents_fallo_con_detalle
    CHECK (estado <> 'FALLIDO' OR detalle_error IS NOT NULL)
);

CREATE INDEX payment_intents_por_documento ON payment_intents (document_id, created_at DESC);
CREATE INDEX payment_intents_por_empresa ON payment_intents (company_id, created_at DESC);
CREATE UNIQUE INDEX payment_intents_referencia_por_proveedor
  ON payment_intents (proveedor, referencia_externa)
  WHERE referencia_externa IS NOT NULL;

ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY payment_intents_lee_su_empresa ON payment_intents
  FOR SELECT TO aai_app
  USING (company_id = app_company_id());

GRANT SELECT ON payment_intents TO aai_app;

COMMENT ON TABLE payment_intents IS
  'Un intento de cobro contra una pasarela. No guarda datos de tarjeta y no '
  'hay columna donde ponerlos: solo el identificador opaco del proveedor y los '
  'cuatro dígitos que el propio proveedor informa.';

-- ---------------------------------------------------------------------------
-- Eventos del proveedor
-- ---------------------------------------------------------------------------
--
-- Una pasarela reenvía: el mismo evento puede llegar dos veces, o desordenado.
-- Se guardan todos, se aplica el que corresponde, y el `UNIQUE` hace que
-- procesar dos veces el mismo sea imposible en vez de improbable.

CREATE TABLE payment_events (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  intent_id      uuid REFERENCES payment_intents (id),

  proveedor      text NOT NULL CHECK (length(btrim(proveedor)) > 0),
  evento_externo text NOT NULL CHECK (length(btrim(evento_externo)) > 0),
  tipo           text NOT NULL CHECK (length(btrim(tipo)) > 0),

  -- Cuándo pasó según el proveedor, y cuándo llegó acá. Los dos, porque la
  -- diferencia entre ellos es lo único que permite detectar un webhook que se
  -- atrasó tres días y explicar por qué se suspendió a alguien que había pagado.
  ocurrio_el     timestamptz,
  recibido_el    timestamptz NOT NULL DEFAULT now(),

  -- Qué se hizo con él. Un evento atrasado o repetido **se registra igual** y
  -- se marca: descartarlo sin dejar rastro borra la explicación de por qué el
  -- estado es el que es.
  resultado      text NOT NULL
                 CHECK (resultado IN ('APLICADO', 'REPETIDO', 'ATRASADO', 'DESCONOCIDO', 'CONFLICTO')),
  detalle        text,

  CONSTRAINT payment_events_unico UNIQUE (proveedor, evento_externo)
);

CREATE INDEX payment_events_por_intento ON payment_events (intent_id, recibido_el DESC);

-- Sin RLS: no tiene `company_id` y no lo lee ninguna empresa. Es el diario de
-- integración del operador. `aai_app` no lo toca.
COMMENT ON TABLE payment_events IS
  'Todo lo que informó la pasarela, incluido lo repetido y lo atrasado. Un '
  'evento descartado sin registrar borra la explicación de por qué el cobro '
  'quedó como quedó.';

-- ---------------------------------------------------------------------------
-- Pasos de cobranza ejecutados
-- ---------------------------------------------------------------------------

CREATE TABLE collection_steps (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id   uuid NOT NULL REFERENCES companies (id),
  document_id  uuid NOT NULL REFERENCES billing_documents (id),

  tipo         text NOT NULL CHECK (tipo IN ('REINTENTO', 'AVISO', 'SUSPENSION')),
  -- Solo en los reintentos. Es lo que permite no repetir uno ya hecho cuando el
  -- ciclo corre tarde y encuentra varios pasos vencidos a la vez.
  numero       integer CHECK (numero IS NULL OR numero > 0),

  programado_para date NOT NULL,
  ejecutado_el    timestamptz NOT NULL DEFAULT now(),
  resultado    text NOT NULL CHECK (resultado IN ('HECHO', 'FALLIDO', 'OMITIDO')),
  detalle      text,

  CONSTRAINT collection_steps_reintento_numerado
    CHECK ((tipo = 'REINTENTO') = (numero IS NOT NULL)),
  -- Ejecutar dos veces el mismo paso del mismo documento sería reintentar el
  -- cobro dos veces, o suspender a alguien que ya estaba suspendido.
  CONSTRAINT collection_steps_unico UNIQUE NULLS NOT DISTINCT (document_id, tipo, numero)
);

CREATE INDEX collection_steps_por_documento ON collection_steps (document_id, programado_para);

ALTER TABLE collection_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY collection_steps_lee_su_empresa ON collection_steps
  FOR SELECT TO aai_app
  USING (company_id = app_company_id());

GRANT SELECT ON collection_steps TO aai_app;

-- ---------------------------------------------------------------------------
-- Vista: el estado de cuenta de una empresa
-- ---------------------------------------------------------------------------

CREATE VIEW billing_account_status WITH (security_invoker = true) AS
SELECT
  d.company_id,
  d.id                AS document_id,
  d.numero,
  d.tipo,
  d.estado,
  d.moneda,
  d.importe_total,
  d.impuestos,
  d.emitido_el,
  d.vence_el,
  d.pagado_el,
  d.es_comprobante_fiscal,
  p.desde             AS periodo_desde,
  p.hasta             AS periodo_hasta,
  -- Días de atraso, o NULL si no está vencido. NULL no es cero: cero días de
  -- atraso significa que vence hoy.
  CASE
    WHEN d.estado = 'EMITIDO' AND d.vence_el IS NOT NULL AND d.vence_el < CURRENT_DATE
      THEN CURRENT_DATE - d.vence_el
  END                 AS dias_de_atraso,
  (SELECT count(*) FROM payment_intents i
    WHERE i.document_id = d.id AND i.estado = 'FALLIDO') AS intentos_fallidos
FROM billing_documents d
LEFT JOIN billing_periods p ON p.id = d.period_id;

GRANT SELECT ON billing_account_status TO aai_app;

COMMENT ON VIEW billing_account_status IS
  'Lo que una empresa necesita ver de su cuenta con NEXO. No trae la '
  'referencia externa del proveedor de pagos ni el detalle del medio.';

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
--
-- `billing:read` — ver qué se le cobra a la empresa. ADMINISTRADOR y CONTADOR:
-- el contador de un estudio necesita saber qué gasta su cliente en el sistema
-- para imputarlo, y es un dato de la empresa, no del proveedor.
--
-- AUDITOR queda **adentro**: su definición en SECURITY.md §3 es «solo lectura
-- total», y un gasto recurrente que el auditor no puede ver es un agujero en
-- esa afirmación.

INSERT INTO permissions (code, description) VALUES
  ('billing:read', 'Ver los cargos, pagos y estado de cuenta de la empresa con NEXO')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR')
  AND p.code = 'billing:read'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Acciones auditadas
-- ---------------------------------------------------------------------------
--
-- La 0091 exige que una acción esté registrada para poder escribirla. Las cinco
-- que produce el ciclo de facturación, más las dos declaraciones.
--
-- `SUSPENDER_POR_FALTA_DE_PAGO` exige motivo: cortarle el acceso a una empresa
-- es la consecuencia más grave del ciclo y tiene que poder explicarse sin
-- reconstruirla desde los intentos de pago.

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('DECLARAR_PRECIO_DE_PLAN',        'facturacion', true),
  ('DECLARAR_POLITICA_DE_COBRANZA',  'facturacion', true),
  ('EMITIR_DOCUMENTO_DE_COBRO',      'facturacion', false),
  ('ANULAR_DOCUMENTO_DE_COBRO',      'facturacion', true),
  ('REGISTRAR_COBRO',                'facturacion', false),
  ('SUSPENDER_POR_FALTA_DE_PAGO',    'facturacion', true),
  ('REACTIVAR_POR_PAGO',             'facturacion', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
