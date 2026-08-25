#!/usr/bin/env node
/**
 * Archiva en `prompt_versions` los prompts que el código conoce.
 *
 * `ai_predictions.prompt_hash` tiene una FK a esta tabla: un prompt no
 * registrado no puede usarse. Es a propósito — sin el texto archivado, el hash
 * es la huella de algo que ya no se puede leer, y la pregunta *"¿con qué
 * instrucciones el sistema propuso esto?"* se queda sin respuesta.
 *
 * Corre con las credenciales de migración, no con las de la aplicación: `aai_app`
 * no tiene INSERT sobre `prompt_versions`. Un prompt que se pudiera insertar por
 * HTTP dejaría de ser un artefacto versionado.
 *
 * Es idempotente. Si un prompt cambió de texto, cambia su hash y entra como fila
 * nueva; la anterior queda, porque las predicciones que la citan siguen
 * existiendo.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  PROMPT_DETERMINISTICO,
  PROMPT_HASH_DETERMINISTICO,
  promptsRegistrados,
} from '../packages/ai-engine/dist/index.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(AQUI, '..', '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  console.error('Falta DATABASE_URL');
  process.exit(1);
}

const prompts = [
  ...promptsRegistrados(),
  {
    hash: PROMPT_HASH_DETERMINISTICO,
    name: PROMPT_DETERMINISTICO.name,
    version: PROMPT_DETERMINISTICO.version,
    texto: PROMPT_DETERMINISTICO.texto,
  },
];

const client = new pg.Client({ connectionString });
await client.connect();

let nuevos = 0;
try {
  await client.query('BEGIN');
  for (const prompt of prompts) {
    const resultado = await client.query(
      `INSERT INTO prompt_versions (hash, name, version, texto)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (hash) DO NOTHING
       RETURNING hash`,
      [prompt.hash, prompt.name, prompt.version, prompt.texto],
    );
    if (resultado.rowCount > 0) {
      nuevos += 1;
      console.log(`  + ${prompt.name} ${prompt.version} → ${prompt.hash.slice(0, 12)}…`);
    }
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

console.log(
  nuevos === 0
    ? `Prompts al día: ${prompts.length} archivados, ninguno nuevo.`
    : `${nuevos} prompt(s) archivado(s). Total conocido: ${prompts.length}.`,
);
