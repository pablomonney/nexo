-- ============================================================================
-- 0106 — Una prueba que termina
-- ============================================================================
--
-- `company_subscriptions.estado` admite `PRUEBA` desde la 0073 y **nada la hace
-- terminar**. Una prueba que no vence no es una prueba: es el producto gratis,
-- y el sistema no tenía forma de notar la diferencia.
--
-- ## Una sola fuente de verdad, y ya existía
--
-- La tentación es agregar `trial_ends_at`. No hace falta y sería peor: la
-- suscripción ya tiene `vigencia_hasta`, que dice hasta cuándo rige. Para una
-- prueba, hasta cuándo rige **es** cuándo termina la prueba.
--
-- Dos columnas para el mismo hecho se desincronizan, y el día que difieran no
-- va a haber forma de saber cuál manda (ADR-022). Así que:
--
--     estado = 'PRUEBA' AND vigencia_hasta = el día que termina
--
-- El `CHECK` de abajo hace que una prueba sin fecha de fin sea imposible. Sin
-- él, la regla viviría en el código que da de alta, y el primer alta por otro
-- camino dejaría una prueba eterna.
--
-- ## Termina suspendida, no cancelada
--
-- Cuando la prueba vence sin conversión, la suscripción pasa a `SUSPENDIDA`.
--
-- No a `CANCELADA`, y la diferencia importa: cancelar es una decisión del
-- cliente, y de `CANCELADA` no se vuelve. Quien dejó vencer una prueba no
-- decidió nada — se le acabó el tiempo, y va a poder contratar mañana sin que
-- el sistema le exija empezar de cero.
--
-- Suspender conserva todo: los datos, la contabilidad y el historial. Es
-- exactamente el mismo estado que la falta de pago, y por el mismo motivo.
--
-- ## Convertir no borra la prueba
--
-- Pasar de `PRUEBA` a `ACTIVA` es un `UPDATE` sobre la misma fila: la vigencia
-- sigue siendo la misma, cambia el estado y aparecen las condiciones acordadas.
-- Cerrar la prueba y abrir otra suscripción partiría en dos la historia de un
-- cliente que nunca se fue.
-- ============================================================================

-- Una prueba sin fecha de fin no es una prueba.
ALTER TABLE company_subscriptions
  ADD CONSTRAINT cs_prueba_con_vencimiento
    CHECK (estado <> 'PRUEBA' OR vigencia_hasta IS NOT NULL);

COMMENT ON COLUMN company_subscriptions.vigencia_hasta IS
  'Hasta cuándo rige. En una PRUEBA es el día que termina, y es obligatorio: '
  'no hay una columna aparte para eso porque dos columnas sobre el mismo hecho '
  'se desincronizan (ADR-022).';

-- ---------------------------------------------------------------------------
-- Acciones auditadas
-- ---------------------------------------------------------------------------
--
-- `VENCER_PRUEBA` exige motivo por lo mismo que `SUSPENDER_POR_FALTA_DE_PAGO`:
-- es el acto que le corta el acceso a alguien, y tiene que poder explicarse sin
-- reconstruirlo desde las fechas.
--
-- `CONVERTIR_PRUEBA` no lo exige: es el camino feliz, y lo que hay que poder
-- mirar —el plan y el importe acordado— queda en `new_value`. Pedir motivo en
-- lo cotidiano entrena a escribir «conversión» y devalúa el motivo donde importa.

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('INICIAR_PRUEBA',   'suscripcion', false),
  ('CONVERTIR_PRUEBA', 'suscripcion', false),
  ('VENCER_PRUEBA',    'suscripcion', true)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;

-- ---------------------------------------------------------------------------
-- Vista: en qué anda cada prueba
-- ---------------------------------------------------------------------------

CREATE VIEW trial_status WITH (security_invoker = true) AS
SELECT
  s.company_id,
  s.id                AS subscription_id,
  p.code              AS plan_code,
  p.name              AS plan,
  s.vigencia_desde    AS empezo,
  s.vigencia_hasta    AS termina,
  -- Días que faltan. Negativo si ya venció; el signo es la información.
  (s.vigencia_hasta - CURRENT_DATE) AS dias_restantes,
  CASE
    WHEN s.estado <> 'PRUEBA'                      THEN 'NO_ES_PRUEBA'
    WHEN s.vigencia_hasta < CURRENT_DATE           THEN 'VENCIDA'
    WHEN s.vigencia_hasta - CURRENT_DATE <= 3      THEN 'POR_VENCER'
    ELSE                                                'EN_CURSO'
  END                 AS situacion
FROM company_subscriptions s
JOIN subscription_plans p ON p.id = s.plan_id
WHERE s.estado = 'PRUEBA';

GRANT SELECT ON trial_status TO aai_app;

COMMENT ON VIEW trial_status IS
  'En qué anda cada prueba. `VENCIDA` es una prueba que ya pasó su fecha y '
  'todavía no la cerró el ciclo: la vista dice el hecho, el ciclo hace el acto. '
  'Confundirlos haría que el acceso dependiera de cuándo alguien mira.';
