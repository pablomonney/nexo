#!/usr/bin/env node
/**
 * Restaura una copia de resguardo **en una base descartable** y comprueba que
 * lo restaurado sirve.
 *
 *   npm run db:restaurar                       — el backup más reciente
 *   node scripts/restaurar-backup.mjs --archivo "C:\...\aai_20260901.backup"
 *   node scripts/restaurar-backup.mjs --conservar   — no borra la base al final
 *
 * ## El problema que resuelve
 *
 * `PROJECT_STATUS.md` decía, desde que existe el backup: *«un backup que nunca
 * se restauró es una hipótesis, no una copia»* (§66). Era una deuda marcada
 * IMPORTANTE y un riesgo vivo: el RPO y el RTO eran estimaciones porque nadie
 * había recorrido el camino de vuelta ni una vez.
 *
 * ## Restaurar no es verificar
 *
 * `pg_restore` puede terminar con código 0 y dejar un esquema a medio poblar:
 * los errores de objetos individuales salen por `stderr` como advertencias. Así
 * que "restauró" no es la pregunta. Las preguntas son tres, y se contestan por
 * separado porque fallan por motivos distintos:
 *
 *   1. ¿Están los candados?      `audit:estructura` sobre la base restaurada.
 *   2. ¿Cuadra lo que hay?       `ledger:verify --observacional` sobre ella.
 *   3. ¿Está todo lo que había?  conteo tabla por tabla contra la base viva.
 *
 * La tercera es la que convierte «se restauró» en «es la misma base». Sin ella,
 * un backup que perdió la mitad de las filas pasa las dos primeras sin ruido:
 * el esquema está completo y un Mayor con menos asientos igual cuadra consigo
 * mismo.
 *
 * ## El candado de nombres
 *
 * Este script **crea y destruye** bases. El destino tiene que estar dentro del
 * prefijo `aai_restauracion`, y no se comprueba "que no sea producción": una
 * lista negra siempre queda corta, y la primera vez que quede corta el error es
 * irreversible. Es el mismo diseño que el sufijo `_test` de `test-db.mjs`.
 *
 * ## Lo que este script no promete
 *
 * No mide el RTO real de una restauración de producción: corre en la misma
 * máquina, sobre el mismo disco, sin red de por medio. Dice que el archivo es
 * restaurable y completo, que es la mitad que hoy no estaba probada.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  apuntandoA,
  backupMasReciente,
  binarioDePostgres,
  DESTINO_POR_DEFECTO,
  esDescartable,
  nombreDeBase,
  PREFIJO_DESCARTABLE,
} from './lib/postgres-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(HERE, '..');
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copiá .env.example a .env y completalo.');
  process.exit(2);
}

function argumento(bandera) {
  const i = process.argv.indexOf(bandera);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : null;
}

// ── Qué archivo ──────────────────────────────────────────────────────────────

const carpeta = process.env.NEXO_BACKUP_DIR ?? DESTINO_POR_DEFECTO;
const pedido = argumento('--archivo');
const elegido = pedido !== null ? { ruta: resolve(pedido) } : backupMasReciente(carpeta);

if (elegido === null) {
  console.error(`No hay ningún archivo .backup en ${carpeta}.`);
  console.error('Generá uno con: npm run db:backup');
  process.exit(2);
}
if (!existsSync(elegido.ruta)) {
  console.error(`No existe el archivo ${elegido.ruta}.`);
  process.exit(2);
}

const info = statSync(elegido.ruta);
const antigüedadHoras = (Date.now() - info.mtimeMs) / 3_600_000;

// ── Adónde ───────────────────────────────────────────────────────────────────

const destino = argumento('--destino') ?? PREFIJO_DESCARTABLE;
if (!esDescartable(destino)) {
  console.error(`El destino "${destino}" está fuera del espacio descartable.`);
  console.error(`Este script borra bases, y solo puede tocar "${PREFIJO_DESCARTABLE}" o`);
  console.error(`nombres que empiecen con "${PREFIJO_DESCARTABLE}_". Se corta.`);
  process.exit(2);
}

const viva = nombreDeBase(DATABASE_URL);
const urlDestino = apuntandoA(DATABASE_URL, destino);
const urlAdmin = apuntandoA(DATABASE_URL, 'postgres');

console.log(`Archivo   ${elegido.ruta}`);
console.log(`           ${(info.size / 1024).toFixed(0)} KB · ${antigüedadHoras.toFixed(1)} h de antigüedad`);
console.log(`Base viva  ${viva}  (solo se lee, para comparar)`);
console.log(`Destino    ${destino}  (se crea y se destruye)\n`);

// ── 0. Base limpia ───────────────────────────────────────────────────────────

const admin = new pg.Client({ connectionString: urlAdmin });
await admin.connect();
try {
  // `WITH (FORCE)` cierra conexiones olvidadas: sin eso una sesión de una
  // corrida anterior impide el DROP y el mensaje no explica por qué.
  await admin.query(`DROP DATABASE IF EXISTS "${destino.replace(/"/g, '""')}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${destino.replace(/"/g, '""')}"`);
  console.log(`✔ base "${destino}" creada vacía`);
} finally {
  await admin.end();
}

/** Deja el sistema como estaba. Se llama pase lo que pase, salvo `--conservar`. */
async function limpiar() {
  if (process.argv.includes('--conservar')) {
    console.log(`\nLa base "${destino}" queda en pie (--conservar).`);
    return;
  }
  const c = new pg.Client({ connectionString: urlAdmin });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${destino.replace(/"/g, '""')}" WITH (FORCE)`);
    console.log(`\n✔ base "${destino}" eliminada`);
  } finally {
    await c.end();
  }
}

let salida = 0;
const problemas = [];

try {
  // ── 1. Restaurar ───────────────────────────────────────────────────────────

  const r = spawnSync(
    binarioDePostgres('pg_restore'),
    ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', urlDestino, elegido.ruta],
    { stdio: 'pipe', encoding: 'utf8' },
  );

  if (r.error !== undefined) {
    console.error(`No se pudo ejecutar pg_restore: ${r.error.message}`);
    console.error('Si los binarios de PostgreSQL no están en el PATH, definí PG_BIN.');
    await limpiar();
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`✘ pg_restore falló (código ${r.status}):`);
    console.error(r.stderr);
    await limpiar();
    process.exit(1);
  }
  console.log('✔ pg_restore terminó sin errores');

  // El rol de la aplicación es del cluster, no del backup: los GRANT se
  // restablecen acá porque se restauró con `--no-privileges` para que el
  // archivo no dependa de qué roles existían el día que se generó.
  const restaurada = new pg.Client({ connectionString: urlDestino });
  await restaurada.connect();
  let tablasRestauradas;
  try {
    await restaurada.query(`GRANT USAGE ON SCHEMA public TO aai_app`);
    await restaurada.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aai_app`,
    );
    await restaurada.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aai_app`);

    tablasRestauradas = await conteos(restaurada);
  } finally {
    await restaurada.end();
  }

  // ── 2. ¿Están los candados? ────────────────────────────────────────────────

  const entorno = { ...process.env, DATABASE_URL: urlDestino };
  const estructura = spawnSync(process.execPath, ['scripts/check-structure.mjs'], {
    cwd: RAIZ,
    env: entorno,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const lineaEstructura = ultimaLineaUtil(estructura, 'audit:estructura');
  if (estructura.status === 0) {
    console.log(`✔ ${lineaEstructura}`);
  } else {
    console.log(`✘ estructura: ${lineaEstructura}`);
    problemas.push('faltan candados en la base restaurada');
    salida = 1;
  }

  // ── 3. ¿Cuadra lo que hay? ─────────────────────────────────────────────────

  const mayor = spawnSync(
    process.execPath,
    ['scripts/verify-ledger.mjs', '--observacional'],
    { cwd: RAIZ, env: entorno, stdio: 'pipe', encoding: 'utf8' },
  );
  const lineaMayor = ultimaLineaUtil(mayor, 'ledger:verify');
  if (mayor.status === 0) {
    console.log(`✔ ${lineaMayor}`);
  } else {
    console.log(`✘ Mayor: ${lineaMayor}`);
    problemas.push('el Mayor de la base restaurada no reconstruye');
    salida = 1;
  }

  // ── 4. ¿Está todo lo que había? ────────────────────────────────────────────
  //
  // La comprobación que las otras dos no hacen. Un backup que perdió filas pasa
  // la estructura (el esquema está entero) y pasa el Mayor (menos asientos
  // también cuadran entre sí). Solo el conteo contra la base viva lo delata.

  const vivaCliente = new pg.Client({ connectionString: DATABASE_URL });
  await vivaCliente.connect();
  let tablasVivas;
  try {
    tablasVivas = await conteos(vivaCliente);
  } finally {
    await vivaCliente.end();
  }

  const diferencias = [];
  let filasComparadas = 0;
  for (const [tabla, n] of tablasVivas) {
    const restaurado = tablasRestauradas.get(tabla);
    filasComparadas += n;
    if (restaurado === undefined) {
      diferencias.push(`${tabla}: falta en la restaurada (viva: ${n})`);
    } else if (restaurado !== n) {
      diferencias.push(`${tabla}: viva ${n}, restaurada ${restaurado}`);
    }
  }
  for (const [tabla] of tablasRestauradas) {
    if (!tablasVivas.has(tabla)) diferencias.push(`${tabla}: sobra en la restaurada`);
  }

  if (diferencias.length > 0) {
    console.log(`✘ ${diferencias.length} diferencia(s) de contenido:`);
    for (const d of diferencias.slice(0, 20)) console.log(`    ${d}`);
    problemas.push('el contenido restaurado no coincide con la base viva');
    salida = 1;
  } else if (filasComparadas === 0) {
    // Cuatro estados, no dos: comparar dos bases vacías y llamarlo verde sería
    // el mismo falso verde que `verify-ledger.mjs` documenta y evita.
    console.log(
      `~ contenido SIN EJERCITAR: las ${tablasVivas.size} tablas coinciden, pero la base viva ` +
        `no tiene ni una fila.\n` +
        `  Este control recién dice algo cuando "${viva}" tenga datos reales.`,
    );
  } else {
    console.log(
      `✔ contenido idéntico: ${tablasVivas.size} tablas, ${filasComparadas} filas comparadas`,
    );
  }
} finally {
  await limpiar();
}

// ── Veredicto ────────────────────────────────────────────────────────────────

console.log('');
if (salida === 0) {
  console.log('El backup es restaurable y su contenido coincide con la base viva.');
  console.log(`Ventana de pérdida al momento de esta prueba: ${antigüedadHoras.toFixed(1)} h.`);
} else {
  console.log('La restauración NO quedó demostrada:');
  for (const p of problemas) console.log(`  · ${p}`);
}
process.exit(salida);

/**
 * El veredicto de un verificador, en una línea.
 *
 * Se busca el renglón que **empieza con el nombre del comando**, que es donde
 * los dos verificadores escriben su conclusión. La primera versión de esto
 * tomaba la última línea no vacía y mostraba `✔ de integración y el modo
 * conductual de audit:invariants.`: el final de un párrafo explicativo que va
 * después del veredicto. Un reporte que cita la línea equivocada es peor que
 * uno que no cita ninguna, porque parece que informó.
 *
 * Si el prefijo no aparece —que es lo que pasa cuando el verificador se cae
 * antes de concluir— se cae a la última línea y después a `stderr`, para que el
 * mensaje de error real llegue a la superficie.
 */
function ultimaLineaUtil(resultado, prefijo) {
  for (const flujo of [resultado.stdout, resultado.stderr]) {
    const lineas = (flujo ?? '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '');
    const veredicto = lineas.find((l) => l.startsWith(prefijo));
    if (veredicto !== undefined) return veredicto;
    const ultima = lineas.at(-1);
    if (ultima !== undefined) return ultima;
  }
  return '(sin salida)';
}

/**
 * Cuántas filas tiene cada tabla del esquema público.
 *
 * Se cuenta de verdad y no se lee `pg_class.reltuples`: esa columna es una
 * estimación que el planificador actualiza cuando se le da la gana, y una
 * estimación no sirve para decidir si un backup está completo.
 */
async function conteos(cliente) {
  const tablas = await cliente.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const salida = new Map();
  for (const { tablename } of tablas.rows) {
    const r = await cliente.query(`SELECT count(*)::int AS n FROM "${tablename.replace(/"/g, '""')}"`);
    salida.set(tablename, r.rows[0].n);
  }
  return salida;
}
