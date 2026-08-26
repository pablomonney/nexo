#!/usr/bin/env node
/**
 * Siembra de plantillas de estados contables.
 *
 *   npm run statements:seed
 *
 * Hoy no siembra ninguna, y el motivo no es que falte escribirlas: es que
 * `statement_templates.norm_version_id` es `NOT NULL` y la norma de la que sale
 * la estructura del ESP —la **Ley 19.550 (T.O. 1984), arts. 63 y 64**— no está
 * sembrada en `norms`.
 *
 * Y no está sembrada por la misma regla que dejó afuera a otros doce documentos
 * en FASE 5b: su `fecha_emision` no surge del documento archivado. El texto de
 * InfoLeg dice *"Texto ordenado por el Anexo del Decreto N° 841/84 B.O.
 * 30/03/1984"* — eso es la fecha de **publicación** del decreto que ordenó el
 * texto, no la de emisión. Completar una con la otra sería afirmar un hecho que
 * nadie verificó.
 *
 * Este script existe para que ese bloqueo sea **una respuesta, no un silencio**:
 * se corre, dice exactamente qué falta y en qué archivo se destraba.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (DATABASE_URL === '') {
  console.log('statements:seed — sin DATABASE_URL. Nada que sembrar.');
  process.exit(0);
}

/** La norma que cada plantilla necesita, y qué artículo la funda. */
const REQUISITOS = [
  {
    estado: 'ESP',
    organismo: 'CONGRESO',
    tipo: 'LEY',
    numero: '19550',
    articulo: 'Art. 63 — contenido del balance general',
    archivo: 'INFOLEG_LGS_19550_texto_actualizado.htm',
  },
  {
    estado: 'ER',
    organismo: 'CONGRESO',
    tipo: 'LEY',
    numero: '19550',
    articulo: 'Art. 64 — contenido del estado de resultados',
    archivo: 'INFOLEG_LGS_19550_texto_actualizado.htm',
  },
];

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  const existentes = await client.query(
    `SELECT statement_kind, framework, entity_type, regulator, version
       FROM statement_templates ORDER BY statement_kind, framework`,
  );

  if (existentes.rows.length > 0) {
    console.log(`Plantillas ya cargadas: ${existentes.rows.length}`);
    for (const fila of existentes.rows) {
      console.log(
        `  · ${fila.statement_kind} ${fila.framework} ${fila.entity_type} ${fila.regulator} v${fila.version}`,
      );
    }
  }

  const faltantes = [];
  for (const requisito of REQUISITOS) {
    const norma = await client.query(
      `SELECT n.id
         FROM norms n
         JOIN norm_versions v ON v.norm_id = n.id
        WHERE n.organismo = $1 AND n.tipo = $2 AND n.numero = $3
        LIMIT 1`,
      [requisito.organismo, requisito.tipo, requisito.numero],
    );
    if (norma.rows.length === 0) faltantes.push(requisito);
  }

  if (faltantes.length === 0) {
    console.log('');
    console.log('La Ley 19.550 está sembrada. Ya se pueden cargar las plantillas:');
    console.log('  1. Transcribir la estructura de los arts. 63 y 64 al árbol de la plantilla.');
    console.log('  2. Validarla con `validarPlantilla()` antes de insertarla.');
    console.log('  3. Cada RUBRO tiene que citar su inciso: el validador lo exige.');
    console.log('');
    console.log('No se hace desde este script: transcribir articulado a una estructura de');
    console.log('presentación es una decisión profesional, no una corrida automática.');
    process.exit(0);
  }

  console.log('');
  console.log(`Plantillas sembradas: 0. Falta la norma de la que sale la estructura.`);
  console.log('');
  for (const requisito of faltantes) {
    console.log(`  ✘ ${requisito.estado}: ${requisito.organismo} ${requisito.tipo} ${requisito.numero}`);
    console.log(`      ${requisito.articulo}`);
    console.log(`      Archivo: docs/normative-sources/originals/${requisito.archivo} (ya archivado, con sha256)`);
  }
  console.log('');
  console.log('Cómo se destraba, en un paso:');
  console.log('');
  console.log('  Agregar una fila a docs/normative-sources/vigencias.csv para');
  console.log('  INFOLEG_LGS_19550_texto_actualizado.htm con su `fecha_emision` verificada.');
  console.log('');
  console.log('  Hoy no está porque el documento archivado solo dice "Texto ordenado por el');
  console.log('  Anexo del Decreto N° 841/84 B.O. 30/03/1984": esa es la fecha de PUBLICACIÓN');
  console.log('  del decreto, no la de su emisión. Es la misma regla que dejó afuera a otros');
  console.log('  doce documentos: completar la emisión con la publicación sería afirmar un');
  console.log('  hecho que nadie verificó.');
  console.log('');
  console.log('  Con esa fila, `npm run norms:seed` carga la ley y este script vuelve a correr.');
  console.log('');
  console.log('Mientras tanto el motor funciona: hay 33 tests que lo prueban sobre plantillas');
  console.log('de fixture. Lo que no hay es una plantilla en producción, y el sistema responde');
  console.log('FUENTE NO ENCONTRADA en vez de armar una estructura por su cuenta.');
} finally {
  await client.end();
}
