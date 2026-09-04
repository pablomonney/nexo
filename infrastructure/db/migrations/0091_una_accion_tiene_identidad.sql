-- ============================================================================
-- 0091 — Una acción tiene identidad, no solo un nombre
-- ============================================================================
--
-- `audit_logs.action` era texto libre, y el candado más importante de la
-- bitácora —«estas cinco acciones exigen motivo»— comparaba **contra cinco
-- literales escritos en un CHECK**. S-20 lo encontró y lo comprobó rompiéndolo:
-- renombrar `ANULAR_ASIENTO` no rompe nada visible y apaga el candado en
-- silencio. El contraasiento pasa a admitirse sin explicación, y nadie se entera
-- hasta que alguien busca por qué se anuló un asiento y no hay respuesta.
--
-- El problema no es que la lista estuviera desactualizada: es que la regla
-- dependía de un string. Un nombre es una etiqueta; lo que faltaba es una
-- **identidad**.
--
-- ## Lo que apareció al construir el registro
--
-- Hay **tres caminos** por los que una acción llega a la bitácora, y el barrido
-- de S-20 veía uno solo:
--
--   1. `action: 'LITERAL'` en TypeScript — 112 acciones. Es lo que S-20 mide.
--   2. `accion: 'LITERAL'` en las tablas de acciones de una ruta, que un ayudante
--      pasa a `recordAudit` — 9 más, **sin medir**.
--   3. **Triggers SQL** que insertan en `audit_logs` desde la base — 9 más, sin
--      medir tampoco.
--
-- Así que cuando S-20 decía «106 acciones, todas VERBO_EN_MAYUSCULAS», estaba
-- diciendo la verdad sobre lo que veía. Dos de las que no veía —las del trigger
-- de afectaciones— están **en inglés**: `AFFECTATION_DECLARED` y
-- `AFFECTATION_CHANGED`, en un vocabulario que es castellano en todo lo demás.
-- Las renombra la 0092; acá quedan registradas como lo que la bitácora ya dice.
--
-- ## Qué cambia
--
-- `audit_actions` es el registro de las acciones que el sistema sabe emitir, y
-- `audit_logs.action` lo referencia:
--
--   · Una acción sin registrar **no se puede escribir**. Renombrar una acción sin
--     registrar el nombre nuevo ya no apaga un candado: falla la escritura,
--     ruidosamente, en la primera prueba que la ejercite.
--
--   · La regla del motivo deja de vivir en un CHECK con literales y pasa a leer
--     `requiere_motivo` del registro. Es la misma regla dependiendo de una
--     estructura en vez de un texto.
--
-- Un CHECK no puede consultar otra tabla, así que la regla es ahora un trigger.
-- No es un rodeo: es lo que permite que la regla y la lista sean **una sola
-- cosa** en vez de dos que hay que mantener iguales.
--
-- ## Las tres decisiones
--
-- **1. El id es el nombre.** No se agrega un identificador numérico al lado del
-- texto. El vocabulario ya es estable y legible —`VERBO_EN_MAYUSCULAS`— y ponerle
-- un segundo identificador obligaría a traducir en cada consulta y en cada
-- pantalla. Lo que faltaba no era otro identificador: era que el que hay
-- estuviera registrado en algún lado.
--
-- **2. No hay columna de criticidad.** Sería inventar una clasificación que nadie
-- consume, y este repositorio tiene barridos que persiguen exactamente eso: una
-- estructura sin escritor ni lector es un hueco. Cuando algo necesite distinguir
-- criticidad, la columna se agrega con su consumidor.
--
-- **3. `id` no lleva CHECK de forma.** La forma del vocabulario es una regla
-- sobre lo que se **escribe de acá en adelante**, y la defiende S-20 sobre el
-- código. Este registro tiene que poder nombrar además lo que la bitácora **ya
-- dice**: hay filas viejas con `objeto.verbo`, de antes de la normalización, y la
-- bitácora es append-only. Un CHECK acá haría que la clave foránea no se pudiera
-- crear sobre datos reales, y la salida fácil sería borrar historia.
-- ============================================================================

CREATE TABLE audit_actions (
  id              text PRIMARY KEY,
  -- Dónde vive la escritura: el archivo de la ruta, el trigger que la emite, o
  -- `historico` para lo que la bitácora ya dice y hoy no emite nadie. Es un
  -- hecho comprobable, no una taxonomía inventada.
  dominio         text NOT NULL,
  -- La regla que antes estaba en un CHECK con cinco literales.
  requiere_motivo boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE audit_actions IS
  'Registro de las acciones que el sistema sabe emitir. `audit_logs.action` lo '
  'referencia: una acción sin registrar no se puede escribir. La regla del '
  'motivo vive acá, no en un CHECK con literales.';

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('ABRIR_CAJA', 'caja', false),
  ('ABRIR_CONCILIACION', 'banks', false),
  ('ABRIR_EJERCICIO', 'closures', false),
  ('ABRIR_RECUENTO', 'recuentos', false),
  ('ACEPTAR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('ACTIVAR_REGLA', 'sin-escritor', true),
  ('ACTUALIZAR_ETAPA_CRM', 'crm', false),
  ('ACTUALIZAR_VENDEDOR', 'comisiones', false),
  ('AFFECTATION_CHANGED', 'trigger:0031', false),
  ('AFFECTATION_DECLARED', 'trigger:0031', false),
  ('ALTA_DE_BIEN_DE_USO', 'activos', false),
  ('AMORTIZAR_EJERCICIO', 'activos', false),
  ('ANULAR_APLICACION_DE_NOTA', 'imputaciones', false),
  ('ANULAR_ASIENTO', 'journal-entries', true),
  ('ANULAR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('ANULAR_IMPUTACION', 'imputaciones', false),
  ('ANULAR_ORDEN_DE_PAGO', 'ordenes-de-pago', false),
  ('ANULAR_RECEPCION', 'recepciones', false),
  ('ANULAR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('APLICAR_NOTA', 'imputaciones', false),
  ('APROBAR_ASIENTO', 'journal-entries', false),
  ('APROBAR_ORDEN_DE_PAGO', 'ordenes-de-pago', false),
  ('APROBAR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('ARCHIVAR_ESCENARIO', 'analisis', false),
  ('ARMAR_ORDEN_DE_PAGO', 'ordenes-de-pago', false),
  ('ARMAR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('ARQUEAR_CAJA', 'caja', false),
  ('ASIGNAR_LISTA_DE_PRECIOS', 'precios', false),
  ('ATRIBUIR_VENTA_A_VENDEDOR', 'comisiones', false),
  ('BAJA_DE_BIEN_DE_USO', 'activos', false),
  ('BLOQUEAR_PERIODO', 'periods', false),
  ('CAMBIAR_ESTADO_DE_PLAN', 'suscripciones', false),
  ('CAMBIAR_PLAN_CUENTAS', 'accounts', true),
  ('CARGAR_CHEQUE', 'cheques', false),
  ('CARGAR_PRECIOS', 'precios', false),
  ('CERRAR_EJERCICIO', 'closures', false),
  ('CERRAR_PERIODO', 'periods', false),
  ('CERRAR_PROYECTO', 'proyectos', false),
  ('CERRAR_RECUENTO', 'recuentos', false),
  ('CERRAR_SUCURSAL', 'sucursales', false),
  ('CONECTAR_INTEGRACION', 'integraciones', false),
  ('CONFIRMAR_CONCILIACION', 'banks', false),
  ('CONFIRMAR_RECEPCION', 'recepciones', false),
  ('CONSTATAR_COMPROBANTE', 'comprobantes', false),
  ('CONSULTAR_PANORAMA', 'intelligence', false),
  ('CONVERTIR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('CORREGIR_CAMPO_EXTRAIDO', 'documents', false),
  ('CREAR_ASIENTO', 'journal-entries', false),
  ('CREAR_CAJA', 'caja', false),
  ('CREAR_CENTRO_DE_COSTO', 'accounts', false),
  ('CREAR_CUENTA_BANCARIA', 'banks', false),
  ('CREAR_DEPOSITO', 'stock', false),
  ('CREAR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('CREAR_EJERCICIO', 'periods', false),
  ('CREAR_LISTA_DE_PRECIOS', 'precios', false),
  ('CREAR_MAPEO_DE_EXTRACTO', 'banks', false),
  ('CREAR_OPORTUNIDAD', 'crm', false),
  ('CREAR_PRODUCTO', 'products', false),
  ('CREAR_PROYECTO', 'proyectos', false),
  ('CREAR_RECEPCION', 'recepciones', false),
  ('CREAR_SUCURSAL', 'sucursales', false),
  ('CREAR_TERCERO', 'parties', false),
  ('CREAR_VENDEDOR', 'comisiones', false),
  ('CREDENCIAL_ARCA_CARGADA', 'arca', false),
  ('CREDENCIAL_ARCA_REVOCADA', 'arca', false),
  ('DECISION_CAMBIADA', 'trigger:0034', false),
  ('DECISION_CORREGIDA', 'decisions', false),
  ('DECISION_EMITIDA', 'trigger:0034', false),
  ('DECISION_REGISTRADA', 'decisions', false),
  ('DECLARAR_AFECTACION', 'afectaciones', false),
  ('DECLARAR_DEPOSITO_POR_DEFECTO', 'stock', false),
  ('DECLARAR_ESQUEMA_DE_COMISION', 'comisiones', false),
  ('DECLARAR_ETAPA_CRM', 'crm', false),
  ('DECLARAR_MAPEO_CONTABLE', 'mapeo-contable', false),
  ('DECLARAR_METODO_DE_VALUACION', 'valuacion', false),
  ('DECLARAR_PLAN', 'suscripciones', false),
  ('DECLARAR_PLAN_DE_PAGOS', 'imputaciones', false),
  ('DECLARAR_PUNTO_DE_VENTA', 'sucursales', false),
  ('DECLARAR_TARIFA_HORARIA', 'proyectos', false),
  ('DECLARAR_UMBRALES_DE_ANALISIS', 'analisis', false),
  ('DEFINIR_MARCO_CONTABLE', 'studio', false),
  ('DESCARTAR_REGISTRO_EXTERNO', 'integraciones', false),
  ('DESCONECTAR_INTEGRACION', 'integraciones', false),
  ('DETALLAR_COMPROBANTE', 'comprobantes', false),
  ('DETALLAR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('DETALLAR_RECEPCION', 'recepciones', false),
  ('EDITAR_ORDEN_DE_PAGO', 'ordenes-de-pago', false),
  ('EDITAR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('EMITIR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('EMITIR_ESTADO_CONTABLE', 'statements', false),
  ('EMITIR_LIBRO', 'books', false),
  ('ENVIAR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('FACTURAR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('GENERAR_LIBRO_IVA', 'vat', false),
  ('GUARDAR_ESCENARIO', 'analisis', false),
  ('IMPORTAR_EXTRACTO', 'banks', false),
  ('IMPUTAR_COBRO', 'imputaciones', false),
  ('INGESTAR_ARCHIVO_EXTERNO', 'integraciones', false),
  ('INGESTAR_REGISTROS_EXTERNOS', 'integraciones', false),
  ('INGRESAR_DOCUMENTO', 'documents', false),
  ('MEJORA_DE_BIEN_DE_USO', 'activos', false),
  ('MODIFICAR_PRODUCTO', 'products', false),
  ('MODIFICAR_TERCERO', 'parties', false),
  ('MOVER_CHEQUE', 'cheques', false),
  ('MOVER_OPORTUNIDAD', 'crm', false),
  ('NOTAS_GENERADAS', 'notes', false),
  ('NOTA_APROBADA', 'notes', false),
  ('NOTA_VERSIONADA', 'notes', false),
  ('OPERACION_FISCAL_REGISTRADA', 'comprobantes', false),
  ('PAGAR_ORDEN_DE_PAGO', 'ordenes-de-pago', false),
  ('PRE_CERRAR_EJERCICIO', 'closures', false),
  ('PROPONER_CLASIFICACION', 'predictions', false),
  ('REABRIR_PERIODO', 'periods', true),
  ('RECHAZAR_DOCUMENTO', 'documents', false),
  ('RECHAZAR_DOCUMENTO_COMERCIAL', 'comercial', false),
  ('RECHAZAR_SOLICITUD_DE_COMPRA', 'solicitudes-de-compra', false),
  ('RECLASIFICAR_APROBADO', 'sin-escritor', true),
  ('REEXTRAER_DOCUMENTO', 'documents', false),
  ('REGISTRAR_SALIDA_DE_STOCK', 'stock', false),
  ('RESOLVER_DUPLICADO', 'documents', false),
  ('RESOLVER_REGISTRO_EXTERNO', 'integraciones', false),
  ('REVISAR_PROPUESTA_IA', 'predictions', false),
  ('ROL_ELIMINADO', 'trigger:0043', false),
  ('ROL_MODIFICADO', 'trigger:0043', false),
  ('ROL_OTORGADO', 'trigger:0043', false),
  ('ROL_RESTITUIDO', 'trigger:0043', false),
  ('ROL_REVOCADO', 'trigger:0043', false),
  ('TRANSFERIR_STOCK', 'stock', false),
  ('VERIFICAR_MAYOR', 'books', false),
  ('VINCULAR_FACTURA_DE_COMPRA', 'comercial', false),
  ('VINCULAR_PRESUPUESTO', 'crm', false),
  ('VINCULAR_TERCERO', 'comprobantes', false)
;

-- Lo que ya está escrito en la bitácora de esta base y no emite ningún archivo
-- ni ningún trigger de hoy. Sin esto la clave foránea no se puede crear sobre
-- datos existentes, y la bitácora no se reescribe para que encaje.
INSERT INTO audit_actions (id, dominio, requiere_motivo)
SELECT DISTINCT l.action, 'historico', false
  FROM audit_logs l
 WHERE NOT EXISTS (SELECT 1 FROM audit_actions a WHERE a.id = l.action);

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_fk FOREIGN KEY (action) REFERENCES audit_actions (id);

-- La regla del motivo, ahora leyendo el registro.
--
-- Se quita el CHECK con los cinco literales. La regla no cambia: cambia de qué
-- depende. Antes, de que el nombre coincidiera con uno de cinco textos; ahora,
-- de una fila que dice que esa acción exige motivo.
ALTER TABLE audit_logs DROP CONSTRAINT audit_reason_required;

CREATE OR REPLACE FUNCTION audit_reason_required() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  exige boolean;
BEGIN
  SELECT requiere_motivo INTO exige FROM audit_actions WHERE id = NEW.action;

  -- `exige IS NULL` no debería poder pasar: la clave foránea ya rechaza una
  -- acción sin registrar. Se contempla igual, porque un trigger que da por
  -- sentado que no puede fallar es un trigger que falla en silencio.
  IF exige IS NULL THEN
    RAISE EXCEPTION 'E_AUDIT_ACTION_DESCONOCIDA: la accion % no esta en audit_actions', NEW.action;
  END IF;

  -- Un motivo en blanco no es un motivo. El CHECK anterior solo pedía
  -- `IS NOT NULL`, así que una cadena vacía lo satisfacía.
  IF exige AND (NEW.motivo IS NULL OR btrim(NEW.motivo) = '') THEN
    RAISE EXCEPTION 'E_AUDIT_MOTIVO_REQUERIDO: la accion % exige motivo', NEW.action;
  END IF;

  RETURN NEW;
END;
$$;

-- `00_` adelante para que corra antes que el encadenamiento por hash: si la
-- escritura va a ser rechazada, que lo sea antes de tomar el lock de la cadena.
CREATE TRIGGER "00_audit_reason_required"
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_reason_required();

GRANT SELECT ON audit_actions TO aai_app;
