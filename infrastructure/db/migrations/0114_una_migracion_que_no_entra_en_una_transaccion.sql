-- ============================================================================
-- 0114 — Una migración que no entra en una transacción
-- ============================================================================
--
-- El motor V1 importa a ~390 filas por segundo dentro de **una sola
-- transacción**. Medido: 3.000 terceros, 7,7 segundos. Cincuenta mil serían dos
-- minutos de transacción abierta, y una empresa real que llega de otro sistema
-- trae más que eso entre comprobantes y movimientos de stock.
--
-- El problema de la transacción única no es la velocidad: es que **no se puede
-- informar el progreso ni reanudar**. Si el proceso se corta a los 40.000, no
-- hay nada escrito y no hay forma de saber dónde estaba. Y mientras corre, la
-- pantalla no puede decir «12.400 de 50.000» porque no hay nada que consultar.
--
-- Esta migración agrega lo que hace falta para partirla en tandas sin perder
-- ninguna de las garantías del V1:
--
--   1. `migration_batches` — el punto de control de cada tanda.
--   2. Progreso en `migrations`, para que la pantalla lo pueda leer.
--   3. Dos estados nuevos: pedir la cancelación y quedar cancelada.
--   4. `origen_tipo = 'MIGRACION'` en el libro de stock.
--   5. Dos entidades canónicas más en el vocabulario de tablas.
--
-- La idempotencia sigue viviendo donde vivía: en el `UNIQUE` de
-- `migration_links`. Una tanda que se repite no duplica nada porque cada fila
-- vuelve a chocar contra esa restricción, no porque el lote lleve la cuenta.

-- ── 1 · Las tandas ─────────────────────────────────────────────────────────
--
-- Una fila por tanda, escrita **antes** de procesarla y cerrada después. Es lo
-- que permite contestar «¿por dónde iba?» sin releer el archivo, y lo que hace
-- que reanudar sea saltear las tandas que ya cerraron en vez de confiar en que
-- las escrituras anteriores se reconozcan una por una.

CREATE TABLE migration_batches (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  migration_id  uuid NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
  table_id      uuid NOT NULL REFERENCES migration_tables(id) ON DELETE CASCADE,

  -- El rango de filas del origen, cerrado en los dos extremos y en la misma
  -- numeración que `migration_rows.numero`. Guardarlo así —y no un «offset»—
  -- es lo que hace que una tanda se pueda volver a ejecutar sola.
  numero        integer NOT NULL CHECK (numero >= 1),
  desde         integer NOT NULL CHECK (desde >= 1),
  hasta         integer NOT NULL CHECK (hasta >= 1),

  estado        text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN (
                  'PENDIENTE','EN_CURSO','COMPLETADA','FALLIDA')),

  filas         integer NOT NULL DEFAULT 0 CHECK (filas >= 0),
  importados    integer NOT NULL DEFAULT 0 CHECK (importados >= 0),
  ya_estaban    integer NOT NULL DEFAULT 0 CHECK (ya_estaban >= 0),
  rechazados    integer NOT NULL DEFAULT 0 CHECK (rechazados >= 0),
  omitidos      integer NOT NULL DEFAULT 0 CHECK (omitidos >= 0),

  -- El hash de las filas crudas del rango. Si el archivo se volviera a cargar
  -- con otro contenido, la tanda ya no describe lo mismo y reanudar sería
  -- mentira. Con el hash se puede afirmar que sí.
  hash          text NOT NULL,

  intentos      integer NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  empezada_el   timestamptz,
  terminada_el  timestamptz,
  error         text,

  CONSTRAINT mb_rango_coherente CHECK (hasta >= desde),
  CONSTRAINT mb_terminada_con_fecha CHECK (
    estado <> 'COMPLETADA' OR terminada_el IS NOT NULL),
  CONSTRAINT mb_fallida_con_motivo CHECK (
    estado <> 'FALLIDA' OR length(btrim(coalesce(error,''))) > 0),

  UNIQUE (table_id, numero)
);

CREATE INDEX migration_batches_mig_idx ON migration_batches (migration_id, estado);

COMMENT ON TABLE migration_batches IS
  'El punto de control de cada tanda de una importación. Permite informar el '
  'progreso y reanudar una migración cortada sin volver a escribir lo ya escrito. '
  'La garantía contra duplicados sigue siendo el UNIQUE de migration_links.';
COMMENT ON COLUMN migration_batches.hash IS
  'Hash de las filas crudas del rango: reanudar sobre un archivo distinto no es '
  'reanudar, y esto lo hace comprobable.';

-- ── 2 · El progreso, donde la pantalla lo pueda leer ───────────────────────

ALTER TABLE migrations
  ADD COLUMN filas_totales    integer NOT NULL DEFAULT 0 CHECK (filas_totales >= 0),
  ADD COLUMN filas_procesadas integer NOT NULL DEFAULT 0 CHECK (filas_procesadas >= 0),
  ADD COLUMN cancelada_el     timestamptz,
  ADD COLUMN cancelada_motivo text;

COMMENT ON COLUMN migrations.filas_procesadas IS
  'Cuántas filas de las incluidas ya pasaron por el importador. Se actualiza al '
  'cerrar cada tanda: es lo que la pantalla muestra como «12.400 de 50.000».';

-- ── 3 · Cancelar ───────────────────────────────────────────────────────────
--
-- Dos estados y no uno. `CANCELACION_PEDIDA` la escribe quien aprieta el botón;
-- `CANCELADA` la escribe el importador cuando termina la tanda en curso y ve el
-- pedido. Con un solo estado habría que matar el proceso a mitad de una tanda,
-- que es exactamente lo que las tandas existen para evitar.

ALTER TABLE migrations DROP CONSTRAINT migrations_estado_check;
ALTER TABLE migrations ADD CONSTRAINT migrations_estado_check CHECK (estado IN (
  'CREADA','CARGADA','ANALIZADA','MAPEADA','VALIDADA','LISTA',
  'IMPORTANDO','CANCELACION_PEDIDA','CANCELADA',
  'COMPLETADA','COMPLETADA_CON_ADVERTENCIAS','FALLIDA','REVERTIDA'));

ALTER TABLE migrations ADD CONSTRAINT mig_cancelada_con_fecha CHECK (
  estado <> 'CANCELADA' OR cancelada_el IS NOT NULL);

-- ── 4 · El libro de stock acepta decir «esto vino de una migración» ────────
--
-- Hasta hoy un movimiento solo podía venir de una recepción, una venta, un
-- ajuste o una transferencia. Un movimiento migrado no es ninguna de esas
-- cuatro cosas, y hacerlo pasar por `AJUSTE` sería mentir sobre su origen: un
-- ajuste dice «alguien contó y había otra cantidad», y acá nadie contó nada.
--
-- `origen_id` es el id de la migración. No lleva clave foránea porque la
-- columna ya sirve a cuatro orígenes distintos —cada uno apunta a otra tabla—,
-- y el índice `sm_por_origen` alcanza para encontrarlos.
--
-- Lo que NO cambia: el libro sigue sin poder editarse ni borrarse. Revertir una
-- migración de stock escribe los movimientos inversos, igual que anular un
-- asiento escribe un contraasiento. Una existencia que desaparece del libro es
-- una existencia que nadie puede auditar.

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_origen_tipo_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_origen_tipo_check
  CHECK (origen_tipo IN ('RECEPCION','VENTA','AJUSTE','TRANSFERENCIA','MIGRACION'));

ALTER TABLE stock_movements DROP CONSTRAINT sm_tipo_coherente;
ALTER TABLE stock_movements ADD CONSTRAINT sm_tipo_coherente
  CHECK ((origen_tipo = 'RECEPCION'     AND tipo = 'ENTRADA')
      OR (origen_tipo = 'VENTA'         AND tipo = 'SALIDA')
      OR (origen_tipo = 'AJUSTE'        AND tipo IN ('AJUSTE_POSITIVO','AJUSTE_NEGATIVO'))
      OR (origen_tipo = 'TRANSFERENCIA' AND tipo IN ('TRANSFERENCIA_ENTRADA','TRANSFERENCIA_SALIDA'))
      -- Una migración trae el histórico tal como estaba: entradas, salidas y los
      -- ajustes que el sistema anterior ya tenía registrados.
      OR (origen_tipo = 'MIGRACION'     AND tipo IN ('ENTRADA','SALIDA',
                                                     'AJUSTE_POSITIVO','AJUSTE_NEGATIVO')));

ALTER TABLE stock_movements DROP CONSTRAINT sm_origen_citado;
ALTER TABLE stock_movements ADD CONSTRAINT sm_origen_citado
  CHECK (origen_tipo NOT IN ('RECEPCION','VENTA','MIGRACION') OR origen_id IS NOT NULL);

-- El costo unitario solo entraba en `ENTRADA` y `AJUSTE_POSITIVO`. Un histórico
-- migrado puede traer el costo de cualquier movimiento, pero solo el de las
-- entradas alimenta el promedio ponderado, así que la regla se deja como está:
-- guardar un costo que el PPP ignora sería guardar un número que no significa
-- lo que parece.

COMMENT ON COLUMN stock_movements.origen_tipo IS
  'De dónde viene el movimiento. MIGRACION es el histórico traído de otro '
  'sistema, con origen_id apuntando a la migración que lo trajo: no es un '
  'AJUSTE, porque nadie contó nada.';

-- ── 5 · Dos entidades canónicas más ────────────────────────────────────────
--
-- `WAREHOUSE` porque un movimiento de stock necesita un depósito y el sistema
-- de origen trae los suyos. `COLLECTION` porque una cobranza es una entidad del
-- dominio aunque hoy no se pueda escribir — el motor la transporta y la muestra,
-- y el motivo de que no se importe está dicho en el código.

ALTER TABLE migration_tables DROP CONSTRAINT migration_tables_entidad_check;
ALTER TABLE migration_tables ADD CONSTRAINT migration_tables_entidad_check
  CHECK (entidad IS NULL OR entidad IN (
    'PARTY','PRODUCT','WAREHOUSE','ACCOUNT','JOURNAL_ENTRY','STOCK_BALANCE',
    'STOCK_MOVEMENT','SALES_DOCUMENT','PURCHASE_DOCUMENT','COLLECTION','PAYMENT'));

-- ── 6 · Aislamiento de las tandas ──────────────────────────────────────────

ALTER TABLE migration_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY migration_batches_por_empresa ON migration_batches
  USING (company_id = app_company_id())
  WITH CHECK (company_id = app_company_id());

-- Una tanda es el estado de un proceso, no la prueba de lo que el origen tenía:
-- se actualiza mientras corre. Lo que no se borra es la fila cruda.
REVOKE DELETE ON migration_batches FROM aai_app;

-- ── 7 · Vocabulario de auditoría ───────────────────────────────────────────

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  -- Cancelar deja la empresa a medio cargar a propósito. Sin motivo, seis meses
  -- después nadie sabe si fue un error de datos o una decisión.
  ('CANCELAR_MIGRACION', 'migracion', true),
  ('REANUDAR_MIGRACION', 'migracion', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
