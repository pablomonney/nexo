#!/usr/bin/env node
/**
 * Declara el precio de un modelo, para que `cost_micros` pueda calcularse.
 *
 *   node scripts/declarar-precio-de-modelo.mjs http gpt-x 150 600 2026-09-01
 *                                              │    │     │   │   └ vigente desde
 *                                              │    │     │   └ micros por mil de salida
 *                                              │    │     └ micros por mil de entrada
 *                                              │    └ model_id, como lo informa el proveedor
 *                                              └ model_provider, como queda en ai_predictions
 *
 * ## Por qué es un script y no una pantalla
 *
 * Un precio no es un dato de una empresa: es del proveedor, y lo declara quien
 * opera NEXO. Ponerlo en la consola obligaría a decidir qué rol de una empresa
 * cliente puede tocar el precio de un modelo, que es una pregunta sin respuesta
 * buena. Vive donde viven las otras siembras del operador.
 *
 * ## Por qué no hay precios cargados
 *
 * Porque son de un proveedor real y **no se inventan**. Un precio inventado
 * produce un costo que se ve igual que uno correcto y se suma igual en un
 * informe que alguien va a comparar contra una factura. Sin fila aplicable,
 * `ai_predictions.cost_micros` queda en `NULL` — que es «no se puede afirmar»,
 * y es la verdad.
 *
 * Los importes son **enteros en micros por cada mil tokens**: un precio en punto
 * flotante multiplicado por millones de tokens acumula error.
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

const [proveedor, modelo, entrada, salida, desde, moneda = 'USD'] = process.argv.slice(2);

if (
  proveedor === undefined ||
  modelo === undefined ||
  entrada === undefined ||
  salida === undefined ||
  desde === undefined
) {
  console.error(
    'Uso: node scripts/declarar-precio-de-modelo.mjs <proveedor> <modelo> ' +
      '<microsEntradaPorMil> <microsSalidaPorMil> <vigenteDesde AAAA-MM-DD> [moneda]',
  );
  process.exit(2);
}

for (const [nombre, valor] of [
  ['microsEntradaPorMil', entrada],
  ['microsSalidaPorMil', salida],
]) {
  if (!/^\d+$/u.test(valor)) {
    console.error(`${nombre} tiene que ser un entero de micros por mil tokens, no "${valor}".`);
    process.exit(2);
  }
}

if (!/^\d{4}-\d{2}-\d{2}$/u.test(desde)) {
  console.error(`vigenteDesde tiene que ser AAAA-MM-DD, no "${desde}".`);
  process.exit(2);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  // Una vigencia nueva **cierra la anterior** en vez de pisarla: el costo de una
  // predicción de marzo se tiene que poder rehacer con el precio de marzo.
  await cliente.query('BEGIN');
  await cliente.query(
    `UPDATE ai_pricing SET vigente_hasta = $3::date
      WHERE model_provider = $1 AND model_id = $2
        AND vigente_hasta IS NULL AND vigente_desde < $3::date`,
    [proveedor, modelo, desde],
  );
  await cliente.query(
    `INSERT INTO ai_pricing
       (model_provider, model_id, input_micros_por_mil, output_micros_por_mil,
        moneda, vigente_desde, declarado_por)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7)`,
    [proveedor, modelo, entrada, salida, moneda, desde, 'script:declarar-precio-de-modelo'],
  );
  await cliente.query('COMMIT');

  console.log(
    `Precio declarado: ${proveedor}/${modelo} — entrada ${entrada}, salida ${salida} ` +
      `micros por mil tokens (${moneda}), vigente desde ${desde}.`,
  );
} catch (error) {
  await cliente.query('ROLLBACK');
  console.error(`No se pudo declarar el precio: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
