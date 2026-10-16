#!/usr/bin/env node
/**
 * Comprueba que una exportación completa de NEXO está íntegra, SIN necesitar NEXO ni su base.
 *
 *   node scripts/verificar-exportacion.mjs nexo-exportacion-2026-10-17.zip
 *
 * Es lo que le permite a quien se lleva sus datos decir «está todo y no se tocó nada»: recorre el manifiesto y, por cada
 * archivo, comprueba que existe, que su sha256 y su tamaño coinciden y que la cantidad de líneas es la de `filas`. Dice
 * también qué se dejó afuera a propósito y si el manifiesto informa tablas que la aplicación no pudo leer.
 *
 * Sale con código 0 si todo coincide, 1 si algo no, y 2 si no pudo leer el archivo. No modifica nada.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const ruta = process.argv[2];
if (ruta === undefined) {
  console.error('Uso: node scripts/verificar-exportacion.mjs <exportacion.zip>');
  process.exit(2);
}

let ArchivoZip;
try {
  ({ ArchivoZip } = await import(pathToFileURL(join(RAIZ, 'packages', 'document-engine', 'dist', 'index.js')).href));
} catch {
  console.error('No encuentro packages/document-engine/dist: corré `npm run build` primero.');
  process.exit(2);
}

let zip;
try {
  zip = new ArchivoZip(readFileSync(ruta), { maxTotalDescomprimido: 1 << 30, maxPorEntrada: 1 << 29, maxEntradas: 70_000 });
} catch (e) {
  console.error(`No se pudo abrir "${ruta}" como ZIP: ${e.message}`);
  console.error('Un archivo cortado a mitad de la descarga no tiene directorio central y no se abre: volvé a exportar.');
  process.exit(2);
}

if (!zip.tiene('manifiesto.json')) {
  console.error('El archivo no tiene manifiesto.json: no es una exportación completa de NEXO.');
  process.exit(2);
}

const manifiesto = JSON.parse(zip.leer('manifiesto.json').toString('utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let fallos = 0;
let revisados = 0;
const mal = (t) => {
  fallos += 1;
  console.log(`  ✘ ${t}`);
};

console.log(`Exportación de ${manifiesto.empresa?.razonSocial ?? '?'} (${manifiesto.empresa?.cuit ?? '?'})`);
console.log(`  formato ${manifiesto.formato} · generada ${manifiesto.generadoEn} · base con ${manifiesto.esquemaDeLaBase?.aplicadas ?? '?'} migraciones`);
console.log(`  pedida por ${manifiesto.exportadoPor} · motivo: ${manifiesto.motivo}\n`);

const declarados = [
  ...(manifiesto.archivosFijos ?? []),
  ...(manifiesto.tablas ?? []),
  ...(manifiesto.catalogos ?? []),
];
for (const f of declarados) {
  revisados += 1;
  if (!zip.tiene(f.archivo)) {
    mal(`${f.archivo}: está en el manifiesto y no en el archivo`);
    continue;
  }
  const bytes = zip.leer(f.archivo);
  if (sha(bytes) !== f.sha256) mal(`${f.archivo}: la huella sha256 no coincide (el archivo cambió o se dañó)`);
  else if (f.bytes !== undefined && bytes.length !== f.bytes) mal(`${f.archivo}: el tamaño no coincide`);
  else if (f.filas !== undefined) {
    const lineas = bytes.toString('utf8').split('\n').filter((l) => l !== '').length;
    if (lineas !== f.filas) mal(`${f.archivo}: tiene ${lineas} líneas y el manifiesto dice ${f.filas}`);
  }
}

// Todo lo que hay en el ZIP tiene que estar declarado (salvo los archivos adjuntos y los tres fijos de documentación).
const conocidos = new Set(['LEEME.txt', 'manifiesto.json', 'esquema.json', ...declarados.map((f) => f.archivo)]);
for (const nombre of zip.nombres) {
  if (!conocidos.has(nombre) && !nombre.startsWith('archivos/')) mal(`${nombre}: está en el archivo y no en el manifiesto`);
}

const adjuntos = zip.nombres.filter((n) => n.startsWith('archivos/'));
if (adjuntos.length !== (manifiesto.archivos?.incluidos ?? 0)) {
  mal(`documentos: hay ${adjuntos.length} en el archivo y el manifiesto declara ${manifiesto.archivos?.incluidos ?? 0}`);
}
if ((manifiesto.archivos?.faltantes ?? []).length > 0) {
  mal(`documentos que la base nombra y el almacén no tenía: ${manifiesto.archivos.faltantes.length} (NEXO no pudo incluirlos)`);
}
if ((manifiesto.noLegibles ?? []).length > 0) {
  mal(`tablas de la empresa que NEXO no pudo leer: ${manifiesto.noLegibles.join(', ')} — la exportación está incompleta`);
}

console.log(`  ${revisados} archivos de datos revisados, ${adjuntos.length} documentos, ${manifiesto.totales?.filas ?? '?'} filas en ${manifiesto.totales?.tablas ?? '?'} tablas.`);
if ((manifiesto.tablasExcluidas ?? []).length + (manifiesto.columnasExcluidas ?? []).length > 0) {
  console.log('  Se dejó afuera a propósito:');
  for (const t of manifiesto.tablasExcluidas ?? []) console.log(`    · tabla ${t.tabla}: ${t.motivo}`);
  for (const c of manifiesto.columnasExcluidas ?? []) console.log(`    · columna ${c.tabla}.${c.columna}: ${c.motivo}`);
}

if (fallos > 0) {
  console.log(`\n✘ ${fallos} problema(s). NO usar este archivo como copia completa.`);
  process.exit(1);
}
console.log('\n✔ La exportación está íntegra: cada archivo coincide con su huella y su cantidad de filas, y no hay nada sin declarar.');
