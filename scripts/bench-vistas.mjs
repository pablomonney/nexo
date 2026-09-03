#!/usr/bin/env node
/**
 * ¿Cuánto tardan las vistas derivadas con datos de verdad?
 *
 *   npm run bench:vistas            # volumen por defecto
 *   npm run bench:vistas -- 400 300 # productos × movimientos por producto
 *
 * ## Por qué existe
 *
 * La 0086 salió de una medición: `stock_valuation` tardaba 25 segundos con
 * 50.000 movimientos de stock de una empresa, y con los datos de los tests
 * tardaba dos milisegundos. **Ninguna suite podía verlo**: los tests prueban
 * que la cuenta esté bien, no que se pueda esperar el resultado.
 *
 * Este script es el molde de esa medición, para el resto de las vistas. No
 * afirma nada sobre producción —otra máquina, otro disco, otra concurrencia—:
 * afirma cuánto tarda **esta** consulta contra **este** volumen, que es lo que
 * hace falta para distinguir «es lento» de «me lo imaginé».
 *
 * ## Dónde corre
 *
 * Solo contra `aai_test`, que es descartable: `npm run test:db -- --reset` la
 * reconstruye. Se niega a tocar cualquier otra base, porque los movimientos de
 * stock que carga **no se pueden borrar** —el libro es append-only— y dejarlos
 * en la base de desarrollo sería ensuciarla para siempre.
 *
 * ## Cómo mide
 *
 * Con el rol `aai_app` y la empresa en contexto, que es como consulta la API.
 * Medir como `postgres` daría números más lindos y equivocados: el superusuario
 * saltea el RLS, así que ni siquiera estaría corriendo la misma consulta.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const URL_BASE = (process.env.DATABASE_URL ?? '').replace(/\/[^/]*$/, '/aai_test');
if (!URL_BASE.endsWith('/aai_test')) {
  console.error('No se pudo derivar la URL de aai_test desde DATABASE_URL.');
  process.exit(1);
}

const PRODUCTOS = Number(process.argv[2] ?? 200);
const POR_PRODUCTO = Number(process.argv[3] ?? 250);
const REPETICIONES = 3;

/**
 * Las consultas que se miden.
 *
 * Cada una es la que hace una pantalla, no una versión simplificada: medir algo
 * más liviano que lo que corre en producción es medir otra cosa.
 */
const CONSULTAS = [
  ['stock_valuation', 'SELECT count(*) FROM stock_valuation WHERE company_id = $1'],
  ['stock_ppp', 'SELECT count(*) FROM stock_ppp WHERE company_id = $1'],
  [
    'work_queue (bandeja)',
    `SELECT count(*) FROM work_queue WHERE company_id = $1`,
  ],
  [
    'work_queue · una página',
    `SELECT item_id FROM work_queue WHERE company_id = $1
      ORDER BY creado_en DESC, item_id DESC LIMIT 50`,
  ],
  ['analytics_costo_de_ventas', 'SELECT count(*) FROM analytics_costo_de_ventas WHERE company_id = $1'],
  ['analytics_margen_por_producto', 'SELECT count(*) FROM analytics_margen_por_producto WHERE company_id = $1'],
  ['analysis_signals', 'SELECT count(*) FROM analysis_signals WHERE company_id = $1'],
  ['invoice_settlement', 'SELECT count(*) FROM invoice_settlement WHERE company_id = $1'],
  ['party_aging', 'SELECT count(*) FROM party_aging WHERE company_id = $1'],
  ['analytics_flujo_de_fondos', 'SELECT count(*) FROM analytics_flujo_de_fondos WHERE company_id = $1'],
  ['company_readiness', 'SELECT count(*) FROM company_readiness WHERE company_id = $1'],
];

const cliente = new pg.Client(URL_BASE);
await cliente.connect();

const empresa = (
  await cliente.query(`SELECT id FROM companies ORDER BY created_at LIMIT 1`)
).rows[0]?.id;
if (empresa === undefined) {
  console.error(
    'La base de test no tiene empresas. Corré una suite de integración primero:\n' +
      '  npx vitest run tests/integration/stock.test.ts',
  );
  process.exit(1);
}

console.log(`Base: aai_test · empresa ${empresa}`);
console.log(`Cargando ${PRODUCTOS} productos × ${POR_PRODUCTO} movimientos…`);

await cliente.query(`SELECT set_config('app.company_id', $1, false)`, [empresa]);

const deposito = (
  await cliente.query(
    `INSERT INTO warehouses (company_id, code, name, created_by)
     VALUES ($1, 'BENCH-' || floor(random() * 1000000)::text, 'Depósito de medición', 'bench')
     RETURNING id`,
    [empresa],
  )
).rows[0].id;

const t0 = Date.now();
await cliente.query(
  `WITH nuevos AS (
     INSERT INTO products (company_id, code, name, kind, tax_treatment, tracks_stock, created_by)
     SELECT $1, 'BENCH-' || g::text || '-' || floor(random() * 1000000)::text,
            'Producto de medición ' || g, 'PRODUCTO', 'NO_GRAVADO', true, 'bench'
       FROM generate_series(1, $2) g
     RETURNING id
   )
   INSERT INTO stock_movements
     (company_id, product_id, warehouse_id, tipo, cantidad, fecha, origen_tipo,
      motivo, created_by)
   SELECT $1, n.id, $3,
          CASE WHEN m % 3 = 0 THEN 'AJUSTE_NEGATIVO' ELSE 'AJUSTE_POSITIVO' END,
          10,
          -- En orden cronológico, que es como entran los movimientos de verdad.
          -- La primera versión de este script los generaba al revés —cada uno
          -- con fecha anterior al anterior— y hacía que el trigger de la 0086
          -- rehiciera la cadena entera en cada fila: la carga no terminaba
          -- nunca. Es un dato sobre el script, y también sobre el trigger.
          current_date - 365 + (m * 365 / $4)::int,
          'AJUSTE',
          'carga de medición',
          'bench'
     FROM nuevos n, generate_series(1, $4) m`,
  [empresa, PRODUCTOS, deposito, POR_PRODUCTO],
);
console.log(`  cargado en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await cliente.query('ANALYZE stock_movements');
await cliente.query('ANALYZE stock_movement_ppp');

// A partir de acá, como la aplicación: sin privilegios y con RLS.
await cliente.query('SET ROLE aai_app');

const movimientos = (
  await cliente.query('SELECT count(*)::int AS n FROM stock_movements WHERE company_id = $1', [
    empresa,
  ])
).rows[0].n;

console.log(`\nMovimientos de stock de la empresa: ${movimientos}\n`);
console.log('vista                            mejor de 3');
console.log('───────────────────────────────  ──────────');

const lentas = [];
for (const [nombre, sql] of CONSULTAS) {
  const tiempos = [];
  for (let i = 0; i < REPETICIONES; i += 1) {
    const t = Date.now();
    try {
      await cliente.query(sql, [empresa]);
    } catch (error) {
      tiempos.push(Number.NaN);
      console.log(`${nombre.padEnd(32)} ${String(error.message).slice(0, 40)}`);
      break;
    }
    tiempos.push(Date.now() - t);
  }
  if (tiempos.some(Number.isNaN)) continue;

  const mejor = Math.min(...tiempos);
  console.log(`${nombre.padEnd(32)} ${String(mejor).padStart(7)} ms`);
  // Un umbral para mirar, no para aprobar: lo que tarda más de un segundo en
  // una máquina de escritorio con esta carga merece que alguien lo mire.
  if (mejor > 1000) lentas.push([nombre, mejor]);
}

if (lentas.length > 0) {
  console.log('\nPara mirar (más de 1000 ms con esta carga):');
  for (const [nombre, ms] of lentas) console.log(`  ${nombre} — ${ms} ms`);
} else {
  console.log('\nNinguna pasó de 1000 ms con esta carga.');
}

console.log(
  '\nEsta base quedó con datos de medición. Para dejarla limpia:\n' +
    '  npm run test:db -- --reset',
);

await cliente.end();
