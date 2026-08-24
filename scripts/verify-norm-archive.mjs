#!/usr/bin/env node
/**
 * Puerta de CI: el archivo normativo está íntegro y el registro no miente.
 *
 * Verifica tres cosas distintas:
 *   1. Cada archivo de originals/ conserva el sha256 registrado en checksums.sha256.
 *   2. Cada fila de registro-de-descargas.csv apunta a un archivo que existe y
 *      cuyo hash coincide con el declarado.
 *   3. No hay archivos en originals/ sin registrar ni filas sin archivo.
 *
 * Sin esto, el "hash del documento original" del sistema de citas es una promesa
 * en un README. Con esto, es una condición de build.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'docs', 'normative-sources');
const ORIGINALS = join(SOURCES, 'originals');
const CHECKSUMS = join(SOURCES, 'checksums.sha256');
const REGISTRY = join(SOURCES, 'registro-de-descargas.csv');

const problems = [];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Parser CSV mínimo con soporte de campos entrecomillados. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

const files = (await readdir(ORIGINALS)).filter((name) => !name.endsWith('.md'));
const actualHashes = new Map();
for (const name of files) {
  actualHashes.set(name, sha256(await readFile(join(ORIGINALS, name))));
}

// 1. checksums.sha256
const checksumLines = (await readFile(CHECKSUMS, 'utf8')).split(/\r?\n/).filter(Boolean);
const declared = new Map();
for (const line of checksumLines) {
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match) {
    problems.push(`checksums.sha256: línea ilegible → ${line}`);
    continue;
  }
  declared.set(match[2], match[1]);
}

for (const [name, hash] of actualHashes) {
  const expected = declared.get(name);
  if (expected === undefined) problems.push(`${name}: presente en originals/ pero ausente de checksums.sha256`);
  else if (expected !== hash) problems.push(`${name}: hash alterado (esperado ${expected}, actual ${hash})`);
}
for (const name of declared.keys()) {
  if (!actualHashes.has(name)) problems.push(`${name}: declarado en checksums.sha256 pero ausente de originals/`);
}

// 2 y 3. registro-de-descargas.csv
const rows = parseCsv(await readFile(REGISTRY, 'utf8'));
const header = rows.shift() ?? [];
const fileIdx = header.indexOf('archivo');
const hashIdx = header.indexOf('sha256');
const levelIdx = header.indexOf('nivel_verificacion');
const urlIdx = header.indexOf('url_oficial');

if (fileIdx < 0 || hashIdx < 0 || levelIdx < 0 || urlIdx < 0) {
  problems.push('registro-de-descargas.csv: faltan columnas obligatorias');
} else {
  const registered = new Set();
  for (const row of rows) {
    const name = row[fileIdx]?.trim();
    const hash = row[hashIdx]?.trim();
    const level = row[levelIdx]?.trim();
    const url = row[urlIdx]?.trim();

    if (!name) {
      problems.push('registro: fila sin nombre de archivo');
      continue;
    }
    registered.add(name);

    const actual = actualHashes.get(name);
    if (actual === undefined) problems.push(`registro: ${name} no existe en originals/`);
    else if (actual !== hash) problems.push(`registro: ${name} declara ${hash} y el archivo es ${actual}`);

    // Nivel V1 significa "documento oficial archivado". Sin URL oficial no lo es.
    if (level === 'V1' && !/^https?:\/\//.test(url ?? '')) {
      problems.push(`registro: ${name} está en V1 pero no declara URL oficial`);
    }
    if (!['V1', 'V2', 'V3', 'V4'].includes(level ?? '')) {
      problems.push(`registro: ${name} tiene nivel de verificación inválido (${level})`);
    }
  }

  for (const name of actualHashes.keys()) {
    if (!registered.has(name)) problems.push(`${name}: archivado sin fila en registro-de-descargas.csv`);
  }
}

if (problems.length === 0) {
  console.log(`norms:verify — ${actualHashes.size} documentos íntegros y registrados.`);
  process.exit(0);
}

console.error(`norms:verify — ${problems.length} problema(s):\n`);
for (const problem of problems) console.error(`  · ${problem}`);
process.exit(1);
