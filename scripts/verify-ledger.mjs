#!/usr/bin/env node
/**
 * Reconstruye el Mayor desde el Diario y verifica que coincide.
 *
 * Es el control que `ACCOUNTING_ENGINE.md` §7 promete: existe un comando que
 * reconstruye el Mayor completo desde el Diario y verifica que coincide con lo
 * materializado.
 *
 *   npm run ledger:verify                        — modo CONDUCTUAL (el de `verify`)
 *   node scripts/verify-ledger.mjs --observacional        — sobre DATABASE_URL, tal cual está
 *   node scripts/verify-ledger.mjs --observacional <cuit> — una sola empresa
 *
 * ## El tercer falso verde de la misma forma
 *
 * Este script tenía exactamente el defecto que `check-invariants.mjs` documenta
 * y arregló para los invariantes, y que las notas volvieron a mostrar en el
 * modelo de datos. Corría contra la base de **desarrollo**, que después de un
 * `db:reset` no tiene empresas, y entonces:
 *
 *     if (empresas.rows.length === 0) { console.log('no hay empresas'); exit(0) }
 *
 * Salir con 0 ahí no dice "el Mayor coincide": dice "no miré". Y había un
 * segundo camino más silencioso todavía: una empresa **sin un solo movimiento**
 * no produce discrepancias, así que imprimía `✔ el Mayor coincide con el Diario`
 * sin haber comparado nada.
 *
 * Encima no estaba en CI. El único lugar donde corría era el `npm run verify`
 * local, contra la base vacía.
 *
 * ## Los cuatro estados, los mismos que los invariantes
 *
 * | Estado | Qué significa | ¿Corta? |
 * |---|---|---|
 * | `VERIFIED` | se compararon movimientos y coinciden | no |
 * | `VIOLATED` | el Mayor no coincide con el Diario | **sí, siempre** |
 * | `NOT_EXERCISED` | no había nada que comparar | **sí, en modo conductual** |
 *
 * No hay `VACUO_PERMITIDO` acá: no existe ninguna razón declarada por la que el
 * fixture conductual no pueda producir asientos aprobados. Si no los produjo, se
 * rompió el fixture, y eso es justamente lo que hay que enterarse.
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

export const VERIFIED = 'VERIFIED';
export const VIOLATED = 'VIOLATED';
export const NOT_EXERCISED = 'NOT_EXERCISED';

const observacional = process.argv.includes('--observacional');
const conductual = !observacional;
const cuitPedido = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? null;

let url = process.env.DATABASE_URL ?? '';
if (url === '') {
  // Sin base no se puede afirmar nada, y en modo conductual eso es un fallo: el
  // gate promete haber comparado. En observacional se avisa y se sigue, porque
  // ahí el comando es una pregunta, no una promesa.
  if (conductual) {
    console.error('ledger:verify — falta DATABASE_URL y el modo conductual necesita una base.');
    process.exit(1);
  }
  console.log('ledger:verify — sin DATABASE_URL. Nada que verificar.');
  process.exit(0);
}

if (conductual) {
  const { prepararBaseDeVerificacion } = await import('./verification-db.mjs');
  const { sembrarFixtures } = await import('./fixtures-invariantes.mjs');
  console.log('Modo CONDUCTUAL — base de verificación aislada y fixtures propios.\n');
  url = await prepararBaseDeVerificacion({ silencioso: true });
  await sembrarFixtures(url, { silencioso: true });
  console.log('  ✔ fixtures conductuales sembrados\n');
} else {
  console.log(`Modo OBSERVACIONAL — se mira ${new URL(url).pathname.slice(1)} tal como está.\n`);
}

// Arriba del bloque que lo usa, y no al lado de `imprimir`: el `try` de abajo
// corre en el orden del módulo, y un `const` declarado después queda en zona
// muerta temporal. `function` se iza; `const` no.
const SIMBOLO = { [VERIFIED]: '✔', [VIOLATED]: '✘', [NOT_EXERCISED]: '✘' };

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const empresas = await client.query(
    cuitPedido === null
      ? 'SELECT id, cuit, legal_name FROM companies ORDER BY legal_name'
      : 'SELECT id, cuit, legal_name FROM companies WHERE cuit = $1',
    cuitPedido === null ? [] : [cuitPedido],
  );

  const resultados = [];

  for (const empresa of empresas.rows) {
    // El universo primero: cuántas líneas de asiento DEBERÍA proyectar el Mayor.
    // Sin este número, "cero discrepancias" y "cero comparaciones" se ven igual.
    const esperados = await contarEsperados(client, empresa.id);
    const discrepancias = await verificar(client, empresa.id);
    const total = discrepancias.reduce((acc, fila) => acc + Number(fila.cantidad), 0);

    // El orden importa, igual que en los invariantes: una discrepancia manda
    // aunque el universo diera cero. Si las dos consultas discrepan, el problema
    // es el control, y taparlo con NOT_EXERCISED sería esconder el caso que hay
    // que mirar.
    const estado = total > 0 ? VIOLATED : esperados > 0 ? VERIFIED : NOT_EXERCISED;

    await client.query(
      `INSERT INTO ledger_verifications
         (company_id, ran_by, movimientos, discrepancias, detalle, resultado)
       VALUES ($1, 'script:ledger-verify', $2, $3, $4::jsonb, $5)`,
      [
        empresa.id,
        esperados,
        total,
        JSON.stringify(discrepancias),
        total === 0 ? 'COINCIDE' : 'DISCREPA',
      ],
    );

    resultados.push({ empresa, esperados, discrepancias, total, estado });
  }

  imprimir(resultados);

  const violados = resultados.filter((r) => r.estado === VIOLATED);
  const ejercitados = resultados.filter((r) => r.estado === VERIFIED);

  if (violados.length > 0) {
    console.error('');
    console.error(
      'El Mayor no coincide con el Diario. Vale el Diario: es el libro con eficacia probatoria',
    );
    console.error(
      '(CCyC art. 330) y el Mayor es su proyección. No emitas estados contables en este estado.',
    );
    process.exit(1);
  }

  if (ejercitados.length === 0) {
    const mensaje =
      empresas.rows.length === 0
        ? 'no hay ni una empresa'
        : `${empresas.rows.length} empresa(s), ninguna con asientos aprobados`;

    if (conductual) {
      console.error('');
      console.error(`ledger:verify — NO EJERCITADO: ${mensaje}.`);
      console.error('');
      console.error('  Esto NO es "el Mayor coincide": es "no había nada que comparar". En modo');
      console.error('  conductual el fixture prometió producir asientos aprobados y no lo hizo, así');
      console.error('  que el que está roto es el fixture, no el libro.');
      process.exit(1);
    }

    console.log('');
    console.log(`ledger:verify — NO EJERCITADO: ${mensaje}. No se afirma que el Mayor coincida.`);
    process.exit(0);
  }

  console.log('');
  console.log(
    `ledger:verify — ${ejercitados.length} empresa(s) verificada(s) con movimientos reales, sin discrepancias.`,
  );
} finally {
  await client.end();
}


function imprimir(resultados) {
  for (const r of resultados) {
    const nombre = `${r.empresa.legal_name} (${r.empresa.cuit})`;

    if (r.estado === VERIFIED) {
      console.log(`  ${SIMBOLO[VERIFIED]} ${nombre} — ${r.esperados} línea(s) proyectadas, coinciden`);
      continue;
    }

    if (r.estado === NOT_EXERCISED) {
      console.log(`  ${SIMBOLO[NOT_EXERCISED]} ${nombre} — sin asientos aprobados: nada que comparar`);
      continue;
    }

    console.error(`  ${SIMBOLO[VIOLATED]} ${nombre} — ${r.total} discrepancia(s):`);
    for (const fila of r.discrepancias) {
      console.error(`      ${fila.tipo}: ${fila.cantidad}`);
      for (const ejemplo of fila.ejemplos) console.error(`        línea ${ejemplo}`);
    }
  }
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
