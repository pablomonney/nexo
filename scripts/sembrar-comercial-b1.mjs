#!/usr/bin/env node
/**
 * Declara la configuración comercial de NEXO: precios y topes de los cinco
 * planes disponibles.
 *
 *   npm run comercial:b1              # muestra qué haría, sin escribir
 *   npm run comercial:b1 -- --aplicar # lo declara
 *
 * ## Los números de acá son decisiones tomadas, no hipótesis
 *
 * La versión anterior de este archivo llevaba la lista de B-1 —29.900 a
 * 159.900, netos— con `declarado_por = 'hipotesis-b1'` y una advertencia de que
 * **nadie los había decidido**. Esos valores quedaron obsoletos el 2026-09-15 y
 * **no se pueden volver a sembrar**: no están en ninguna parte de este archivo.
 *
 * Lo que hay ahora son los precios comerciales definitivos, con dos diferencias
 * que cambian lo que se cobra y conviene tener presentes:
 *
 *   · **Son finales, con IVA incluido** (`incluye_impuestos = true`). La lista
 *     anterior era neta. Un plan de 59.900 se le cobra al cliente 59.900, y el
 *     neto sale de dividir, no de sumar.
 *   · Los topes **también son decisiones**, ya no hipótesis. Por eso
 *     `declarado_por` dice `comercial-2026-09` y no `hipotesis-b1`.
 *
 * ## Por qué esto es un script y no una migración
 *
 * Un precio cambia y una migración no. Poner `59900.00` dentro de un archivo
 * que se aplica una sola vez y no se puede editar dejaría el precio de
 * septiembre escrito para siempre en la historia del esquema, y el de octubre
 * en otro lado.
 *
 * Acá cada precio se declara con **vigencia y motivo**, y una vigencia nueva
 * cierra la anterior en vez de pisarla: un documento emitido en marzo se tiene
 * que poder rehacer con el precio de marzo.
 *
 * ## Correrlo dos veces no duplica nada
 *
 * Los precios cierran la vigencia anterior y abren una nueva solo si cambió
 * algo; los topes se escriben con `ON CONFLICT DO UPDATE`. Volver a correrlo el
 * mismo día deja la base como está.
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

/** Quién declaró esto. Sirve para distinguirlo de la hipótesis vieja. */
const DECLARANTE = 'comercial-2026-09';

const MOTIVO_PRECIO =
  'Lista comercial de septiembre de 2026. Importes FINALES, con IVA incluido.';
const MOTIVO_TOPE =
  'Topes comerciales de septiembre de 2026. Decisión tomada, no hipótesis.';

/**
 * «Hoy» es el día que dice la base, no el que dice UTC.
 *
 * Esto decía `getUTCDate()`, y en Argentina —UTC menos tres— después de las
 * nueve de la noche eso ya es mañana. Consecuencia medida el 2026-09-09 a las
 * 22:07: los cinco precios quedaron con `vigente_desde` en el día siguiente, la
 * consulta del catálogo —que compara contra `CURRENT_DATE`— no encontró
 * ninguno, y **los planes se quedaron sin precio hasta la medianoche**.
 */
async function hoySegunLaBase(cliente) {
  const { rows } = await cliente.query('SELECT CURRENT_DATE::text AS hoy');
  return rows[0].hoy;
}

/**
 * Los precios definitivos. **Finales, con IVA incluido.**
 *
 * `incluye_impuestos` no tiene valor por defecto en el esquema justamente para
 * que esta decisión se escriba: suponerla mal cambia lo que se cobra en un 21 %.
 */
const INCLUYE_IMPUESTOS = true;

const PRECIOS = [
  ['CONTABLE', 'MENSUAL', 'ARS', '59900.00'],
  ['ESTUDIO', 'MENSUAL', 'ARS', '89900.00'],
  ['GESTION', 'MENSUAL', 'ARS', '119900.00'],
  ['EMPRESA_B1', 'MENSUAL', 'ARS', '249900.00'],
  ['COMPLETO', 'MENSUAL', 'ARS', '449900.00'],
];

/**
 * Los topes, por plan y por recurso.
 *
 * `ILIMITADO` no es un número grande: es una fila que declara que **este plan no
 * tiene tope de ese recurso** (0122). Es distinto de no declarar la fila, que
 * significa «nadie lo escribió» y así se informa.
 *
 * Los cinco recursos que el sistema mide de verdad. `EMPRESAS` pasó a medirse
 * en la 0122: antes se podía declarar y ninguna vista lo evaluaba.
 *
 * `COMPROBANTES_MES` y `DOCUMENTOS_MES` son dos recursos distintos —un
 * comprobante fiscal no es un documento subido— y la decisión comercial les da
 * el mismo número a los dos.
 */
const ILIMITADO = Symbol('sin tope');

const TOPES = {
  CONTABLE:   { EMPRESAS: 1,  USUARIOS: 2,  COMPROBANTES_MES: 1000,   DOCUMENTOS_MES: 1000,   INTEGRACIONES: 1 },
  ESTUDIO:    { EMPRESAS: 20, USUARIOS: 5,  COMPROBANTES_MES: 5000,   DOCUMENTOS_MES: 5000,   INTEGRACIONES: 3 },
  GESTION:    { EMPRESAS: 1,  USUARIOS: 5,  COMPROBANTES_MES: 5000,   DOCUMENTOS_MES: 5000,   INTEGRACIONES: 3 },
  EMPRESA_B1: { EMPRESAS: 5,  USUARIOS: 15, COMPROBANTES_MES: 25000,  DOCUMENTOS_MES: 25000,  INTEGRACIONES: 10 },
  COMPLETO:   { EMPRESAS: 20, USUARIOS: 50, COMPROBANTES_MES: 100000, DOCUMENTOS_MES: 100000, INTEGRACIONES: ILIMITADO },
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

  console.log(`\n══ Configuración comercial ${aplicar ? '' : '(ENSAYO)'} ═══════════════════\n`);
  console.log(`  Vigente desde ${desde}   ·   importes FINALES (IVA incluido)\n`);

  for (const [code, , moneda, importe] of PRECIOS) {
    const t = TOPES[code];
    console.log(`  ${planes.get(code).name.padEnd(16)} ${moneda} ${importe.padStart(10)} / mes`);
    console.log(
      `    ${Object.entries(t)
        .map(([r, v]) => `${r.toLowerCase()}=${v === ILIMITADO ? 'sin tope' : v}`)
        .join('  ')}`,
    );
  }

  if (!aplicar) {
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
       VALUES ($1, $2, $3, $4::numeric, $5, $6::date, $7, $8)
       ON CONFLICT (plan_id, periodicidad, moneda, vigente_desde) DO UPDATE
         SET importe = EXCLUDED.importe,
             incluye_impuestos = EXCLUDED.incluye_impuestos,
             declarado_por = EXCLUDED.declarado_por,
             motivo = EXCLUDED.motivo`,
      [planId, periodicidad, moneda, importe, INCLUYE_IMPUESTOS, desde, DECLARANTE, MOTIVO_PRECIO],
    );
  }

  for (const [code, topes] of Object.entries(TOPES)) {
    const planId = planes.get(code).id;
    for (const [recurso, valor] of Object.entries(topes)) {
      const sinTope = valor === ILIMITADO;
      await cliente.query(
        `INSERT INTO plan_limits (plan_id, recurso, tope, ilimitado, declarado_por)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (plan_id, recurso) DO UPDATE
           SET tope = EXCLUDED.tope,
               ilimitado = EXCLUDED.ilimitado,
               declarado_por = EXCLUDED.declarado_por,
               declarado_el = now()`,
        [planId, recurso, sinTope ? null : valor, sinTope, DECLARANTE],
      );
    }
  }

  await cliente.query('COMMIT');

  console.log('\n  Declarado.\n');
  console.log(`  ${MOTIVO_PRECIO}`);
  console.log(`  ${MOTIVO_TOPE}\n`);
  console.log(
    '  Declarar la lista NO cambia lo acordado con quien ya está suscripto:\n' +
      '  company_subscriptions.importe_acordado se congela al alta, y un contrato\n' +
      '  puede diferir de la lista.\n',
  );
} catch (error) {
  await cliente.query('ROLLBACK');
  console.error(`\n  ✘ No se pudo declarar: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
