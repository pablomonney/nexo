-- ============================================================================
-- 0061 — Listas de precios: por lista, por cliente y por cantidad
-- ============================================================================
--
-- `products.list_price` es **un** precio. Alcanza para proponer un renglón y no
-- alcanza para nada más: no hay precio mayorista, ni precio acordado con un
-- cliente, ni escala por cantidad. `PROJECT_STATUS.md` lo tenía anotado.
--
-- ## El eje de vigencia no es opcional
--
-- Una lista de precios **rige entre dos fechas**, y ese eje es la razón por la
-- que esta migración no es una tabla de precios y ya. El §6 —«no usar la norma
-- de hoy para una operación de ayer»— vale igual para los precios: reimprimir
-- un presupuesto de marzo con la lista de septiembre produce un documento que
-- dice algo que nunca se ofreció.
--
-- Es el mismo mecanismo que ya usan `norm_versions` y las alícuotas: se
-- pregunta *«¿qué regía el día de la operación?»*, nunca *«¿qué rige hoy?»*.
--
-- ## El precio resuelto dice de dónde salió
--
-- `resolver_precio()` no devuelve un número: devuelve el número **y su origen**
-- —qué lista, qué tramo de cantidad, o que salió del precio base del producto,
-- o que no hay precio—. Un precio sin procedencia es indefendible frente al
-- cliente que pregunta por qué le cobraron eso.
--
-- Y cuando no hay ninguno, la respuesta es `SIN_PRECIO`. No se estima, no se
-- arrastra el del mes pasado y no se interpola entre tramos.
--
-- ## Lo que esto NO hace
--
-- **No fija el precio de nada.** El renglón de un presupuesto sigue guardando
-- el precio que alguien escribió: la lista es una *sugerencia*, igual que la
-- cuenta contable sugerida de un producto (0048). Imponerla haría imposible la
-- excepción, que en una venta es la mitad del trabajo.
--
-- No modela descuentos por lista, ni promociones con condiciones, ni precios
-- por sucursal. Cada uno es una decisión de producto y ninguna está tomada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La lista
-- ---------------------------------------------------------------------------
CREATE TABLE price_lists (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),

  code           text NOT NULL CHECK (length(btrim(code)) > 0),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  currency       text NOT NULL DEFAULT 'ARS',

  -- El eje de vigencia. `hasta` nulo significa «sigue rigiendo», no «rigió
  -- para siempre»: la diferencia importa al preguntar por una fecha futura.
  vigente_desde  date NOT NULL,
  vigente_hasta  date,

  status         text NOT NULL DEFAULT 'ACTIVA'
                   CHECK (status IN ('ACTIVA', 'ARCHIVADA')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT pl_vigencia_coherente
    CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde),
  CONSTRAINT pl_code_unico UNIQUE (company_id, code),
  CONSTRAINT pl_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY pl_por_empresa ON price_lists
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON price_lists TO aai_app;

COMMENT ON TABLE price_lists IS
  'Una lista de precios con su período de vigencia. El precio de una operación '
  'se busca por la fecha de la operación, nunca por la de hoy (§6).';

-- ---------------------------------------------------------------------------
-- 2 · Los precios, con tramo de cantidad
-- ---------------------------------------------------------------------------
CREATE TABLE price_list_items (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  price_list_id  uuid NOT NULL,
  product_id     uuid NOT NULL,

  -- El tramo empieza acá y llega hasta el siguiente `cantidad_desde` del mismo
  -- producto. No se guarda un `hasta`: sería una segunda verdad que puede
  -- contradecir al `desde` de al lado, y ese conflicto no tendría solución.
  cantidad_desde numeric(18, 4) NOT NULL DEFAULT 1 CHECK (cantidad_desde > 0),
  precio         numeric(18, 4) NOT NULL CHECK (precio >= 0),

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pli_lista_fk
    FOREIGN KEY (company_id, price_list_id) REFERENCES price_lists (company_id, id)
    ON DELETE CASCADE,
  CONSTRAINT pli_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  CONSTRAINT pli_tramo_unico UNIQUE (company_id, price_list_id, product_id, cantidad_desde)
);

ALTER TABLE price_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_list_items FORCE ROW LEVEL SECURITY;
CREATE POLICY pli_por_empresa ON price_list_items
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON price_list_items TO aai_app;

CREATE INDEX pli_busqueda_idx
  ON price_list_items (company_id, product_id, price_list_id, cantidad_desde DESC);

COMMENT ON COLUMN price_list_items.cantidad_desde IS
  'Piso del tramo. El techo es el siguiente tramo del mismo producto y no se '
  'guarda: dos columnas que describen el mismo borde pueden contradecirse.';

-- ---------------------------------------------------------------------------
-- 3 · Qué lista le corresponde a cada cliente
-- ---------------------------------------------------------------------------
-- También con vigencia: un cliente puede pasar de minorista a mayorista, y un
-- presupuesto viejo tiene que poder reimprimirse con la lista que tenía
-- entonces.
CREATE TABLE party_price_lists (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id     uuid NOT NULL REFERENCES companies (id),
  party_id       uuid NOT NULL,
  price_list_id  uuid NOT NULL,

  desde          date NOT NULL,
  hasta          date,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL,

  CONSTRAINT ppl_vigencia_coherente CHECK (hasta IS NULL OR hasta >= desde),
  CONSTRAINT ppl_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT ppl_lista_fk
    FOREIGN KEY (company_id, price_list_id) REFERENCES price_lists (company_id, id)
);

ALTER TABLE party_price_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_price_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY ppl_por_empresa ON party_price_lists
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON party_price_lists TO aai_app;

CREATE INDEX ppl_tercero_idx ON party_price_lists (company_id, party_id, desde DESC);

-- Un tercero no puede tener dos listas asignadas el mismo día: el sistema no
-- tendría con qué elegir, y elegir por el orden de inserción es azar disfrazado.
CREATE FUNCTION assert_una_lista_por_fecha() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  superpuestas integer;
BEGIN
  SELECT count(*) INTO superpuestas
    FROM party_price_lists o
   WHERE o.company_id = NEW.company_id
     AND o.party_id = NEW.party_id
     AND o.id <> NEW.id
     -- Solapamiento de intervalos, tratando NULL como infinito.
     AND daterange(o.desde, o.hasta, '[]') && daterange(NEW.desde, NEW.hasta, '[]');

  IF superpuestas > 0 THEN
    RAISE EXCEPTION
      'E_PRECIO_LISTAS_SUPERPUESTAS: el tercero ya tiene otra lista asignada en ese período.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ppl_una_por_fecha
  AFTER INSERT OR UPDATE ON party_price_lists
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_una_lista_por_fecha();

-- ---------------------------------------------------------------------------
-- 4 · La resolución
-- ---------------------------------------------------------------------------
-- Devuelve el precio **y de dónde salió**. Las cuatro procedencias posibles son
-- exhaustivas y ninguna es «se estimó»:
--
--   LISTA_DEL_TERCERO  la lista asignada al cliente, vigente a esa fecha
--   PRECIO_BASE        `products.list_price`, cuando no hay lista aplicable
--   SIN_PRECIO         no hay ninguno, y no se inventa
--
-- `SECURITY INVOKER` es lo que corresponde: la función lee tablas con RLS y
-- tiene que verlas con los permisos de quien pregunta, no con los del dueño.
CREATE FUNCTION resolver_precio(
  p_company_id uuid,
  p_product_id uuid,
  p_party_id   uuid,
  p_fecha      date,
  p_cantidad   numeric DEFAULT 1
)
RETURNS TABLE (precio numeric, origen text, lista_codigo text, tramo_desde numeric)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT i.precio, 'LISTA_DEL_TERCERO'::text, l.code, i.cantidad_desde
    FROM party_price_lists a
    JOIN price_lists l
      ON l.id = a.price_list_id AND l.company_id = a.company_id
    JOIN price_list_items i
      ON i.price_list_id = l.id AND i.company_id = l.company_id
     AND i.product_id = p_product_id
   WHERE a.company_id = p_company_id
     AND a.party_id = p_party_id
     AND p_fecha BETWEEN a.desde AND coalesce(a.hasta, 'infinity'::date)
     AND l.status = 'ACTIVA'
     AND p_fecha BETWEEN l.vigente_desde AND coalesce(l.vigente_hasta, 'infinity'::date)
     -- El tramo que aplica es el mayor `cantidad_desde` que no supera a la
     -- cantidad pedida. Si ninguno lo cumple —todos empiezan más arriba— no hay
     -- precio por lista, y **no** se usa el más chico: sería inventar un tramo.
     AND i.cantidad_desde <= p_cantidad
   ORDER BY i.cantidad_desde DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.list_price, 'PRECIO_BASE'::text, NULL::text, NULL::numeric
    FROM products p
   WHERE p.id = p_product_id AND p.company_id = p_company_id
     AND p.list_price IS NOT NULL;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::numeric, 'SIN_PRECIO'::text, NULL::text, NULL::numeric;
END;
$$;

COMMENT ON FUNCTION resolver_precio(uuid, uuid, uuid, date, numeric) IS
  'El precio de un producto para un tercero a una fecha y una cantidad, con su '
  'procedencia. Nunca estima: si no hay precio, contesta SIN_PRECIO.';

-- ---------------------------------------------------------------------------
-- 5 · Las listas vigentes a una fecha, para poder mirarlas
-- ---------------------------------------------------------------------------
CREATE VIEW price_list_coverage WITH (security_invoker = true) AS
SELECT l.company_id,
       l.id                                   AS price_list_id,
       l.code,
       l.name,
       l.currency,
       l.vigente_desde,
       l.vigente_hasta,
       l.status,
       count(DISTINCT i.product_id)::int      AS productos,
       count(i.id)::int                       AS tramos,
       count(DISTINCT a.party_id)::int        AS terceros_asignados,
       -- Vigente **hoy**. Es una lectura de tablero, no la que usa
       -- `resolver_precio()`: esa siempre pregunta por la fecha de la operación.
       (current_date BETWEEN l.vigente_desde
                         AND coalesce(l.vigente_hasta, 'infinity'::date))
         AND l.status = 'ACTIVA'              AS vigente_hoy
  FROM price_lists l
  LEFT JOIN price_list_items i
    ON i.price_list_id = l.id AND i.company_id = l.company_id
  LEFT JOIN party_price_lists a
    ON a.price_list_id = l.id AND a.company_id = l.company_id
 GROUP BY l.company_id, l.id, l.code, l.name, l.currency,
          l.vigente_desde, l.vigente_hasta, l.status;

COMMENT ON VIEW price_list_coverage IS
  'Qué tiene cada lista y a cuántos terceros alcanza. `vigente_hoy` es para el '
  'tablero: la resolución de un precio siempre pregunta por la fecha de la '
  'operación, no por hoy.';
