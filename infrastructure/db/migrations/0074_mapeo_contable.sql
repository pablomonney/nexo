-- ============================================================================
-- 0074 — El mapeo contable declarado: a qué cuenta va cada cosa
-- ============================================================================
--
-- La auditoría integral encontró que **el Mayor se escribe a mano**. Facturar,
-- cobrar, pagar, recibir mercadería o devengar una comisión no producen ningún
-- asiento: el único hecho que los genera solo es el cierre de ejercicio. Cada
-- módulo dice honestamente «no toco el Mayor», y lo que faltaba era el paso que
-- resuelve eso una vez para todos.
--
-- ## El motor de propuesta ya existía, y salía vacío
--
-- `decision-de-comprobante.ts` produce una `PropuestaDeAsiento` con renglones.
-- La API la llamaba inyectándole `armarLineas` como `() => []`, así que la
-- propuesta salía **siempre sin renglones**, y encima la respuesta la
-- descartaba. No era un olvido: armar los renglones exige saber a qué cuenta va
-- cada cosa, y esa declaración no existía en ningún lado.
--
-- ## Lo que faltaba era una declaración, no un algoritmo
--
-- Parte del mapeo ya estaba: `products` tiene cuenta de venta y de compra, y
-- `accounts.tax_role` distingue IVA débito de IVA crédito. Lo que no estaba es
-- **la contrapartida**: cuál es la cuenta de deudores por ventas y cuál la de
-- proveedores de esta empresa. Elegirla por el sistema sería inventar la
-- contabilidad de alguien; pedirla una vez y recordarla es lo que hace un ERP.
--
-- Sin mapeo declarado, la propuesta sigue saliendo sin renglones y **se dice
-- por qué** — con el nombre del rol que falta. Es la misma disciplina de la
-- tarifa horaria (0070), del esquema de comisión (0071) y de los umbrales de
-- análisis (0058): lo que nadie declaró no se supone.
--
-- ## Y la cuenta declarada tiene que servir para lo que se la usa
--
-- Un rol no admite cualquier cuenta. Deudores por ventas es del ACTIVO,
-- proveedores del PASIVO, ventas es INGRESO, y el IVA débito no puede ser una
-- cuenta de resultado. No es rigidez: es que un asiento armado con una cuenta
-- del tipo equivocado descuadra el balance de forma silenciosa, y el error se
-- descubre un ejercicio después.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · La declaración
-- ---------------------------------------------------------------------------
CREATE TABLE company_account_map (
  company_id   uuid NOT NULL REFERENCES companies (id),

  rol          text NOT NULL
                 CHECK (rol IN ('CLIENTES', 'PROVEEDORES', 'IVA_DEBITO',
                                'IVA_CREDITO', 'VENTAS', 'COMPRAS')),
  account_id   uuid NOT NULL,

  declarado_por text NOT NULL,
  declarado_el  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (company_id, rol),
  CONSTRAINT cam_cuenta_fk
    FOREIGN KEY (company_id, account_id) REFERENCES accounts (company_id, id)
);

ALTER TABLE company_account_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_account_map FORCE ROW LEVEL SECURITY;
CREATE POLICY cam_por_empresa ON company_account_map
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON company_account_map TO aai_app;

COMMENT ON TABLE company_account_map IS
  'A qué cuenta va cada cosa, declarado por la empresa. Sin esto el sistema no '
  'propone ningún asiento: elegir la cuenta por su cuenta sería inventar la '
  'contabilidad de alguien.';

-- ---------------------------------------------------------------------------
-- 2 · La cuenta tiene que servir para el rol
-- ---------------------------------------------------------------------------
-- Un asiento armado con una cuenta del tipo equivocado descuadra el balance en
-- silencio y el error aparece un ejercicio después. La coherencia se comprueba
-- acá y no en la aplicación porque una declaración por SQL directo tiene las
-- mismas consecuencias que una por la API.
CREATE FUNCTION assert_cuenta_del_rol() RETURNS trigger
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
    WHEN 'CLIENTES'    THEN ARRAY['ACTIVO']
    WHEN 'PROVEEDORES' THEN ARRAY['PASIVO']
    WHEN 'IVA_DEBITO'  THEN ARRAY['PASIVO']
    WHEN 'IVA_CREDITO' THEN ARRAY['ACTIVO']
    WHEN 'VENTAS'      THEN ARRAY['INGRESO']
    WHEN 'COMPRAS'     THEN ARRAY['COSTO', 'GASTO']
  END;

  IF NOT (tipo = ANY (esperado)) THEN
    RAISE EXCEPTION
      'E_MAPEO_TIPO: el rol % espera una cuenta de tipo % y la declarada es %.',
      NEW.rol, array_to_string(esperado, ' o '), tipo
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cam_cuenta_del_rol
  AFTER INSERT OR UPDATE ON company_account_map
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_cuenta_del_rol();

-- ---------------------------------------------------------------------------
-- 3 · Qué falta, derivado
-- ---------------------------------------------------------------------------
CREATE VIEW accounting_map_status WITH (security_invoker = true) AS
SELECT c.id                                        AS company_id,
       ARRAY(
         SELECT r FROM unnest(ARRAY['CLIENTES', 'PROVEEDORES', 'IVA_DEBITO',
                                    'IVA_CREDITO', 'VENTAS', 'COMPRAS']) AS r
          WHERE NOT EXISTS (SELECT 1 FROM company_account_map m
                             WHERE m.company_id = c.id AND m.rol = r)
          ORDER BY r
       )                                           AS roles_faltantes,
       (SELECT count(*)::int FROM company_account_map m WHERE m.company_id = c.id)
                                                   AS roles_declarados,
       -- Cuántos comprobantes hay esperando. Sin ninguno, que falte el mapeo no
       -- es un problema todavía: una empresa recién creada no tiene qué asentar.
       (SELECT count(*)::int FROM tax_transactions t WHERE t.company_id = c.id)
                                                   AS comprobantes
  FROM companies c;

COMMENT ON VIEW accounting_map_status IS
  'Qué roles del mapeo contable faltan declarar. Se deriva: no hay una columna '
  '«completo» que pueda quedar desactualizada.';

-- ---------------------------------------------------------------------------
-- 4 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_mapeo WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- Hay comprobantes registrados y el mapeo está incompleto. Mientras falte, el
-- sistema no propone ningún asiento y cada uno se escribe a mano.
SELECT s.company_id,
       'MAPEO_CONTABLE_INCOMPLETO'::text             AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'company_account_map'::text                   AS entidad,
       s.company_id                                  AS entity_id,
       'INCOMPLETO'::text                            AS estado,
       'Falta declarar a qué cuenta va: ' ||
         array_to_string(s.roles_faltantes, ', ') ||
         '. Sin eso el sistema no propone asientos y cada uno se escribe a mano'
                                                     AS motivo,
       false                                         AS bloquea,
       s.roles_faltantes                             AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       now()                                         AS creado_en,
       now()                                         AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/accounting-map'::text                       AS traza_ref
  FROM accounting_map_status s
 WHERE s.comprobantes > 0 AND array_length(s.roles_faltantes, 1) > 0

) q;

COMMENT ON VIEW work_queue_mapeo IS
  'Un solo aviso, y no bloquea: se puede seguir registrando asientos a mano. '
  'Lo que dice es que hay un trabajo repetido que una declaración evita.';

-- ⚠ `WITH (security_invoker = true)` repetido: `CREATE OR REPLACE` no conserva
-- las reloptions, y sin eso la bandeja de una empresa aparecería en la de otra.
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
UNION ALL SELECT * FROM work_queue_mapeo;

GRANT SELECT ON accounting_map_status TO aai_app;
GRANT SELECT ON work_queue_mapeo TO aai_app;
GRANT SELECT ON work_queue TO aai_app;

-- ---------------------------------------------------------------------------
-- 5 · Permisos
-- ---------------------------------------------------------------------------
-- Declarar el mapeo es tocar el plan de cuentas por otro camino: va con los
-- mismos permisos que las cuentas, y no se crea uno nuevo.
COMMENT ON COLUMN company_account_map.rol IS
  'Se lee con `account:read` y se declara con `account:write`: es una decisión '
  'sobre el plan de cuentas y no merece un permiso propio.';
