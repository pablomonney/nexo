/**
 * Cuántas veces se le puede preguntar al modelo.
 *
 * Son **dos límites distintos** y conviene no mezclarlos, porque protegen de
 * cosas distintas y los decide gente distinta:
 *
 *     por minuto, por usuario   técnico.   Ataja el bucle.        Lo fija NEXO.
 *     por día, por empresa      comercial. Ataja el gasto.        Lo declara la empresa.
 *
 * El primero tiene un valor por defecto porque un bucle es un problema técnico
 * con una respuesta técnica. El segundo **no tiene valor por defecto**: cuántas
 * preguntas por día entran en el plan de una empresa es una decisión que no se
 * pone en una migración. Sin cupo declarado no hay tope, y la respuesta lo dice.
 *
 * ## De dónde sale el consumo
 *
 * De `ai_answers`, que ya registra cada llamada —aceptada, rechazada o
 * abstenida—. No hay contador aparte: sería un segundo número sobre el mismo
 * hecho, y el día que se desincronizara no habría forma de saber cuál miente
 * (ADR-022).
 *
 * Consecuencia buena: el cupo **no se saltea cambiando de usuario**, porque se
 * cuenta por empresa, que es la que paga.
 */

import { withCompany, type Tx } from '@aai/db';
import type { PrecioDelModelo } from '@aai/ai-engine';

export interface EstadoDelCupo {
  /** Llamadas de la empresa en el día corriente. */
  readonly usadasHoy: number;
  /** `null` = la empresa no declaró tope de preguntas. */
  readonly topeDiario: number | null;
  /** Tokens (entrada + salida) que el asistente de la empresa consumió en el día corriente. */
  readonly tokensUsadosHoy: number;
  /** `null` = la empresa no declaró tope de tokens. */
  readonly topeTokensPorDia: number | null;
  /** De dónde sale el tope de tokens: lo declaró la empresa, o rige el de su plan. `null` si no hay tope. */
  readonly origenDelTopeDeTokens?: 'EMPRESA' | 'PLAN' | null;
  /** Llamadas de este usuario en el último minuto. */
  readonly delUsuarioEnElMinuto: number;
  readonly topePorMinuto: number;
}

/**
 * Lee el consumo sin decidir nada.
 *
 * Separado de la decisión para poder mostrarlo: una pantalla que dice «te
 * quedan 12 de 200» es distinta de una que corta en la 201 sin aviso.
 */
export async function leerCupo(
  tx: Tx,
  companyId: string,
  actorId: string,
  topePorMinuto: number,
): Promise<EstadoDelCupo> {
  const r = await tx.query<{
    usadas_hoy: string;
    tope_diario: number | null;
    tokens_hoy: string;
    tope_tokens: string | null;
    origen_tope: 'EMPRESA' | 'PLAN';
    del_usuario: string;
  }>(
    `SELECT
       (SELECT count(*) FROM ai_answers a
         WHERE a.company_id = $1
           AND a.created_at >= date_trunc('day', now()))                       AS usadas_hoy,
       (SELECT q.llamadas_por_dia FROM ai_quotas q WHERE q.company_id = $1)     AS tope_diario,
       -- Los tokens del día salen de los turnos del asistente (el hecho que ya los guarda), por empresa.
       (SELECT COALESCE(sum(COALESCE(m.tokens_entrada, 0) + COALESCE(m.tokens_salida, 0)), 0)
          FROM assistant_messages m
         WHERE m.company_id = $1 AND m.rol = 'asistente'
           AND m.created_at >= date_trunc('day', now()))                       AS tokens_hoy,
       -- El tope de la empresa gana; si no declaró uno, rige el del plan que tiene hoy (plan_ai_quotas, 0142).
       COALESCE(
         (SELECT q.tokens_por_dia::text FROM ai_quotas q WHERE q.company_id = $1 AND q.tokens_por_dia IS NOT NULL),
         (SELECT pq.tokens_por_dia::text
            FROM company_subscriptions s
            JOIN plan_ai_quotas pq ON pq.plan_id = s.plan_id
           WHERE s.company_id = $1 AND s.estado IN ('PRUEBA', 'ACTIVA', 'MOROSA')
           ORDER BY s.created_at DESC
           LIMIT 1))                                                          AS tope_tokens,
       (SELECT CASE WHEN EXISTS (SELECT 1 FROM ai_quotas q WHERE q.company_id = $1 AND q.tokens_por_dia IS NOT NULL)
                    THEN 'EMPRESA' ELSE 'PLAN' END)                           AS origen_tope,
       (SELECT count(*) FROM ai_answers a
         WHERE a.company_id = $1 AND a.created_by = $2
           AND a.created_at >= now() - interval '1 minute')                     AS del_usuario`,
    [companyId, actorId],
  );

  const f = r.rows[0]!;
  return {
    usadasHoy: Number(f.usadas_hoy),
    topeDiario: f.tope_diario,
    tokensUsadosHoy: Number(f.tokens_hoy),
    topeTokensPorDia: f.tope_tokens === null ? null : Number(f.tope_tokens),
    origenDelTopeDeTokens: f.tope_tokens === null ? null : f.origen_tope,
    delUsuarioEnElMinuto: Number(f.del_usuario),
    topePorMinuto,
  };
}

export type MotivoDeCorte =
  | { readonly codigo: 'LIMITE_POR_MINUTO'; readonly detalle: string }
  | { readonly codigo: 'CUPO_DIARIO_AGOTADO'; readonly detalle: string }
  | { readonly codigo: 'CUPO_DE_TOKENS_AGOTADO'; readonly detalle: string };

/**
 * ¿Se puede preguntar? `null` es que sí.
 *
 * Pura sobre el estado: la decisión se puede probar sin base, y la lectura se
 * puede mostrar sin decidir.
 */
export function motivoDeCorte(estado: EstadoDelCupo): MotivoDeCorte | null {
  if (estado.delUsuarioEnElMinuto >= estado.topePorMinuto) {
    return {
      codigo: 'LIMITE_POR_MINUTO',
      detalle:
        `Este usuario hizo ${estado.delUsuarioEnElMinuto} preguntas en el último minuto y el ` +
        `límite técnico es ${estado.topePorMinuto}. Es un tope contra el bucle, no contra el ` +
        'uso: se libera solo.',
    };
  }

  if (estado.topeDiario !== null && estado.usadasHoy >= estado.topeDiario) {
    return {
      codigo: 'CUPO_DIARIO_AGOTADO',
      detalle:
        `La empresa declaró un cupo de ${estado.topeDiario} preguntas por día y hoy lleva ` +
        `${estado.usadasHoy}. El cupo se cuenta por empresa, no por usuario: entrar con otro ` +
        'nombre no lo cambia.',
    };
  }

  // Los tokens de un turno se conocen después de la llamada: se mira lo ya consumido, así que el turno que cruza el tope se completa
  // y el siguiente se corta (se puede pasar por un turno, no más).
  if (estado.topeTokensPorDia !== null && estado.tokensUsadosHoy >= estado.topeTokensPorDia) {
    return {
      codigo: 'CUPO_DE_TOKENS_AGOTADO',
      detalle:
        `La empresa declaró un cupo de ${estado.topeTokensPorDia} tokens por día y hoy lleva ${estado.tokensUsadosHoy}. ` +
        'El cupo se cuenta por empresa, no por usuario, y se renueva al empezar el día.',
    };
  }

  return null;
}

/**
 * El precio vigente de un modelo, o `null` si nadie lo declaró.
 *
 * Vive acá y no en el paquete porque necesita la base: el cálculo en sí es puro
 * y está en `@aai/ai-engine/costo.ts`, que no puede tocar un cliente de base
 * (ADR-001, y el lint de arquitectura lo impone).
 */
export async function precioVigente(
  tx: Tx,
  modelProvider: string,
  modelId: string,
): Promise<PrecioDelModelo | null> {
  const r = await tx.query<{ input: string; output: string }>(
    `SELECT input_micros_por_mil::text AS input, output_micros_por_mil::text AS output
       FROM ai_pricing
      WHERE model_provider = $1 AND model_id = $2
        AND vigente_desde <= current_date
        AND (vigente_hasta IS NULL OR vigente_hasta > current_date)
      ORDER BY vigente_desde DESC
      LIMIT 1`,
    [modelProvider, modelId],
  );
  const f = r.rows[0];
  if (f === undefined) return null;
  return {
    inputMicrosPorMil: Number(f.input),
    outputMicrosPorMil: Number(f.output),
  };
}

/** Lee y decide, en una transacción. Devuelve el motivo, o `null` si se puede. */
export async function evaluarCupo(
  companyId: string,
  actorId: string,
  topePorMinuto: number,
): Promise<MotivoDeCorte | null> {
  const estado = await withCompany({ companyId, actorId }, (tx) =>
    leerCupo(tx, companyId, actorId, topePorMinuto),
  );
  return motivoDeCorte(estado);
}
