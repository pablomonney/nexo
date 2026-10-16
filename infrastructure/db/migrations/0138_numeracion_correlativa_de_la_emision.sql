-- ---------------------------------------------------------------------------
-- La numeración fiscal es correlativa: ARCA no tolera huecos, y un rechazo no consume número
-- ---------------------------------------------------------------------------
--
-- **No habilita emitir.** Corrige un supuesto de la migración 0117 que se midió falso contra ARCA (homologación,
-- 2026-10-16, E4 de `docs/EMISION_DE_FACTURAS_PLAN.md`).
--
-- ## Lo que 0117 suponía
--
--     «Si ARCA rechaza, ese número se consumió.» · «No se pretende que los huecos sean imposibles.»
--
-- ## Lo que ARCA hace de verdad
--
--   1. Pedir un número **saltado** (último autorizado + 2) se rechaza con el error **10016**: «El numero o fecha del
--      comprobante no se corresponde con el proximo a autorizar. Consultar metodo FECompUltimoAutorizado.» No autoriza nada.
--   2. Un comprobante **rechazado** no avanza el «último autorizado»: el siguiente que se pida tiene que llevar **el mismo
--      número** que el rechazado.
--
-- Con 0117 tal como estaba, después del primer rechazo la numeración de ese punto de venta quedaba trabada: el contador local
-- seguía adelante, ARCA exigía el número anterior, y cada intento nuevo se rechazaba por el hueco que el propio sistema
-- había abierto. La numeración correlativa **no se resuelve adivinando localmente: se resuelve siguiendo a ARCA**.
--
-- ## Qué cambia
--
--   · El número de una intención **RECHAZADA** vuelve a ser libre: ARCA nunca lo autorizó. (Un número en DESCONOCIDA o en
--     RECONCILIANDO sigue ocupado: puede estar autorizado, y reusarlo sería la doble emisión por otro camino.)
--   · `reservar_numero_fiscal_correlativo(intención, último_autorizado_por_ARCA)`: sincroniza el contador con lo que dice
--     ARCA y recién entonces reserva. Garantiza que el número reservado es exactamente **el siguiente al último autorizado**.
--   · **Una sola emisión en curso por punto de venta y tipo.** Como la numeración es estrictamente secuencial, dos emisiones
--     simultáneas en el mismo punto de venta y tipo no pueden ir en paralelo: la segunda esperaría un número que todavía no
--     se sabe. La función serializa por «carril» (empresa, ambiente, punto de venta, tipo) y se niega a reservar mientras
--     haya otra intención LISTA, EMITIENDO, DESCONOCIDA o RECONCILIANDO en el mismo carril. Una intención LISTA que nadie va
--     a emitir se saca del medio anulándola (`LISTA → ANULADA` ya existe).
--   · Se niega a reservar si ARCA dice un último autorizado **menor** que el mayor que esta empresa tiene autorizado: algo no
--     cierra y adivinar sería peor que decirlo.
--
-- `reservar_numero_fiscal` (0117) **no cambia**: sigue siendo la reserva simple, idempotente, sobre la que se apoya ésta.
-- ---------------------------------------------------------------------------

-- 1 · El número de una intención rechazada vuelve a estar libre.
DROP INDEX IF EXISTS fiscal_emissions_un_numero;

CREATE UNIQUE INDEX fiscal_emissions_un_numero
  ON fiscal_emissions (company_id, ambiente, punto_venta, cbte_tipo, cbte_numero)
  WHERE cbte_numero IS NOT NULL AND estado NOT IN ('ANULADA', 'RECHAZADA');

COMMENT ON INDEX fiscal_emissions_un_numero IS
  'Dos intenciones vivas no pueden tener el mismo número. Una RECHAZADA no cuenta: ARCA nunca la autorizó y no avanzó la '
  'numeración, así que el siguiente pedido lleva ese mismo número. Una en DESCONOCIDA sí cuenta: puede estar autorizada.';

-- 2 · La reserva que sigue a ARCA.
CREATE OR REPLACE FUNCTION reservar_numero_fiscal_correlativo(
  p_emision_id   uuid,
  p_ultimo_arca  bigint
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_emision          fiscal_emissions%ROWTYPE;
  v_max_autorizado   bigint;
BEGIN
  SELECT * INTO v_emision FROM fiscal_emissions WHERE id = p_emision_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe la intención fiscal %', p_emision_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotente: si ya tenía número, es ése. Un reintento no consume otro.
  IF v_emision.cbte_numero IS NOT NULL THEN
    RETURN v_emision.cbte_numero;
  END IF;

  IF v_emision.estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'Una intención en % no puede reservar número', v_emision.estado
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_ultimo_arca IS NULL OR p_ultimo_arca < 0 THEN
    RAISE EXCEPTION 'El último autorizado informado por ARCA no es válido: %', p_ultimo_arca
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- El carril: la numeración es estrictamente secuencial, así que todo lo que reserva o emite en el mismo punto de venta y
  -- tipo se serializa acá. El candado vive hasta el final de la transacción.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'fiscal-carril:' || v_emision.company_id::text || ':' || v_emision.ambiente || ':' ||
    v_emision.punto_venta::text || ':' || v_emision.cbte_tipo::text, 0));

  IF EXISTS (
    SELECT 1 FROM fiscal_emissions o
     WHERE o.company_id = v_emision.company_id
       AND o.ambiente = v_emision.ambiente
       AND o.punto_venta = v_emision.punto_venta
       AND o.cbte_tipo = v_emision.cbte_tipo
       AND o.id <> p_emision_id
       AND o.estado IN ('LISTA', 'EMITIENDO', 'DESCONOCIDA', 'RECONCILIANDO')
  ) THEN
    RAISE EXCEPTION
      'Hay otra emisión sin resolver en el punto de venta % (tipo %). La numeración es correlativa: resolvela (emitila, '
      'reconciliala o anulala) antes de reservar otro número',
      v_emision.punto_venta, v_emision.cbte_tipo
      USING ERRCODE = 'lock_not_available';
  END IF;

  SELECT coalesce(max(o.cbte_numero), 0) INTO v_max_autorizado
    FROM fiscal_emissions o
   WHERE o.company_id = v_emision.company_id
     AND o.ambiente = v_emision.ambiente
     AND o.punto_venta = v_emision.punto_venta
     AND o.cbte_tipo = v_emision.cbte_tipo
     AND o.estado = 'AUTORIZADA';

  IF p_ultimo_arca < v_max_autorizado THEN
    RAISE EXCEPTION
      'ARCA informa que el último autorizado es % y esta empresa tiene autorizado el %. No cierra: no se reserva número',
      p_ultimo_arca, v_max_autorizado
      USING ERRCODE = 'check_violation';
  END IF;

  -- El contador sigue a ARCA: la fuente de verdad de la numeración es el organismo, no esta tabla.
  INSERT INTO fiscal_counters (company_id, ambiente, punto_venta, cbte_tipo, last_number)
  VALUES (v_emision.company_id, v_emision.ambiente, v_emision.punto_venta, v_emision.cbte_tipo, p_ultimo_arca)
  ON CONFLICT (company_id, ambiente, punto_venta, cbte_tipo)
    DO UPDATE SET last_number = EXCLUDED.last_number;

  RETURN reservar_numero_fiscal(p_emision_id);
END;
$$;

COMMENT ON FUNCTION reservar_numero_fiscal_correlativo IS
  'Reserva EL SIGUIENTE al último autorizado por ARCA y pasa la intención a LISTA. Serializa por punto de venta y tipo: '
  'una sola emisión en curso por carril. Idempotente.';
