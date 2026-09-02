-- ============================================================================
-- 0078 — El costo entra por donde entra la mercadería
-- ============================================================================
--
-- La 0077 dejó `stock_movements.costo_unitario` y no dejó cómo llenarlo para
-- las entradas, que es el caso que importa: las entradas al stock **no las
-- escribe ninguna ruta**, las escribe el trigger que proyecta una recepción
-- confirmada (0054). Una columna que solo se puede llenar por SQL directo es
-- una columna que en la práctica queda vacía.
--
-- ## Dónde va el costo
--
-- En el renglón de la recepción. Es el lugar donde alguien ya está mirando la
-- mercadería y el remito, y es el único momento en que el dato está a mano. El
-- trigger lo copia al movimiento.
--
-- ## Por qué no se toma de la factura de compra
--
-- Sería lo ideal y hoy no alcanza: la factura puede llegar después de la
-- mercadería, puede cubrir varias recepciones y puede traer conceptos que no
-- son costo del producto —flete, percepciones—. Derivarlo de ahí exige decidir
-- cómo se prorratea, y eso es una política contable que nadie declaró.
--
-- Mientras tanto se declara, y si no se declaró la valuación no se afirma. La
-- derivación desde la factura queda anotada como el paso siguiente.
--
-- ## Es opcional, y su ausencia se ve
--
-- Una recepción sin costo declarado sigue entrando: la mercadería llegó, y
-- negarse a registrarla porque falta un dato contable dejaría el stock
-- mintiendo. Lo que pasa es que el producto queda sin valuar, y la bandeja lo
-- dice desde la 0077.
-- ============================================================================

ALTER TABLE goods_receipt_lines ADD COLUMN costo_unitario numeric(18, 4)
  CHECK (costo_unitario IS NULL OR costo_unitario >= 0);

COMMENT ON COLUMN goods_receipt_lines.costo_unitario IS
  'Costo unitario declarado al recibir. Opcional: la mercadería entra igual. '
  'Sin él, la valuación de ese producto no se afirma.';

-- El trigger de la 0054, con el costo. Se reescribe entero —no hay `ALTER
-- FUNCTION ... ADD COLUMN`— y el resto queda idéntico a propósito: lo único
-- que cambia es que el `INSERT` ahora lleva `costo_unitario`.
CREATE OR REPLACE FUNCTION proyectar_recepcion_a_stock() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  con_stock integer;
BEGIN
  IF NEW.status <> 'CONFIRMADA' OR OLD.status = 'CONFIRMADA' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO con_stock
    FROM goods_receipt_lines l
    JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE l.receipt_id = NEW.id AND p.tracks_stock;

  IF con_stock = 0 THEN RETURN NEW; END IF;

  -- El depósito es obligatorio recién acá y no en el alta: al crear el borrador
  -- puede no saberse todavía dónde se va a descargar.
  IF NEW.warehouse_id IS NULL THEN
    RAISE EXCEPTION
      'E_STOCK_SIN_DEPOSITO: la recepción tiene productos con stock y no dice en qué depósito entraron.'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO stock_movements
    (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
     origen_tipo, origen_id, costo_unitario, created_by)
  SELECT NEW.company_id, l.product_id, NEW.warehouse_id, 'ENTRADA', l.cantidad,
         NEW.received_at, 'RECEPCION', NEW.id, l.costo_unitario,
         coalesce(nullif(current_setting('app.actor_id', true), ''), current_user)
    FROM goods_receipt_lines l
    JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
   WHERE l.receipt_id = NEW.id AND p.tracks_stock;

  RETURN NEW;
END;
$$;

-- La reversión de una recepción anulada escribe un AJUSTE_NEGATIVO, y ese no
-- lleva costo: su costo es el promedio del momento, igual que cualquier salida.
-- El CHECK de la 0077 ya lo impide; queda dicho para que nadie lo agregue
-- creyendo que falta.
