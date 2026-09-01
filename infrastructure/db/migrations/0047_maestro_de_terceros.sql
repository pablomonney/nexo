-- 0047_maestro_de_terceros.sql — el tercero deja de ser un uuid sin dueño.
--
-- ## El defecto
--
-- `journal_entry_lines.party_id` existe desde la 0005. El trigger
-- `assert_line_account_valid` lo **exige** cuando la cuenta tiene
-- `requires_third_party`. Y no referencia a ninguna tabla: es un `uuid` suelto
-- que `POST /journal-entries` acepta del cuerpo del pedido sin comprobar nada.
--
-- Las consecuencias no son teóricas:
--
--   1. El Mayor por tercero —`GET /books/mayor` ya lo emite— agrupa por un
--      identificador que puede no significar nada. Dos líneas del mismo
--      proveedor con uuid distintos son dos terceros; el mismo uuid en dos
--      empresas es el mismo tercero. Ninguna de las dos cosas es cierta.
--   2. `accounts.requires_third_party` promete una dimensión contable que el
--      sistema no puede resolver a un nombre.
--   3. No hay cuenta corriente posible. Ni compras, ni ventas, ni CRM: todos
--      esos módulos empiezan por saber quién es la contraparte.
--
-- `tax_transactions` guarda `cuit_contraparte` y `razon_social` **en cada
-- comprobante**. Eso está bien y no se toca: un comprobante es evidencia y dice
-- lo que dice. Pero mil facturas del mismo proveedor son hoy mil cadenas
-- sueltas, y no hay forma de preguntar "¿qué le compré a este?".
--
-- ## La decisión
--
-- Un maestro de terceros **por empresa**, y el comprobante conserva lo que
-- declaró. El vínculo al maestro es una resolución posterior, opcional y
-- verificable — no una corrección del comprobante.
--
--   COMPROBANTE (lo que dice el papel)     MAESTRO (a quién resolvimos)
--   cuit_contraparte = '30712345678'  ───► parties.numero_documento
--   razon_social     = 'ACME SRL'          parties.razon_social
--
-- Si algún día el maestro cambia de razón social, el comprobante sigue
-- diciendo lo que decía. Son dos hechos distintos y viven separados.
--
-- ## Lo que NO se hace acá
--
-- - **No se crean tablas `clientes` y `proveedores`.** El mismo CUIT le compra
--   y le vende a la empresa todo el tiempo; dos tablas serían dos verdades
--   sobre la misma persona. Los roles van en una tabla hija.
-- - **No se guarda el saldo de la cuenta corriente.** Se deriva del Mayor
--   (vista `party_balances`). Un saldo almacenado es una segunda verdad que
--   algún día no va a coincidir con los asientos, y entonces habría que decidir
--   cuál de las dos manda. No hay tal dilema si solo existe una.
-- - **No se toca `requires_third_party` ni el trigger que lo exige.** Siguen
--   igual; ahora lo que exigen existe.

-- ---------------------------------------------------------------------------
-- 1 · El maestro
-- ---------------------------------------------------------------------------
CREATE TABLE parties (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id        uuid NOT NULL REFERENCES companies (id),

  -- Identificación tributaria. `SIN_IDENTIFICAR` es un estado legítimo, no un
  -- hueco: el consumidor final del mostrador no tiene documento que registrar y
  -- forzar uno inventado sería peor que no tener ninguno.
  tipo_documento    text NOT NULL DEFAULT 'CUIT'
                      CHECK (tipo_documento IN ('CUIT', 'CUIL', 'DNI', 'PASAPORTE',
                                                'DOC_EXTRANJERO', 'SIN_IDENTIFICAR')),
  numero_documento  text,

  razon_social      text NOT NULL CHECK (length(btrim(razon_social)) > 0),
  nombre_fantasia   text,

  -- Mismo vocabulario que `tax_transactions.condicion_iva`. No es casualidad:
  -- cuando un comprobante se resuelve contra un tercero, las dos condiciones
  -- tienen que poder compararse sin traducir.
  condicion_iva     text NOT NULL DEFAULT 'DESCONOCIDA'
                      CHECK (condicion_iva IN ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO',
                                               'CONSUMIDOR_FINAL', 'NO_CATEGORIZADO', 'DESCONOCIDA')),

  email             text,
  telefono          text,
  domicilio         text,
  localidad         text,
  provincia         text,
  codigo_postal     text,
  pais              text NOT NULL DEFAULT 'AR',

  observaciones     text,

  -- Baja lógica. Un tercero con movimientos no se borra jamás: se archiva, y
  -- deja de ofrecerse para operaciones nuevas sin desaparecer del Mayor.
  status            text NOT NULL DEFAULT 'ACTIVO'
                      CHECK (status IN ('ACTIVO', 'ARCHIVADO')),

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Un documento sin número solo se admite si se declaró que no hay documento.
  -- Al revés también: no se puede declarar `SIN_IDENTIFICAR` y traer número.
  CONSTRAINT parties_documento_coherente
    CHECK ((tipo_documento = 'SIN_IDENTIFICAR' AND numero_documento IS NULL)
        OR (tipo_documento <> 'SIN_IDENTIFICAR' AND numero_documento IS NOT NULL)),

  -- CUIT y CUIL son once dígitos. El DNI, hasta ocho. No se valida el dígito
  -- verificador acá: eso es una regla de negocio y vive en la aplicación, donde
  -- puede explicar por qué rechaza. Acá vive la forma, que no depende de nadie.
  CONSTRAINT parties_documento_forma
    CHECK (numero_documento IS NULL
        OR (tipo_documento IN ('CUIT', 'CUIL') AND numero_documento ~ '^[0-9]{11}$')
        OR (tipo_documento = 'DNI'             AND numero_documento ~ '^[0-9]{1,8}$')
        OR  tipo_documento IN ('PASAPORTE', 'DOC_EXTRANJERO')),

  -- La clave compuesta que hace posible la FK con empresa incluida (punto 3).
  -- No es redundante con la PK: es el objetivo de una referencia foránea.
  CONSTRAINT parties_id_empresa UNIQUE (company_id, id)
);

-- El mismo documento no puede estar dos veces en la misma empresa. En empresas
-- distintas sí: son maestros independientes y el aislamiento es total.
CREATE UNIQUE INDEX parties_documento_unico
  ON parties (company_id, tipo_documento, numero_documento)
  WHERE numero_documento IS NOT NULL;

CREATE INDEX parties_razon_social_idx ON parties (company_id, lower(razon_social));
CREATE INDEX parties_status_idx ON parties (company_id, status);

COMMENT ON TABLE parties IS
  'Maestro de terceros por empresa: clientes, proveedores y demás contrapartes. '
  'Es a quién apunta journal_entry_lines.party_id y a quién se resuelve —sin '
  'sobrescribirlo— el cuit_contraparte declarado en un comprobante.';
COMMENT ON COLUMN parties.numero_documento IS
  'NULL únicamente cuando tipo_documento = SIN_IDENTIFICAR.';
COMMENT ON COLUMN parties.status IS
  'ARCHIVADO no oculta los movimientos históricos: solo deja de ofrecerse para '
  'operaciones nuevas.';

CREATE TRIGGER parties_updated_at
  BEFORE UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER parties_no_delete
  BEFORE DELETE ON parties
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 2 · Los roles del tercero
-- ---------------------------------------------------------------------------
-- Un mismo CUIT es proveedor de servicios y cliente al mismo tiempo con toda
-- normalidad. Por eso el rol es una fila, no una columna ni una tabla aparte:
-- agregar EMPLEADO o TRANSPORTISTA mañana no exige tocar el esquema.
--
-- El rol es una **declaración de una persona** —"voy a comprarle a este"—, no
-- un hecho derivado. Es legítimo que exista antes del primer comprobante:
-- justamente para eso se da de alta un proveedor.
CREATE TABLE party_roles (
  party_id    uuid NOT NULL,
  company_id  uuid NOT NULL,
  role        text NOT NULL
                CHECK (role IN ('CLIENTE', 'PROVEEDOR', 'EMPLEADO', 'ACREEDOR',
                                'DEUDOR', 'TRANSPORTISTA', 'OTRO')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL,

  PRIMARY KEY (party_id, role),
  CONSTRAINT party_roles_party_fk
    FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id)
);

CREATE INDEX party_roles_por_rol ON party_roles (company_id, role);

COMMENT ON TABLE party_roles IS
  'Roles declarados de un tercero. Un tercero puede ser cliente y proveedor a '
  'la vez; por eso no hay tablas separadas.';

CREATE TRIGGER party_roles_no_delete
  BEFORE DELETE ON party_roles
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- 3 · La línea de asiento pasa a referenciar un tercero que existe
-- ---------------------------------------------------------------------------
-- La referencia lleva la empresa **dentro de la clave**. Con una FK simple a
-- `parties (id)` una empresa podría imputarle un movimiento al tercero de otra:
-- el uuid existiría y la base lo aceptaría. RLS no alcanza para impedirlo,
-- porque las restricciones foráneas se verifican con privilegios del sistema.
--
-- Si esta migración falla acá, es porque hay líneas con un `party_id` que no
-- corresponde a ningún tercero. Es la respuesta correcta: esas líneas afirman
-- una dimensión contable que nadie puede resolver, y hay que decidir qué son
-- antes de seguir. No se convierte en NOT VALID para que el error aparezca.
ALTER TABLE journal_entry_lines
  ADD CONSTRAINT jel_party_fk
  FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id);

CREATE INDEX jel_party_idx ON journal_entry_lines (company_id, party_id)
  WHERE party_id IS NOT NULL;

COMMENT ON COLUMN journal_entry_lines.party_id IS
  'Tercero imputado. Obligatorio cuando la cuenta tiene requires_third_party. '
  'Desde la 0047 referencia a parties con la empresa incluida en la clave.';

-- ---------------------------------------------------------------------------
-- 4 · El comprobante se resuelve al maestro sin dejar de decir lo que dice
-- ---------------------------------------------------------------------------
ALTER TABLE tax_transactions ADD COLUMN party_id uuid;

ALTER TABLE tax_transactions
  ADD CONSTRAINT tt_party_fk
  FOREIGN KEY (company_id, party_id) REFERENCES parties (company_id, id);

CREATE INDEX tt_party_idx ON tax_transactions (company_id, party_id)
  WHERE party_id IS NOT NULL;

COMMENT ON COLUMN tax_transactions.party_id IS
  'Tercero del maestro al que se resolvió la contraparte. NULL es legítimo: el '
  'comprobante vale igual. cuit_contraparte y razon_social NO se sobrescriben.';

-- El vínculo tiene que ser cierto. Si el comprobante declara un CUIT y el
-- tercero al que se lo apunta tiene otro, alguien se equivocó de fila — y el
-- error sería invisible: el subdiario seguiría saliendo bien, y la cuenta
-- corriente del proveedor equivocado empezaría a crecer sin motivo.
CREATE OR REPLACE FUNCTION assert_party_coincide_con_comprobante() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  doc_tercero text;
  tipo_tercero text;
BEGIN
  IF NEW.party_id IS NULL OR NEW.cuit_contraparte IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.numero_documento, p.tipo_documento
    INTO doc_tercero, tipo_tercero
    FROM parties p
   WHERE p.id = NEW.party_id AND p.company_id = NEW.company_id;

  -- Solo se compara contra un documento comparable. Un tercero identificado por
  -- pasaporte no tiene CUIT que contrastar, y eso no es una incoherencia.
  IF tipo_tercero IN ('CUIT', 'CUIL') AND doc_tercero IS DISTINCT FROM NEW.cuit_contraparte THEN
    RAISE EXCEPTION
      'El comprobante declara el CUIT % y el tercero vinculado tiene %. No se vincula a un tercero distinto del que dice el comprobante.',
      NEW.cuit_contraparte, doc_tercero
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tt_party_coherente
  BEFORE INSERT OR UPDATE OF party_id, cuit_contraparte ON tax_transactions
  FOR EACH ROW EXECUTE FUNCTION assert_party_coincide_con_comprobante();

-- ---------------------------------------------------------------------------
-- 5 · La cuenta corriente se deriva, no se guarda
-- ---------------------------------------------------------------------------
-- El saldo de un tercero es la suma de sus movimientos aprobados en el Mayor.
-- No hay una columna `saldo` que mantener sincronizada porque no puede
-- desincronizarse algo que no existe.
--
-- Solo cuentan los asientos `APROBADO`: un borrador no le debe plata a nadie.
CREATE VIEW party_balances WITH (security_invoker = true) AS
SELECT p.company_id,
       p.id                                AS party_id,
       p.razon_social,
       p.tipo_documento,
       p.numero_documento,
       p.status,
       coalesce(m.debe, 0)                 AS debe,
       coalesce(m.haber, 0)                AS haber,
       coalesce(m.debe, 0) - coalesce(m.haber, 0) AS saldo,
       coalesce(m.movimientos, 0)          AS movimientos,
       m.ultimo_movimiento
  FROM parties p
  LEFT JOIN LATERAL (
        SELECT sum(l.debit)   AS debe,
               sum(l.credit)  AS haber,
               -- `::int` a propósito: `count(*)` es bigint y el driver lo
               -- entrega como cadena. Un conteo que llega como texto obliga a
               -- convertirlo en cada consumidor, y el primero que se olvide
               -- compara "10" < "9" y le da la razón.
               count(*)::int  AS movimientos,
               max(e.entry_date) AS ultimo_movimiento
          FROM journal_entry_lines l
          JOIN journal_entries e
            ON e.id = l.entry_id AND e.company_id = l.company_id
         WHERE l.party_id = p.id
           AND l.company_id = p.company_id
           AND e.status = 'APROBADO'
       ) m ON true;

COMMENT ON VIEW party_balances IS
  'Cuenta corriente derivada del Mayor. Saldo deudor positivo, acreedor '
  'negativo. Solo asientos APROBADO. No hay saldo almacenado en ninguna tabla.';

-- ---------------------------------------------------------------------------
-- 6 · Permisos
-- ---------------------------------------------------------------------------
-- Leer el maestro y escribirlo son dos cosas distintas. Dar de alta un
-- proveedor cambia a quién se le pueden imputar movimientos, así que la
-- escritura queda del lado de quien responde por la contabilidad.
INSERT INTO permissions (code, description) VALUES
  ('party:read',  'Consultar el maestro de terceros y su cuenta corriente'),
  ('party:write', 'Dar de alta, editar y archivar terceros');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'USUARIO_EMPRESA', 'SOLO_LECTURA')
  AND p.code = 'party:read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code IN ('ADMINISTRADOR', 'CONTADOR')
  AND p.code = 'party:write';

-- ---------------------------------------------------------------------------
-- 7 · RLS
-- ---------------------------------------------------------------------------
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parties
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

ALTER TABLE party_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON party_roles
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON parties TO aai_app;
GRANT SELECT, INSERT, UPDATE ON party_roles TO aai_app;
GRANT SELECT ON party_balances TO aai_app;
