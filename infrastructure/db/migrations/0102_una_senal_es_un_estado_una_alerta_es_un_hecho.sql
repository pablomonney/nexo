-- ============================================================================
-- 0102 — Una señal es un estado; una alerta es un hecho
-- ============================================================================
--
-- `analysis_signals` contesta **qué es cierto ahora**: este cliente concentra el
-- 40 % de las ventas, este producto se vendió bajo costo. Es una vista, se
-- recalcula en cada consulta y no guarda nada — que es lo correcto para un
-- estado (ADR-022).
--
-- Lo que no puede contestar es **desde cuándo**. Una señal que cruza el umbral
-- hoy y otra que lo cruzó hace tres semanas se ven idénticas, y no lo son: la
-- segunda es un problema que nadie miró. Tampoco tiene dónde anotar que alguien
-- la vio y decidió que no importaba, ni por qué.
--
-- `alerts` existe desde la 0028 para eso y **nunca la escribió nadie** — está
-- registrada como deuda desde entonces. Esta migración le agrega lo que le
-- faltaba para poder escribirse sin mentir, y la 0102 la conecta.
--
-- ## Una alerta no es una segunda copia de la señal
--
-- La señal dice «el margen de este producto es 3 %». La alerta dice «el 15 de
-- marzo a las 9:14 el margen de este producto cruzó el umbral declarado, y el
-- 20 de marzo Ana la revisó y anotó por qué la descarta». Son dos hechos
-- distintos: el estado y el evento.
--
-- Por eso la alerta **congela** el valor que la disparó. Cuando el margen se
-- recupere, la señal va a dejar de existir y la alerta va a seguir diciendo qué
-- pasó — que es de lo que se trata.
--
-- ## Sin metodología no se abre
--
-- El §23 del pliego lo pide y acá es un `NOT NULL`: cada alerta trae la cuenta
-- exacta para rehacerla a mano. Una alerta que dice «margen bajo» sin decir
-- contra qué ni cómo se calculó es una afirmación sin evidencia, y una
-- afirmación sin evidencia entrena a ignorar las alertas.
--
-- Se copia de la señal que la disparó, así que no hay forma de abrir una sin
-- ella: la señal siempre la trae.
--
-- ## Una abierta por sujeto, no una por corrida
--
-- El índice parcial de abajo es lo que hace que el detector se pueda correr cada
-- hora sin llenar la pantalla. Si el mismo producto sigue vendiéndose bajo
-- costo, la alerta es **la misma** —se actualiza el valor y la última vez que se
-- vio—, no una nueva cada vez.
--
-- Es la diferencia entre un sistema que avisa y uno que hace ruido, y el
-- segundo termina apagado.
-- ============================================================================

ALTER TABLE alerts
  -- Sobre qué: el producto, el cliente, la cuenta. Texto y no un id, porque una
  -- alerta puede ser sobre algo que no es una fila —«las ventas de marzo»—, y
  -- el id ya viaja en object_id cuando existe.
  ADD COLUMN sujeto        text,
  -- Lo que disparó la alerta, congelado. Cuando el problema se corrija la señal
  -- va a desaparecer y esto va a seguir diciendo qué pasó.
  ADD COLUMN valor         numeric(18, 4),
  ADD COLUMN unidad        text,
  ADD COLUMN umbral        numeric(18, 4),
  ADD COLUMN referencia    numeric(18, 4),
  -- La cuenta exacta, para rehacerla a mano. Sin esto una alerta es una
  -- afirmación sin evidencia, y eso entrena a ignorarlas.
  ADD COLUMN metodologia   text,
  ADD COLUMN detectada_el  timestamptz NOT NULL DEFAULT now(),
  -- La última vez que el detector la volvió a ver. Es lo que distingue un
  -- problema que sigue de uno que se arregló y nadie cerró.
  ADD COLUMN vista_el      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN resuelta_el   timestamptz;

ALTER TABLE alerts
  ADD CONSTRAINT alerts_con_metodologia
    CHECK (metodologia IS NULL OR length(btrim(metodologia)) >= 10),
  -- Una alerta resuelta dice cuándo dejó de estar. Sin fecha, «resuelta» es una
  -- etiqueta y no un hecho.
  ADD CONSTRAINT alerts_resuelta_con_fecha
    CHECK (status <> 'RESUELTA' OR resuelta_el IS NOT NULL);

-- Una abierta por empresa, tipo y sujeto. Sin esto, correr el detector cada
-- hora genera veinticuatro alertas por día del mismo problema, y la pantalla
-- deja de servir.
CREATE UNIQUE INDEX alerts_una_abierta_por_sujeto
  ON alerts (company_id, kind, sujeto)
  NULLS NOT DISTINCT
  WHERE status IN ('ABIERTA', 'RECONOCIDA');

CREATE INDEX alerts_abiertas ON alerts (company_id, severity, detectada_el DESC)
  WHERE status = 'ABIERTA';

COMMENT ON TABLE alerts IS
  'El EVENTO de que una señal cruzó su umbral, con el valor congelado. No es '
  'una copia de la señal: la señal dice qué es cierto ahora, la alerta dice '
  'desde cuándo y quién la miró. Una abierta por sujeto, no una por corrida.';

COMMENT ON COLUMN alerts.metodologia IS
  'La cuenta exacta para rehacer la alerta a mano. Una alerta sin esto es una '
  'afirmación sin evidencia, y eso entrena a ignorarlas.';

-- ---------------------------------------------------------------------------
-- Acciones auditadas
-- ---------------------------------------------------------------------------
--
-- Descartar una alerta exige motivo: es la acción que hace que un problema
-- detectado deje de verse, y seis meses después alguien va a querer saber quién
-- decidió que no importaba.
--
-- Abrirla no lo exige: la abre el detector, y su motivo es la metodología.

INSERT INTO audit_actions (id, dominio, requiere_motivo) VALUES
  ('ABRIR_ALERTA',      'analisis', false),
  ('RECONOCER_ALERTA',  'analisis', true),
  ('DESCARTAR_ALERTA',  'analisis', true),
  ('RESOLVER_ALERTA',   'analisis', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
