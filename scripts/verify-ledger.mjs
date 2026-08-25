#!/usr/bin/env node
/**
 * Reconstruye el Mayor desde el Diario y verifica que coincide.
 *
 * Es el control que `ACCOUNTING_ENGINE.md` §7 promete: existe un comando que
 * reconstruye el Mayor completo desde el Diario y verifica que coincide con lo
 * materializado.
 *
 *   npm run ledger:verify              # todas las empresas
 *   npm run ledger:verify -- <cuit>    # una sola
 *
 * Sale con código distinto de cero si alguna empresa discrepa. Un control que
 * informa y sigue no es un control: si el Mayor no coincide con el Diario, no se
 * emiten estados contables, y el pipeline tiene que enterarse.
 *
 * Sin DATABASE_URL no falla: avisa y sale con 0. Un desarrollador sin base
 * levantada tiene que poder correr `npm run verify`.
 *
 * La verificación se hace **en SQL**, no trayendo los movimientos a memoria. Un
 * ejercicio con medio millón de movimientos no entra en un proceso de Node, y un
 * control que solo funciona en libros chicos no sirve para el caso en el que
 * hace falta.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Mismo criterio que scripts/migrate.mjs: .env es local y está en .gitignore;
// en CI las variables vienen del entorno y el archivo no existe.
const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';

if (DATABASE_URL === '') {
  console.log('ledger:verify — sin DATABASE_URL. Nada que verificar.');
  process.exit(0);
}

const cuitPedido = process.argv[2] ?? null;

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  const empresas = await client.query(
    cuitPedido === null
      ? 'SELECT id, cuit, legal_name FROM companies ORDER BY legal_name'
      : 'SELECT id, cuit, legal_name FROM companies WHERE cuit = $1',
    cuitPedido === null ? [] : [cuitPedido],
  );

  if (empresas.rows.length === 0) {
    console.log(`ledger:verify — no hay empresas${cuitPedido === null ? '' : ` con CUIT ${cuitPedido}`}.`);
    process.exit(0);
  }

  let conDiscrepancias = 0;

  for (const empresa of empresas.rows) {
    const discrepancias = await verificar(client, empresa.id);
    const total = discrepancias.reduce((acc, fila) => acc + Number(fila.cantidad), 0);

    await client.query(
      `INSERT INTO ledger_verifications
         (company_id, ran_by, movimientos, discrepancias, detalle, resultado)
       VALUES ($1, 'script:ledger-verify', $2, $3, $4::jsonb, $5)`,
      [
        empresa.id,
        await contarEsperados(client, empresa.id),
        total,
        JSON.stringify(discrepancias),
        total === 0 ? 'COINCIDE' : 'DISCREPA',
      ],
    );

    if (total === 0) {
      console.log(`  ✔ ${empresa.legal_name} (${empresa.cuit}) — el Mayor coincide con el Diario`);
      continue;
    }

    conDiscrepancias += 1;
    console.error(`  ✘ ${empresa.legal_name} (${empresa.cuit}) — ${total} discrepancia(s):`);
    for (const fila of discrepancias) {
      console.error(`      ${fila.tipo}: ${fila.cantidad}`);
      for (const ejemplo of fila.ejemplos) console.error(`        línea ${ejemplo}`);
    }
  }

  if (conDiscrepancias > 0) {
    console.error('');
    console.error(
      'El Mayor no coincide con el Diario. Vale el Diario: es el libro con eficacia probatoria',
    );
    console.error(
      '(CCyC art. 330) y el Mayor es su proyección. No emitas estados contables en este estado.',
    );
    process.exit(1);
  }

  console.log(`ledger:verify — ${empresas.rows.length} empresa(s) verificada(s), sin discrepancias.`);
} finally {
  await client.end();
}

/**
 * Las tres formas en que el Mayor puede no coincidir con el Diario.
 *
 * `SOBRA_EN_MAYOR` es la grave: un movimiento sin línea de asiento detrás es un
 * saldo que nadie puede explicar. Las otras dos indican una proyección
 * incompleta o desactualizada, que es malo pero tiene arreglo evidente.
 */
async function verificar(client, companyId) {
  const consultas = [
    {
      tipo: 'FALTA_EN_MAYOR',
      sql: `SELECT l.id::text AS linea
              FROM journal_entry_lines l
              JOIN journal_entries e ON e.id = l.entry_id
             WHERE e.company_id = $1
               AND e.status IN ('APROBADO', 'ANULADO')
               AND NOT EXISTS (SELECT 1 FROM ledger_movements m WHERE m.entry_line_id = l.id)`,
    },
    {
      tipo: 'SOBRA_EN_MAYOR',
      sql: `SELECT m.entry_line_id::text AS linea
              FROM ledger_movements m
              JOIN journal_entry_lines l ON l.id = m.entry_line_id
              JOIN journal_entries e ON e.id = l.entry_id
             WHERE m.company_id = $1
               AND e.status NOT IN ('APROBADO', 'ANULADO')`,
    },
    {
      tipo: 'DATO_DISTINTO',
      sql: `SELECT m.entry_line_id::text AS linea
              FROM ledger_movements m
              JOIN journal_entry_lines l ON l.id = m.entry_line_id
              JOIN journal_entries e ON e.id = l.entry_id
             WHERE m.company_id = $1
               AND (m.debit <> l.debit
                 OR m.credit <> l.credit
                 OR m.account_id <> l.account_id
                 OR m.movement_date <> e.entry_date
                 OR m.period_id <> e.period_id)`,
    },
  ];

  const hallazgos = [];
  for (const consulta of consultas) {
    const resultado = await client.query(consulta.sql, [companyId]);
    if (resultado.rows.length === 0) continue;
    hallazgos.push({
      tipo: consulta.tipo,
      cantidad: resultado.rows.length,
      // Se guardan unos pocos ejemplos y no las cien mil filas: el detalle
      // completo se saca con la misma consulta, y un jsonb de un millón de ids
      // convierte la tabla de verificaciones en un problema propio.
      ejemplos: resultado.rows.slice(0, 5).map((fila) => fila.linea),
    });
  }
  return hallazgos;
}

async function contarEsperados(client, companyId) {
  const resultado = await client.query(
    `SELECT count(*)::int AS n
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND e.status IN ('APROBADO', 'ANULADO')`,
    [companyId],
  );
  return resultado.rows[0].n;
}
