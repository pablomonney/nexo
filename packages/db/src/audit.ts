/**
 * Escritura en la bitácora (§21).
 *
 * `prev_hash` y `hash` los calcula el trigger `audit_chain_link` en la base, no
 * la aplicación: si el encadenamiento dependiera del código, bastaría con
 * insertar por otro camino para romperlo.
 */

import type { Tx } from './tenancy.js';

export type ActorType = 'USER' | 'SYSTEM' | 'AI';

/** Acciones que la base exige acompañar de un motivo (constraint audit_reason_required). */
export const ACTIONS_REQUIRING_REASON = [
  'ANULAR_ASIENTO',
  'REABRIR_PERIODO',
  'ACTIVAR_REGLA',
  'RECLASIFICAR_APROBADO',
  'CAMBIAR_PLAN_CUENTAS',
] as const;

export interface AuditEvent {
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
  readonly motivo?: string;
  /** Sujeto a la evaluación de protección de datos personales (§21). */
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export async function recordAudit(tx: Tx, companyId: string, event: AuditEvent): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs
       (company_id, actor_type, actor_id, action, object_type, object_id,
        old_value, new_value, motivo, ip, user_agent, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '', '')`,
    [
      companyId,
      event.actorType,
      event.actorId,
      event.action,
      event.objectType,
      event.objectId,
      event.oldValue === undefined ? null : JSON.stringify(event.oldValue),
      event.newValue === undefined ? null : JSON.stringify(event.newValue),
      event.motivo ?? null,
      event.ip ?? null,
      event.userAgent ?? null,
    ],
  );
}
