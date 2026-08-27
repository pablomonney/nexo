#!/usr/bin/env node
/**
 * Carga reglas desde `docs/accounting-rules/*.json` a `accounting_rules`.
 *
 *   npm run reglas:cargar            — muestra qué pasaría, sin escribir
 *   npm run reglas:cargar -- --aplicar
 *
 * ## Reparto de responsabilidades
 *
 * Este script hace el **IO**: lee los archivos, recalcula el SHA-256 del
 * documento archivado, extrae su texto y consulta el corpus. La decisión de
 * aceptar o rechazar la toma `validarReglaParaCarga()`, que es puro y vive en
 * `@aai/normative-engine`. Esa separación no es estética: el lint de
 * arquitectura prohíbe IO en los paquetes de dominio, y además permite testear
 * los rechazos sin disco ni base.
 *
 * ## Todo entra como DRAFT
 *
 * No hay bandera para insertar en `ACTIVE`. Activar exige la aprobación del §32
 * y se hace con `npm run reglas:aprobar`, que es un acto distinto, de otra
 * persona, y con su propia bitácora. La base también lo impide por su cuenta —
 * `rule_active_requires_approval`—, así que son dos candados independientes.
 *
 * ## Simula por defecto
 *
 * Una regla que entra a la base sin que nadie mire el diff es una afirmación
 * normativa que nadie revisó.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { validarReglaParaCarga, normalizarTexto } from '@aai/normative-engine';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(join(AQUI, '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const aplicar = process.argv.includes('--aplicar');
const DIR_REGLAS = join(RAIZ, 'docs', 'accounting-rules');
const DIR_DOCS = join(RAIZ, 'docs', 'normative-sources', 'originals');

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

/**
 * Texto plano de un documento archivado.
 *
 * Los de INFOLEG vienen en HTML y en latin-1. Se decodifica así y se quita el
 * marcado; la comparación contra la cita normaliza espacios después, porque el
 * HTML parte los párrafos en varias líneas y eso no debería invalidar una cita
 * correcta.
 */
function textoPlano(ruta) {
  const crudo = readFileSync(ruta, 'latin1');
  return crudo
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8220;|&#8221;/g, '"');
}

const db = new pg.Client({ connectionString });
await db.connect();

const archivos = existsSync(DIR_REGLAS)
  ? readdirSync(DIR_REGLAS).filter((f) => f.endsWith('.json')).sort()
  : [];

if (archivos.length === 0) {
  console.log(`No hay reglas en ${DIR_REGLAS}.`);
  await db.end();
  process.exit(0);
}

console.log(`${archivos.length} archivo(s) de regla en docs/accounting-rules/\n`);

let aceptadas = 0;
let rechazadas = 0;
let insertadas = 0;

for (const archivo of archivos) {
  console.log(`── ${archivo}`);
  let cruda;
  try {
    cruda = JSON.parse(readFileSync(join(DIR_REGLAS, archivo), 'utf8'));
  } catch (error) {
    console.log(`   ✘ no es JSON válido: ${error.message}`);
    rechazadas += 1;
    continue;
  }

  // --- El contexto: disco y corpus ------------------------------------------
  const nombreDoc = cruda?.fuente?.documento?.archivo;
  const rutaDoc = typeof nombreDoc === 'string' ? join(DIR_DOCS, nombreDoc) : null;

  let sha256Calculado = null;
  let texto = null;
  if (rutaDoc !== null && existsSync(rutaDoc)) {
    sha256Calculado = createHash('sha256').update(readFileSync(rutaDoc)).digest('hex');
    texto = textoPlano(rutaDoc);
  }

  const f = cruda?.fuente ?? {};
  const norma = await db.query(
    `SELECT v.id AS norm_version_id, d.sha256
       FROM norms n
       JOIN norm_versions v ON v.norm_id = n.id
       LEFT JOIN norm_documents d ON d.norm_version_id = v.id
      WHERE n.organismo = $1 AND n.tipo = $2 AND n.numero = $3 AND n.anio = $4
      ORDER BY v.version DESC
      LIMIT 1`,
    [f.organismo ?? '', f.tipo ?? '', String(f.numero ?? ''), Number(f.anio ?? 0)],
  );

  const contexto = {
    normVersionId: norma.rows[0]?.norm_version_id ?? null,
    sha256Registrado: norma.rows[0]?.sha256 ?? null,
    sha256Calculado,
    textoDelDocumento: texto,
  };

  // --- La decisión ----------------------------------------------------------
  const resultado = validarReglaParaCarga(cruda, contexto);

  if (!resultado.ok) {
    rechazadas += 1;
    console.log(`   ✘ RECHAZADA (${resultado.rechazos.length})`);
    for (const r of resultado.rechazos) console.log(`      [${r.codigo}] ${r.detalle}`);
    console.log('');
    continue;
  }

  aceptadas += 1;
  const m = cruda.regla;
  console.log(`   ✔ válida — ${m.clave} v${m.version} · dominio ${m.dominio} · DRAFT`);
  console.log(`      norma      ${f.organismo} ${f.tipo} ${f.numero}/${f.anio} (${contexto.normVersionId})`);
  console.log(`      sha256     ${sha256Calculado.slice(0, 32)}… verificado contra disco y corpus`);
  console.log(`      cita       art. ${cruda.cita.articulo}${cruda.cita.inciso ? ` inc. ${cruda.cita.inciso}` : ''} — hallada literal en el documento`);
  console.log(`      hechos     ${resultado.hechosDetectados.join(', ') || '(ninguno)'}`);
  console.log(`      vigencia   ${cruda.vigencia.desde} → ${cruda.vigencia.hasta ?? 'sin fin declarado'}`);

  if (!aplicar) {
    console.log('      (simulación: no se escribió)');
    console.log('');
    continue;
  }

  // --- La escritura ---------------------------------------------------------
  // `status` va literal, no desde el archivo: aunque alguien lograra pasar la
  // validación con otro valor, acá no hay forma de escribir algo que no sea
  // DRAFT.
  const ya = await db.query('SELECT id, status FROM accounting_rules WHERE rule_key = $1 AND version = $2', [
    m.clave,
    m.version,
  ]);
  if (ya.rowCount > 0) {
    console.log(`      ya existe (estado ${ya.rows[0].status}); no se toca`);
    console.log('');
    continue;
  }

  await db.query(
    `INSERT INTO accounting_rules
       (rule_key, version, norm_version_id, domain, valid_from, valid_to,
        jurisdiction, entity_types, frameworks, priority, conditions, action,
        status, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',$13)`,
    [
      m.clave,
      m.version,
      contexto.normVersionId,
      m.dominio,
      cruda.vigencia.desde,
      cruda.vigencia.hasta,
      m.jurisdiccion,
      m.tiposDeEnte ?? [],
      m.marcos ?? [],
      m.prioridad,
      JSON.stringify(cruda.condiciones.ast),
      JSON.stringify({
        ...cruda.accion,
        // La cita viaja con la acción para que una regla resuelta pueda mostrar
        // de dónde sale sin volver a leer el archivo.
        _cita: {
          articulo: cruda.cita.articulo,
          inciso: cruda.cita.inciso ?? null,
          texto: normalizarTexto(cruda.cita.texto),
          documento_sha256: sha256Calculado,
        },
        _hechosRequeridos: cruda.condiciones.hechosRequeridos,
      }),
      m.propuestaPor,
    ],
  );
  insertadas += 1;
  console.log('      INSERTADA en estado DRAFT');
  console.log('');
}

const conteo = await db.query(
  `SELECT status, count(*)::int n FROM accounting_rules
    WHERE proposed_by NOT IN ('proponente') GROUP BY status ORDER BY status`,
);
await db.end();

console.log('─────────────────────────────────────────');
console.log(`Válidas: ${aceptadas} · Rechazadas: ${rechazadas} · Insertadas: ${insertadas}`);
console.log(`Reglas reales por estado: ${conteo.rows.map((r) => `${r.status}=${r.n}`).join(' · ') || '(ninguna)'}`);
if (!aplicar && aceptadas > 0) {
  console.log('\nSimulación. Agregá --aplicar para escribir.');
}
console.log('\nNinguna regla queda ACTIVE por esta vía. Ver `npm run reglas:aprobar`.');
