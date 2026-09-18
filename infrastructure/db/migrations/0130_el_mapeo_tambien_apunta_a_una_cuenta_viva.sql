-- ---------------------------------------------------------------------------
-- El mapeo también apunta a una cuenta viva
-- ---------------------------------------------------------------------------
--
-- La 0129 cerró el agujero de `status` en los cuatro objetos que declaran una
-- cuenta: productos, bienes de uso, cajas y bancos. Faltaba el quinto, que es el
-- que más asientos toca: `company_account_map`.
--
-- `assert_cuenta_del_rol` (0074, ampliada en la 0079) comprueba tipo e
-- imputabilidad y no mira el estado. Una empresa podía declarar
--
--     VENTAS → 4.1.01
--
-- y después archivar `4.1.01`. La fila del mapeo queda intacta, el disparador no
-- vuelve a correr —lo que cambió es `accounts`, no el mapeo— y la propuesta de
-- asiento seguía ofreciendo una cuenta archivada. El renglón no llegaba al
-- Mayor, porque `validate.ts` lo rechaza con `E_ACCOUNT_NOT_POSTABLE`, pero el
-- error aparecía recién al cargar el asiento y sin decir de dónde venía.
--
-- ## Qué comprueba cada capa, ahora que están las dos
--
--     al declarar el mapeo    este disparador: tipo, imputabilidad y estado
--     al leer el mapeo        `leerMapeo`: imputabilidad y estado otra vez
--     al registrar            `validate.ts`: E_ACCOUNT_NOT_POSTABLE
--
-- No es la misma comprobación tres veces: son tres momentos distintos. El
-- disparador no puede ver el futuro —archivar es un `UPDATE` sobre `accounts`—
-- y por eso el lector vuelve a mirar. Esto cierra el caso de declarar el mapeo
-- contra una cuenta que ya estaba muerta.
--
-- ## Y de paso, el `SELECT` que no encuentra
--
-- El disparador original no comprobaba `FOUND`. Sin filas, las variables quedan
-- en NULL, y en SQL `NOT NULL` es NULL: ningún `IF` dispara y la fila pasa. Hoy
-- la clave foránea compuesta de la 0074 hace que ese caso no se pueda alcanzar,
-- pero la comprobación es de una línea y no depende de que esa clave siga
-- siendo compuesta mañana.

CREATE OR REPLACE FUNCTION assert_cuenta_del_rol() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tipo       text;
  imputable  boolean;
  estado     text;
  esperado   text[];
BEGIN
  SELECT a.type, a.is_postable, a.status INTO tipo, imputable, estado
    FROM accounts a
   WHERE a.id = NEW.account_id AND a.company_id = NEW.company_id;

  -- `cam_cuenta_fk` (0074) ya es compuesta sobre `(company_id, account_id)`, así
  -- que esta rama no se alcanza: la clave foránea rechaza la fila antes. Está
  -- igual porque sin ella un `SELECT ... INTO` sin filas deja las tres variables
  -- en NULL, y entonces `NOT imputable` es NULL, `tipo = ANY (esperado)` es NULL
  -- y **ninguno de los IF siguientes dispara**. La fila pasaría todas las
  -- comprobaciones por no haber encontrado nada que comprobar.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'E_MAPEO_CUENTA_AJENA: la cuenta declarada para % no existe en esta empresa.', NEW.rol
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT imputable THEN
    RAISE EXCEPTION
      'E_MAPEO_NO_IMPUTABLE: la cuenta declarada para % no es imputable; una cuenta de '
      'agrupación no recibe movimientos.', NEW.rol
      USING ERRCODE = 'check_violation';
  END IF;

  esperado := CASE NEW.rol
    WHEN 'CLIENTES'        THEN ARRAY['ACTIVO']
    WHEN 'PROVEEDORES'     THEN ARRAY['PASIVO']
    WHEN 'IVA_DEBITO'      THEN ARRAY['PASIVO']
    WHEN 'IVA_CREDITO'     THEN ARRAY['ACTIVO']
    WHEN 'VENTAS'          THEN ARRAY['INGRESO']
    WHEN 'COMPRAS'         THEN ARRAY['COSTO', 'GASTO']
    -- La mercadería es un activo: es lo que la empresa tiene hasta que lo
    -- vende. Declararla como gasto haría que la compra se lleve el resultado
    -- del mes en que se compró, y la venta no tenga costo.
    WHEN 'MERCADERIA'      THEN ARRAY['ACTIVO']
    WHEN 'COSTO_DE_VENTAS' THEN ARRAY['COSTO', 'GASTO']
  END;

  IF esperado IS NULL THEN
    RAISE EXCEPTION
      'E_MAPEO_ROL_SIN_TIPO: el rol % no tiene tipo de cuenta esperado. Agregarlo al '
      'CASE es parte de agregar el rol.', NEW.rol
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (tipo = ANY (esperado)) THEN
    RAISE EXCEPTION
      'E_MAPEO_TIPO: el rol % espera una cuenta de tipo % y la declarada es %.',
      NEW.rol, array_to_string(esperado, ' o '), tipo
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lo que agrega esta migración.
  IF estado <> 'ACTIVE' THEN
    RAISE EXCEPTION
      'E_MAPEO_ARCHIVADA: la cuenta declarada para % está archivada, y archivarla fue decir '
      'que ya no se usa.', NEW.rol
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION assert_cuenta_del_rol() IS
  'La cuenta declarada para un rol es de esta empresa, del tipo que el rol '
  'espera, imputable y no archivada. No decide a que cuenta va nada: rechaza '
  'una declaracion que no puede funcionar.';
