#!/usr/bin/env node
/**
 * Crea la base de datos de DATABASE_URL si no existe.
 *
 * Se conecta a la base `postgres` del mismo servidor con las mismas credenciales
 * y emite el CREATE DATABASE. Es idempotente: si ya existe, no hace nada.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(HERE, '..', '.env'));
} catch {
  // Sin .env se usan las variables del entorno.
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copiá .env.example a .env y completalo.');
  process.exit(2);
}

const target = new URL(DATABASE_URL);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (dbName.length === 0) {
  console.error('DATABASE_URL no indica una base de datos.');
  process.exit(2);
}

const admin = new URL(DATABASE_URL);
admin.pathname = '/postgres';

const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (existing.rowCount > 0) {
    console.log(`La base "${dbName}" ya existe.`);
  } else {
    // El nombre no puede parametrizarse en CREATE DATABASE; se cita como identificador.
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    console.log(`Base "${dbName}" creada.`);
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  await client.end();
}
