#!/usr/bin/env node
/**
 * Declara el precio de un plan.
 *
 *   node scripts/declarar-precio-de-plan.mjs PROFESSIONAL MENSUAL ARS 85000.00 si 2026-10-01 "Lista de precios de octubre"
 *                                            │            │       │   │        │  │          └ motivo
 *                                            │            │       │   │        │  └ vigente desde
 *                                            │            │       │   │        └ el importe incluye impuestos: si | no
 *                                            │            │       │   └ importe
 *                                            │            │       └ moneda ISO
 *                                            │            └ MENSUAL | ANUAL
 *                                            └ código del plan
 *
 * ## Por qué es un script y no una pantalla
 *
 * El precio de un plan **no es un dato de una empresa cliente**: es de NEXO.
 * Ponerlo en la consola obligaría a decidir qué rol de una empresa puede tocar
 * el precio que esa misma empresa paga, que es una pregunta sin respuesta buena.
 * Vive donde viven las otras declaraciones del operador.
 *
 * ## Por qué no hay precios cargados
 *
 * Porque **no están decididos**, y un número de ejemplo se ve exactamente igual
 * que uno decidido. Aparecería en el catálogo, en un documento de cobro y en un
 * tablero de facturación, y nadie sabría de dónde salió. Sin precio vigente una
 * suscripción no se factura, y el ciclo lo informa con esas palabras.
 *
 * ## Una vigencia nueva cierra la anterior
 *
 * No la pisa. Un documento emitido en marzo se tiene que poder rehacer con el
 * precio de marzo: si la fila se sobrescribiera, el importe cobrado dejaría de
 * tener respaldo el día que cambie la lista.
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

const [plan, periodicidad, moneda, importe, incluye, desde, ...resto] = process.argv.slice(2);
const motivo = resto.join(' ');

const uso =
  'Uso: node scripts/declarar-precio-de-plan.mjs <PLAN> <MENSUAL|ANUAL> <MONEDA> ' +
  '<importe> <si|no incluye impuestos> <vigenteDesde AAAA-MM-DD> <motivo>';

if (
  plan === undefined ||
  periodicidad === undefined ||
  moneda === undefined ||
  importe === undefined ||
  incluye === undefined ||
  desde === undefined
) {
  console.error(uso);
  process.exit(2);
}

if (periodicidad !== 'MENSUAL' && periodicidad !== 'ANUAL') {
  console.error(`La periodicidad es MENSUAL o ANUAL, no "${periodicidad}".`);
  process.exit(2);
}
if (!/^[A-Z]{3}$/u.test(moneda)) {
  console.error(`La moneda es un código ISO de tres letras, no "${moneda}".`);
  process.exit(2);
}
// Se exige el importe con sus dos decimales escritos. Aceptar "85000" y
// completar los centavos sería suponer, y en un precio suponer es equivocarse
// por cien.
if (!/^\d+\.\d{2}$/u.test(importe)) {
  console.error(`El importe se escribe con dos decimales, por ejemplo 85000.00, no "${importe}".`);
  process.exit(2);
}
if (incluye !== 'si' && incluye !== 'no') {
  console.error(
    'Falta decir si el importe incluye impuestos: "si" o "no". No tiene valor por ' +
      'defecto porque suponerlo mal cambia lo que se cobra en un 21 %.',
  );
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(desde)) {
  console.error(`vigenteDesde tiene que ser AAAA-MM-DD, no "${desde}".`);
  process.exit(2);
}
if (motivo.trim().length < 5) {
  console.error('Falta el motivo. Dentro de seis meses es lo único que explica este precio.');
  process.exit(2);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  await cliente.query('BEGIN');

  const { rows } = await cliente.query('SELECT id, name FROM subscription_plans WHERE code = $1', [
    plan,
  ]);
  if (rows.length === 0) {
    throw new Error(`No existe el plan "${plan}". Los planes se crean con una migración.`);
  }
  const planId = rows[0].id;

  await cliente.query(
    `UPDATE plan_prices SET vigente_hasta = $4::date
      WHERE plan_id = $1 AND periodicidad = $2 AND moneda = $3
        AND vigente_hasta IS NULL AND vigente_desde < $4::date`,
    [planId, periodicidad, moneda, desde],
  );

  await cliente.query(
    `INSERT INTO plan_prices
       (plan_id, periodicidad, moneda, importe, incluye_impuestos, vigente_desde,
        declarado_por, motivo)
     VALUES ($1, $2, $3, $4::numeric, $5, $6::date, $7, $8)`,
    [
      planId,
      periodicidad,
      moneda,
      importe,
      incluye === 'si',
      desde,
      'script:declarar-precio-de-plan',
      motivo,
    ],
  );

  await cliente.query('COMMIT');
  console.log(
    `Precio declarado: ${rows[0].name} ${periodicidad} ${moneda} ${importe} ` +
      `(${incluye === 'si' ? 'con' : 'sin'} impuestos incluidos), vigente desde ${desde}.`,
  );
  console.log(
    'Declarar el precio de lista NO cambia lo acordado con quien ya está suscripto: ' +
      'company_subscriptions.importe_acordado se congela al alta, y un contrato puede ' +
      'diferir de la lista.',
  );
} catch (error) {
  await cliente.query('ROLLBACK');
  console.error(`No se pudo declarar el precio: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
