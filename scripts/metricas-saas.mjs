#!/usr/bin/env node
/**
 * Cómo está el negocio de NEXO.
 *
 *   npm run metricas:saas
 *
 * ## Por qué es un script del operador
 *
 * Estas cifras atraviesan a **todas** las empresas: son del negocio de NEXO, no
 * de ninguno de sus clientes. Las vistas que las calculan no las puede leer
 * `aai_app` —está revocado y hay un test que lo comprueba—, así que no hay
 * endpoint que las devuelva y no puede haberlo.
 *
 * ## Lo que este informe no hace
 *
 * **No devuelve cero cuando no sabe.** Si no hay suscripciones con importe
 * acordado, no dice «MRR: 0» —que se leería como «NEXO no factura»— sino que no
 * hay de dónde calcularlo y cuántas suscripciones quedaron afuera.
 *
 * Y **no calcula CAC ni LTV**. CAC necesita el gasto de adquisición y LTV el
 * margen bruto por cliente; ninguno de los dos existe todavía, porque NEXO no
 * lleva su propia contabilidad. Inventar el numerador daría un número que se ve
 * igual que uno medido.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

const q = async (sql, valores = []) => (await cliente.query(sql, valores)).rows;

try {
  console.log('\n══ NEXO — métricas del negocio ══════════════════════════════\n');

  const ingreso = await q('SELECT * FROM saas_ingreso_recurrente ORDER BY moneda');
  const sinImporte = await q('SELECT * FROM saas_sin_importe ORDER BY empresa');

  if (ingreso.length === 0) {
    console.log('  MRR — no se puede calcular.');
    console.log('');
    console.log('    No hay ninguna suscripción vigente con importe acordado. Eso NO es');
    console.log('    un MRR de cero: es que nadie declaró cuánto se cobra. Un cero acá se');
    console.log('    leería como «NEXO no factura nada», que es otra cosa.');
    if (sinImporte.length > 0) {
      console.log('');
      console.log(`    Hay ${sinImporte.length} suscripción(es) vigente(s) sin importe:`);
      for (const s of sinImporte) {
        console.log(`      ${s.empresa} — plan ${s.plan ?? 'sin plan'} (${s.estado})`);
      }
    }
    console.log('');
    console.log('    Se destraba declarando precios: npm run plan:precio');
  } else {
    for (const i of ingreso) {
      console.log(`  ${i.moneda}`);
      console.log(`    MRR   ${i.mrr}`);
      console.log(`    ARR   ${i.arr}`);
      console.log(`    ARPU  ${i.arpu ?? 'no se puede afirmar'}`);
      console.log(
        `    Suscripciones  ${i.suscripciones_activas} activas · ` +
          `${i.en_prueba} en prueba · ${i.suspendidas} suspendidas`,
      );
      console.log('');
    }
    // Lo excluido va al lado del total, siempre. Un MRR sin esta línea es un
    // número que no se puede auditar.
    console.log(
      sinImporte.length === 0
        ? '  Ninguna suscripción vigente quedó afuera del cálculo.'
        : `  ⚠ ${sinImporte.length} suscripción(es) vigente(s) SIN importe acordado ` +
            'quedaron afuera del MRR. No son cero: nadie las terminó de acordar.',
    );
    for (const s of sinImporte) {
      console.log(`      ${s.empresa} — plan ${s.plan ?? 'sin plan'} (${s.estado})`);
    }
  }

  console.log('\n── Movimientos de los últimos doce meses ────────────────────\n');
  const movimientos = await q(
    `SELECT mes, tipo, count(*)::int AS n
       FROM saas_movimientos
      WHERE mes >= date_trunc('month', CURRENT_DATE) - interval '11 months'
      GROUP BY mes, tipo ORDER BY mes DESC, tipo`,
  );
  if (movimientos.length === 0) {
    console.log('  Ninguno registrado.');
  } else {
    for (const m of movimientos) {
      console.log(`  ${m.mes.toISOString().slice(0, 7)}  ${m.tipo.padEnd(24)} ${m.n}`);
    }
    console.log('');
    console.log('  La baja que pide el cliente y la suspensión por falta de pago van');
    console.log('  separadas: sumarlas hace que arreglar el cobro parezca retención.');
  }

  console.log('\n── Cobranza ─────────────────────────────────────────────────\n');
  const cobranza = await q('SELECT * FROM saas_cobranza_mensual ORDER BY mes DESC, moneda LIMIT 24');
  if (cobranza.length === 0) {
    console.log('  Todavía no se emitió ningún cargo.');
  } else {
    for (const c of cobranza) {
      console.log(
        `  ${c.mes.toISOString().slice(0, 7)} ${c.moneda}  ` +
          `emitido ${c.emitido}  cobrado ${c.cobrado ?? '0.00'}  ` +
          `pendiente ${c.pendiente ?? '0.00'}  anulado ${c.anulado ?? '0.00'}`,
      );
    }
  }

  console.log('\n── Lo que este informe NO puede decir ───────────────────────\n');
  console.log('  CAC   necesita el gasto de adquisición (marketing, ventas, comisiones).');
  console.log('  LTV   necesita el margen bruto por cliente.');
  console.log('  Costo por cliente, margen por plan, burn, runway: lo mismo.');
  console.log('');
  console.log('  Ninguno existe porque NEXO todavía no lleva su propia contabilidad.');
  console.log('  La forma de tenerlos no es agregar una vista: es que NEXO sea una');
  console.log('  empresa más dentro de NEXO, con su plan de cuentas y sus gastos');
  console.log('  imputados. Ver NEXO_CORPORATE.md.\n');
} catch (error) {
  console.error(`No se pudieron leer las métricas: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
