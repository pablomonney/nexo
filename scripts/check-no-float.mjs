#!/usr/bin/env node
/**
 * Puerta de CI: prohibido el punto flotante en cálculos monetarios.
 *
 * Regla 4 del README y ARCHITECTURE.md §7. `0.1 + 0.2 !== 0.3` es una curiosidad
 * en una calculadora y un asiento descuadrado en un libro Diario.
 *
 * Detecta los patrones que en la práctica introducen floats en importes:
 * parseFloat, Number.parseFloat, toFixed, Math.round/floor/ceil sobre dinero, y
 * literales decimales asignados a algo que se llame importe/monto/total/amount.
 *
 * No pretende ser un analizador de tipos: `Money` ya hace el trabajo pesado con
 * bigint. Esto es la red que atrapa el atajo escrito a las tres de la mañana.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.git']);

const FORBIDDEN = [
  {
    pattern: /\bparseFloat\s*\(/,
    message: 'parseFloat produce un float. Usá moneyFromDecimalString().',
  },
  {
    pattern: /\.toFixed\s*\(/,
    message: 'toFixed redondea en punto flotante. Usá toDecimalString() o formatAr().',
  },
  {
    pattern: /\bMath\.(round|floor|ceil)\s*\([^)]*\b(amount|importe|monto|total|debit|credit|saldo|iva)\b/i,
    message: 'Redondeo en float sobre un importe. Usá multiplyByRate() con un RoundingMode.',
  },
  {
    pattern: /\b(amount|importe|monto|total|debit|credit|saldo)\w*\s*[:=]\s*-?\d+\.\d+/i,
    message: 'Literal decimal asignado a un importe. Usá moneyFromDecimalString().',
  },
  {
    pattern: /\bNumber\s*\(\s*\w*(amount|importe|monto|total|debit|credit)\w*\s*\)/i,
    message: 'Number() sobre un importe lo convierte a float. Mantené bigint.',
  },
];

/** Los tests pueden nombrar los patrones prohibidos para verificar que se detectan. */
const ALLOW_MARKER = 'no-float-check: allow';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (['.ts', '.tsx', '.mts', '.js', '.mjs'].includes(extname(entry.name))) yield full;
  }
}

const findings = [];

for (const scanDir of SCAN_DIRS) {
  let exists = true;
  try {
    await readdir(join(ROOT, scanDir));
  } catch {
    exists = false;
  }
  if (!exists) continue;

  for await (const file of walk(join(ROOT, scanDir))) {
    const source = await readFile(file, 'utf8');
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARKER)) return;
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          findings.push({
            file: relative(ROOT, file).replace(/\\/g, '/'),
            line: index + 1,
            text: line.trim(),
            message: rule.message,
          });
        }
      }
    });
  }
}

if (findings.length === 0) {
  console.log('check:no-float — sin hallazgos.');
  process.exit(0);
}

console.error(`check:no-float — ${findings.length} hallazgo(s):\n`);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}`);
  console.error(`    ${finding.text}`);
  console.error(`    → ${finding.message}\n`);
}
process.exit(1);
