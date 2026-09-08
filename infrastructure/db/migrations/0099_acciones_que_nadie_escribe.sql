-- ============================================================================
-- 0099 — Acciones que nadie escribe
-- ============================================================================
--
-- La 0096 registró siete acciones de facturación en `audit_actions`. Dos de
-- ellas **nadie las escribe, y nadie las va a escribir**:
--
--     DECLARAR_PRECIO_DE_PLAN
--     DECLARAR_POLITICA_DE_COBRANZA
--
-- No por un olvido: `audit_logs` es por empresa —`company_id` es obligatorio— y
-- estas dos son declaraciones de NEXO, no de ninguna empresa cliente. No hay
-- empresa a la que atribuirlas.
--
-- Y no quedan sin registro: `plan_prices` y `collection_policies` guardan
-- `declarado_por`, `declarado_el` y `motivo` en la propia fila, y una vigencia
-- nueva cierra la anterior en vez de pisarla. Ese **es** el rastro. Duplicarlo
-- en la bitácora sería un segundo registro del mismo hecho, capaz de
-- contradecir al primero (ADR-022).
--
-- Se las quita porque una acción registrada que nadie escribe es exactamente el
-- defecto que S-20 vigila: el día que alguien busque «quién declaró este
-- precio» en la bitácora y no encuentre nada, la ausencia se va a leer como
-- «nadie lo declaró» en vez de como «se registra en otro lado».
--
-- ## Y una que sí se escribe
--
-- `CAMBIAR_PLAN_DE_SUSCRIPCION` la escribe `cambiarDePlan`. Sin motivo
-- obligatorio: el cambio de plan es una operación comercial normal, y el importe
-- viejo y el nuevo quedan en `old_value`/`new_value`, que es lo que hay que
-- poder mirar. Exigir motivo en lo cotidiano entrena a escribir «cambio» y
-- devalúa el motivo donde sí importa.
-- ============================================================================

DELETE FROM audit_actions
 WHERE id IN ('DECLARAR_PRECIO_DE_PLAN', 'DECLARAR_POLITICA_DE_COBRANZA')
   AND NOT EXISTS (SELECT 1 FROM audit_logs l WHERE l.action = audit_actions.id);

INSERT INTO audit_actions (id, dominio, requiere_motivo)
VALUES ('CAMBIAR_PLAN_DE_SUSCRIPCION', 'facturacion', false)
ON CONFLICT (id) DO UPDATE
  SET dominio = EXCLUDED.dominio, requiere_motivo = EXCLUDED.requiere_motivo;
