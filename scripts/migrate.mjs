#!/usr/bin/env node
/**
 * Runner de migraciones SQL.
 *
 * SQL-first a propósito (ADR-008): las restricciones que sostienen el producto
 * —constraint diferido de Debe = Haber, guardia de período, prohibición de
 * borrado, RLS, encadenamiento de la bitácora— no son expresables en un ORM.
 * Escribir el esquema en SQL y derivar el cliente tipado desde la base evita
 * que exista una "verdad" en el ORM distinta de la que aplica el motor.
 *
 * Uso:
 *   node scripts/migrate.mjs up       aplica las pendientes
 *   node scripts/migrate.mjs status   lista aplicadas y pendientes
 *   node scripts/migrate.mjs reset    DROP SCHEMA public y reaplica (solo dev)
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'infrastructure', 'db', 'migrations');

// .env es local y está en .gitignore. Se carga con la API nativa de Node para no
// sumar una dependencia solo para leer un archivo de dos líneas.
try {
  process.loadEnvFile(join(HERE, '..', '.env'));
} catch {
  // Sin .env se usan las variables del entorno (es el caso de CI).
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copiá .env.example a .env y completalo.');
  process.exit(2);
}

async function loadMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applied(client) {
  const { rows } = await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

async function up(client) {
  await ensureTable(client);
  const done = await applied(client);
  const migrations = await loadMigrations();

  for (const migration of migrations) {
    const previous = done.get(migration.name);
    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        // Una migración aplicada es historia: si cambió, alguien editó el pasado.
        throw new Error(
          `La migración ${migration.name} ya aplicada cambió de contenido.\n` +
            `  esperado ${previous}\n  actual   ${migration.checksum}\n` +
            'Creá una migración nueva en vez de editar una aplicada.',
        );
      }
      continue;
    }

    process.stdout.write(`aplicando ${migration.name} ... `);
    // Cada migración corre en su propia transacción: o entra entera o no entra.
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (error) {
      await client.query('ROLLBACK');
      console.log('FALLÓ');
      throw error;
    }
  }
  console.log('Migraciones al día.');
}

async function status(client) {
  await ensureTable(client);
  const done = await applied(client);
  const migrations = await loadMigrations();
  for (const migration of migrations) {
    const mark = done.has(migration.name) ? '[x]' : '[ ]';
    console.log(`${mark} ${migration.name}`);
  }
}

async function reset(client) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('reset está deshabilitado con NODE_ENV=production');
  }
  console.log('DROP SCHEMA public CASCADE');
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await up(client);
}

const command = process.argv[2] ?? 'status';
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  if (command === 'up') await up(client);
  else if (command === 'status') await status(client);
  else if (command === 'reset') await reset(client);
  else {
    console.error(`Comando desconocido: ${command}`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await client.end();
}
