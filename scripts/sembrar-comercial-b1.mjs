#!/usr/bin/env node
/**
 * Declara los precios y los topes de la hipótesis comercial B-1.
 *
 *   npm run comercial:b1              # ve qué haría
 *   npm run comercial:b1 -- --aplicar # lo declara
 *
 * ## Por qué esto es un script y no una migración
 *
 * Un precio cambia y una migración no. Poner `29900.00` dentro de un archivo
 * que se aplica una sola vez y no se puede editar dejaría el precio de octubre
 * escrito para siempre en la historia del esquema, y el de noviembre en otro
 * lado.
 *
 * Acá cada precio se declara con **vigencia y motivo**, y una vigencia nueva
 * cierra la anterior en vez de pisarla: un documento emitido en marzo se tiene
 * que poder rehacer con el precio de marzo.
 *
 * ## Lo que estos números son, exactamente
 *
 * Los **precios** salen de una decisión tomada: son los de B-1.
 *
 * Los **topes** —cuántas empresas, cuántos usuarios, cuántos comprobantes por
 * mes entran en cada plan— **no los decidió nadie todavía**. Son una hipótesis,
 * y por eso quedan declarados con `declarado_por = 'hipotesis-b1'`: para que se
 * distingan de una decisión tomada cuando alguien mire por qué a un cliente se
 * le avisó que excedió su plan.
 *
 * Que se puedan distinguir importa porque **el tope no bloquea**: avisa. Un
 * sistema contable que se niega a registrar un hecho por una cuestión comercial
 * deja los libros incompletos, y eso no se arregla pagando después.
 *
 * ## Sin `--aplicar` no escribe nada
 *
 * Declarar precios es un acto comercial con consecuencias, y el que lo corre
 * tiene que poder ver qué va a declarar antes de declararlo.
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

const aplicar = process.argv.includes('--aplicar');
const desdeDeclarado = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/u.test(a)) ?? null;

/**
 * «Hoy» es el día que dice la base, no el que dice UTC.
 *
 * Esto decía `getUTCDate()`, y en Argentina —UTC menos tres— después de las
 * nueve de la noche eso ya es mañana. Consecuencia medida el 2026-09-09 a las
 * 22:07: los cinco precios quedaron con `vigente_desde` en el día siguiente, la
 * consulta del catálogo —que compara contra `CURRENT_DATE`— no encontró
 * ninguno, y **los planes se quedaron sin precio hasta la medianoche**. Tres
 * pruebas se pusieron en rojo por un huso horario.
 *
 * Se le pregunta a la base porque es la base la que después compara: cualquier
 * otra fuente puede discrepar con ella y este es exactamente el error que se
 * está arreglando.
 */
async function hoySegunLaBase(cliente) {
  const { rows } = await cliente.query('SELECT CURRENT_DATE::text AS hoy');
  return rows[0].hoy;
}

/**
 * Los precios de B-1. **Sin IVA**: `incluye_impuestos = false`.
 *
 * La lista comercial dice «+ IVA», así que lo que se guarda es el neto. Guardar
 * el final y llamarlo neto sería equivocarse por un 21 % en cada cargo.
 */
const PRECIOS = [
  ['CONTABLE', 'MENSUAL', 'ARS', '29900.00'],
  ['GESTION', 'MENSUAL', 'ARS', '59900.00'],
  ['ESTUDIO', 'MENSUAL', 'ARS', '79900.00'],
  ['EMPRESA_B1', 'MENSUAL', 'ARS', '99900.00'],
  ['COMPLETO', 'MENSUAL', 'ARS', '159900.00'],
];

/**
 * Los topes. **Hipótesis, no decisión.**
 *
 * Cada uno responde a lo que el plan pretende cubrir: Contable es una empresa
 * llevando sus libros; Estudio es una cartera de clientes; Completo es una
 * organización con varias unidades.
 *
 * Ninguno bloquea: el sistema mide el uso y avisa.
 */
const TOPES = {
  CONTABLE:   { EMPRESAS: 1,  USUARIOS: 3,  COMPROBANTES_MES: 300,   DOCUMENTOS_MES: 300,   INTEGRACIONES: 1 },
  GESTION:    { EMPRESAS: 1,  USUARIOS: 8,  COMPROBANTES_MES: 1500,  DOCUMENTOS_MES: 1500,  INTEGRACIONES: 2 },
  ESTUDIO:    { EMPRESAS: 25, USUARIOS: 10, COMPROBANTES_MES: 4000,  DOCUMENTOS_MES: 4000,  INTEGRACIONES: 2 },
  EMPRESA_B1: { EMPRESAS: 3,  USUARIOS: 20, COMPROBANTES_MES: 6000,  DOCUMENTOS_MES: 6000,  INTEGRACIONES: 5 },
  COMPLETO:   { EMPRESAS: 5,  USUARIOS: 40, COMPROBANTES_MES: 20000, DOCUMENTOS_MES: 20000, INTEGRACIONES: 15 },
};

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

try {
  const planes = new Map(
    (
      await cliente.query(
        `SELECT code, id, name FROM subscription_plans WHERE status = 'DISPONIBLE'`,
      )
    ).rows.map((r) => [r.code, r]),
  );

  const faltantes = PRECIOS.map(([c]) => c).filter((c) => !planes.has(c));
  if (faltantes.length > 0) {
    throw new Error(`No hay planes disponibles con estos códigos: ${faltantes.join(', ')}`);
  }

  const desde = desdeDeclarado ?? (await hoySegunLaBase(cliente));

  console.log(`\n══ Hipótesis comercial B-1 ${aplicar ? '' : '(ENSAYO)'} ═══════════════\n`);
  console.log(`  Vigente desde ${desde}\n`);

  for (const [code, , moneda, importe] of PRECIOS) {
    console.log(`  ${planes.get(code).name.padEnd(16)} ${moneda} ${importe.padStart(10)} / mes + IVA`);
  }
  console.log('');

  if (!aplicar) {
    console.log('  Los TOPES son una hipótesis, no una decisión tomada:\n');
    for (const [code, topes] of Object.entries(TOPES)) {
      console.log(
        `    ${code.padEnd(11)} ` +
          Object.entries(topes)
            .map(([r, t]) => `${r.toLowerCase()}=${t}`)
            .join('  '),
      );
    }
    console.log('\n  Nada se escribió. Para declararlo: npm run comercial:b1 -- --aplicar\n');
    process.exit(0);
  }

  await cliente.query('BEGIN');

  for (const [code, periodicidad, moneda, importe] of PRECIOS) {
    const planId = planes.get(code).id;
    // Una vigencia nueva cierra la anterior. Sin esto quedarían dos precios
    // vigentes y el motor elegiría por orden de inserción, es decir por azar.
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
       VALUES ($1, $2, $3, $4::numeric, false, $5::date, 'b1', $6)
       ON CONFLICT (plan_id, periodicidad, moneda, vigente_desde) DO NOTHING`,
      [
        planId,
        periodicidad,
        moneda,
        importe,
        desde,
        'Lista de precios de B-1. Importes NETOS: la lista comercial dice «+ IVA».',
      ],
    );
  }

  for (const [code, topes] of Object.entries(TOPES)) {
    const planId = planes.get(code).id;
    for (const [recurso, tope] of Object.entries(topes)) {
      await cliente.query(
        `INSERT INTO plan_limits (plan_id, recurso, tope, declarado_por)
         VALUES ($1, $2, $3, 'hipotesis-b1')
         ON CONFLICT (plan_id, recurso) DO UPDATE
           SET tope = EXCLUDED.tope, declarado_por = EXCLUDED.declarado_por,
               declarado_el = now()`,
        [planId, recurso, tope],
      );
    }
  }

  await cliente.query('COMMIT');

  console.log('  Declarado.\n');
  console.log('  Los precios quedaron como decisión (declarado_por = b1).');
  console.log('  Los topes quedaron como HIPÓTESIS (declarado_por = hipotesis-b1):');
  console.log('  cuando alguien los confirme, volver a declararlos con su nombre.\n');
  console.log('  Recordá que el tope NO bloquea: avisa. Un sistema contable que se');
  console.log('  niega a registrar un hecho por una cuestión comercial deja los libros');
  console.log('  incompletos, y eso no se arregla pagando después.\n');
} catch (error) {
  await cliente.query('ROLLBACK').catch(() => undefined);
  console.error(`No se pudo declarar: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
