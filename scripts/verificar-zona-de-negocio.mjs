#!/usr/bin/env node
/**
 * Comprueba que las conexiones de la aplicación cuentan los días en hora argentina.
 *
 *   node scripts/verificar-zona-de-negocio.mjs
 *
 * Es de **solo lectura**: ejecuta tres `SELECT`, no escribe nada y no imprime la
 * conexión ni credencial alguna.
 *
 * ## Por qué existe
 *
 * `/health/db` es una sonda pública y se quiere que diga lo mínimo: no informa la
 * zona de las conexiones. Este script es la comprobación interna, y usa el mismo
 * `initPool` compilado que la API —no una copia de su lógica—, así que lo que
 * mide es lo que la aplicación hace de verdad.
 *
 * ## Qué dice, y cómo se lee
 *
 *   desdeLaAplicacion   una conexión abierta con `initPool`, como las de la API.
 *   conexionCruda       una conexión `pg` sin la opción de zona: lo que ve `psql`
 *                       o cualquier script que no la pida. Es el control.
 *
 * Sale con código 0 solo si la zona de la aplicación es la del negocio **y** su
 * `CURRENT_DATE` coincide con el día argentino calculado fuera de la base.
 *
 * ## La comprobación decisiva de los defectos de fechas #3, #4 y #5
 *
 * Solo tiene poder de noche. Entre las 21:00 y las 24:00 ART, `date -u +%F` ya es
 * mañana: si la conexión cruda (UTC) devuelve la fecha de mañana y la de la
 * aplicación la de hoy, el arreglo está activo. De día las dos fechas coinciden y
 * el script solo confirma la zona. Por eso el resultado dice si la comprobación
 * pudo distinguir algo (`distingue: true`).
 */

import pg from 'pg';

const { initPool, closePool, withoutCompany } = await import('@aai/db');
const { hoyEnZonaDeNegocio, ZONA_DE_NEGOCIO } = await import('@aai/shared');

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

const CONSULTA = `SELECT current_setting('TimeZone') AS zona,
                         current_date::text AS hoy,
                         (now() AT TIME ZONE 'UTC')::date::text AS hoy_utc`;

initPool(url, { max: 1 });
const desdeLaAplicacion = await withoutCompany('system:verificar-zona', async (tx) =>
  (await tx.query(CONSULTA)).rows[0],
);
await closePool();

const cruda = new pg.Client({ connectionString: url });
await cruda.connect();
const conexionCruda = (await cruda.query(CONSULTA)).rows[0];
await cruda.end();

const hoyArgentina = hoyEnZonaDeNegocio();

const zonaOk = desdeLaAplicacion.zona === ZONA_DE_NEGOCIO;
const fechaOk = desdeLaAplicacion.hoy === hoyArgentina;
const distingue = conexionCruda.hoy !== desdeLaAplicacion.hoy;

const informe = {
  zonaDeNegocio: ZONA_DE_NEGOCIO,
  desdeLaAplicacion: { zona: desdeLaAplicacion.zona, currentDate: desdeLaAplicacion.hoy },
  conexionCruda: { zona: conexionCruda.zona, currentDate: conexionCruda.hoy },
  hoyEnArgentinaCalculadoFueraDeLaBase: hoyArgentina,
  hoyEnUtc: desdeLaAplicacion.hoy_utc,
  distingue,
  zonaOk,
  fechaOk,
};
console.log(JSON.stringify(informe, null, 2));

if (!zonaOk || !fechaOk) {
  console.error(
    `\nFALLA: la aplicación debería estar en ${ZONA_DE_NEGOCIO} y con CURRENT_DATE = ${hoyArgentina}.`,
  );
  process.exit(1);
}
console.log(
  distingue
    ? '\nOK — y esta corrida distingue: la conexión cruda ve otro día que la de la aplicación.'
    : '\nOK — pero esta corrida no distingue (las dos zonas dan el mismo día). Repetir entre las 21:00 y las 24:00 ART.',
);
