#!/usr/bin/env node
/**
 * Mide la extracción contra un corpus con respuestas conocidas y publica las
 * métricas por campo.
 *
 * Es el instrumento del criterio de salida de la FASE 3b. No inventa el corpus:
 * los documentos los aporta quien tiene comprobantes reales anonimizados. Con la
 * carpeta vacía, el script lo dice y termina — publicar métricas sobre datos
 * sintéticos sería medir el generador, no el sistema.
 *
 * ## Dos capas que conviene medir por separado
 *
 * Un error de extracción puede venir de dos lugares muy distintos:
 *
 *   1. El OCR leyó mal el papel.
 *   2. El OCR leyó bien y el sistema interpretó mal lo que leyó.
 *
 * Mezclarlos deja sin saber dónde invertir. Por eso el corpus admite un archivo
 * `.txt` al lado de cada documento con su transcripción: cuando existe, se usa
 * como si fuera la salida del OCR, y lo que se mide es exclusivamente la capa de
 * interpretación —parsers, reglas, controles de coherencia—. Eso se puede medir
 * hoy, sin contratar ningún motor.
 *
 * ## Uso
 *
 *   node scripts/extraction-metrics.mjs [--corpus <dir>] [--salida <archivo.md>]
 *
 * El corpus por defecto es `corpus/`, con esta forma:
 *
 *   corpus/
 *     ground-truth.json      [{ "archivo": "001.pdf", "esperado": { ... } }]
 *     documentos/001.pdf
 *     documentos/001.pdf.txt   (opcional: transcripción)
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  InMemoryDocumentStore,
  MockOcrEngine,
  calcularMetricas,
  ingerir,
  paginaDeTexto,
  reporteMarkdown,
} from '../packages/document-engine/dist/index.js';

const argumentos = process.argv.slice(2);
const valorDe = (nombre, porDefecto) => {
  const indice = argumentos.indexOf(`--${nombre}`);
  return indice === -1 ? porDefecto : (argumentos[indice + 1] ?? porDefecto);
};

const raizCorpus = resolve(valorDe('corpus', 'corpus'));
const salida = valorDe('salida', 'docs/product/extraction-metrics.md');
const EMPRESA = '00000000-0000-7000-8000-000000000001';

let verdad;
try {
  verdad = JSON.parse(await readFile(join(raizCorpus, 'ground-truth.json'), 'utf8'));
} catch {
  console.error(`No hay corpus en ${raizCorpus}.`);
  console.error('');
  console.error('El criterio de salida de la FASE 3b pide 100 comprobantes reales');
  console.error('anonimizados. Ese corpus no se puede generar: hay que aportarlo.');
  console.error('Ver corpus/README.md para la forma que tiene que tener.');
  process.exit(2);
}

if (!Array.isArray(verdad) || verdad.length === 0) {
  console.error('ground-truth.json está vacío.');
  process.exit(2);
}

const disponibles = new Set(await readdir(join(raizCorpus, 'documentos')));
const resultados = [];
const faltantes = [];

for (const caso of verdad) {
  if (!disponibles.has(caso.archivo)) {
    faltantes.push(caso.archivo);
    continue;
  }

  const ruta = join(raizCorpus, 'documentos', caso.archivo);
  const bytes = await readFile(ruta);

  // Transcripción opcional: si está, se usa como salida del OCR.
  let ocr;
  try {
    const transcripcion = await readFile(`${ruta}.txt`, 'utf8');
    const lineas = transcripcion.split(/\r?\n/);
    ocr = new MockOcrEngine({
      porDefecto: { paginas: [paginaDeTexto(1, lineas, 1)] },
    });
  } catch {
    ocr = undefined;
  }

  const resultado = await ingerir(
    {
      companyId: EMPRESA,
      nombreOriginal: caso.archivo,
      origen: 'FOLDER',
      bytes,
    },
    { store: new InMemoryDocumentStore(), ...(ocr !== undefined ? { ocr } : {}) },
  );

  if (!resultado.ok) {
    console.warn(`  rechazado: ${caso.archivo} — ${resultado.motivo}`);
    resultados.push({ caso: { id: caso.archivo, esperado: caso.esperado }, campos: [] });
    continue;
  }

  resultados.push({
    caso: { id: caso.archivo, esperado: caso.esperado },
    campos: resultado.extraccion.campos,
  });
}

if (faltantes.length > 0) {
  console.warn(`Faltan ${faltantes.length} archivos declarados en ground-truth.json:`);
  for (const nombre of faltantes.slice(0, 10)) console.warn(`  - ${nombre}`);
}

const reporte = calcularMetricas(resultados);
const markdown = [
  reporteMarkdown(reporte),
  '',
  '## Cómo leer esto',
  '',
  'Si existe un `.txt` junto al documento, la lectura no la hizo un OCR: es la',
  'transcripción del corpus. En ese caso estas métricas miden **la capa de',
  'interpretación**, no el reconocimiento óptico. Son dos números distintos y no',
  'se deben presentar como uno solo.',
  '',
  `Documentos declarados: ${verdad.length}. Procesados: ${resultados.length}.` +
    (faltantes.length > 0 ? ` Faltantes: ${faltantes.length}.` : ''),
  '',
].join('\n');

await writeFile(salida, markdown, 'utf8');

console.log(`Reporte escrito en ${salida}`);
for (const metrica of reporte.porCampo) {
  const alerta = metrica.tasaErrorSilencioso > 0 ? ' ⚠' : '';
  console.log(
    `  ${metrica.fieldPath.padEnd(34)} cobertura ${(metrica.cobertura * 100).toFixed(1).padStart(5)}%` +
      `  error silencioso ${(metrica.tasaErrorSilencioso * 100).toFixed(1).padStart(5)}%${alerta}`,
  );
}

// Un error silencioso es lo que este sistema existe para no tener. Que el
// comando termine en cero cuando los hay haría que pase desapercibido en CI.
const conError = reporte.porCampo.filter((metrica) => metrica.incorrectos > 0);
if (conError.length > 0) {
  console.error('');
  console.error(`Hay ${conError.length} campo(s) con errores silenciosos.`);
  process.exit(1);
}
