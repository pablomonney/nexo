-- ---------------------------------------------------------------------------
-- Una factura no se emite dos veces
-- ---------------------------------------------------------------------------
--
-- El candado de la emisión fiscal. **No habilita emitir**: `arca-emision` sigue
-- fuera del grafo de la aplicación. Lo que hace es dejar imposible el defecto
-- que B2.5.4 clasificó como bloqueante antes de que exista el camino que lo
-- produciría.
--
-- ## El defecto, dicho una vez
--
--     se manda el pedido → se corta → no se sabe si ARCA autorizó
--
-- Reintentar ahí duplica la factura. Y un comprobante autorizado de más no se
-- borra: se anula con una nota de crédito, que es otro comprobante, con su
-- numeración y su impacto contable.
--
-- ## Por qué la idempotencia no puede vivir solo en el código
--
-- Porque `if (!existe) crear` tiene una ventana entre la pregunta y la
-- escritura, y dos pedidos simultáneos la atraviesan los dos. La garantía tiene
-- que estar donde la concurrencia se resuelve de verdad: en un índice único.
--
-- ## Qué identifica a una intención fiscal
--
-- La **operación comercial**, no la petición HTTP. La misma venta pedida dos
-- veces es una sola intención de emitir; dos ventas son dos.
--
-- Por eso la clave es `(company_id, ambiente, origen_tipo, origen_id)` y no
-- lleva sello de tiempo, ni uuid nuevo por reintento, ni sesión: todos cambian
-- entre dos intentos de emitir **lo mismo**, que es justo cuando la clave tiene
-- que coincidir.
--
-- El ambiente entra en la clave a propósito: la misma venta emitida en
-- homologación y en producción son dos hechos distintos ante el organismo.
-- ---------------------------------------------------------------------------

CREATE TABLE fiscal_emissions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),

  -- ── La intención ────────────────────────────────────────────────────────
  ambiente       text NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  origen_tipo    text NOT NULL CHECK (origen_tipo ~ '^[A-Z_]{3,40}$'),
  origen_id      uuid NOT NULL,

  -- ── El comprobante que se pretende ──────────────────────────────────────
  punto_venta    integer NOT NULL CHECK (punto_venta BETWEEN 1 AND 99999),
  cbte_tipo      integer NOT NULL REFERENCES arca_comprobante_types (codigo),
  -- Nulo mientras no se haya reservado. Se reserva al pasar a LISTA.
  cbte_numero    bigint CHECK (cbte_numero IS NULL OR cbte_numero > 0),

  estado         text NOT NULL DEFAULT 'BORRADOR'
                 CHECK (estado IN ('BORRADOR', 'LISTA', 'EMITIENDO', 'AUTORIZADA',
                                   'RECHAZADA', 'DESCONOCIDA', 'RECONCILIANDO', 'ANULADA')),

  -- ── La evidencia de ARCA ────────────────────────────────────────────────
  -- Solo se escribe con una respuesta del organismo delante. NEXO no puede
  -- marcar AUTORIZADA porque la venta exista o porque el PDF se haya armado.
  cae            text CHECK (cae IS NULL OR cae ~ '^\d{8,}$'),
  cae_vencimiento date,

  -- ── Rastro ──────────────────────────────────────────────────────────────
  -- Cuántas veces se llamó. **No es un contador de reintentos**: es cuántas
  -- veces esta intención llegó a EMITIENDO, que para una emisión fiscal es un
  -- número que alguien va a querer mirar.
  llamadas       integer NOT NULL DEFAULT 0 CHECK (llamadas >= 0),
  ultimo_error   text,
  -- Qué código devolvió ARCA al rechazar. Sanitizado: sin material sensible.
  codigo_rechazo text,

  -- La consulta de reconciliación que resolvió la duda, si hubo una.
  reconciliado_con uuid REFERENCES arca_query_log (id),

  creado_el      timestamptz NOT NULL DEFAULT now(),
  creado_por     text NOT NULL,
  actualizado_el timestamptz NOT NULL DEFAULT now(),

  -- ── Lo que la base garantiza sobre los estados ──────────────────────────

  -- Autorizada exige las tres cosas. Una autorización sin CAE es una
  -- afirmación sin prueba.
  CONSTRAINT emision_autorizada_con_evidencia
    CHECK (estado <> 'AUTORIZADA'
           OR (cae IS NOT NULL AND cae_vencimiento IS NOT NULL AND cbte_numero IS NOT NULL)),

  -- Y al revés: no hay CAE sin autorización. Guardar un CAE en una intención
  -- rechazada dejaría un comprobante que parece válido en una consulta que no
  -- mire el estado.
  CONSTRAINT emision_cae_solo_si_autorizada
    CHECK (cae IS NULL OR estado = 'AUTORIZADA'),

  -- De LISTA en adelante hay número reservado. Sin número no se puede llamar:
  -- el número lo pone el emisor, no ARCA.
  CONSTRAINT emision_numero_desde_lista
    CHECK (estado IN ('BORRADOR', 'ANULADA') OR cbte_numero IS NOT NULL),

  -- Un rechazo sin motivo no se puede diagnosticar, y el que lo mire dentro de
  -- una semana no va a tener otra fuente.
  CONSTRAINT emision_rechazo_con_motivo
    CHECK (estado <> 'RECHAZADA' OR ultimo_error IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- El candado de idempotencia
-- ---------------------------------------------------------------------------
--
-- Es la garantía central. Dos procesos simultáneos que quieran emitir la misma
-- venta chocan acá, y el segundo recibe 23505 en vez de crear una segunda
-- intención.
--
-- Se excluye ANULADA: abandonar una intención y volver a empezar es legítimo, y
-- la anulada ya no compite por nada. Sin esa exclusión, un error corregible
-- dejaría la venta sin poder facturarse nunca.

CREATE UNIQUE INDEX fiscal_emissions_una_por_intencion
  ON fiscal_emissions (company_id, ambiente, origen_tipo, origen_id)
  WHERE estado <> 'ANULADA';

COMMENT ON INDEX fiscal_emissions_una_por_intencion IS
  'Una operación comercial produce UNA intención fiscal por ambiente. La '
  'idempotencia vive acá y no en un if: dos pedidos simultáneos atraviesan un '
  'if y chocan contra un índice.';

-- El otro candado, y es distinto: dos intenciones no pueden quedarse con el
-- mismo número de comprobante. Un número duplicado es una numeración que
-- describe algo que no pasó.
CREATE UNIQUE INDEX fiscal_emissions_un_numero
  ON fiscal_emissions (company_id, ambiente, punto_venta, cbte_tipo, cbte_numero)
  WHERE cbte_numero IS NOT NULL AND estado <> 'ANULADA';

CREATE INDEX fiscal_emissions_pendientes
  ON fiscal_emissions (company_id, estado)
  WHERE estado IN ('EMITIENDO', 'DESCONOCIDA', 'RECONCILIANDO');

-- ---------------------------------------------------------------------------
-- Aislamiento
-- ---------------------------------------------------------------------------

ALTER TABLE fiscal_emissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_emissions FORCE ROW LEVEL SECURITY;

CREATE POLICY fiscal_emissions_por_empresa ON fiscal_emissions
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON fiscal_emissions TO aai_app;
-- Una intención fiscal no se borra. Se anula, y queda.
REVOKE DELETE ON fiscal_emissions FROM aai_app;

COMMENT ON TABLE fiscal_emissions IS
  'La intención de emitir un comprobante, con su estado. Existe para que un '
  'timeout no se resuelva reintentando: DESCONOCIDA no tiene transición a '
  'EMITIENDO. El transporte sigue fuera del alcance de la aplicación.';

-- ---------------------------------------------------------------------------
-- La numeración
-- ---------------------------------------------------------------------------
--
-- ## Se reserva ANTES de llamar, y no hay alternativa
--
-- No es una preferencia de diseño: **el número lo pone el emisor**, no ARCA.
-- `FECAESolicitar` lleva el número en el pedido. Así que reservar después de
-- llamar es imposible.
--
-- ## La consecuencia: los huecos existen
--
-- Si ARCA rechaza, ese número se consumió. Si la llamada queda en
-- DESCONOCIDA, ese número no se puede reusar hasta saber qué pasó — y si
-- resultó autorizado, nunca.
--
-- **No se pretende que los huecos sean imposibles.** Pretenderlo llevaría a
-- reusar un número que ARCA pudo haber autorizado, que es exactamente la doble
-- emisión por otro camino. La numeración correlativa sin huecos es una
-- obligación ante el organismo que se resuelve **preguntándole a ARCA por dónde
-- va** (`FECompUltimoAutorizado`), no adivinando localmente.
--
-- ## Por qué un contador y no `MAX(numero) + 1`
--
-- `MAX + 1` bajo concurrencia da el mismo número dos veces: los dos lectores
-- ven el mismo máximo. El `UPDATE ... RETURNING` toma un candado de fila, y el
-- segundo espera. Es el mismo patrón que `next_commercial_number` (0050), que
-- ya resolvió esto para los documentos internos.

CREATE TABLE fiscal_counters (
  company_id  uuid NOT NULL REFERENCES companies (id),
  ambiente    text NOT NULL CHECK (ambiente IN ('homologacion', 'produccion')),
  punto_venta integer NOT NULL CHECK (punto_venta BETWEEN 1 AND 99999),
  cbte_tipo   integer NOT NULL REFERENCES arca_comprobante_types (codigo),
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (company_id, ambiente, punto_venta, cbte_tipo)
);

ALTER TABLE fiscal_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY fiscal_counters_por_empresa ON fiscal_counters
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON fiscal_counters TO aai_app;
REVOKE DELETE ON fiscal_counters FROM aai_app;

COMMENT ON TABLE fiscal_counters IS
  'Por dónde va la numeración de cada punto de venta y tipo. Se sincroniza con '
  'FECompUltimoAutorizado antes de emitir: la fuente de verdad es ARCA, esto '
  'es la reserva local que evita que dos procesos tomen el mismo número.';

/**
 * Reserva el número siguiente y lo deja escrito en la intención.
 *
 * Hace las dos cosas en la misma transacción a propósito: un número reservado
 * que no quedó asociado a ninguna intención es un hueco que nadie puede
 * explicar después.
 */
CREATE OR REPLACE FUNCTION reservar_numero_fiscal(
  p_emision_id uuid
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_emision  fiscal_emissions%ROWTYPE;
  v_numero   bigint;
BEGIN
  -- La fila de la intención, bloqueada: dos llamadas concurrentes sobre la
  -- misma intención se serializan acá.
  SELECT * INTO v_emision FROM fiscal_emissions WHERE id = p_emision_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe la intención fiscal %', p_emision_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_emision.cbte_numero IS NOT NULL THEN
    -- Ya tenía número. Devolverlo es lo idempotente: reservar dos veces por un
    -- reintento dejaría un número quemado en cada intento.
    RETURN v_emision.cbte_numero;
  END IF;

  IF v_emision.estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Una intención en % no puede reservar número', v_emision.estado
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO fiscal_counters (company_id, ambiente, punto_venta, cbte_tipo, last_number)
  VALUES (v_emision.company_id, v_emision.ambiente, v_emision.punto_venta,
          v_emision.cbte_tipo, 0)
  ON CONFLICT DO NOTHING;

  UPDATE fiscal_counters
     SET last_number = last_number + 1
   WHERE company_id = v_emision.company_id
     AND ambiente = v_emision.ambiente
     AND punto_venta = v_emision.punto_venta
     AND cbte_tipo = v_emision.cbte_tipo
  RETURNING last_number INTO v_numero;

  UPDATE fiscal_emissions
     SET cbte_numero = v_numero, estado = 'LISTA', actualizado_el = now()
   WHERE id = p_emision_id;

  RETURN v_numero;
END;
$$;

COMMENT ON FUNCTION reservar_numero_fiscal IS
  'Reserva el número siguiente y pasa la intención a LISTA, en una transacción. '
  'Idempotente: si ya tenía número lo devuelve sin consumir otro.';

-- ---------------------------------------------------------------------------
-- Las transiciones, garantizadas por la base
-- ---------------------------------------------------------------------------
--
-- La máquina de estados vive en `packages/tax-engine/src/emision.ts`. Este
-- trigger es la segunda mitad: sin él, la regla se sostiene en que todo el
-- mundo pase por esa función, y una consulta suelta la saltearía.
--
-- **La transición que no existe es la que importa:** DESCONOCIDA → EMITIENDO.
-- No está en la lista, así que la base la rechaza.

CREATE OR REPLACE FUNCTION assert_transicion_de_emision() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_permitidas text[];
BEGIN
  -- El número va **antes** del retorno temprano, y no es un detalle de orden.
  --
  -- La primera versión comprobaba las transiciones primero y salía enseguida
  -- cuando el estado no cambiaba. Con eso, un `UPDATE ... SET cbte_numero = 999`
  -- sin tocar el estado pasaba entero: justo la consulta suelta contra la que
  -- este trigger existe. Lo encontró S-42 al correrse por primera vez.
  --
  -- Cambiar el número dejaría la numeración de la empresa describiendo un
  -- comprobante distinto del que se le pidió a ARCA.
  IF OLD.cbte_numero IS NOT NULL AND NEW.cbte_numero IS DISTINCT FROM OLD.cbte_numero THEN
    RAISE EXCEPTION 'El número de un comprobante reservado no se cambia'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lo mismo con el ambiente y con el origen: son parte de la identidad de la
  -- intención. Moverlos convertiría esta fila en otra intención distinta,
  -- esquivando el índice único que impide el duplicado.
  IF NEW.ambiente <> OLD.ambiente
     OR NEW.origen_tipo <> OLD.origen_tipo
     OR NEW.origen_id <> OLD.origen_id
     OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'La identidad de una intención fiscal no se cambia'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.estado = OLD.estado THEN
    RETURN NEW;
  END IF;

  v_permitidas := CASE OLD.estado
    WHEN 'BORRADOR'      THEN ARRAY['LISTA', 'ANULADA']
    WHEN 'LISTA'         THEN ARRAY['EMITIENDO', 'ANULADA']
    WHEN 'EMITIENDO'     THEN ARRAY['AUTORIZADA', 'RECHAZADA', 'DESCONOCIDA']
    -- Terminales. Un comprobante autorizado se anula con una nota de crédito,
    -- que es otra intención; no se re-emite.
    WHEN 'AUTORIZADA'    THEN ARRAY[]::text[]
    WHEN 'RECHAZADA'     THEN ARRAY[]::text[]
    -- Acá está el candado de toda la fase: de la duda solo se sale
    -- averiguando, nunca emitiendo de nuevo.
    WHEN 'DESCONOCIDA'   THEN ARRAY['RECONCILIANDO']
    WHEN 'RECONCILIANDO' THEN ARRAY['AUTORIZADA', 'RECHAZADA', 'DESCONOCIDA']
    WHEN 'ANULADA'       THEN ARRAY[]::text[]
  END;

  IF NOT (NEW.estado = ANY (v_permitidas)) THEN
    RAISE EXCEPTION
      'Transición de emisión fiscal no permitida: % → %. Desde % solo se puede ir a %',
      OLD.estado, NEW.estado, OLD.estado,
      coalesce(array_to_string(v_permitidas, ', '), 'ningún estado')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER fiscal_emissions_transiciones
  BEFORE UPDATE ON fiscal_emissions
  FOR EACH ROW EXECUTE FUNCTION assert_transicion_de_emision();

-- ---------------------------------------------------------------------------
-- Bitácora
-- ---------------------------------------------------------------------------

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('DECLARAR_INTENCION_FISCAL', 'fiscal', false),
  ('RESERVAR_NUMERO_FISCAL',    'fiscal', false),
  ('EMITIR_COMPROBANTE',        'fiscal', false),
  ('RECONCILIAR_EMISION',       'fiscal', true),
  ('ANULAR_INTENCION_FISCAL',   'fiscal', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;

-- ---------------------------------------------------------------------------
-- Lo que queda pendiente, a la vista
-- ---------------------------------------------------------------------------
--
-- Una intención en DESCONOCIDA es trabajo que alguien tiene que resolver, y no
-- se resuelve solo. Va a la bandeja con `bloquea = true`: mientras no se sepa
-- qué pasó, esa venta no se puede facturar de nuevo.

CREATE VIEW work_queue_emision WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id, q.*
  FROM (
SELECT e.company_id,
       'EMISION_SIN_RESOLVER'::text                 AS rama,
       'REQUIERE_FUENTE_EXTERNA'::text              AS categoria,
       'fiscal_emissions'::text                     AS entidad,
       e.id                                         AS entity_id,
       e.estado                                     AS estado,
       'La emisión del comprobante ' || e.punto_venta || '-' ||
         coalesce(e.cbte_numero::text, 'sin número') ||
         ' quedó sin saber si ARCA la autorizó. Hay que reconciliar contra el ' ||
         'organismo antes de volver a facturar esta operación'
                                                    AS motivo,
       true                                         AS bloquea,
       ARRAY['consulta de reconciliación contra ARCA']::text[] AS evidencia_faltante,
       'SISTEMA'::text                              AS origen,
       'ACCIONABLE'::text                           AS disponibilidad,
       e.creado_el                                  AS creado_en,
       e.actualizado_el                             AS actualizado_en,
       NULL::date                                   AS fecha_limite,
       '/fiscal-emissions/' || e.id                 AS traza_ref
  FROM fiscal_emissions e
 WHERE e.estado IN ('DESCONOCIDA', 'RECONCILIANDO')
) q;

GRANT SELECT ON work_queue_emision TO aai_app;

CREATE OR REPLACE VIEW work_queue WITH (security_invoker = true) AS
SELECT * FROM work_queue_nucleo
UNION ALL SELECT * FROM work_queue_comercial
UNION ALL SELECT * FROM work_queue_compras
UNION ALL SELECT * FROM work_queue_cobranzas
UNION ALL SELECT * FROM work_queue_stock
UNION ALL SELECT * FROM work_queue_activos
UNION ALL SELECT * FROM work_queue_integraciones
UNION ALL SELECT * FROM work_queue_senales
UNION ALL SELECT * FROM work_queue_precios
UNION ALL SELECT * FROM work_queue_cheques
UNION ALL SELECT * FROM work_queue_lotes
UNION ALL SELECT * FROM work_queue_caja
UNION ALL SELECT * FROM work_queue_crm
UNION ALL SELECT * FROM work_queue_proyectos
UNION ALL SELECT * FROM work_queue_comisiones
UNION ALL SELECT * FROM work_queue_sucursales
UNION ALL SELECT * FROM work_queue_suscripcion
UNION ALL SELECT * FROM work_queue_mapeo
UNION ALL SELECT * FROM work_queue_arranque
UNION ALL SELECT * FROM work_queue_valuacion
UNION ALL SELECT * FROM work_queue_pagos
UNION ALL SELECT * FROM work_queue_correcciones
UNION ALL SELECT * FROM work_queue_solicitudes
UNION ALL SELECT * FROM work_queue_arca
UNION ALL SELECT * FROM work_queue_emision;
