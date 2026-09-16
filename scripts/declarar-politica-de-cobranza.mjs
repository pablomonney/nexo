#!/usr/bin/env node
/**
 * Declara qué pasa cuando un pago falla.
 *
 *   node scripts/declarar-politica-de-cobranza.mjs 3,7,14 0,2,5 17 21 2026-10-01 "Política inicial"
 *                                                  │      │     │  │  │          └ motivo
 *                                                  │      │     │  │  └ vigente desde
 *                                                  │      │     │  └ días hasta suspender
 *                                                  │      │     └ días hasta la mora
 *                                                  │      └ avisos, en días desde el fallo
 *                                                  └ reintentos, en días desde el fallo
 *
 * Para una política sin reintentos, sin avisos o sin paso de mora se pasa `""`
 * en el argumento correspondiente. Los tres vacíos son decisiones declarables y
 * distintas de no tener política.
 *
 * ## Sin política declarada no pasa nada, y eso está bien
 *
 * Un pago fallido se registra igual. Lo que no ocurre es el reintento, el aviso,
 * la mora ni la suspensión. **Eso no es «cero reintentos»**: es que nadie dijo
 * cuántos.
 *
 * La diferencia importa el día que el sistema suspenda a un cliente: si el
 * calendario saliera de un valor por defecto puesto en el código, nadie podría
 * decir quién lo decidió. Es la misma disciplina que los cupos de IA y los topes
 * de plan.
 *
 * ## Los días se cuentan desde el fallo, no desde el paso anterior
 *
 * Con offsets relativos, agregar un reintento o un aviso en el medio corre todos
 * los siguientes y le cambia el calendario a quien ya estaba en curso.
 *
 * ## Qué hace cada paso
 *
 *     REINTENTO   se vuelve a consultar el cobro.
 *     AVISO       sale un mensaje. No cambia el estado de nada.
 *     MORA        la suscripción pasa a MOROSA: el servicio sigue y los módulos
 *                 que no sobreviven a la mora (0125) quedan en pausa.
 *     SUSPENSION  se corta el acceso.
 *
 * Los cuatro conservan **todo**: los datos, la contabilidad y el historial.
 *
 * ## Lo que la base no deja declarar
 *
 * Suspender antes del último reintento —el reintento correría sobre una
 * suscripción ya suspendida, cobraría bien y el cliente seguiría afuera—,
 * avisar después de suspender, poner la mora después de la suspensión y repetir
 * o desordenar los días de aviso. Son `CHECK` de la 0096 y la 0126, no
 * validaciones de este script: un `INSERT` por otro camino tampoco puede.
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

const [reintentos, avisos, mora, gracia, desde, ...resto] = process.argv.slice(2);
const motivo = resto.join(' ');

if (
  reintentos === undefined ||
  avisos === undefined ||
  mora === undefined ||
  gracia === undefined ||
  desde === undefined
) {
  console.error(
    'Uso: node scripts/declarar-politica-de-cobranza.mjs <reintentos> <avisos> ' +
      '<diasHastaLaMora> <diasHastaSuspender> <vigenteDesde AAAA-MM-DD> <motivo>',
  );
  console.error('Los reintentos y los avisos son días separados por coma. "" para ninguno.');
  console.error('diasHastaLaMora admite "" para una política sin escalón de mora.');
  process.exit(2);
}

/** Un arreglo de días desde la coma, o `null` si no es uno. */
function listaDeDias(texto) {
  if (texto.trim() === '') return [];
  const partes = texto.split(',').map((d) => d.trim());
  return partes.every((d) => /^\d+$/u.test(d)) ? partes.map(Number) : null;
}

const diasDeReintento = listaDeDias(reintentos);
if (diasDeReintento === null) {
  console.error(`Los reintentos son días enteros separados por coma, no "${reintentos}".`);
  process.exit(2);
}

const diasDeAviso = listaDeDias(avisos);
if (diasDeAviso === null) {
  console.error(`Los avisos son días enteros separados por coma, no "${avisos}".`);
  process.exit(2);
}

// `""` es «esta política no declara un paso de mora» y llega a la base como
// NULL. **No se traduce a cero**: cero sería «la mora empieza el día del
// fallo», que es otra decisión y perfectamente declarable escribiendo 0.
const diasDeMora = mora.trim() === '' ? null : mora.trim();
if (diasDeMora !== null && !/^\d+$/u.test(diasDeMora)) {
  console.error(`diasHastaLaMora tiene que ser un entero de días o "", no "${mora}".`);
  process.exit(2);
}

if (!/^\d+$/u.test(gracia)) {
  console.error(`diasHastaSuspender tiene que ser un entero de días, no "${gracia}".`);
  process.exit(2);
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
       (reintentos_en_dias, aviso_en_dias, dias_de_mora, dias_de_gracia,
        vigente_desde, declarado_por, motivo)
     VALUES ($1::integer[], $2::integer[], $3::integer, $4::integer, $5::date, $6, $7)`,
    [
      diasDeReintento,
      diasDeAviso,
      diasDeMora === null ? null : Number(diasDeMora),
      Number(gracia),
      desde,
      'script:declarar-politica-de-cobranza',
      motivo,
    ],
  );

  await cliente.query('COMMIT');
  console.log(
    `Política declarada, vigente desde ${desde}:\n` +
      `  reintentos  ${diasDeReintento.length === 0 ? 'ninguno' : `a los ${diasDeReintento.join(', ')} días`}\n` +
      `  avisos      ${diasDeAviso.length === 0 ? 'ninguno' : `a los ${diasDeAviso.join(', ')} días`}\n` +
      `  mora        ${diasDeMora === null ? 'sin escalón: de ACTIVA pasa a SUSPENDIDA' : `a los ${diasDeMora} días`}\n` +
      `  suspensión  a los ${gracia} días`,
  );
  console.log(
    '\nLa mora y la suspensión conservan todo: los datos, la contabilidad y el ' +
      'historial. La mora apaga los módulos que no sobreviven a la mora; la ' +
      'suspensión corta el acceso. Las dos se levantan pagando.',
  );
} catch (error) {
  await cliente.query('ROLLBACK');
  console.error(`No se pudo declarar la política: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
