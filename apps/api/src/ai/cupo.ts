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
  /** `null` = la empresa no declaró tope. */
  readonly topeDiario: number | null;
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
    del_usuario: string;
  }>(
    `SELECT
       (SELECT count(*) FROM ai_answers a
         WHERE a.company_id = $1
           AND a.created_at >= date_trunc('day', now()))                       AS usadas_hoy,
       (SELECT q.llamadas_por_dia FROM ai_quotas q WHERE q.company_id = $1)     AS tope_diario,
       (SELECT count(*) FROM ai_answers a
         WHERE a.company_id = $1 AND a.created_by = $2
           AND a.created_at >= now() - interval '1 minute')                     AS del_usuario`,
    [companyId, actorId],
  );

  const f = r.rows[0]!;
  return {
    usadasHoy: Number(f.usadas_hoy),
    topeDiario: f.tope_diario,
    delUsuarioEnElMinuto: Number(f.del_usuario),
    topePorMinuto,
  };
}

export type MotivoDeCorte =
  | { readonly codigo: 'LIMITE_POR_MINUTO'; readonly detalle: string }
  | { readonly codigo: 'CUPO_DIARIO_AGOTADO'; readonly detalle: string };

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
