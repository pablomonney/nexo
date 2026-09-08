#!/usr/bin/env node
/**
 * Declara qué pasa cuando un pago falla.
 *
 *   node scripts/declarar-politica-de-cobranza.mjs 3,7,14 17 21 2026-10-01 "Política inicial"
 *                                                  │      │  │  │          └ motivo
 *                                                  │      │  │  └ vigente desde
 *                                                  │      │  └ días hasta suspender
 *                                                  │      └ días hasta avisar
 *                                                  └ reintentos, en días desde el fallo
 *
 * ## Sin política declarada no pasa nada, y eso está bien
 *
 * Un pago fallido se registra igual. Lo que no ocurre es el reintento, el aviso
 * ni la suspensión. **Eso no es «cero reintentos»**: es que nadie dijo cuántos.
 *
 * La diferencia importa el día que el sistema suspenda a un cliente: si el
 * calendario saliera de un valor por defecto puesto en el código, nadie podría
 * decir quién lo decidió. Es la misma disciplina que los cupos de IA y los topes
 * de plan.
 *
 * ## Los días se cuentan desde el fallo, no desde el reintento anterior
 *
 * Con offsets relativos, agregar un reintento en el medio corre todos los
 * siguientes y le cambia el calendario a quien ya estaba en curso.
 *
 * ## Lo que la base no deja declarar
 *
 * Suspender antes del último reintento —el reintento correría sobre una
 * suscripción ya suspendida, cobraría bien y el cliente seguiría afuera— y
 * avisar después de suspender. Los dos son `CHECK` de la 0096, no validaciones
 * de este script: un `INSERT` por otro camino tampoco puede.
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

const [reintentos, aviso, gracia, desde, ...resto] = process.argv.slice(2);
const motivo = resto.join(' ');

if (
  reintentos === undefined ||
  aviso === undefined ||
  gracia === undefined ||
  desde === undefined
) {
  console.error(
    'Uso: node scripts/declarar-politica-de-cobranza.mjs <dias,separados,por,coma> ' +
      '<diasHastaAvisar> <diasHastaSuspender> <vigenteDesde AAAA-MM-DD> <motivo>',
  );
  console.error('Para una política sin reintentos, pasá "" como primer argumento.');
  process.exit(2);
}

const dias = reintentos.trim() === '' ? [] : reintentos.split(',').map((d) => d.trim());
if (dias.some((d) => !/^\d+$/u.test(d))) {
  console.error(`Los reintentos son días enteros separados por coma, no "${reintentos}".`);
  process.exit(2);
}
for (const [nombre, valor] of [
  ['diasHastaAvisar', aviso],
  ['diasHastaSuspender', gracia],
]) {
  if (!/^\d+$/u.test(valor)) {
    console.error(`${nombre} tiene que ser un entero de días, no "${valor}".`);
    process.exit(2);
  }
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(desde)) {
  console.error(`vigenteDesde tiene que ser AAAA-MM-DD, no "${desde}".`);
  process.exit(2);
}
if (motivo.trim().length < 5) {
  console.error(
    'Falta el motivo. Es lo único que va a explicar, el día que suspenda a alguien, ' +
      'por qué el calendario es este.',
  );
  process.exit(2);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  await cliente.query('BEGIN');

  await cliente.query(
    `UPDATE collection_policies SET vigente_hasta = $1::date
      WHERE vigente_hasta IS NULL AND vigente_desde < $1::date`,
    [desde],
  );

  await cliente.query(
    `INSERT INTO collection_policies
       (reintentos_en_dias, aviso_en_dias, dias_de_gracia, vigente_desde, declarado_por, motivo)
     VALUES ($1::integer[], $2::integer, $3::integer, $4::date, $5, $6)`,
    [
      dias.map((d) => Number(d)),
      Number(aviso),
      Number(gracia),
      desde,
      'script:declarar-politica-de-cobranza',
      motivo,
    ],
  );

  await cliente.query('COMMIT');
  console.log(
    `Política declarada, vigente desde ${desde}: ` +
      `${dias.length === 0 ? 'sin reintentos' : `reintentos a los ${dias.join(', ')} días`}, ` +
      `aviso a los ${aviso}, suspensión a los ${gracia}.`,
  );
  console.log(
    'Suspender conserva todo: los datos, la contabilidad y el historial. Lo que se ' +
      'corta es el acceso, y se levanta pagando.',
  );
} catch (error) {
  await cliente.query('ROLLBACK');
  console.error(`No se pudo declarar la política: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
