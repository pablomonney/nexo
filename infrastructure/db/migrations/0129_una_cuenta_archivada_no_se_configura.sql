-- ---------------------------------------------------------------------------
-- Una cuenta archivada no se configura
-- ---------------------------------------------------------------------------
--
-- Los objetos concretos —productos, bienes de uso, cajas, cuentas bancarias—
-- apuntan a una cuenta del plan. Cada uno comprueba algo distinto antes de
-- aceptarla, y ninguno comprueba lo mismo que los demás:
--
--     products        is_postable y tipo          (0048)
--     fixed_assets    is_postable y tipo          (0055)
--     cash_boxes      nada                        (0068)
--     bank_accounts   is_postable, en la ruta     (0022 / routes/banks.ts)
--
-- Los cuatro comparten el mismo agujero: **`status` no se mira en ninguno**.
-- Una cuenta archivada se puede configurar hoy en cualquiera de los cuatro. Y
-- archivar una cuenta es exactamente decir «esta cuenta ya no se usa»; dejar que
-- quede configurada como destino de una imputación futura contradice el acto de
-- archivarla.
--
-- ## Qué cambia y qué no
--
-- Esto **no** decide a qué cuenta va nada. No es resolución ni precedencia: es
-- la misma comprobación que ya se hacía, aplicada a una condición que faltaba, y
-- aplicada en los cuatro lugares en vez de en dos y medio.
--
-- ## El momento en que se comprueba, y el que no alcanza
--
-- Los disparadores son `BEFORE INSERT OR UPDATE`: miran la cuenta cuando se la
-- configura. **No pueden** impedir que alguien archive después una cuenta que ya
-- estaba configurada, porque esa es una modificación de `accounts` y no del
-- objeto. Impedirlo desde acá sería convertir «archivar una cuenta» en una
-- operación que puede fallar por una fila lejana, y eso volvería el archivado
-- impracticable en cualquier empresa con historia.
--
-- Por eso quien lee una cuenta configurada vuelve a comprobarla. Es lo que hace
-- `leerDetalle` en `routes/mapeo-contable.ts`: si la cuenta del producto ya no
-- sirve, el renglón cae en la genérica y se avisa. Este candado cierra el caso
-- de configurarla rota; el lector cierra el de que se rompa después.
--
-- ## El caso aparte de `bank_accounts`
--
-- Su clave foránea es `REFERENCES accounts (id)` a secas: las otras tres tablas
-- usan la compuesta `(company_id, account_id)`, que hace imposible apuntar a una
-- cuenta de otra empresa. Ninguna ruta puede producir esa fila —`banks.ts`
-- resuelve la cuenta por `company_id` y código— pero la base no lo impide.
--
-- Se cierra con una comprobación en el disparador y no cambiando la clave. Un
-- `ALTER` de la foránea fallaría entero si existiera una sola fila vieja
-- inconsistente, y dejaría la migración a medio aplicar en una base que hoy no
-- tiene ese problema. El disparador protege lo que viene sin apostar sobre lo
-- que hay.

-- ---------------------------------------------------------------------------
-- 1 · Productos
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_cuentas_del_producto() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imputable boolean;
  tipo text;
  estado text;
BEGIN
  IF NEW.sales_account_id IS NOT NULL THEN
    SELECT a.is_postable, a.type, a.status INTO imputable, tipo, estado
      FROM accounts a WHERE a.id = NEW.sales_account_id;
    IF NOT imputable THEN
      RAISE EXCEPTION 'La cuenta de venta no es imputable: un asiento no puede apoyarse en ella'
        USING ERRCODE = 'check_violation';
    END IF;
    IF tipo NOT IN ('INGRESO', 'ACTIVO') THEN
      RAISE EXCEPTION 'La cuenta de venta es de tipo %: se esperaba INGRESO', tipo
        USING ERRCODE = 'check_violation';
    END IF;
    IF estado <> 'ACTIVE' THEN
      RAISE EXCEPTION
        'La cuenta de venta está archivada: archivarla fue decir que ya no se usa'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.purchase_account_id IS NOT NULL THEN
    SELECT a.is_postable, a.type, a.status INTO imputable, tipo, estado
      FROM accounts a WHERE a.id = NEW.purchase_account_id;
    IF NOT imputable THEN
      RAISE EXCEPTION 'La cuenta de compra no es imputable: un asiento no puede apoyarse en ella'
        USING ERRCODE = 'check_violation';
    END IF;
    -- ACTIVO es legítimo: una compra de mercadería para reventa va a bienes de
    -- cambio, no a resultado. COSTO y GASTO también. PASIVO no.
    IF tipo NOT IN ('COSTO', 'GASTO', 'ACTIVO') THEN
      RAISE EXCEPTION 'La cuenta de compra es de tipo %: se esperaba COSTO, GASTO o ACTIVO', tipo
        USING ERRCODE = 'check_violation';
    END IF;
    IF estado <> 'ACTIVE' THEN
      RAISE EXCEPTION
        'La cuenta de compra está archivada: archivarla fue decir que ya no se usa'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2 · Bienes de uso
-- ---------------------------------------------------------------------------
-- Las tres cuentas del bien ya se comprobaban por imputabilidad y por tipo. Los
-- cuatro `E_BIEN_*` de la 0055 se conservan palabra por palabra: `activos.ts`
-- los traduce por subcadena, y cambiarlos dejaría al usuario viendo el error
-- crudo de PostgreSQL. El estado entra como un código nuevo, que es lo que
-- corresponde a una condición nueva.
CREATE OR REPLACE FUNCTION assert_cuentas_del_bien() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imputable boolean;
  tipo text;
  archivada uuid;
BEGIN
  SELECT a.is_postable, a.type INTO imputable, tipo
    FROM accounts a WHERE a.id = NEW.account_id;
  IF NOT imputable OR tipo <> 'ACTIVO' THEN
    RAISE EXCEPTION 'E_BIEN_CUENTA_ACTIVO: la cuenta del bien tiene que ser de ACTIVO e imputable'
      USING ERRCODE = 'check_violation';
  END IF;

  -- La amortización acumulada es una regularizadora del activo: vive en ACTIVO
  -- con saldo acreedor. Exigirla en PASIVO sería el error clásico.
  SELECT a.is_postable, a.type INTO imputable, tipo
    FROM accounts a WHERE a.id = NEW.accumulated_account_id;
  IF NOT imputable OR tipo <> 'ACTIVO' THEN
    RAISE EXCEPTION
      'E_BIEN_CUENTA_ACUMULADA: la amortización acumulada es regularizadora del activo: cuenta de ACTIVO e imputable'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.is_postable, a.type INTO imputable, tipo
    FROM accounts a WHERE a.id = NEW.expense_account_id;
  IF NOT imputable OR tipo NOT IN ('GASTO', 'COSTO') THEN
    RAISE EXCEPTION 'E_BIEN_CUENTA_GASTO: la cuenta de amortización del ejercicio va a GASTO o COSTO'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.account_id = NEW.accumulated_account_id THEN
    RAISE EXCEPTION 'E_BIEN_CUENTAS_IGUALES: el bien y su amortización acumulada no comparten cuenta'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lo que agrega esta migración. Una sola consulta para las tres: da lo mismo
  -- cuál de ellas está archivada, porque el remedio es el mismo.
  SELECT a.id INTO archivada
    FROM accounts a
   WHERE a.id IN (NEW.account_id, NEW.accumulated_account_id, NEW.expense_account_id)
     AND a.status <> 'ACTIVE'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'E_BIEN_CUENTA_ARCHIVADA: una de las cuentas del bien está archivada, y archivarla fue decir que ya no se usa'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3 · Cajas
-- ---------------------------------------------------------------------------
-- No tenía ninguna comprobación. Una caja que apunta a una cuenta de agrupación
-- es el mismo defecto que `banks.ts` rechaza desde su alta: no hay Mayor contra
-- el cual arquear.
--
-- No se comprueba el tipo. Que la cuenta de una caja sea del activo es cierto en
-- la práctica, pero decidirlo acá sería una regla nueva sobre qué puede ser una
-- caja, y esta migración cierra agujeros: no abre criterios.
CREATE FUNCTION assert_cuenta_de_la_caja() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imputable boolean;
  estado text;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;

  SELECT a.is_postable, a.status INTO imputable, estado
    FROM accounts a WHERE a.id = NEW.account_id AND a.company_id = NEW.company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuenta de la caja no existe en esta empresa'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT imputable THEN
    RAISE EXCEPTION
      'La cuenta de la caja es de agrupación y no recibe movimientos: no hay Mayor contra el cual arquear'
      USING ERRCODE = 'check_violation';
  END IF;
  IF estado <> 'ACTIVE' THEN
    RAISE EXCEPTION 'La cuenta de la caja está archivada' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cash_boxes_cuenta_valida
  BEFORE INSERT OR UPDATE OF account_id ON cash_boxes
  FOR EACH ROW EXECUTE FUNCTION assert_cuenta_de_la_caja();

-- ---------------------------------------------------------------------------
-- 4 · Cuentas bancarias
-- ---------------------------------------------------------------------------
-- La imputabilidad la exigía la ruta. Acá se exige en la base, junto con el
-- estado y la pertenencia, que es la que la clave foránea de esta tabla no
-- garantiza.
CREATE FUNCTION assert_cuenta_del_banco() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  imputable boolean;
  estado text;
BEGIN
  SELECT a.is_postable, a.status INTO imputable, estado
    FROM accounts a WHERE a.id = NEW.account_id AND a.company_id = NEW.company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuenta bancaria apunta a una cuenta que no es de esta empresa'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT imputable THEN
    RAISE EXCEPTION
      'La cuenta contable del banco es de agrupación: no hay Mayor contra el cual conciliar'
      USING ERRCODE = 'check_violation';
  END IF;
  IF estado <> 'ACTIVE' THEN
    RAISE EXCEPTION 'La cuenta contable del banco está archivada'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_accounts_cuenta_valida
  BEFORE INSERT OR UPDATE OF account_id, company_id ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION assert_cuenta_del_banco();

COMMENT ON FUNCTION assert_cuenta_de_la_caja() IS
  'La cuenta de una caja existe en esta empresa, es imputable y no esta '
  'archivada. No decide a que cuenta va nada: solo rechaza una configuracion '
  'que no puede funcionar.';
COMMENT ON FUNCTION assert_cuenta_del_banco() IS
  'Idem para la cuenta contable de un banco. La pertenencia se comprueba aca '
  'porque la clave foranea de bank_accounts referencia accounts (id) y no la '
  'compuesta con company_id.';
