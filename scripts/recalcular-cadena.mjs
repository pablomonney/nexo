#!/usr/bin/env node
/**
 * Recalcula el hash de las últimas filas de las bitácoras encadenadas **sin usar
 * las funciones de la base**.
 *
 *   node scripts/recalcular-cadena.mjs                     — últimas 50 filas de cada cadena
 *   node scripts/recalcular-cadena.mjs --ultimas 200       — otra ventana
 *   node scripts/recalcular-cadena.mjs --empresa <uuid>    — solo esa empresa (más la cadena normativa)
 *   node scripts/recalcular-cadena.mjs --sin-normativa     — solo la bitácora por empresa
 *
 * ## Para qué sirve
 *
 * `verify_audit_chain()` y el trigger que escribe el hash comparten fórmula y
 * están fijados igual (UTC, ISO): si se equivocan **juntos**, el verificador da
 * verde sobre un hash que nadie más sabe reproducir. Este script lee las
 * columnas crudas y calcula SHA-256 en Node, con su propia copia de la fórmula
 * (`scripts/lib/cadena.mjs`). Es la comprobación independiente que pide el paso
 * V5 de `docs/PLAN_ZONA_HORARIA.md`: después de una acción real que escriba
 * auditoría, la fila nueva tiene que coincidir con lo que se calcula afuera.
 *
 * Solo lee (`BEGIN READ ONLY`) y fija su propia sesión en UTC y estilo ISO,
 * que es como se escribió el historial: lo único del payload que depende de la
 * sesión es `occurred_at::text`. No depende de la zona de negocio, a propósito.
 *
 * Código de salida: 0 si todas las filas coinciden y los enlaces cierran; 1 si
 * alguna no (se informan); 2 si no pudo leer.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { payloadDeAuditoria, payloadNormativo, revisarVentana } from './lib/cadena.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const argumentos = process.argv.slice(2);
const valorDe = (bandera) => {
  const i = argumentos.indexOf(bandera);
  return i >= 0 ? argumentos[i + 1] : undefined;
};
const ULTIMAS = Number.parseInt(valorDe('--ultimas') ?? '50', 10);
const EMPRESA = valorDe('--empresa');
const CON_NORMATIVA = !argumentos.includes('--sin-normativa');

if (!Number.isInteger(ULTIMAS) || ULTIMAS < 1 || ULTIMAS > 100000) {
  console.error('--ultimas tiene que ser un entero entre 1 y 100000.');
  process.exit(2);
}
if (EMPRESA !== undefined && !/^[0-9a-f-]{36}$/i.test(EMPRESA)) {
  console.error('--empresa tiene que ser un uuid.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

// La sesión canónica (UTC, ISO) se pide DESPUÉS de conectar, con SET LOCAL: así
// no depende de PGOPTIONS ni de la configuración de la base, y a propósito NO
// usa la zona de negocio —no compara ninguna fecha, solo lee texto—.
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const informe = { ultimas: ULTIMAS, empresas: [], normativa: null, ok: false };

try {
  await db.connect();
  await db.query('BEGIN READ ONLY');
  await db.query("SET LOCAL timezone = 'UTC'");
  await db.query("SET LOCAL datestyle = 'ISO, MDY'");

  const empresas = EMPRESA
    ? [EMPRESA]
    : (await db.query('SELECT DISTINCT company_id::text AS id FROM audit_logs ORDER BY 1')).rows.map((r) => r.id);

  for (const id of empresas) {
    // N+1 filas: la más vieja es el contexto del enlace de la ventana. El ORDER BY
    // va CALIFICADO: `seq` a secas es el alias de texto de la lista (`seq::text`) y
    // ordenaría '9937' por encima de '10121'.
    const { rows } = await db.query(
      `SELECT id::text AS id, seq::text AS seq, company_id::text AS company_id, prev_hash, hash,
              actor_type, actor_id, action, object_type, object_id,
              old_value::text AS old_value, new_value::text AS new_value, motivo,
              occurred_at::text AS occurred_at
         FROM audit_logs WHERE company_id = $1 ORDER BY audit_logs.seq DESC LIMIT $2`,
      [id, ULTIMAS + 1],
    );
    const ventana = rows.reverse();
    informe.empresas.push({
      empresa: id,
      ...revisarVentana(ventana, payloadDeAuditoria, { desdeElPrincipio: ventana.length <= ULTIMAS }),
    });
  }

  if (CON_NORMATIVA) {
    const { rows } = await db.query(
      `SELECT id::text AS id, seq::text AS seq, prev_hash, hash, actor_type, actor_id, action,
              object_type, object_id, old_value::text AS old_value, new_value::text AS new_value,
              motivo, occurred_at::text AS occurred_at
         FROM normative_audit_logs ORDER BY normative_audit_logs.seq DESC LIMIT $1`,
      [ULTIMAS + 1],
    );
    const ventana = rows.reverse();
    informe.normativa = revisarVentana(ventana, payloadNormativo, { desdeElPrincipio: ventana.length <= ULTIMAS });
  }

  await db.query('ROLLBACK');
} catch (error) {
  console.error('No se pudo leer la bitácora:', error instanceof Error ? error.message : error);
  await db.end().catch(() => undefined);
  process.exit(2);
}
await db.end();

const todas = [...informe.empresas, ...(informe.normativa ? [informe.normativa] : [])];
const rotas = todas.reduce((n, c) => n + c.hashesRotos.length + c.enlacesRotos.length, 0);
informe.revisadas = todas.reduce((n, c) => n + c.revisadas, 0);
informe.rotas = rotas;
informe.ok = rotas === 0 && informe.revisadas > 0;
console.log(JSON.stringify(informe, null, 2));
process.exit(informe.ok ? 0 : 1);
