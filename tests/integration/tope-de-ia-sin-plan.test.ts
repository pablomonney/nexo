/**
 * Una empresa sin suscripción propia ni tope propio NO se queda sin límite de gasto de IA (migración 0142).
 *
 * El caso real: una empresa que un estudio da de alta dentro de su organización no pasa por el alta autoservicio, así que no tiene
 * suscripción, y la puerta comercial —que falla abierta— no le pone plan. Sin esta regla, el tope de tokens por plan no la alcanzaba y
 * su asistente quedaba **sin ningún tope**. Ahora hereda el **más bajo** de los topes de plan.
 *
 * `plan_ai_quotas` es una tabla global y las suites corren en paralelo: el caso corre dentro de una transacción que se deshace, de modo
 * que la fila de prueba no la ve ninguna otra suite.
 */

import { leerCupo } from '@aai/api/ai/cupo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';

const suite = hasDatabase ? describe : describe.skip;

suite('el tope de IA de una empresa sin plan propio', () => {
  let env: EntornoApi;

  beforeAll(async () => {
    env = await crearEntorno('ia-sin-plan');
  });

  afterAll(async () => {
    await env.cerrar();
  });

  const cupo = () =>
    leerCupo({ query: (texto: string, valores?: readonly unknown[]) => env.db.query(texto, valores as unknown[]) } as never, env.empresa, 'user:x', 12);

  it('hereda el más bajo de los topes de plan, y lo dice', async () => {
    await env.db.query('BEGIN');
    try {
      await env.db.query('DELETE FROM ai_quotas WHERE company_id = $1', [env.empresa]);
      const plan = (
        await env.db.query<{ id: string }>(
          `INSERT INTO subscription_plans (code, name, descripcion, orden) VALUES ($1, 'Plan sin uso', 'Plan de la prueba del tope por defecto', $2) RETURNING id`,
          [`T_SP_${env.stamp}`, 5000 + Math.floor(Math.random() * 90000)],
        )
      ).rows[0]!.id;
      await env.db.query(
        `INSERT INTO plan_ai_quotas (plan_id, tokens_por_dia, declarado_por, motivo) VALUES ($1, 7, 'test', 'Tope de la prueba, deshecho al terminar')`,
        [plan],
      );

      const sin = await cupo();
      expect(sin.topeTokensPorDia, 'sin suscripción ni tope propio rige el más bajo de los topes de plan').toBe(7);
      expect(sin.origenDelTopeDeTokens).toBe('PLAN');

      // Un tope propio gana, aunque sea más alto.
      await env.db.query(
        `INSERT INTO ai_quotas (company_id, llamadas_por_dia, tokens_por_dia, motivo, declarado_por) VALUES ($1, NULL, 5000, 'Tope propio de la prueba', 'test')`,
        [env.empresa],
      );
      const propio = await cupo();
      expect(propio.topeTokensPorDia).toBe(5000);
      expect(propio.origenDelTopeDeTokens).toBe('EMPRESA');
    } finally {
      await env.db.query('ROLLBACK');
    }
  });

  it('sin ningún tope de plan declarado en toda la base, no hay tope (no se inventa uno)', async () => {
    await env.db.query('BEGIN');
    try {
      await env.db.query('DELETE FROM ai_quotas WHERE company_id = $1', [env.empresa]);
      await env.db.query('DELETE FROM plan_ai_quotas');
      const e = await cupo();
      expect(e.topeTokensPorDia).toBeNull();
      expect(e.origenDelTopeDeTokens).toBeNull();
    } finally {
      await env.db.query('ROLLBACK');
    }
  });
});
