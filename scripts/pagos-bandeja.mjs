#!/usr/bin/env node
/**
 * Aplica las notificaciones que dejó el webhook de la pasarela.
 *
 *   node scripts/pagos-bandeja.mjs             # aplica lo pendiente
 *   node scripts/pagos-bandeja.mjs --ensayo    # dice qué haría, sin escribir
 *   node scripts/pagos-bandeja.mjs --ver       # solo mira, sin aplicar nada
 *
 * ## Por qué es un script y no parte de la ruta
 *
 * Porque escribe en `payment_intents` y en `payment_events`, y el rol con el que
 * corre la API no puede: tiene `SELECT` sobre la primera y nada sobre la
 * segunda. Ese candado es lo que impide que el administrador de una empresa
 * cliente se marque un cargo como pagado, y abrirlo para que el webhook
 * funcionara lo abriría para toda la API.
 *
 * La ruta pública guarda la notificación y no aplica nada. Esto la aplica, y
 * antes de aplicar nada **le pregunta a la pasarela qué pasó de verdad**: del
 * cuerpo que llegó por internet se usa un solo dato, cuál es el recurso a
 * consultar.
 *
 * ## Correrlo dos veces es inocuo
 *
 * Una fila ya aplicada no vuelve a mirarse, y el `UNIQUE (proveedor,
 * evento_externo)` de `payment_events` haría imposible reprocesarla igual.
 * Agendarlo cada pocos minutos es la forma prevista de usarlo.
 *
 * ## Qué no hace
 *
 * No cobra. En un esquema de suscripción el débito lo ejecuta la pasarela; acá
 * solo se registra lo que ya ocurrió del otro lado.
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

const { drenarBandeja } = await import(
  new URL('../apps/api/dist/pagos/bandeja.js', import.meta.url).href
);
const { crearProveedorDePagos, modoDePagos } = await import(
  new URL('../apps/api/dist/pagos/fabrica.js', import.meta.url).href
);
const { config } = await import(new URL('../apps/api/dist/config.js', import.meta.url).href);

const args = process.argv.slice(2);
const ensayo = args.includes('--ensayo');
const soloVer = args.includes('--ver');

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
await cliente.connect();

// El `Tx` que esperan los módulos es solo `{ query }`. No se pasa el cliente
// crudo para que no pueda cerrar la conexión ni abrir otra transacción.
const tx = { query: (text, values) => cliente.query(text, values) };

try {
  const modo = modoDePagos();
  console.log(`\n══ Bandeja de pagos ═════════════════════════════════════════\n`);
  console.log(`  pasarela: ${modo.valor}${modo.real ? '' : '  (no conectada)'}`);
  console.log(`  ${modo.detalle}\n`);

  const resumen = await cliente.query(
    `SELECT estado, count(*)::text AS n FROM payment_webhook_inbox
      GROUP BY estado ORDER BY estado`,
  );

  if (resumen.rows.length === 0) {
    console.log('  Todavía no llegó ninguna notificación.\n');
  } else {
    for (const r of resumen.rows) console.log(`  ${r.estado.padEnd(12)} ${r.n}`);
    console.log('');
  }

  if (soloVer) {
    const { rows } = await cliente.query(
      `SELECT tipo, accion, recurso_id, estado, detalle, recibido_el
         FROM payment_webhook_inbox
        WHERE estado <> 'APLICADO'
        ORDER BY recibido_el DESC LIMIT 50`,
    );
    for (const r of rows) {
      console.log(`  ${r.estado.padEnd(12)} ${r.tipo}${r.accion ? ` (${r.accion})` : ''}`);
      console.log(`    recurso ${r.recurso_id}  ${r.recibido_el.toISOString()}`);
      if (r.detalle) console.log(`    ${r.detalle}`);
    }
    console.log('');
    process.exit(0);
  }

  await cliente.query('BEGIN');

  const hechos = await drenarBandeja(tx, crearProveedorDePagos(), config.pagos.ambiente);

  if (ensayo) {
    await cliente.query('ROLLBACK');
  } else {
    await cliente.query('COMMIT');
  }

  if (hechos.length === 0) {
    console.log('  No había nada pendiente.\n');
  } else {
    console.log(
      `  ${hechos.length} notificación(es)${ensayo ? '  (ENSAYO: no se escribió nada)' : ''}\n`,
    );
    // Una por una con su motivo, y no un total: «tres sin efecto» no le sirve a
    // nadie, y el motivo es exactamente lo que hay que mirar.
    for (const h of hechos) {
      console.log(`  ${h.desenlace.padEnd(12)} ${h.detalle}`);
    }
    console.log('');
  }

  // Los fallos cuentan para el código de salida: son lo que alguien tiene que
  // mirar. `SIN_EFECTO` no cuenta — un evento repetido o atrasado es
  // comportamiento normal de una pasarela, no un problema.
  const fallos = hechos.filter((h) => h.desenlace === 'FALLIDO').length;
  if (fallos > 0) {
    console.log(`  ${fallos} con fallo. Revisalos: no se reintentan solos.\n`);
    process.exit(1);
  }
} finally {
  await cliente.end();
}
