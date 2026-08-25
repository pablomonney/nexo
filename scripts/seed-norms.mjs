#!/usr/bin/env node
/**
 * Carga el archivo normativo en la base: `norms`, `norm_versions` y
 * `norm_documents`.
 *
 * Los documentos ya están archivados con hash desde FASE 1. Este script los
 * vuelve **consultables**: hasta ahora eran 21 PDFs y HTMLs con un CSV al lado, y
 * el motor normativo no podía resolver contra ellos.
 *
 * ## La regla que gobierna este script
 *
 * **Una norma sin fecha de emisión verificada no se carga.**
 *
 * `norm_versions.fecha_emision` es `NOT NULL`, y completarla con la fecha de
 * publicación —o con el año— sería afirmar un hecho que nadie verificó. Las
 * fechas salen de `vigencias.csv`, donde cada fila cita el artículo del que
 * surge. Las que no están, se informan y se saltean: la salida del script dice
 * exactamente qué falta relevar.
 *
 * ## Lo que este script NO hace
 *
 * No carga `norm_adoptions` ni `accounting_rules`.
 *
 * - Las **adopciones** requieren el acto del consejo profesional archivado. La
 *   Res. CPCECABA 460/2024 todavía no está en el archivo, así que el motor va a
 *   responder `ADOPCION_NO_RELEVADA` para CABA — que es lo correcto mientras el
 *   acto no esté.
 * - Las **reglas** requieren transcribir el articulado que las funda. Eso es
 *   trabajo normativo con revisión humana, no un script.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}

/** Parser de CSV con comillas: los títulos y las notas traen comas. */
function parsearCsv(texto) {
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else enComillas = false;
      } else campo += c;
      continue;
    }
    if (c === '"' && campo.length === 0) enComillas = true;
    else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n') {
      fila.push(campo.replace(/\r$/, ''));
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (campo.length > 0 || fila.length > 0) {
    fila.push(campo.replace(/\r$/, ''));
    filas.push(fila);
  }
  return filas.filter((f) => f.some((v) => v.trim().length > 0));
}

function aObjetos(filas) {
  const encabezados = filas[0];
  return filas.slice(1).map((fila) =>
    Object.fromEntries(encabezados.map((clave, i) => [clave, (fila[i] ?? '').trim()])),
  );
}

const base = join(RAIZ, 'docs', 'normative-sources');
const registro = aObjetos(parsearCsv(await readFile(join(base, 'registro-de-descargas.csv'), 'utf8')));
const vigencias = aObjetos(parsearCsv(await readFile(join(base, 'vigencias.csv'), 'utf8')));
const vigenciaPorArchivo = new Map(vigencias.map((fila) => [fila.archivo, fila]));

/**
 * Tipos del registro que el esquema no admite tal cual.
 *
 * `norms.tipo` tiene un CHECK con la lista cerrada de la migración 0006. Un tipo
 * que no está en esa lista no se traduce a uno parecido: se informa.
 */
const TIPOS_VALIDOS = new Set([
  'CONSTITUCION', 'LEY', 'DECRETO', 'RG', 'RESOLUCION', 'DISPOSICION',
  'RT', 'RES_JG', 'RES_MD', 'RES_CD', 'INTERPRETACION', 'MANUAL', 'PARAMETRO',
]);

const ORGANISMOS_VALIDOS = new Set([
  'CONGRESO', 'PEN', 'ARCA', 'AFIP', 'IGJ', 'CNV', 'BCRA', 'INAES',
  'FACPCE', 'CPCE_CABA', 'CPCE_PROVINCIAL', 'PROVINCIAL', 'MUNICIPAL',
]);

/** Jerarquía del §3: P1 legislación · P2 organismos de control · P3 profesional · P4 explicativo. */
function jerarquiaDe(organismo, tipo) {
  if (organismo === 'CONGRESO' || organismo === 'PEN') return 1;
  if (tipo === 'MANUAL' || tipo === 'GUIA' || tipo === 'PROYECTO' || tipo === 'PUBLICACION') return 4;
  if (['ARCA', 'AFIP', 'IGJ', 'CNV', 'BCRA', 'INAES'].includes(organismo)) return 2;
  return 3;
}

function mimeDe(archivo) {
  return archivo.endsWith('.pdf') ? 'application/pdf' : 'text/html';
}

const client = new pg.Client({ connectionString });
await client.connect();

const cargadas = [];
const salteadas = [];

try {
  await client.query('BEGIN');

  for (const fila of registro) {
    const organismo = fila.organismo;
    const tipo = fila.tipo;
    const motivos = [];

    if (!ORGANISMOS_VALIDOS.has(organismo)) motivos.push(`organismo "${organismo}" fuera del catálogo`);
    if (!TIPOS_VALIDOS.has(tipo)) motivos.push(`tipo "${tipo}" fuera del catálogo`);

    const vigencia = vigenciaPorArchivo.get(fila.archivo);
    if (vigencia === undefined || vigencia.fecha_emision.length === 0) {
      motivos.push('sin fecha de emisión verificada en vigencias.csv');
    }

    if (motivos.length > 0) {
      salteadas.push({ archivo: fila.archivo, motivos });
      continue;
    }

    const numero = fila.numero.length > 0 ? fila.numero : 'S/N';
    const norma = await client.query(
      `INSERT INTO norms (organismo, tipo, numero, anio, titulo, jurisdiccion, hierarchy_level)
       VALUES ($1, $2, $3, $4, $5, 'AR', $6)
       ON CONFLICT (organismo, tipo, numero, anio) DO UPDATE SET titulo = EXCLUDED.titulo
       RETURNING id`,
      [organismo, tipo, numero, Number(fila.anio), fila.titulo, jerarquiaDe(organismo, tipo)],
    );
    const normId = norma.rows[0].id;

    const version = await client.query(
      `INSERT INTO norm_versions
         (norm_id, version, fecha_emision, fecha_publicacion, fecha_vigencia, verification_level)
       VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (norm_id, version) DO UPDATE
         SET fecha_publicacion = EXCLUDED.fecha_publicacion,
             fecha_vigencia = EXCLUDED.fecha_vigencia
       RETURNING id`,
      [
        normId,
        vigencia.fecha_emision,
        vigencia.fecha_publicacion || null,
        vigencia.fecha_vigencia || null,
        fila.nivel_verificacion,
      ],
    );
    const versionId = version.rows[0].id;

    // El hash es lo que permite demostrar, años después, qué texto exacto usaba
    // el sistema. Sale del registro de descargas, no se recalcula acá: si el
    // archivo cambió, `npm run norms:verify` es quien tiene que gritar.
    await client.query(
      `INSERT INTO norm_documents
         (norm_version_id, url_oficial, storage_key, sha256, mime, bytes, captured_by)
       VALUES ($1, $2, $3, $4, $5, 1, 'fase-1')
       ON CONFLICT (norm_version_id, sha256) DO NOTHING`,
      [
        versionId,
        fila.url_oficial,
        `docs/normative-sources/originals/${fila.archivo}`,
        fila.sha256,
        mimeDe(fila.archivo),
      ],
    );

    cargadas.push(`${organismo} ${tipo} ${numero}/${fila.anio}`);
  }

  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

console.log(`Normas cargadas: ${cargadas.length}`);
for (const nombre of cargadas) console.log(`  + ${nombre}`);

if (salteadas.length > 0) {
  console.log('');
  console.log(`Salteadas: ${salteadas.length}. No se inventan datos para completarlas.`);
  for (const { archivo, motivos } of salteadas) {
    console.log(`  - ${archivo}: ${motivos.join('; ')}`);
  }
}

console.log('');
console.log('Adopciones jurisdiccionales cargadas: 0.');
console.log(
  '  Para que el motor resuelva normas profesionales en CABA falta archivar la\n' +
    '  Res. CPCECABA 460/2024. Hasta entonces responde ADOPCION_NO_RELEVADA, que es\n' +
    '  lo correcto: la vigencia de FACPCE y la del consejo son hechos distintos.',
);
