#!/usr/bin/env node
/**
 * Comprueba que las conexiones de la aplicación cuentan los días en hora argentina.
 *
 *   node scripts/verificar-zona-de-negocio.mjs
 *
 * Es de SOLO LECTURA: ejecuta SELECT, no escribe nada y no imprime la conexión
 * ni credencial alguna.
 *
 * ## Por qué existe
 *
 * /health/db es una sonda pública y se quiere que diga lo mínimo: no informa la
 * zona de las conexiones. Este script es la comprobación interna, y usa el mismo
 * initPool compilado que la API —no una copia de su lógica—, así que lo que mide
 * es lo que la aplicación hace de verdad.
 *
 * ## Lo que se midió mal la primera vez
 *
 * La primera versión comparaba CURRENT_DATE con el reloj real, y su capacidad de
 * distinguir las dos zonas dependía de A QUÉ HORA SE LA CORRÍA: de día las dos
 * fechas coinciden y el resultado era distingue=false aunque todo estuviera bien.
 * Esa corrida no demostraba nada sobre los defectos de fechas.
 *
 * Ahora la prueba principal NO DEPENDE DEL RELOJ. Se le pide a PostgreSQL que
 * convierta a fecha una matriz de instantes fijos alrededor de las 21:00 ART, de
 * fin de mes y de fin de año —(instante::timestamptz)::date usa la zona de la
 * sesión— y se compara con la fecha argentina calculada fuera de la base. Si la
 * conexión de la aplicación estuviera en UTC, los instantes de las 21:00 a las
 * 24:00 ART darían otro día, a cualquier hora a la que se corra esto.
 *
 * ## Cómo se lee
 *
 *   desdeLaAplicacion   una conexión abierta con initPool, como las de la API.
 *   conexionCruda       una conexión pg sin la opción de zona: lo que ve psql o
 *                       cualquier script que no la pida. Es el control.
 *   matriz              cada instante: lo esperado, lo que dice la aplicación y
 *                       lo que dice la conexión cruda.
 *   distingue           true si la conexión cruda ve algún día distinto del
 *                       argentino: la comprobación tiene poder. Contra una base
 *                       en UTC (producción) es SIEMPRE true, a cualquier hora.
 *   funcionesDeHash     las tres funciones de la cadena de auditoría y lo que
 *                       tienen fijado (migraciones 0131 y 0132). Informativo.
 *
 * Sale con código 0 solo si la zona de la aplicación es la del negocio, TODA la
 * matriz coincide, y su CURRENT_DATE coincide con el día argentino de ahora.
 */

import pg from 'pg';

const { initPool, closePool, withoutCompany } = await import('@aai/db');
const { hoyEnZonaDeNegocio, ZONA_DE_NEGOCIO } = await import('@aai/shared');

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

/**
 * Instantes fijos. 21:00 ART = 00:00Z del día siguiente, que es donde un
 * CURRENT_DATE en UTC adelanta un día. Incluye fin de mes, fin de año y febrero
 * (común y bisiesto).
 */
const INSTANTES = [
  '2026-10-05T23:59:59Z', // 20:59:59 ART
  '2026-10-06T00:00:00Z', // 21:00:00 ART
  '2026-10-06T00:00:01Z', // 21:00:01 ART
  '2026-10-06T02:59:59Z', // 23:59:59 ART
  '2026-10-06T03:00:00Z', // 00:00:00 ART del día siguiente
  '2026-10-31T23:59:59Z', // último día del mes, 20:59:59 ART
  '2026-11-01T00:00:00Z', // 21:00 ART del 31/10: en UTC ya es noviembre
  '2026-11-01T03:00:00Z', // 00:00 ART del 01/11
  '2026-12-31T23:59:59Z', // 20:59:59 ART del 31/12
  '2027-01-01T00:00:00Z', // 21:00 ART del 31/12: en UTC ya es año nuevo
  '2027-01-01T02:59:59Z', // 23:59:59 ART del 31/12
  '2027-01-01T03:00:00Z', // 00:00 ART del 01/01
  '2027-03-01T02:59:59Z', // 28/02 en un año común
  '2028-03-01T02:59:59Z', // 29/02 en un año bisiesto
];

const CONSULTA_DE_LA_MATRIZ = `SELECT i AS instante, (i::timestamptz)::date::text AS dia
                                 FROM unnest($1::text[]) WITH ORDINALITY AS t(i, n)
                                ORDER BY n`;

const CONSULTA_DE_LA_SESION = `SELECT current_setting('TimeZone') AS zona,
                                      current_date::text AS hoy,
                                      (now() AT TIME ZONE 'UTC')::date::text AS hoy_utc`;

const CONSULTA_DE_FUNCIONES = `SELECT proname, coalesce(array_to_string(proconfig, ' | '), '') AS fijado
                                 FROM pg_proc
                                WHERE pronamespace = 'public'::regnamespace
                                  AND proname IN ('audit_chain_link', 'normative_audit_chain_link', 'verify_audit_chain')
                                ORDER BY proname`;

// «Hoy» se calcula fuera de la base ANTES y DESPUÉS de consultarla: si la consulta
// cae justo en la medianoche argentina, la base puede ver el día nuevo y el
// cálculo de antes el viejo (o al revés). Cualquiera de los dos extremos vale.
const hoyAntes = hoyEnZonaDeNegocio();
initPool(url, { max: 1 });
const aplicacion = await withoutCompany('system:verificar-zona', async (tx) => ({
  sesion: (await tx.query(CONSULTA_DE_LA_SESION)).rows[0],
  matriz: (await tx.query(CONSULTA_DE_LA_MATRIZ, [INSTANTES])).rows,
  funciones: (await tx.query(CONSULTA_DE_FUNCIONES)).rows,
}));
await closePool();

const cruda = new pg.Client({ connectionString: url });
await cruda.connect();
const conexionCruda = {
  sesion: (await cruda.query(CONSULTA_DE_LA_SESION)).rows[0],
  matriz: (await cruda.query(CONSULTA_DE_LA_MATRIZ, [INSTANTES])).rows,
};
await cruda.end();

const matriz = INSTANTES.map((instante, i) => ({
  instante,
  esperado: hoyEnZonaDeNegocio(new Date(instante)),
  aplicacion: aplicacion.matriz[i].dia,
  cruda: conexionCruda.matriz[i].dia,
}));

const hoyArgentina = hoyEnZonaDeNegocio();
const hoyPosible = (dia) => dia === hoyAntes || dia === hoyArgentina;
const zonaOk = aplicacion.sesion.zona === ZONA_DE_NEGOCIO;
const matrizOk = matriz.every((fila) => fila.aplicacion === fila.esperado);
const fechaOk = hoyPosible(aplicacion.sesion.hoy);
const distingue = matriz.some((fila) => fila.cruda !== fila.esperado);

const informe = {
  zonaDeNegocio: ZONA_DE_NEGOCIO,
  desdeLaAplicacion: { zona: aplicacion.sesion.zona, currentDate: aplicacion.sesion.hoy },
  conexionCruda: { zona: conexionCruda.sesion.zona, currentDate: conexionCruda.sesion.hoy },
  hoyEnArgentinaCalculadoFueraDeLaBase: hoyArgentina,
  hoyEnUtc: aplicacion.sesion.hoy_utc,
  matriz,
  funcionesDeHash: aplicacion.funciones,
  zonaOk,
  matrizOk,
  fechaOk,
  distingue,
};
console.log(JSON.stringify(informe, null, 2));

if (!zonaOk || !matrizOk || !fechaOk) {
  console.error(
    `\nFALLA: la aplicación debería estar en ${ZONA_DE_NEGOCIO}` +
      (matrizOk ? '' : ', y la conversión de los instantes fijos no coincide') +
      (fechaOk ? '' : `, y su CURRENT_DATE debería ser ${hoyArgentina}`) +
      '.',
  );
  process.exit(1);
}
console.log(
  distingue
    ? '\nOK — y la comprobación distingue: la conexión cruda ve otro día que la de la aplicación en al menos un instante fijo.'
    : '\nOK — pero esta base ya está en la zona del negocio por defecto: la conexión cruda no se distingue de la de la aplicación, así que no se demostró que initPool la pida. La base de producción (UTC) siempre distingue.',
);
