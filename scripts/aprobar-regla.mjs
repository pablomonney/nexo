#!/usr/bin/env node
/**
 * Aprueba una regla en DRAFT y la pasa a ACTIVE. Es el §32.
 *
 *   npm run reglas:aprobar -- --clave AR-IVA-CF-VINCULACION-001 --version 1 \
 *     --aprobador "user:maria.perez" --constancia "Revisado contra el art. 12 …"
 *
 * ## Por qué es un script aparte y no una bandera del cargador
 *
 * Porque son actos distintos y de personas distintas. Cargar una regla es
 * proponerla; activarla es hacerse responsable de que dice lo que la norma dice.
 * Si fuera `--aplicar --activar`, la misma corrida haría las dos cosas y la
 * separación de funciones sería una convención en vez de un hecho.
 *
 * ## Tres candados, y ninguno es este script
 *
 * La base los impone por su cuenta, así que saltear este comando no alcanza:
 *
 * 1. `rule_active_requires_approval` — ACTIVE exige `approved_by` y `approved_at`.
 * 2. `rule_segregation_of_duties` — quien aprueba no puede ser quien propuso.
 * 3. `rules_source_verified` — la norma tiene que estar en nivel V1 y tener
 *    documento archivado, o la activación se rechaza.
 *
 * Lo que agrega este script es que el acto quede **explicado**: pide una
 * constancia escrita y la deja en la bitácora de auditoría junto al antes y el
 * después.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(join(AQUI, '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const clave = process.argv[i]?.replace(/^--/, '');
  if (clave !== undefined) args.set(clave, process.argv[i + 1]);
}

const clave = args.get('clave');
const version = Number(args.get('version'));
const aprobador = args.get('aprobador');
const constancia = args.get('constancia');

if (clave === undefined || !Number.isInteger(version) || aprobador === undefined) {
  console.error('Uso: --clave <rule_key> --version <n> --aprobador <id> --constancia "<texto>"');
  process.exit(2);
}

/**
 * La constancia es obligatoria y no puede ser un trámite.
 *
 * Una aprobación sin motivo escrito es una firma que no dice qué se revisó, y
 * dentro de dos años nadie va a poder reconstruirlo. El mínimo de largo no
 * garantiza calidad, pero descarta el "ok".
 */
if (typeof constancia !== 'string' || constancia.trim().length < 30) {
  console.error('Falta --constancia, o es demasiado corta (mínimo 30 caracteres).');
  console.error('Tiene que decir QUÉ se revisó y contra qué. Queda en la bitácora de auditoría.');
  process.exit(2);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

const db = new pg.Client({ connectionString });
await db.connect();

try {
  const actual = await db.query(
    `SELECT r.id, r.status, r.proposed_by, r.domain, r.valid_from::text AS desde,
            r.action, n.organismo, n.tipo, n.numero, n.anio, v.verification_level
       FROM accounting_rules r
       JOIN norm_versions v ON v.id = r.norm_version_id
       JOIN norms n ON n.id = v.norm_id
      WHERE r.rule_key = $1 AND r.version = $2`,
    [clave, version],
  );

  if (actual.rowCount === 0) {
    console.error(`No existe la regla ${clave} v${version}.`);
    process.exit(1);
  }

  const regla = actual.rows[0];

  if (regla.status === 'ACTIVE') {
    console.error(`${clave} v${version} ya está ACTIVE. Una regla no se aprueba dos veces.`);
    process.exit(1);
  }
  if (regla.status !== 'DRAFT' && regla.status !== 'IN_REVIEW') {
    console.error(`${clave} v${version} está en estado ${regla.status}: no se puede aprobar desde ahí.`);
    process.exit(1);
  }
  if (regla.proposed_by === aprobador) {
    console.error(
      `"${aprobador}" es quien propuso esta regla. Aprobar lo propio no es una revisión.`,
    );
    process.exit(1);
  }

  // Un gap normativo abierto que nombre esta regla la bloquea. La base también
  // lo impone (`accounting_rules_gap_abierto`, 0041); acá se consulta antes para
  // poder decir CUÁL gap y QUÉ falta, en vez de devolver un error de constraint.
  const gaps = await db.query(
    `SELECT topic, description, blocks
       FROM normative_gaps
      WHERE blocks_rule_key = $1 AND status = 'ABIERTO'`,
    [clave],
  );
  if (gaps.rowCount > 0) {
    console.error(`\n✘ ${clave} no se puede activar: hay ${gaps.rowCount} gap(s) normativo(s) abiertos.\n`);
    for (const gap of gaps.rows) {
      console.error(`  · ${gap.topic}`);
      console.error(`    falta    ${gap.description}`);
      console.error(`    bloquea  ${gap.blocks}\n`);
    }
    console.error('  Un gap se cierra incorporando la fuente oficial que falta —descarga, SHA-256,');
    console.error('  registro en registro-de-descargas.csv—, no cambiando su estado a mano.');
    process.exit(1);
  }

  // Se muestra QUÉ se está por activar, antes de activarlo.
  const cita = regla.action?._cita ?? {};
  console.log('\nSe va a ACTIVAR:');
  console.log(`  regla     ${clave} v${version} · dominio ${regla.domain} · vigente desde ${regla.desde}`);
  console.log(`  norma     ${regla.organismo} ${regla.tipo} ${regla.numero}/${regla.anio} (nivel ${regla.verification_level})`);
  console.log(`  artículo  ${cita.articulo ?? '?'}${cita.inciso ? ` inc. ${cita.inciso}` : ''}`);
  console.log(`  propuesta ${regla.proposed_by}`);
  console.log(`  aprueba   ${aprobador}\n`);

  await db.query('BEGIN');
  const r = await db.query(
    `UPDATE accounting_rules
        SET status = 'ACTIVE', approved_by = $3, approved_at = now()
      WHERE rule_key = $1 AND version = $2 AND status IN ('DRAFT','IN_REVIEW')
      RETURNING id`,
    [clave, version, aprobador],
  );
  if (r.rowCount === 0) {
    await db.query('ROLLBACK');
    console.error('No se actualizó ninguna fila: alguien cambió el estado mientras tanto.');
    process.exit(1);
  }

  // La bitácora encadenada por hash. Sin esto la activación sería un UPDATE que
  // nadie puede reconstruir después.
  //
  // Va a `normative_audit_logs` y no a `audit_logs`. La corrección anterior
  // arregló los nombres de las columnas —`object_type`, `old_value`/`new_value`—
  // y dejó pasar lo otro: `audit_logs.company_id` es NOT NULL, y acá se pasaba
  // NULL porque una regla no es de ninguna empresa. La inserción fallaba con
  // 23502 SIEMPRE, después del UPDATE, y el `catch` la revertía. Es decir: este
  // comando nunca pudo aprobar nada. No se notó porque nunca se aprobó una regla
  // —el §32 exige la firma, y la firma no tenía dónde escribirse—.
  //
  // El destino correcto no es aflojar el NOT NULL: es reconocer que un acto
  // normativo no ocurre dentro de una empresa. Ver la 0041.
  await db.query(
    `INSERT INTO normative_audit_logs
       (actor_type, actor_id, action, object_type, object_id,
        old_value, new_value, motivo, prev_hash, hash, seq)
     VALUES ('USER', $1, 'RULE_APPROVED', 'accounting_rules', $2, $3, $4, $5, '', '', 0)`,
    [
      aprobador,
      regla.id,
      JSON.stringify({ status: regla.status }),
      JSON.stringify({ status: 'ACTIVE', approved_by: aprobador }),
      constancia.trim(),
    ],
  );
  await db.query('COMMIT');

  console.log(`✔ ${clave} v${version} quedó ACTIVE.`);
  console.log(`  Constancia registrada en audit_logs: "${constancia.trim().slice(0, 80)}…"`);
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(`\n✘ No se pudo aprobar: ${error.message}`);
  console.error('\n  Los candados de la base son independientes de este script:');
  console.error('   · rule_active_requires_approval — ACTIVE exige firma y fecha');
  console.error('   · rule_segregation_of_duties    — quien aprueba no puede haber propuesto');
  console.error('   · rules_source_verified         — la norma tiene que ser V1 y con documento');
  process.exit(1);
} finally {
  await db.end();
}
