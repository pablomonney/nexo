-- ============================================================================
-- 0064 — Cheques propios y de terceros
-- ============================================================================
--
-- No existía nada. En Argentina el cheque de tercero en cartera es una parte
-- central del capital de trabajo: se recibe de un cliente, se guarda, se
-- deposita, o se endosa a un proveedor en lugar de pagar. Todos los ERP del
-- mercado lo tienen y NEXO no lo tenía.
--
-- ## El estado no se guarda: se deriva
--
-- Un cheque tiene un ciclo —en cartera, depositado, acreditado, rechazado,
-- endosado— y la tentación es una columna `estado` que se va actualizando. Sería
-- una segunda verdad: el día que un `UPDATE` falle a mitad de camino, el estado
-- y la historia dirían cosas distintas y no habría forma de saber cuál vale.
--
-- Acá el cheque guarda **lo que no cambia** —número, banco, importe, las dos
-- fechas— y `check_movements` es un libro **append-only** de lo que le fue
-- pasando. El estado es el último movimiento, derivado en una vista.
--
-- Es exactamente la forma de `stock_movements` → `stock_on_hand` (0054), y por
-- el mismo motivo: deshacer no es editar, es un movimiento nuevo.
--
-- ## Las dos fechas, y por qué ninguna se deduce
--
-- `fecha_emision` es cuándo se libró. `fecha_pago` es a partir de cuándo se
-- puede cobrar — en un cheque común coincide con la emisión, en uno diferido no.
-- **Las dos se declaran.** El sistema no calcula el vencimiento a partir de un
-- plazo legal: los plazos de presentación del cheque salen de la Ley 24.452 y
-- sus modificatorias, que no están archivadas en el registro normativo, y
-- afirmar una fecha sin fuente sería inventarla (§30, §47).
--
-- Lo que sí es un hecho, y por eso la bandeja lo informa: un cheque en cartera
-- cuya fecha de pago ya pasó y que sigue sin depositarse.
--
-- ## Lo que este módulo NO hace
--
-- **No escribe en el Mayor.** Recibir un cheque en cancelación de una factura es
-- un asiento —Valores a depositar contra Deudores— y ese asiento lo firma una
-- persona por el camino de siempre. El cheque puede *citar* ese asiento, y no
-- reemplazarlo: si el registro de cheques moviera el Mayor por su cuenta,
-- habría dos orígenes para el mismo saldo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0 · Lo que faltaba para poder llevar la empresa dentro de la clave
-- ---------------------------------------------------------------------------
-- `bank_accounts` tenía única sobre `(company_id, account_id)` —la cuenta
-- contable— pero no sobre `(company_id, id)`. Sin eso no se puede escribir una
-- clave foránea compuesta hacia ella, y una clave foránea sin la empresa adentro
-- es un agujero real: las FK se verifican con privilegios del sistema y el RLS
-- no las alcanza, así que un cheque podría depositarse en la cuenta de otra
-- empresa y la base lo aceptaría.
--
-- Es la misma corrección que necesitaron `journal_entries` (0055) y `accounts`
-- (0048) cuando algo tuvo que apuntarles.
ALTER TABLE bank_accounts
  ADD CONSTRAINT bank_accounts_id_empresa UNIQUE (company_id, id);

-- ---------------------------------------------------------------------------
-- 1 · El cheque: lo que no cambia
-- ---------------------------------------------------------------------------
CREATE TABLE checks (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),

  -- RECIBIDO: de un tercero, entra a la cartera.
  -- EMITIDO:  propio, sale contra una cuenta bancaria de la empresa.
  tipo              text NOT NULL CHECK (tipo IN ('RECIBIDO', 'EMITIDO')),

  numero            text NOT NULL CHECK (length(btrim(numero)) > 0),
  banco             text NOT NULL CHECK (length(btrim(banco)) > 0),
  -- El CUIT del librador cuando se conoce. Nulo es válido: un cheque al portador
  -- que llegó por ventanilla puede no traerlo, y exigirlo obligaría a inventarlo.
  cuit_librador     text CHECK (cuit_librador IS NULL OR cuit_librador ~ '^\d{11}$'),

  importe           numeric(18, 2) NOT NULL CHECK (importe > 0),
  moneda            text NOT NULL DEFAULT 'ARS',

  fecha_emision     date NOT NULL,
  -- A partir de cuándo se puede cobrar. En un cheque común es la de emisión; en
  -- uno diferido, después. Se declara: el plazo legal no está archivado.
  fecha_pago        date NOT NULL,

  -- De quién se recibió, o a quién se entregó.
  party_id          uuid,
  -- Solo para los propios: de qué cuenta de la empresa sale.
  bank_account_id   uuid,

  -- El asiento que lo registró contablemente, si ya se hizo. El cheque **no**
  -- escribe el Mayor: lo cita.
  journal_entry_id  uuid,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,

  CONSTRAINT ck_fecha_pago_no_anterior
    CHECK (fecha_pago >= fecha_emision),
  -- Un cheque propio sale de una cuenta de la empresa; uno de tercero no.
  CONSTRAINT ck_propio_con_cuenta
    CHECK ((tipo = 'EMITIDO') = (bank_account_id IS NOT NULL)),

  CONSTRAINT ck_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id),
  CONSTRAINT ck_cuenta_fk
    FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  CONSTRAINT ck_asiento_fk
    FOREIGN KEY (company_id, journal_entry_id) REFERENCES journal_entries (company_id, id),

  -- Idempotencia real: el mismo banco no emite dos veces el mismo número. Sin
  -- esto, cargar dos veces el mismo cheque duplicaría la cartera en silencio.
  CONSTRAINT ck_numero_unico UNIQUE (company_id, tipo, banco, numero),
  CONSTRAINT ck_id_empresa UNIQUE (company_id, id)
);

ALTER TABLE checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE checks FORCE ROW LEVEL SECURITY;
CREATE POLICY checks_por_empresa ON checks
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON checks TO aai_app;

CREATE INDEX checks_cartera_idx ON checks (company_id, tipo, fecha_pago);

COMMENT ON TABLE checks IS
  'Lo que no cambia de un cheque. Su estado NO está acá: se deriva de '
  'check_movements, que es append-only. Una columna de estado sería una segunda '
  'verdad que puede contradecir a la historia.';

COMMENT ON COLUMN checks.fecha_pago IS
  'Desde cuándo se puede cobrar. Se declara: los plazos de la Ley 24.452 no '
  'están en el registro normativo y afirmar una fecha sin fuente es inventarla.';

-- ---------------------------------------------------------------------------
-- 2 · El libro de movimientos
-- ---------------------------------------------------------------------------
CREATE TABLE check_movements (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  check_id         uuid NOT NULL,

  -- Los seis hechos que le pueden pasar a un cheque. El catálogo es cerrado
  -- porque cada uno tiene consecuencias distintas sobre la cartera.
  tipo             text NOT NULL CHECK (tipo IN (
                     'RECIBIDO',    -- entra a la cartera
                     'ENTREGADO',   -- se emitió y salió (cheque propio)
                     'DEPOSITADO',  -- se presentó en una cuenta
                     'ACREDITADO',  -- el banco lo pagó
                     'ENDOSADO',    -- se entregó a un tercero en pago
                     'RECHAZADO',   -- volvió sin fondos u otro motivo
                     'ANULADO')),   -- se anuló antes de circular

  fecha            date NOT NULL,

  -- Adónde fue. Cada destino corresponde a un tipo y el trigger lo verifica.
  bank_account_id  uuid,   -- DEPOSITADO
  party_id         uuid,   -- ENDOSADO
  motivo           text,   -- obligatorio en RECHAZADO y ANULADO

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,

  CONSTRAINT cm_motivo_cuando_corresponde
    CHECK (tipo NOT IN ('RECHAZADO', 'ANULADO')
           OR length(btrim(coalesce(motivo, ''))) > 2),

  CONSTRAINT cm_cheque_fk
    FOREIGN KEY (company_id, check_id) REFERENCES checks (company_id, id),
  CONSTRAINT cm_cuenta_fk
    FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  CONSTRAINT cm_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id)
);

ALTER TABLE check_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE check_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY cm_por_empresa ON check_movements
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());
GRANT SELECT, INSERT ON check_movements TO aai_app;

CREATE INDEX cm_cheque_idx ON check_movements (company_id, check_id, fecha, id);

-- Append-only, igual que el libro de stock y que la bitácora: deshacer es un
-- movimiento nuevo, no una edición.
CREATE TRIGGER cm_no_update BEFORE UPDATE ON check_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_update();
CREATE TRIGGER cm_no_delete BEFORE DELETE ON check_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

COMMENT ON TABLE check_movements IS
  'Qué le fue pasando a cada cheque. Append-only: un error se corrige con otro '
  'movimiento, igual que un asiento se anula por contraasiento.';

-- ---------------------------------------------------------------------------
-- 3 · Qué movimiento puede seguir a cuál
-- ---------------------------------------------------------------------------
-- La máquina de estados vive en la base y no en la ruta. Una transición
-- imposible —depositar un cheque ya acreditado, endosar uno rechazado— tiene que
-- ser imposible por cualquier camino, no solo por el que pasa por la API.
CREATE FUNCTION assert_movimiento_de_cheque() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cheque_tipo  text;
  anterior     text;
BEGIN
  SELECT c.tipo INTO cheque_tipo
    FROM checks c WHERE c.id = NEW.check_id AND c.company_id = NEW.company_id;

  SELECT m.tipo INTO anterior
    FROM check_movements m
   WHERE m.check_id = NEW.check_id AND m.company_id = NEW.company_id
     AND m.id <> NEW.id
   ORDER BY m.fecha DESC, m.id DESC
   LIMIT 1;

  -- El primer movimiento tiene que ser el que corresponde al tipo de cheque.
  IF anterior IS NULL THEN
    IF cheque_tipo = 'RECIBIDO' AND NEW.tipo <> 'RECIBIDO' THEN
      RAISE EXCEPTION
        'E_CHEQUE_PRIMER_MOVIMIENTO: un cheque de tercero entra a la cartera con RECIBIDO, y este es %.',
        NEW.tipo USING ERRCODE = 'check_violation';
    END IF;
    IF cheque_tipo = 'EMITIDO' AND NEW.tipo NOT IN ('ENTREGADO', 'ANULADO') THEN
      RAISE EXCEPTION
        'E_CHEQUE_PRIMER_MOVIMIENTO: un cheque propio empieza por ENTREGADO o ANULADO, y este es %.',
        NEW.tipo USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  -- Lo que ya terminó no vuelve a moverse. Un cheque acreditado se cobró; uno
  -- endosado ya no es de esta empresa.
  IF anterior IN ('ACREDITADO', 'ENDOSADO', 'ANULADO') THEN
    RAISE EXCEPTION
      'E_CHEQUE_CERRADO: el cheque está en % y no admite más movimientos.', anterior
      USING ERRCODE = 'check_violation';
  END IF;

  -- Las transiciones que sí existen.
  IF NOT (
       (anterior = 'RECIBIDO'   AND NEW.tipo IN ('DEPOSITADO', 'ENDOSADO', 'RECHAZADO'))
    OR (anterior = 'ENTREGADO'  AND NEW.tipo IN ('ACREDITADO', 'RECHAZADO'))
    OR (anterior = 'DEPOSITADO' AND NEW.tipo IN ('ACREDITADO', 'RECHAZADO'))
    -- Un rechazado vuelve a la cartera: se reclama y se puede volver a
    -- depositar, o se endosa. Lo que no hace es acreditarse solo.
    OR (anterior = 'RECHAZADO'  AND NEW.tipo IN ('DEPOSITADO', 'ENDOSADO'))
  ) THEN
    RAISE EXCEPTION
      'E_CHEQUE_TRANSICION: de % no se pasa a %.', anterior, NEW.tipo
      USING ERRCODE = 'check_violation';
  END IF;

  -- El destino tiene que corresponder al hecho.
  IF NEW.tipo = 'DEPOSITADO' AND NEW.bank_account_id IS NULL THEN
    RAISE EXCEPTION
      'E_CHEQUE_SIN_CUENTA: depositar exige decir en qué cuenta.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tipo = 'ENDOSADO' AND NEW.party_id IS NULL THEN
    RAISE EXCEPTION
      'E_CHEQUE_SIN_DESTINATARIO: endosar exige decir a quién.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER cm_transicion
  AFTER INSERT ON check_movements
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION assert_movimiento_de_cheque();

-- ---------------------------------------------------------------------------
-- 4 · El estado, derivado
-- ---------------------------------------------------------------------------
CREATE VIEW check_status WITH (security_invoker = true) AS
SELECT c.company_id,
       c.id                                  AS check_id,
       c.tipo,
       c.numero,
       c.banco,
       c.cuit_librador,
       c.importe,
       c.moneda,
       c.fecha_emision,
       c.fecha_pago,
       c.party_id,
       p.razon_social,
       c.bank_account_id,
       c.journal_entry_id,

       -- Sin movimientos el cheque está cargado y no circuló. No es un estado
       -- inventado: es la ausencia de historia, y se nombra distinto.
       coalesce(u.tipo, 'SIN_MOVIMIENTOS')   AS estado,
       u.fecha                               AS ultimo_movimiento,
       u.motivo                              AS ultimo_motivo,

       -- En cartera: entró y todavía no salió. Es lo que la empresa tiene.
       coalesce(u.tipo, '') IN ('RECIBIDO', 'RECHAZADO')
         AND c.tipo = 'RECIBIDO'             AS en_cartera,

       -- Hecho, no umbral: la fecha de pago ya pasó. Cuántos días hace es una
       -- resta, no una opinión sobre si es mucho.
       greatest(0, current_date - c.fecha_pago) AS dias_desde_fecha_de_pago
  FROM checks c
  LEFT JOIN parties p ON p.id = c.party_id AND p.company_id = c.company_id
  LEFT JOIN LATERAL (
        SELECT m.tipo, m.fecha, m.motivo
          FROM check_movements m
         WHERE m.check_id = c.id AND m.company_id = c.company_id
         ORDER BY m.fecha DESC, m.id DESC
         LIMIT 1
       ) u ON true;

COMMENT ON VIEW check_status IS
  'El estado de cada cheque, derivado del último movimiento. No hay columna de '
  'estado que mantener, así que no puede quedar desactualizada.';

-- ---------------------------------------------------------------------------
-- 5 · La cartera y lo que va a entrar
-- ---------------------------------------------------------------------------
CREATE VIEW checks_en_cartera WITH (security_invoker = true) AS
SELECT company_id,
       count(*)::int                                    AS cantidad,
       sum(importe)                                     AS total,
       sum(importe) FILTER (WHERE fecha_pago <= current_date)              AS al_dia_de_hoy,
       sum(importe) FILTER (WHERE fecha_pago > current_date
                              AND fecha_pago <= current_date + 30)         AS proximos_30,
       sum(importe) FILTER (WHERE fecha_pago > current_date + 30
                              AND fecha_pago <= current_date + 60)         AS de_31_a_60,
       sum(importe) FILTER (WHERE fecha_pago > current_date + 60)          AS mas_de_60,
       min(fecha_pago)                                  AS proxima_fecha
  FROM check_status
 WHERE en_cartera
 GROUP BY company_id;

COMMENT ON VIEW checks_en_cartera IS
  'Los cheques de terceros que la empresa tiene, por tramo de fecha de pago. Es '
  'plata con fecha conocida: entra al flujo de fondos por su fecha, no por la '
  'de la factura que lo originó.';

-- ---------------------------------------------------------------------------
-- 6 · La bandeja
-- ---------------------------------------------------------------------------
CREATE VIEW work_queue_cheques WITH (security_invoker = true) AS
SELECT md5(q.rama || ':' || q.entity_id)::uuid AS item_id,
       q.*
  FROM (

-- 1 · En cartera y su fecha de pago ya pasó. Es plata cobrable que está en un
--     cajón. No hay umbral: la fecha pasó o no pasó.
SELECT s.company_id,
       'CHEQUE_COBRABLE_SIN_DEPOSITAR'::text         AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'checks'::text                                AS entidad,
       s.check_id                                    AS entity_id,
       s.estado                                      AS estado,
       'El cheque ' || s.banco || ' ' || s.numero || ' de ' || s.importe ||
         ' se puede cobrar desde el ' || s.fecha_pago ||
         ' y sigue en cartera'                       AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.fecha_emision::timestamptz                  AS creado_en,
       s.fecha_emision::timestamptz                  AS actualizado_en,
       s.fecha_pago                                  AS fecha_limite,
       '/checks/' || s.check_id                      AS traza_ref
  FROM check_status s
 WHERE s.en_cartera AND s.fecha_pago <= current_date

UNION ALL

-- 2 · Rechazado. Es un cobro que se dio por hecho y no ocurrió: hay que
--     reclamarlo, y mientras tanto la cuenta corriente del cliente miente.
SELECT s.company_id,
       'CHEQUE_RECHAZADO'::text                      AS rama,
       'REQUIERE_REVISION'::text                     AS categoria,
       'checks'::text                                AS entidad,
       s.check_id                                    AS entity_id,
       s.estado                                      AS estado,
       'El cheque ' || s.banco || ' ' || s.numero || ' de ' || s.importe ||
         ' fue rechazado: ' || coalesce(s.ultimo_motivo, 'sin motivo registrado')
                                                     AS motivo,
       false                                         AS bloquea,
       NULL::text[]                                  AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.fecha_emision::timestamptz                  AS creado_en,
       s.ultimo_movimiento::timestamptz              AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/checks/' || s.check_id                      AS traza_ref
  FROM check_status s
 WHERE s.estado = 'RECHAZADO'

UNION ALL

-- 3 · Cargado y sin registrar contablemente. El cheque existe en la cartera y
--     no está en el Mayor: el saldo de Valores a depositar no lo incluye.
SELECT s.company_id,
       'CHEQUE_SIN_ASIENTO'::text                    AS rama,
       'REQUIERE_DECLARACION'::text                  AS categoria,
       'checks'::text                                AS entidad,
       s.check_id                                    AS entity_id,
       s.estado                                      AS estado,
       'El cheque ' || s.banco || ' ' || s.numero ||
         ' no cita ningún asiento: no está en el Mayor' AS motivo,
       false                                         AS bloquea,
       ARRAY['ASIENTO']::text[]                      AS evidencia_faltante,
       'SISTEMA'::text                               AS origen,
       'ACCIONABLE'::text                            AS disponibilidad,
       s.fecha_emision::timestamptz                  AS creado_en,
       s.fecha_emision::timestamptz                  AS actualizado_en,
       NULL::date                                    AS fecha_limite,
       '/checks/' || s.check_id                      AS traza_ref
  FROM check_status s
 WHERE s.journal_entry_id IS NULL
   AND s.estado <> 'ANULADO'

) q;

COMMENT ON VIEW work_queue_cheques IS
  'Ramas de cheques. Las tres son hechos: una fecha que pasó, un rechazo que '
  'ocurrió y un asiento que falta. Ninguna necesita un umbral declarado.';

-- ---------------------------------------------------------------------------
-- 7 · La bandeja suma la rama
-- ---------------------------------------------------------------------------
-- ⚠ `WITH (security_invoker = true)` repetido a propósito: `CREATE OR REPLACE`
-- no conserva las reloptions, y omitirlo haría que la bandeja de una empresa
-- apareciera en la de otra. Pasó en la 0058.
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
UNION ALL SELECT * FROM work_queue_cheques;

-- ---------------------------------------------------------------------------
-- 8 · Permisos
-- ---------------------------------------------------------------------------
-- Mover un cheque cambia dónde está la plata de la empresa. Va con permiso
-- propio y no con el de bancos: quien concilia un extracto no necesariamente es
-- quien decide endosar un cheque a un proveedor.
INSERT INTO permissions (code, description) VALUES
  ('check:read',  'Consultar la cartera de cheques'),
  ('check:write', 'Cargar cheques y registrar sus movimientos');

-- Leer la cartera es como leer el banco: la ve quien mira la plata de la
-- empresa, incluido el auditor.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
   AND p.code = 'check:read';

-- Escribir sigue a `stock:write` y no a `allocation:write`: registrar que un
-- cheque se depositó es una operación administrativa, no una imputación
-- contable. Quien opera la empresa puede hacerlo; imputar ese cobro contra una
-- factura sigue exigiendo `allocation:write`.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'USUARIO_EMPRESA')
   AND p.code = 'check:write';

GRANT SELECT ON check_status TO aai_app;
GRANT SELECT ON checks_en_cartera TO aai_app;
GRANT SELECT ON work_queue_cheques TO aai_app;
GRANT SELECT ON work_queue TO aai_app;
