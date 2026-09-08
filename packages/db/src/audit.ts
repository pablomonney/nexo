/**
 * Escritura en la bitácora (§21).
 *
 * `prev_hash` y `hash` los calcula el trigger `audit_chain_link` en la base, no
 * la aplicación: si el encadenamiento dependiera del código, bastaría con
 * insertar por otro camino para romperlo.
 */

import type { Tx } from './tenancy.js';

export type ActorType = 'USER' | 'SYSTEM' | 'AI';

/**
 * Acciones que la base exige acompañar de un motivo.
 *
 * Desde la 0091 la regla vive en `audit_actions.requiere_motivo` y la impone un
 * trigger, no un CHECK con literales. Esta lista es el espejo del lado del
 * código —para que un `recordAudit` sin motivo se pueda detectar antes de
 * llegar a la base— y S-20 comprueba que las dos digan lo mismo.
 */
export const ACTIONS_REQUIRING_REASON = [
  'ANULAR_ASIENTO',
  'REABRIR_PERIODO',
  'ACTIVAR_REGLA',
  'RECLASIFICAR_APROBADO',
  'CAMBIAR_PLAN_CUENTAS',
  // Declarar que un escenario se aplicó sin decir por qué sería un vínculo sin
  // argumento: es lo único que conecta el acto con la predicción.
  'DECLARAR_ESCENARIO_APLICADO',
  // Un cupo es una traba: sin motivo, seis meses despues nadie sabe por que
  // esta puesta ni si sigue teniendo sentido.
  'DECLARAR_CUPO_DE_IA',
  // Una credencial que cambio sin explicacion, seis meses despues, es una
  // pregunta sin respuesta en una auditoria.
  'DECLARAR_REFERENCIA_DE_SECRETO',
  'ROTAR_REFERENCIA_DE_SECRETO',
  'REVOCAR_REFERENCIA_DE_SECRETO',
  // Anular dice "esto no debio emitirse". Sin motivo, seis meses despues nadie
  // sabe si fue un error de carga o una decision comercial.
  'ANULAR_DOCUMENTO_DE_COBRO',
  // Cortarle el acceso a una empresa es la consecuencia mas grave del ciclo.
  // Tiene que poder explicarse sin reconstruirla desde los intentos de pago.
  'SUSPENDER_POR_FALTA_DE_PAGO',
  // Descartar una decision propuesta: sin motivo, el registro dice que alguien
  // penso el problema y no dice por que no se hizo nada.
  'DESCARTAR_DECISION',
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
