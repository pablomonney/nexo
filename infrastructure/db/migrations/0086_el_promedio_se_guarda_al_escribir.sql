-- ============================================================================
-- 0086 — El promedio se calcula al escribir, y se sigue pudiendo rehacer
-- ============================================================================
--
-- ## El defecto, medido
--
-- `stock_ppp` recorre el libro de stock movimiento por movimiento con un CTE
-- recursivo, cada vez que alguien mira la valuación. Andaba perfecto con los
-- datos de los tests. Con datos de verdad, no:
--
--   200 productos × 250 movimientos = 50.000 movimientos de **una** empresa
--   `SELECT count(*) FROM stock_valuation` → 25.000 ms
--
-- Medido en `aai_test` con el rol `aai_app` y la empresa en contexto, que es
-- exactamente como consulta la API. Veinticinco segundos. Y de esa vista
-- cuelgan la valuación, el costo de mercadería vendida, el margen por producto
-- y las dos señales de margen: la pantalla de existencias de una empresa con
-- dos años de movimientos se queda colgada.
--
-- 50.000 movimientos no es un caso extremo. Un comercio con 200 artículos y
-- setenta movimientos por día llega en dos años.
--
-- ## Por qué se puede guardar sin crear una segunda verdad
--
-- La regla de esta base es derivar y no guardar: un valor guardado puede
-- contradecir a aquello de lo que salió. Acá **no puede**, y el motivo ya
-- estaba escrito en la 0054: el libro de stock es *append-only*. Un movimiento
-- no se edita (`stock_movements_inmutable`) y no se borra
-- (`stock_movements_no_delete`).
--
-- Si la historia no cambia, el promedio calculado sobre ella tampoco. Lo único
-- que puede alterarlo es un movimiento **nuevo**, y de eso se encarga el
-- trigger.
--
-- Nada de esto contradice la 0077: sigue prohibido que una persona escriba el
-- costo de una salida (`sm_costo_solo_en_entradas`). El costo lo calcula la
-- base, con la misma fórmula de siempre, y ahora lo calcula una vez en vez de
-- una por consulta.
--
-- ## Y se sigue pudiendo rehacer a mano
--
-- El recorrido recursivo no se borra: queda como `stock_ppp_derivado`. No lo
-- usa ninguna pantalla — existe para **comprobar la caché contra la
-- derivación**, que es lo que convierte un valor guardado en un valor
-- verificable. Es el mismo recurso que `ledger:verify` usa contra el Mayor.
--
-- ## El caso incómodo: cargar un movimiento con fecha vieja
--
-- El orden del libro es (fecha, alta, id). Un movimiento cargado hoy con fecha
-- del mes pasado se mete en el medio y deja mal todo lo que viene después.
-- Prohibirlo sería impedir cargar la recepción del lunes el martes, que es
-- trabajo real. Entonces el trigger mira si hay movimientos posteriores del
-- mismo producto: si no los hay —el caso normal— calcula un paso y listo; si
-- los hay, rehace la cadena de ese producto. Se paga solo cuando hace falta.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La empresa dentro de la clave, para poder colgarse del movimiento
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movements ADD CONSTRAINT sm_id_empresa UNIQUE (company_id, id);

-- El índice que acompaña al orden del libro: (fecha, alta, id) por producto. Lo
-- usa el trigger para encontrar el movimiento anterior sin recorrer la tabla.
CREATE INDEX sm_recorrido
  ON stock_movements (company_id, product_id, fecha, created_at, id);

-- ---------------------------------------------------------------------------
-- 2 · La caché del recorrido
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movement_ppp (
  company_id      uuid NOT NULL REFERENCES companies (id),
  movement_id     uuid NOT NULL,
  product_id      uuid NOT NULL,

  n               bigint NOT NULL CHECK (n >= 1),
  -- Existencia y costo acumulados **después** de este movimiento.
  cantidad        numeric NOT NULL,
  costo_total     numeric NOT NULL,
  -- Lo que se llevó esta salida, al promedio vigente al salir. NULL en las
  -- entradas y en las salidas que no se pudieron costear.
  costo_de_salida numeric,
  falta_costo     boolean NOT NULL,

  PRIMARY KEY (company_id, movement_id),

  CONSTRAINT smp_movimiento_fk
    FOREIGN KEY (company_id, movement_id)
    REFERENCES stock_movements (company_id, id) ON DELETE CASCADE,
  CONSTRAINT smp_producto_fk
    FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id)
);

ALTER TABLE stock_movement_ppp ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement_ppp FORCE ROW LEVEL SECURITY;
CREATE POLICY smp_por_empresa ON stock_movement_ppp
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- Solo lectura para la aplicación: esta tabla la escribe el trigger, nadie más.
-- Que la API pudiera escribirla haría exactamente lo que la 0077 evita — una
-- segunda verdad sobre el costo, capaz de contradecir al libro.
--
-- El `REVOKE` no es decorativo: esta base tiene un `ALTER DEFAULT PRIVILEGES`
-- que le da `INSERT, SELECT, UPDATE` a `aai_app` sobre cada tabla nueva. Sin
-- revocarlo, el comentario de arriba sería falso — la API podría escribir el
-- costo a mano. Lo encontró el primer intento de esta migración: el `GRANT
-- SELECT` no quitaba nada, y el único permiso que faltaba era `DELETE`, así
-- que el recálculo se caía con 500 y el resto pasaba sin ruido.
REVOKE INSERT, UPDATE, DELETE ON stock_movement_ppp FROM aai_app;
GRANT SELECT ON stock_movement_ppp TO aai_app;

CREATE INDEX smp_por_producto
  ON stock_movement_ppp (company_id, product_id, n DESC);

COMMENT ON TABLE stock_movement_ppp IS
  'El recorrido del promedio ponderado, calculado al escribir. No es una '
  'segunda verdad: el libro de stock es append-only, así que lo ya calculado '
  'no puede cambiar. Se comprueba contra stock_ppp_derivado.';

-- ---------------------------------------------------------------------------
-- 3 · Lo que ya estaba escrito, calculado una vez
-- ---------------------------------------------------------------------------
INSERT INTO stock_movement_ppp
  (company_id, movement_id, product_id, n, cantidad, costo_total,
   costo_de_salida, falta_costo)
SELECT company_id, movement_id, product_id, n, cantidad, costo_total,
       costo_de_salida, falta_costo
  FROM stock_ppp;

-- ---------------------------------------------------------------------------
-- 4 · La derivación se queda, para poder comprobar
-- ---------------------------------------------------------------------------
CREATE VIEW stock_ppp_derivado WITH (security_invoker = true) AS
WITH RECURSIVE paso AS (
  SELECT m.company_id,
         m.product_id,
         m.n,
         m.movement_id,
         m.fecha,
         m.tipo,
         m.delta,
         m.cantidad                                AS cantidad_movimiento,
         m.delta                                   AS cantidad,
         CASE WHEN m.delta > 0 AND m.costo_unitario IS NOT NULL
              THEN m.delta * m.costo_unitario ELSE 0 END
                                                   AS costo_total,
         NULL::numeric                             AS costo_de_salida,
         (m.delta > 0 AND m.costo_unitario IS NULL) AS falta_costo
    FROM stock_movements_ordenados m
   WHERE m.n = 1

  UNION ALL

  SELECT m.company_id,
         m.product_id,
         m.n,
         m.movement_id,
         m.fecha,
         m.tipo,
         m.delta,
         m.cantidad,
         p.cantidad + m.delta,
         CASE
           WHEN m.delta > 0 THEN
             p.costo_total
             + CASE WHEN m.costo_unitario IS NULL THEN 0 ELSE m.delta * m.costo_unitario END
           WHEN p.cantidad > 0 THEN
             p.costo_total + m.delta * (p.costo_total / p.cantidad)
           ELSE p.costo_total
         END,
         CASE WHEN m.delta < 0 AND p.cantidad > 0
              THEN round(-m.delta * (p.costo_total / p.cantidad), 2)
         END,
         p.falta_costo OR (m.delta > 0 AND m.costo_unitario IS NULL)
    FROM paso p
    JOIN stock_movements_ordenados m
      ON m.company_id = p.company_id
     AND m.product_id = p.product_id
     AND m.n = p.n + 1
)
SELECT * FROM paso;

COMMENT ON VIEW stock_ppp_derivado IS
  'El mismo recorrido, recalculado desde el libro. No lo usa ninguna pantalla: '
  'existe para comprobar la caché contra la derivación, que es lo que hace '
  'verificable a un valor guardado.';

GRANT SELECT ON stock_ppp_derivado TO aai_app;

-- ---------------------------------------------------------------------------
-- 5 · `stock_ppp` pasa a leer lo calculado
-- ---------------------------------------------------------------------------
-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions. Y el orden y el tipo de las columnas se respetan exactamente
-- —no se pueden cambiar—: de esta vista cuelgan otras cinco.
CREATE OR REPLACE VIEW stock_ppp WITH (security_invoker = true) AS
SELECT c.company_id,
       c.product_id,
       c.n,
       c.movement_id,
       m.fecha,
       m.tipo,
       CASE WHEN m.tipo IN ('ENTRADA', 'AJUSTE_POSITIVO') THEN m.cantidad
            ELSE -m.cantidad END                   AS delta,
       m.cantidad                                  AS cantidad_movimiento,
       c.cantidad,
       c.costo_total,
       c.costo_de_salida,
       c.falta_costo
  FROM stock_movement_ppp c
  JOIN stock_movements m
    ON m.id = c.movement_id AND m.company_id = c.company_id;

COMMENT ON VIEW stock_ppp IS
  'El recorrido del promedio ponderado móvil, movimiento por movimiento. Cada '
  'salida trae el costo con el que salió. Desde la 0086 se lee de lo calculado '
  'al escribir; la cuenta se puede rehacer con stock_ppp_derivado.';

-- ---------------------------------------------------------------------------
-- 6 · El paso, y la cadena entera cuando hace falta
-- ---------------------------------------------------------------------------
CREATE FUNCTION recalcular_ppp_de_producto(empresa uuid, producto uuid)
RETURNS void
-- SECURITY DEFINER porque `aai_app` no escribe esta tabla —y no debe—: la
-- escribe la base en nombre de quien la creó. El `search_path` fijo es
-- obligatorio en una función privilegiada: sin él, quien la invoque podría
-- anteponer un esquema propio y hacerle ejecutar otra cosa.
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM stock_movement_ppp c
   WHERE c.company_id = empresa AND c.product_id = producto;

  INSERT INTO stock_movement_ppp
    (company_id, movement_id, product_id, n, cantidad, costo_total,
     costo_de_salida, falta_costo)
  SELECT d.company_id, d.movement_id, d.product_id, d.n, d.cantidad, d.costo_total,
         d.costo_de_salida, d.falta_costo
    FROM stock_ppp_derivado d
   WHERE d.company_id = empresa AND d.product_id = producto;
END;
$$;

COMMENT ON FUNCTION recalcular_ppp_de_producto(uuid, uuid) IS
  'Rehace la cadena de un producto desde el libro. Se llama sola cuando entra '
  'un movimiento con fecha anterior a otro ya cargado.';

CREATE FUNCTION proyectar_ppp() RETURNS trigger
-- Por lo mismo que la anterior: escribe la caché, que la aplicación solo lee.
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql AS $$
DECLARE
  anterior record;
  delta    numeric;
  promedio numeric;
BEGIN
  -- Las transferencias no entran al recorrido: mueven de depósito, no cambian
  -- la existencia ni el costo de la empresa. Es lo mismo que hace
  -- `stock_movements_ordenados`.
  IF NEW.tipo IN ('TRANSFERENCIA_ENTRADA', 'TRANSFERENCIA_SALIDA') THEN
    RETURN NULL;
  END IF;

  delta := CASE WHEN NEW.tipo IN ('ENTRADA', 'AJUSTE_POSITIVO')
                THEN NEW.cantidad ELSE -NEW.cantidad END;

  -- El último eslabón de la cadena de este producto, con su lugar en el orden
  -- del libro. Una sola búsqueda contesta las dos preguntas: de dónde sigue la
  -- cuenta, y si el movimiento nuevo va después o se mete en el medio.
  --
  -- La primera versión hacía además un `EXISTS` sobre `stock_movements`
  -- buscando movimientos posteriores. Con la tabla casi vacía al planificar
  -- —una sesión que arranca cargando— el plan quedaba en recorrido secuencial
  -- y se repetía en cada alta: cargar cincuenta mil movimientos no terminaba
  -- nunca. Lo encontró `npm run bench:vistas`.
  SELECT c.n, c.cantidad, c.costo_total, c.falta_costo,
         m.fecha, m.created_at, m.id
    INTO anterior
    FROM stock_movement_ppp c
    JOIN stock_movements m ON m.id = c.movement_id AND m.company_id = c.company_id
   WHERE c.company_id = NEW.company_id AND c.product_id = NEW.product_id
   ORDER BY c.n DESC
   LIMIT 1;

  -- Se metió antes del último: la cadena de atrás cambia y se rehace entera.
  -- Es el caso raro, y es el único que cuesta.
  IF anterior IS NOT NULL
     AND (anterior.fecha, anterior.created_at, anterior.id)
         > (NEW.fecha, NEW.created_at, NEW.id) THEN
    PERFORM recalcular_ppp_de_producto(NEW.company_id, NEW.product_id);
    RETURN NULL;
  END IF;

  -- El primero del producto: no hay promedio previo, así que una salida
  -- inicial no se puede costear.
  IF anterior IS NULL THEN
    INSERT INTO stock_movement_ppp
      (company_id, movement_id, product_id, n, cantidad, costo_total,
       costo_de_salida, falta_costo)
    VALUES (
      NEW.company_id, NEW.id, NEW.product_id, 1, delta,
      CASE WHEN delta > 0 AND NEW.costo_unitario IS NOT NULL
           THEN delta * NEW.costo_unitario ELSE 0 END,
      NULL,
      delta > 0 AND NEW.costo_unitario IS NULL
    );
    RETURN NULL;
  END IF;

  -- Con existencia en cero o negativa no hay promedio: la salida no descuenta
  -- nada y no se costea. Es la misma regla que la derivación.
  promedio := CASE WHEN anterior.cantidad > 0
                   THEN anterior.costo_total / anterior.cantidad END;

  INSERT INTO stock_movement_ppp
    (company_id, movement_id, product_id, n, cantidad, costo_total,
     costo_de_salida, falta_costo)
  VALUES (
    NEW.company_id, NEW.id, NEW.product_id, anterior.n + 1,
    anterior.cantidad + delta,
    CASE
      WHEN delta > 0 THEN
        anterior.costo_total
        + CASE WHEN NEW.costo_unitario IS NULL THEN 0 ELSE delta * NEW.costo_unitario END
      WHEN promedio IS NOT NULL THEN anterior.costo_total + delta * promedio
      ELSE anterior.costo_total
    END,
    CASE WHEN delta < 0 AND promedio IS NOT NULL
         THEN round(-delta * promedio, 2) END,
    anterior.falta_costo OR (delta > 0 AND NEW.costo_unitario IS NULL)
  );

  RETURN NULL;
END;
$$;

CREATE TRIGGER sm_proyecta_ppp
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION proyectar_ppp();

COMMENT ON FUNCTION proyectar_ppp() IS
  'Calcula el paso del promedio al escribir el movimiento. Un paso cuando el '
  'movimiento es el último del producto —el caso normal—; la cadena entera '
  'cuando entra con fecha anterior a otro ya cargado.';
