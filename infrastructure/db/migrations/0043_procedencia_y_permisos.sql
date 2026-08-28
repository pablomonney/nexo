-- 0043_procedencia_y_permisos.sql — de dónde salió el dato, y quién dio acceso.
--
-- Dos huecos que la auditoría maestra encontró, distintos entre sí y con la
-- misma consecuencia: el sistema no puede responder una pregunta que promete
-- responder.
--
-- ## 1 · «Constatado» no dice quién lo constató
--
-- `tax_transactions.constatacion` existe desde la 0021 y distingue con cuidado
-- `NO_CONSULTADO` de `NO_VERIFICABLE` —«nadie preguntó» de «se preguntó y no se
-- pudo»—. Lo que no distingue es **quién contestó**: hoy el valor `OK` puede
-- venir de ARCA o de que alguien lo escribió en el cuerpo del pedido, y una vez
-- guardado se ven idénticos.
--
-- Eso convierte una verificación en una afirmación, que es exactamente la
-- frontera que el §11 pide no cruzar. Un comprobante apócrifo declarado como
-- constatado produce un crédito fiscal indebido sobre el que después cierran
-- perfectamente el Mayor, el Balance y los Estados Contables.
--
-- No se agrega otra tabla ni se reemplaza la columna: se agrega la
-- **procedencia**, que es el dato que faltaba.
--
-- ## 2 · Dar acceso a la contabilidad de un cliente no deja rastro
--
-- `grant_company_role` valida bien —nivel del actor, pertenencia al estudio,
-- rol existente— y no escribe ni una línea de auditoría. Tampoco la ruta. Un
-- estudio no puede reconstruir quién le dio a quién acceso a qué empresa, que
-- es de las primeras preguntas de cualquier revisión.
--
-- El candado va en la **tabla**, no en la función ni en la ruta: así cubre los
-- tres caminos —API, función y SQL directo— con una sola pieza. Es el mismo
-- criterio de `audit_tax_affectation` (0031) y `audit_accounting_decision`
-- (0034), y por eso reutiliza `audit_logs` en vez de inventar una bitácora
-- nueva: `user_company_roles` **sí** tiene `company_id`, así que el acto ocurre
-- dentro de una empresa y ahí es donde se tiene que poder leer.

-- ---------------------------------------------------------------------------
-- 1 · Procedencia de la constatación
-- ---------------------------------------------------------------------------

ALTER TABLE tax_transactions
  ADD COLUMN constatacion_origen text NOT NULL DEFAULT 'NO_CONSULTADO',
  ADD COLUMN constatacion_at     timestamptz,
  ADD COLUMN constatacion_por    text,
  ADD COLUMN arca_query_id       uuid REFERENCES arca_query_log (id);

COMMENT ON COLUMN tax_transactions.constatacion_origen IS
  'De dónde salió el valor de constatacion: ARCA lo contestó, una persona lo '
  'declaró bajo su responsabilidad, nadie preguntó, o —ORIGEN_NO_REGISTRADO— la '
  'fila es anterior a esta columna y su procedencia no se puede establecer. Sin '
  'esta columna, un dato verificado y uno afirmado se ven iguales.';

-- Las filas anteriores a esta migración tienen un resultado y **ninguna forma
-- de saber de dónde salió**: se escribía en el cuerpo del pedido y no quedaba
-- registro de si alguien lo verificó o lo escribió de memoria.
--
-- Las tres salidas posibles, y por qué esta:
--
--   · marcarlas `DECLARACION_PROFESIONAL` sería **fabricar una firma** que nadie
--     puso, que es exactamente lo que esta migración existe para impedir;
--   · volverlas a `NO_CONSULTADO` borraría el dato y, con él, la evidencia de
--     que estas filas existen y hay que revisarlas;
--   · marcarlas como lo que son deja el resultado a la vista y dice que su
--     origen no se puede establecer.
--
-- Es el mismo criterio que `FUENTE NO ENCONTRADA` y que `NO_VERIFICABLE`: el
-- sistema dice lo que no sabe en vez de completarlo.
UPDATE tax_transactions
   SET constatacion_origen = 'ORIGEN_NO_REGISTRADO'
 WHERE constatacion <> 'NO_CONSULTADO';

ALTER TABLE tax_transactions
  ADD CONSTRAINT tt_constatacion_origen_conocido
    CHECK (constatacion_origen IN
      ('NO_CONSULTADO', 'ARCA', 'DECLARACION_PROFESIONAL', 'ORIGEN_NO_REGISTRADO')),

  -- Sin consultar no hay resultado, y con resultado hay que decir de dónde
  -- salió. Las dos direcciones, porque las dos formas de mentir importan.
  ADD CONSTRAINT tt_constatacion_coherente
    CHECK (
      (constatacion = 'NO_CONSULTADO' AND constatacion_origen = 'NO_CONSULTADO')
      OR (constatacion <> 'NO_CONSULTADO' AND constatacion_origen <> 'NO_CONSULTADO')
    ),

  -- Una constatación de ARCA tiene que poder mostrarse: la fila del log es la
  -- prueba de que la consulta ocurrió, con su ambiente y su respuesta cruda.
  ADD CONSTRAINT tt_constatacion_arca_con_consulta
    CHECK (constatacion_origen <> 'ARCA' OR arca_query_id IS NOT NULL),

  -- Una declaración profesional tiene firma y fecha. Igual que en
  -- `tax_affectations`: sin las dos, no es una declaración.
  ADD CONSTRAINT tt_constatacion_declarada_firmada
    CHECK (
      constatacion_origen <> 'DECLARACION_PROFESIONAL'
      OR (constatacion_por IS NOT NULL AND constatacion_at IS NOT NULL)
    );

-- El log de ARCA es de la misma empresa que la operación. Un JOIN por id sin
-- este control dejaría que la prueba de una empresa respalde el comprobante de
-- otra, que es la forma en que una fuga se convierte en una afirmación.
CREATE OR REPLACE FUNCTION assert_constatacion_coherente() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  log_company uuid;
  log_service text;
BEGIN
  IF NEW.arca_query_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT q.company_id, q.service INTO log_company, log_service
    FROM arca_query_log q WHERE q.id = NEW.arca_query_id;

  IF log_company IS NULL THEN
    RAISE EXCEPTION 'La consulta ARCA % no existe', NEW.arca_query_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF log_company <> NEW.company_id THEN
    RAISE EXCEPTION
      'La consulta ARCA % es de otra empresa: no puede respaldar esta operación fiscal',
      NEW.arca_query_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF log_service <> 'wscdc' THEN
    RAISE EXCEPTION
      'La consulta ARCA % es del servicio % y la constatación de comprobantes es wscdc',
      NEW.arca_query_id, log_service
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_transactions_constatacion_coherente
  BEFORE INSERT OR UPDATE ON tax_transactions
  FOR EACH ROW EXECUTE FUNCTION assert_constatacion_coherente();

-- Una constatación de ARCA no se pisa con otra cosa sin dejar la anterior a la
-- vista. Lo que sí se admite es pasar de NO_CONSULTADO a cualquiera: es el
-- camino normal.
CREATE OR REPLACE FUNCTION assert_constatacion_no_se_degrada() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.constatacion_origen = 'ARCA' AND NEW.constatacion_origen <> 'ARCA' THEN
    RAISE EXCEPTION
      'La operación % ya fue constatada por ARCA: una declaración profesional no reemplaza '
      'una respuesta del organismo. Volvé a consultar si hace falta actualizarla.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tax_transactions_constatacion_no_degrada
  BEFORE UPDATE ON tax_transactions
  FOR EACH ROW EXECUTE FUNCTION assert_constatacion_no_se_degrada();

-- ---------------------------------------------------------------------------
-- 2 · Auditoría de los cambios de permisos
-- ---------------------------------------------------------------------------
-- En la tabla y no en la función: `grant_company_role` es un camino, no el
-- único. Un `INSERT` a mano, un script de migración de datos o una futura ruta
-- de revocación pasan por acá igual.
--
-- El actor sale de `app.actor_id`, que `withCompany`/`withoutCompany` fijan en
-- cada transacción. Si no está —un `psql` suelto—, queda `current_user`, que es
-- menos informativo pero no es una mentira.

CREATE OR REPLACE FUNCTION audit_company_role() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fila       user_company_roles;
  actor      text;
  accion     text;
  antes      jsonb;
  despues    jsonb;
  rol_codigo text;
  email      text;
BEGIN
  fila := CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;

  actor := coalesce(nullif(current_setting('app.actor_id', true), ''), current_user);

  SELECT r.code INTO rol_codigo FROM roles r WHERE r.id = fila.role_id;
  SELECT u.email INTO email FROM users u WHERE u.id = fila.user_id;

  -- Un rol que se apaga poniéndole `valid_to` es una revocación, no una edición.
  -- Nombrarlo distinto es lo que permite buscarlo después.
  accion := CASE
    WHEN TG_OP = 'INSERT' THEN 'ROL_OTORGADO'
    WHEN TG_OP = 'DELETE' THEN 'ROL_ELIMINADO'
    WHEN OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL THEN 'ROL_REVOCADO'
    WHEN OLD.valid_to IS NOT NULL AND NEW.valid_to IS NULL THEN 'ROL_RESTITUIDO'
    ELSE 'ROL_MODIFICADO'
  END;

  antes := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE
    jsonb_build_object('validFrom', OLD.valid_from, 'validTo', OLD.valid_to) END;

  despues := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE
    jsonb_build_object('validFrom', NEW.valid_from, 'validTo', NEW.valid_to) END;

  INSERT INTO audit_logs
    (company_id, actor_type, actor_id, action, object_type, object_id,
     old_value, new_value, motivo, prev_hash, hash)
  VALUES (
    fila.company_id,
    'USER',
    actor,
    accion,
    'user_company_roles',
    fila.id,
    -- El rol y el destinatario van en los dos lados: quien lea la bitácora
    -- dentro de dos años tiene que poder entenderla sin resolver ids contra
    -- tablas que para entonces pueden haber cambiado.
    CASE WHEN antes IS NULL THEN NULL ELSE
      antes || jsonb_build_object('rol', rol_codigo, 'usuario', email, 'userId', fila.user_id) END,
    CASE WHEN despues IS NULL THEN NULL ELSE
      despues || jsonb_build_object('rol', rol_codigo, 'usuario', email, 'userId', fila.user_id) END,
    format('%s de %s sobre la empresa', rol_codigo, coalesce(email, fila.user_id::text)),
    '', ''
  );

  RETURN NULL;
END;
$$;

CREATE TRIGGER user_company_roles_audit
  AFTER INSERT OR UPDATE OR DELETE ON user_company_roles
  FOR EACH ROW EXECUTE FUNCTION audit_company_role();

-- ---------------------------------------------------------------------------
-- 3 · Permisos nuevos
-- ---------------------------------------------------------------------------
-- Declarar la afectación de un comprobante es un acto profesional: define si un
-- crédito fiscal se computa. Va con el CONTADOR, no con el ADMINISTRADOR, por
-- el mismo reparto del §42 que separa administrar el sistema de firmar la
-- contabilidad.

INSERT INTO permissions (code, description) VALUES
  ('tax_affectation:declare', 'Declarar profesionalmente la afectación fiscal de un comprobante'),
  ('tax_transaction:constatar', 'Constatar un comprobante contra ARCA');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'CONTADOR'
  AND p.code IN ('tax_affectation:declare', 'tax_transaction:constatar');
