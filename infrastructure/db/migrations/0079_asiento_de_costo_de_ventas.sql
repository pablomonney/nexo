-- ============================================================================
-- 0079 — El costo de mercadería vendida llega al Mayor
-- ============================================================================
--
-- La 0077 dejó el costo calculado y afuera del Diario: `analytics_costo_de_ventas`
-- dice cuánto costó lo que salió por venta, y el resultado del ejercicio seguía
-- sin incluirlo. Una venta figuraba entera como ganancia.
--
-- Lo que faltaba para cerrar el circuito no era el cálculo: era **saber contra
-- qué cuentas se asienta**, y eso es exactamente lo que la 0074 resolvió para
-- los comprobantes. Se usa el mismo mecanismo: dos roles más en el mapeo
-- declarado por la empresa.
--
--   · `MERCADERIA`        — el activo que se da de baja al vender
--   · `COSTO_DE_VENTAS`   — el resultado negativo que se reconoce
--
-- Sin los dos declarados, no se propone nada y se dice cuál falta. Elegirlos por
-- la empresa sería inventar su plan de cuentas.
--
-- ## Sigue sin haber asiento automático
--
-- El sistema **propone**; el asiento lo carga y lo firma una persona por
-- `POST /journal-entries`, como todo lo demás. Automatizarlo exigiría decidir
-- cuándo se asienta —por cada venta, por mes, al cierre— y esa es una decisión
-- de política contable que nadie tomó. Proponerlo por período consultado deja
-- esa elección donde corresponde: en quien pide la propuesta.
--
-- ## Y no se propone lo que no se puede afirmar
--
-- Si falta el método de valuación, si hay salidas sin costo, o si el período no
-- tiene costo calculado, no hay propuesta. Un asiento de costo armado sobre un
-- promedio incompleto cuadra igual y dice una cifra que no es.
-- ============================================================================

ALTER TABLE company_account_map DROP CONSTRAINT company_account_map_rol_check;

ALTER TABLE company_account_map ADD CONSTRAINT company_account_map_rol_check
  CHECK (rol IN ('CLIENTES', 'PROVEEDORES', 'IVA_DEBITO', 'IVA_CREDITO',
                 'VENTAS', 'COMPRAS', 'MERCADERIA', 'COSTO_DE_VENTAS'));

-- El trigger de la 0074, con los dos roles nuevos. Se reescribe entero porque
-- el `CASE` es exhaustivo a propósito: un rol sin tipo esperado devolvería NULL
-- y la comparación pasaría siempre, que es la peor forma de un control.
CREATE OR REPLACE FUNCTION assert_cuenta_del_rol() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tipo       text;
  imputable  boolean;
  esperado   text[];
BEGIN
  SELECT a.type, a.is_postable INTO tipo, imputable
    FROM accounts a
   WHERE a.id = NEW.account_id AND a.company_id = NEW.company_id;

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

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- La vista que arma el asiento, por período
-- ---------------------------------------------------------------------------
-- Un solo renglón por lado: el costo del período contra la mercadería. No se
-- abre por producto a propósito — un asiento con doscientas líneas por mes no
-- lo lee nadie, y el detalle por producto ya está en `analytics_costo_de_ventas`
-- con su trazabilidad.
CREATE VIEW cogs_por_mes WITH (security_invoker = true) AS
SELECT c.company_id,
       c.mes,
       sum(c.costo)                                AS costo,
       sum(c.salidas_sin_costo)::int               AS salidas_sin_costo,
       count(*)::int                               AS productos,
       max(c.metodo)                               AS metodo,
       -- Si algún producto del mes tiene salidas sin costear, el total del mes
       -- no se puede afirmar: sumar lo que sí tiene costo daría un costo más
       -- chico que el real y un margen más grande que el real.
       bool_or(c.salidas_sin_costo > 0)            AS incompleto,
       bool_or(c.metodo IS NULL)                   AS sin_metodo
  FROM analytics_costo_de_ventas c
 GROUP BY c.company_id, c.mes;

COMMENT ON VIEW cogs_por_mes IS
  'El costo de lo vendido, por mes y en una sola cifra, con las dos razones por '
  'las que puede no ser afirmable: método sin declarar o salidas sin costear.';

GRANT SELECT ON cogs_por_mes TO aai_app;
