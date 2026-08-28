-- 0035_una_operacion_por_documento.sql — el candado de idempotencia que faltaba.
--
-- `tax_transactions` no tenía forma de impedir que el mismo comprobante entrara
-- dos veces. No se notaba porque nadie la escribía en producción: las filas
-- venían de fixtures, que no reintentan.
--
-- ## Por qué la clave es el documento y no el número de comprobante
--
-- La tentación es `UNIQUE (company_id, cbte_tipo, punto_venta, cbte_numero)`.
-- Es incorrecta: ese trío identifica un comprobante **por emisor**, y en una
-- misma empresa conviven la Factura A 0001-00000005 de un proveedor y la de
-- otro. Sin el CUIT del emisor en la clave, dos comprobantes legítimos chocan.
--
-- Y con el CUIT tampoco alcanza, porque en VENTAS el emisor es la propia empresa
-- y `cuit_contraparte` es el receptor —que puede ser el mismo consumidor final
-- en mil operaciones distintas—.
--
-- El documento sí identifica la operación sin ambigüedad: un archivo archivado
-- con su hash es un comprobante concreto. Registrar el mismo documento dos veces
-- es el duplicado que hay que impedir, y `document_duplicates` ya se ocupa de
-- detectar que dos archivos distintos sean el mismo comprobante.
--
-- Parcial porque `document_id` es opcional: un ajuste de cierre es una operación
-- fiscal sin papel, y varios de esos conviven sin chocar entre sí.

CREATE UNIQUE INDEX tax_transactions_un_documento
  ON tax_transactions (document_id)
  WHERE document_id IS NOT NULL;

COMMENT ON INDEX tax_transactions_un_documento IS
  'Un documento archivado produce UNA operación fiscal. La idempotencia del '
  'registro se apoya acá y no en el número de comprobante, que no identifica '
  'sin el emisor.';
