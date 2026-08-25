#!/usr/bin/env node
/**
 * Carga la semilla de tipos de comprobante en `arca_comprobante_types`.
 *
 * La semilla vive en un solo lugar —`packages/document-engine/src/catalogo.ts`,
 * transcripta del manual archivado con hash— y este script la copia a la base.
 * Duplicarla en un `INSERT` dentro de una migración habría creado dos fuentes
 * que se desincronizan a la primera corrección.
 *
 * Las filas entran con `vigencia_verificada = false` a propósito: el manual
 * enumera los códigos pero no sus fechas de vigencia, y ARCA publica la tabla
 * con `FchDesde`/`FchHasta` a través de `FEParamGetTiposCbte`. Hasta que esa
 * sincronización exista, el sistema sabe qué significa cada código pero no
 * afirma desde cuándo — que es la diferencia entre citar y suponer (§6, §30).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { FUENTE_SEMILLA, semillaCompleta } from '../packages/document-engine/dist/catalogo.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(AQUI, '..', '.env'));
} catch {
  // Sin .env se usan las variables del entorno, que es el caso de CI.
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

const fuente = `${FUENTE_SEMILLA.documento} — ${FUENTE_SEMILLA.seccion}`;
let insertados = 0;
let actualizados = 0;

try {
  await client.query('BEGIN');
  for (const tipo of semillaCompleta()) {
    const resultado = await client.query(
      `INSERT INTO arca_comprobante_types
         (codigo, descripcion, letra, clase, fuente, verification_level, vigencia_verificada)
       VALUES ($1, $2, $3, $4, $5, 'V1', false)
       ON CONFLICT (codigo) DO UPDATE
         SET descripcion = EXCLUDED.descripcion,
             letra = EXCLUDED.letra,
             clase = EXCLUDED.clase,
             fuente = EXCLUDED.fuente
       RETURNING (xmax = 0) AS insertado`,
      [tipo.codigo, tipo.descripcion, tipo.letra, tipo.clase, fuente],
    );
    if (resultado.rows[0].insertado) insertados += 1;
    else actualizados += 1;
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

console.log(`Semilla cargada: ${insertados} nuevos, ${actualizados} actualizados.`);
console.log(`Fuente: ${fuente}`);
console.log(
  `Vigencia por fecha: NO verificada. Requiere sincronizar ${FUENTE_SEMILLA.metodoAutoritativo}.`,
);
