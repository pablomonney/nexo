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
 * ## De dónde salen los números (decisión del titular: «que sea un 15 % de lo que pagan por mes»; 2026-10-20: «que se suban»)
 *
 * El presupuesto de IA de cada plan es el **10 % de su precio neto mensual** (decisión del titular, 2026-10-20: antes era el 15 % calculado
 * con un precio por token más caro). Se convierte a dólares (US$ 1 = $ 1.550) y se reparte en 30 días al precio **medido con el modelo real**:
 * el 97 % de lo que se gasta es entrada (US$ 0,10 por millón) y el 3 % salida (US$ 0,50 por millón), o sea ≈ US$ 0,112 por millón de tokens.
 * Sin margen: si las respuestas se alargan, el costo sube por encima del 10 % (cada punto de salida de más cuesta ≈ 0,4 puntos). El tope es
 * **total del plan**, no por empresa.
 *
 *     plan          neto/mes   10 %      US$/mes   ÷ 30 días ÷ US$ 0,112/M → tokens por día (redondeado hacia abajo a 10.000)
 *     Esencial       49.999     5.000      3,23                   960.000   (28,8 millones por mes)
 *     Gestión        99.999    10.000      6,45                 1.920.000   (57,6 millones)
 *     Estudio       149.999    15.000      9,68                 2.880.000   (86,4 millones)
 *     Empresa       199.999    20.000     12,90                 3.840.000   (115,2 millones)
 *     Empresa Plus  349.999    35.000     22,58                 6.720.000   (201,6 millones)
 *
 * Si se usa el tope completo todos los días, el costo es el 10 % del precio. Una consulta con herramienta usa ~13.000 tokens (medido con el
 * modelo real): 960.000 por día son unas 70 consultas.
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
  'Tope diario de tokens del asistente por plan, TOTAL para todas las empresas del estudio (2026-10-20): el presupuesto de IA es el 10 % del precio neto mensual del plan (precio por token medido, US$ 1 = $ 1.550).';

const CUPOS = [
  ['CONTABLE', 960_000],
  ['GESTION', 1_920_000],
  ['ESTUDIO', 2_880_000],
  ['EMPRESA_B1', 3_840_000],
  ['COMPLETO', 6_720_000],
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
