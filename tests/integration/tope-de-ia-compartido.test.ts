/**
 * El tope de IA del plan es TOTAL: lo comparten todas las empresas del estudio (migración 0144).
 *
 * Decisión del titular, 2026-10-20: «si lo usás en una empresa, se gastan para todas. No para esa sola empresa». Antes (0142) cada empresa
 * tenía su tope: un estudio con 50 empresas podía gastar 50 veces el presupuesto de su plan.
 *
 * Lo que se afirma sobre `consumo_de_ia_del_estudio()`: (a) suma lo que gastaron TODAS las empresas del estudio de la empresa en contexto;
 * (b) no cuenta nada de otro estudio; (c) el tope es el del plan vigente de cualquiera de las empresas del estudio, y sin suscripción rige el
 * más bajo; (d) sin empresa en contexto no devuelve nada; (e) lo hoy cuenta, lo de ayer no.
 *
 * `plan_ai_quotas` es una tabla global y las suites corren en paralelo: todo corre dentro de una transacción que se deshace.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

suite('el tope de IA es del contrato: lo comparten las empresas del estudio', () => {
  let a: EntornoApi;
  let b: EntornoApi;

  beforeAll(async () => {
    a = await crearEntorno('ia-compartida-a');
    b = await crearEntorno('ia-compartida-b');
  });

  afterAll(async () => {
    await a.cerrar();
    await b.cerrar();
  });

  /** Una empresa más en el mismo estudio que `a`. */
  async function hermana(): Promise<string> {
    const sufijo = await sufijoUnico(a.db);
    const r = await a.db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type, jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [a.organizationId, `Hermana de IA ${sufijo}`, `30${sufijo}4`],
    );
    return r.rows[0]!.id;
  }

  /** Un turno del asistente con estos tokens, en esa empresa. */
  async function turno(empresa: string, entrada: number, salida: number, cuando = 'now()'): Promise<void> {
    const c = await a.db.query<{ id: string }>(
      `INSERT INTO assistant_conversations (company_id, created_by, titulo) VALUES ($1, 'test', 'Prueba del tope compartido') RETURNING id`,
      [empresa],
    );
    await a.db.query(
      `INSERT INTO assistant_messages (company_id, conversation_id, rol, texto, estado, tokens_entrada, tokens_salida, created_at)
       VALUES ($1, $2, 'asistente', 'respuesta', 'RESPONDIDA', $3, $4, ${cuando})`,
      [empresa, c.rows[0]!.id, entrada, salida],
    );
  }

  /** Lo que ve `consumo_de_ia_del_estudio()` con esta empresa en contexto (`null` = ninguna fila). */
  async function consumo(empresa: string | null): Promise<{ usados: number; tope: number | null } | null> {
    await a.db.query(`SELECT set_config('app.company_id', $1, true)`, [empresa ?? '']);
    const r = await a.db.query<{ usados: string; tope: string | null }>(
      'SELECT tokens_usados_hoy::text AS usados, tope_del_plan::text AS tope FROM consumo_de_ia_del_estudio()',
    );
    const f = r.rows[0];
    return f === undefined ? null : { usados: Number(f.usados), tope: f.tope === null ? null : Number(f.tope) };
  }

  async function planConTope(tokens: number, codigo: string): Promise<string> {
    const plan = (
      await a.db.query<{ id: string }>(
        `INSERT INTO subscription_plans (code, name, descripcion, orden) VALUES ($1, 'Plan del tope compartido', 'Prueba del tope total', $2) RETURNING id`,
        [codigo, 5000 + Math.floor(Math.random() * 90000)],
      )
    ).rows[0]!.id;
    await a.db.query(`INSERT INTO plan_ai_quotas (plan_id, tokens_por_dia, declarado_por, motivo) VALUES ($1, $2, 'test', 'Prueba, deshecha al terminar')`, [plan, tokens]);
    return plan;
  }

  it('suma lo que gastaron todas las empresas del estudio, y nada de otro estudio', async () => {
    await a.db.query('BEGIN');
    try {
      const otra = await hermana();
      const antes = (await consumo(a.empresa))!.usados;

      await turno(a.empresa, 1000, 200);
      await turno(otra, 5000, 800);

      // Desde cualquiera de las dos empresas se ve el MISMO total: lo que se usa en una se gasta para todas.
      expect((await consumo(a.empresa))!.usados).toBe(antes + 7000);
      expect((await consumo(otra))!.usados).toBe(antes + 7000);

      // Un estudio distinto no entra en la cuenta, aunque gaste.
      const deB = (await consumo(b.empresa))!.usados;
      await turno(b.empresa, 100_000, 100_000);
      expect((await consumo(a.empresa))!.usados, 'lo de otro estudio no cuenta').toBe(antes + 7000);
      expect((await consumo(b.empresa))!.usados).toBe(deB + 200_000);
    } finally {
      await a.db.query('ROLLBACK');
    }
  });

  it('lo de ayer no cuenta: el tope se renueva al empezar el día', async () => {
    await a.db.query('BEGIN');
    try {
      const antes = (await consumo(a.empresa))!.usados;
      await turno(a.empresa, 9_000_000, 9_000_000, `date_trunc('day', now()) - interval '1 minute'`);
      expect((await consumo(a.empresa))!.usados).toBe(antes);
    } finally {
      await a.db.query('ROLLBACK');
    }
  });

  it('el tope es el del plan de cualquiera de las empresas del estudio; sin suscripción rige el más bajo', async () => {
    await a.db.query('BEGIN');
    try {
      const otra = await hermana();
      await a.db.query('DELETE FROM plan_ai_quotas');

      expect((await consumo(a.empresa))!.tope, 'ninguna cuota de plan declarada: no hay tope (no se inventa uno)').toBeNull();

      const chico = await planConTope(7, `T_CP_${a.stamp}`);
      await planConTope(500_000, `T_CG_${a.stamp}`);
      expect((await consumo(a.empresa))!.tope, 'sin suscripción rige el más bajo de los topes de plan').toBe(7);

      // La suscripción es de la HERMANA, y rige para todo el estudio.
      const grande = (await a.db.query<{ id: string }>(`SELECT plan_id AS id FROM plan_ai_quotas WHERE tokens_por_dia = 500000`)).rows[0]!.id;
      await a.db.query(
        `INSERT INTO company_subscriptions (company_id, plan_id, estado, vigencia_desde, created_by) VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, 'test')`,
        [otra, grande],
      );
      expect((await consumo(a.empresa))!.tope, 'rige el plan de la hermana').toBe(500_000);
      expect((await consumo(otra))!.tope).toBe(500_000);
      expect(chico).not.toBe(grande);

      // Lo de otro estudio no cambia el tope de éste.
      expect((await consumo(b.empresa))!.tope).not.toBe(500_000);
    } finally {
      await a.db.query('ROLLBACK');
    }
  });

  it('sin empresa en contexto no devuelve nada', async () => {
    await a.db.query('BEGIN');
    try {
      expect(await consumo(null)).toBeNull();
    } finally {
      await a.db.query('ROLLBACK');
    }
  });
});
