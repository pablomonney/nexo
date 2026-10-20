#!/usr/bin/env node
/**
 * Declara el tope diario de tokens del asistente de IA, por plan (`plan_ai_quotas`, migración 0142).
 *
 *   node scripts/declarar-cupos-de-ia-por-plan.mjs              # muestra qué haría, sin escribir
 *   node scripts/declarar-cupos-de-ia-por-plan.mjs --aplicar    # lo declara
 *
 * ## Qué es y por qué es un script
 *
 * Es el tope que rige para una empresa **cuando no declaró uno propio** (`ai_quotas.tokens_por_dia`, 0141): el de la empresa gana y
 * éste es el piso de seguridad. Sin él, una empresa que enciende el asistente no tiene ningún tope de gasto.
 *
 * Cuántos tokens entran en cada plan es una decisión comercial, y una decisión comercial cambia: por eso es un script con motivo
 * escrito y no una migración que quede fijada en la historia del esquema. Correrlo dos veces deja la base como está.
 *
 * ## De dónde salen los números (decisión del titular, 2026-10-19: «que sea un 15 % de lo que pagan por mes»)
 *
 * El presupuesto de IA de cada plan es el **15 % de su precio neto mensual**. Se convierte a dólares (supuesto: US$ 1 = $ 1.500; si el
 * dólar es otro se recalcula acá) y se reparte en 30 días al precio del **peor caso**: todo en salida, a US$ 0,50 por millón de tokens
 * (Claude Haiku 5.5). El uso normal cuesta alrededor de un tercio de eso. En los planes que atienden varias empresas el tope es **por
 * empresa**, así que el presupuesto se divide por la cantidad de empresas del plan: si todas usan su tope completo todos los días, el gasto
 * sigue siendo ≤ 15 %.
 *
 *     plan          neto/mes   15 %      US$/mes   ÷ 30 días ÷ empresas → tokens/día por empresa
 *     Esencial       50.000     7.500      5,00        1 empresa      → 330.000
 *     Gestión       100.000    15.000     10,00        1 empresa      → 660.000
 *     Estudio       125.000    18.750     12,50       20 empresas     →  40.000
 *     Empresa       205.000    30.750     20,50        5 empresas     → 270.000
 *     Empresa Plus  370.000    55.500     37,00       20 empresas     → 120.000
 *
 * Un turno normal usa ~1.200 tokens: 330.000 por día son unas 275 consultas.
 *
 * Los códigos de plan son los de la lista comercial de `sembrar-comercial-b1.mjs`.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { opcionesDeConexion } from './lib/zona.mjs';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI y en el servidor las variables vienen del entorno */
}

const aplicar = process.argv.includes('--aplicar');
const DECLARANTE = 'comercial-2026-10';
const MOTIVO =
  'Tope diario de tokens del asistente por plan y por empresa, decidido el 2026-10-19: el presupuesto de IA es el 15 % del precio neto mensual del plan (peor caso, US$ 1 = $ 1.500).';

const CUPOS = [
  ['CONTABLE', 330_000],
  ['GESTION', 660_000],
  ['ESTUDIO', 40_000],
  ['EMPRESA_B1', 270_000],
  ['COMPLETO', 120_000],
];

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL, ...opcionesDeConexion() });
await cliente.connect();
try {
  const planes = new Map(
    (await cliente.query(`SELECT code, id, name FROM subscription_plans WHERE status = 'DISPONIBLE'`)).rows.map((r) => [r.code, r]),
  );
  const faltantes = CUPOS.map(([c]) => c).filter((c) => !planes.has(c));
  if (faltantes.length > 0) throw new Error(`No hay planes disponibles con estos códigos: ${faltantes.join(', ')}`);

  console.log(`\n══ Cupo diario de tokens del asistente, por plan ${aplicar ? '' : '(ENSAYO)'} ══════\n`);
  for (const [code, tokens] of CUPOS) {
    console.log(`  ${planes.get(code).name.padEnd(16)} ${String(tokens).padStart(10)} tokens por día y empresa`);
  }

  if (!aplicar) {
    console.log('\n  Nada se escribió. Para declararlo: node scripts/declarar-cupos-de-ia-por-plan.mjs --aplicar\n');
    process.exit(0);
  }

  await cliente.query('BEGIN');
  for (const [code, tokens] of CUPOS) {
    await cliente.query(
      `INSERT INTO plan_ai_quotas (plan_id, tokens_por_dia, declarado_por, motivo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (plan_id) DO UPDATE
         SET tokens_por_dia = EXCLUDED.tokens_por_dia, declarado_por = EXCLUDED.declarado_por,
             motivo = EXCLUDED.motivo, declarado_el = now()`,
      [planes.get(code).id, tokens, DECLARANTE, MOTIVO],
    );
  }
  await cliente.query('COMMIT');
  console.log('\n  Declarado.\n');
} catch (error) {
  await cliente.query('ROLLBACK').catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
