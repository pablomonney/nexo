#!/usr/bin/env node
/**
 * El ciclo de facturación: emitir lo que vence y avanzar la cobranza.
 *
 *   node scripts/facturacion-ciclo.mjs              # con la fecha de hoy
 *   node scripts/facturacion-ciclo.mjs 2026-11-01   # con una fecha dada
 *   node scripts/facturacion-ciclo.mjs --ensayo     # sin escribir nada
 *
 * ## Por qué es un script y no un endpoint
 *
 * Porque el que emite no puede ser un usuario de una empresa cliente. El
 * administrador de una empresa no tiene por qué poder emitirse un cargo, ni
 * marcarlo pagado, ni levantarse una suspensión.
 *
 * No es una cuestión de disciplina: `aai_app` —el rol con el que corre la
 * aplicación— tiene **solo `SELECT`** sobre las tablas de facturación. Este
 * script conecta como operador de la instalación, que es otra cosa.
 *
 * ## Correrlo dos veces el mismo día es inocuo
 *
 * Un período ya facturado se informa como omitido en vez de duplicarse, y el
 * `UNIQUE` de la 0096 lo impediría igual. Es la condición para poder agendarlo
 * sin miedo y para poder reintentarlo cuando la corrida anterior murió a la
 * mitad.
 *
 * ## Lo que este ciclo no puede hacer
 *
 * **Cobrar.** No hay pasarela de pago contratada, así que los reintentos se
 * registran como omitidos con ese motivo. Tampoco puede avisar: no hay
 * proveedor de correo. Las dos cosas se informan al final, y ninguna impide que
 * el resto corra.
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

const { correrCiclo } = await import(
  new URL('../apps/api/dist/billing/ciclo.js', import.meta.url).href
);

const args = process.argv.slice(2);
const ensayo = args.includes('--ensayo');
const fecha = args.find((a) => /^\d{4}-\d{2}-\d{2}$/u.test(a)) ?? hoyIso();

function hoyIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

// El `Tx` que espera el ciclo es solo `{ query }`. No se le pasa el cliente
// crudo para que no pueda cerrar la conexión ni abrir otra transacción: lo único
// que puede hacer es consultar dentro de la que abrimos acá.
const tx = { query: (text, values) => cliente.query(text, values) };

try {
  await cliente.query('BEGIN');

  const informe = await correrCiclo(tx, fecha, 'system:facturacion-ciclo');

  if (ensayo) {
    await cliente.query('ROLLBACK');
  } else {
    await cliente.query('COMMIT');
  }

  console.log(`\nCiclo de facturación — ${informe.hoy}${ensayo ? '  (ENSAYO: no se escribió nada)' : ''}\n`);

  if (informe.emitidos.length === 0) {
    console.log('  No había nada que emitir.');
  } else {
    console.log(`  Emitidos: ${informe.emitidos.length}`);
    for (const d of informe.emitidos) {
      console.log(
        `    #${d.numero}  ${d.moneda} ${d.importe}  ${d.desde} a ${d.hasta}  ` +
          `empresa ${d.companyId}`,
      );
    }
  }

  if (informe.omitidos.length > 0) {
    console.log(`\n  Omitidos: ${informe.omitidos.length}`);
    // Una por una con su motivo, y no un total: «tres omitidas» no le sirve a
    // nadie, y el motivo es exactamente lo que hay que arreglar.
    for (const o of informe.omitidos) {
      console.log(`    ${o.motivo}  suscripción ${o.subscriptionId}`);
      console.log(`      ${o.detalle}`);
    }
  }

  if (informe.cobranza.length > 0) {
    console.log(`\n  Cobranza: ${informe.cobranza.length} paso(s)`);
    for (const p of informe.cobranza) {
      console.log(
        `    ${p.paso.tipo}${p.paso.numero ? ` #${p.paso.numero}` : ''}  ${p.resultado}  ` +
          `documento ${p.documentId}`,
      );
      console.log(`      ${p.detalle}`);
    }
  }

  console.log('');
} catch (error) {
  await cliente.query('ROLLBACK').catch(() => undefined);
  console.error(`El ciclo falló y no se escribió nada: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
