#!/usr/bin/env node
/**
 * Declara el tope diario de tokens del asistente de IA, por plan (`plan_ai_quotas`, migración 0142).
 *
 *   node scripts/declarar-cupos-de-ia-por-plan.mjs              # muestra qué haría, sin escribir
 *   node scripts/declarar-cupos-de-ia-por-plan.mjs --aplicar    # lo declara
 *
 * ## Qué es y por qué es un script
 *
 * Es el tope de IA **del contrato**: lo comparten **todas las empresas del estudio** (decisión del titular, 2026-10-20: «si lo usás en una
 * empresa se gastan para todas»). Lo mide `consumo_de_ia_del_estudio()` (0144). Cada empresa puede además declarar uno propio, más chico
 * (`ai_quotas.tokens_por_dia`, 0141). Sin este tope, un estudio que enciende el asistente no tiene ningún límite de gasto.
 *
 * Cuántos tokens entran en cada plan es una decisión comercial, y una decisión comercial cambia: por eso es un script con motivo
 * escrito y no una migración que quede fijada en la historia del esquema. Correrlo dos veces deja la base como está.
 *
 * ## De dónde salen los números (decisión del titular, 2026-10-19: «que sea un 15 % de lo que pagan por mes»)
 *
 * El presupuesto de IA de cada plan es el **15 % de su precio neto mensual**. Se convierte a dólares (supuesto: US$ 1 = $ 1.500; si el
 * dólar es otro se recalcula acá) y se reparte en 30 días al precio del **peor caso**: todo en salida, a US$ 0,50 por millón de tokens
 * (Claude Haiku 5.5). El uso normal cuesta alrededor de un tercio de eso. El tope es **total del plan**, no por empresa: da lo mismo cuántas
 * empresas lo usen, el gasto del contrato nunca pasa del 15 %.
 *
 *     plan          neto/mes   15 %      US$/mes   ÷ 30 días → tokens por día, en total (redondeado hacia abajo a 10.000)
 *     Esencial       49.999     7.500      5,00                   330.000
 *     Gestión        99.999    15.000     10,00                   660.000
 *     Estudio       149.999    22.500     15,00                   990.000
 *     Empresa       199.999    30.000     20,00                 1.330.000
 *     Empresa Plus  349.999    52.500     35,00                 2.330.000
 *
 * Medido el 2026-10-20 con el modelo real, una consulta con herramienta usa ~13.000 tokens (no 1.200): 330.000 por día son 25–30 consultas.
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
  'Tope diario de tokens del asistente por plan, TOTAL para todas las empresas del estudio (2026-10-20): el presupuesto de IA es el 15 % del precio neto mensual del plan (peor caso, US$ 1 = $ 1.500).';

const CUPOS = [
  ['CONTABLE', 330_000],
  ['GESTION', 660_000],
  ['ESTUDIO', 990_000],
  ['EMPRESA_B1', 1_330_000],
  ['COMPLETO', 2_330_000],
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
    console.log(`  ${planes.get(code).name.padEnd(16)} ${String(tokens).padStart(10)} tokens por día en total (compartidos por todas las empresas)`);
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
