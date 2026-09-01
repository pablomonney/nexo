#!/usr/bin/env node
/**
 * Copia de resguardo de la base, en formato custom de PostgreSQL.
 *
 *   npm run db:backup
 *   node scripts/backup-db.mjs --destino "D:\otro\lado"
 *
 * ## Por qué existe siendo una sola línea de `pg_dump`
 *
 * Porque una copia que existe solamente porque alguien se acordó de escribir el
 * comando una vez no es un procedimiento: es una anécdota. Lo que convierte a
 * `pg_dump` en un resguardo es que esté escrito, que el destino no dependa de la
 * memoria de nadie, y que exista el otro lado —`restaurar-backup.mjs`— que
 * demuestra que el archivo sirve.
 *
 * ## Formato custom (`-Fc`) y no SQL plano
 *
 * `pg_restore` sobre un archivo custom puede restaurar selectivamente, permite
 * `--no-owner` y comprime. Un `.sql` plano solo se puede reproducir entero con
 * `psql`, y cualquier error a mitad de camino deja una base a medio hacer sin
 * decir en qué objeto se cortó.
 *
 * ## Lo que este script NO hace
 *
 * No verifica nada. Un backup recién escrito y nunca restaurado es una hipótesis
 * (§66). La verificación es `npm run db:restaurar`, que corre aparte y contra
 * una base descartable.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binarioDePostgres, DESTINO_POR_DEFECTO, nombreDeBase } from './lib/postgres-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(HERE, '..', '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copiá .env.example a .env y completalo.');
  process.exit(2);
}

const indiceDestino = process.argv.indexOf('--destino');
const carpeta =
  indiceDestino !== -1 && process.argv[indiceDestino + 1] !== undefined
    ? process.argv[indiceDestino + 1]
    : (process.env.NEXO_BACKUP_DIR ?? DESTINO_POR_DEFECTO);

if (!existsSync(carpeta)) {
  mkdirSync(carpeta, { recursive: true });
  console.log(`Carpeta creada: ${carpeta}`);
}

const base = nombreDeBase(DATABASE_URL);
// Sello ordenable y sin caracteres que Windows rechace en un nombre de archivo.
const sello = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
const archivo = join(carpeta, `${base}_${sello}.backup`);

const pgDump = binarioDePostgres('pg_dump');
console.log(`Resguardando "${base}" → ${archivo}`);

const r = spawnSync(
  pgDump,
  ['--format=custom', '--no-owner', '--compress=9', '--file', archivo, DATABASE_URL],
  { stdio: 'inherit' },
);

if (r.error !== undefined) {
  console.error(`No se pudo ejecutar ${pgDump}: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`pg_dump terminó con código ${r.status}. El archivo puede estar incompleto.`);
  process.exit(1);
}

const tamaño = statSync(archivo).size;
console.log(`\n✔ ${(tamaño / 1024).toFixed(0)} KB escritos.`);
console.log('Todavía es una hipótesis. Para convertirlo en una copia: npm run db:restaurar');
