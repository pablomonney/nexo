#!/usr/bin/env node
/**
 * La base de **verificación**: ni la de desarrollo ni la de tests.
 *
 *   npm run verify:db     — la rehace desde cero, migra y siembra
 *
 * ## Por qué hace falta una tercera
 *
 * El 2026-08-28 la auditoría del cierre encontró que `audit:invariants` corría
 * contra la base de desarrollo. Después de un `db:reset` esa base está vacía, así
 * que los catorce invariantes daban VACUO y `verify` terminaba en 0 igual. El
 * gate estaba ciego y decía que sí.
 *
 * La causa exacta no es un descuido de este script sino un efecto de segundo
 * orden: hasta el 2026-08-27 los tests de integración escribían en la base de
 * desarrollo, y el checker veía *de casualidad* los datos que ellos dejaban.
 * Aislar la base de tests —una corrección correcta y necesaria— le sacó al gate
 * los únicos datos que estaba mirando, sin que nada lo dijera.
 *
 * Las tres bases, y por qué no alcanzan dos:
 *
 *   `aai`         desarrollo. Tiene lo que el desarrollador puso. `verify` no
 *                 la toca: verificar contra ella produce efectos colaterales y
 *                 resultados que dependen de quién corre el comando.
 *   `aai_test`    los tests de integración. Determinística por suite, pero su
 *                 contenido depende de qué suites corrieron y en qué orden.
 *   `aai_verify`  esta. Se destruye y se rehace en cada corrida, se siembra con
 *                 fixtures determinísticos y se verifica sobre ella. Nada de lo
 *                 que hay adentro depende de nadie.
 *
 * ## Por qué destruir y rehacer, y no envolver en una transacción
 *
 * Mismo argumento que en `test-db.mjs`, y acá pesa más: el candado `Debe =
 * Haber` es un `CONSTRAINT TRIGGER ... DEFERRABLE` que **solo dispara en el
 * COMMIT**. Un fixture que nunca confirma no ejercita el candado más importante
 * del sistema, y lo peor es que el gate seguiría dando verde. Los fixtures
 * confirman de verdad; el aislamiento lo da la base, no el rollback.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(HERE, '..');
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

/**
 * URL de la base de verificación.
 *
 * Se puede fijar con `VERIFY_DATABASE_URL`; si no, se deriva de `DATABASE_URL`
 * con el sufijo `_verify`, que es lo bastante explícito como para que nadie la
 * confunda al leer un log.
 */
export function urlDeVerificacion(env = process.env) {
  if (env['VERIFY_DATABASE_URL'] !== undefined && env['VERIFY_DATABASE_URL'] !== '') {
    return env['VERIFY_DATABASE_URL'];
  }
  const base = env['DATABASE_URL'];
  if (base === undefined || base === '') return '';

  const url = new URL(base);
  const nombre = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (nombre === '') return '';
  // Se parte del nombre sin sufijos para que `DATABASE_URL=...aai_test` no
  // produzca `aai_test_verify`.
  const raiz = nombre.replace(/_(test|verify)$/, '');
  url.pathname = `/${raiz}_verify`;
  return url.toString();
}

export function nombreDe(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * Destruye la base de verificación, la vuelve a crear, migra y siembra.
 *
 * El candado del nombre no es una convención: es la condición para poder tocar
 * la base. Este script tiene permiso para hacer `DROP DATABASE`, y un
 * `VERIFY_DATABASE_URL` mal puesto apuntando a desarrollo sería irrecuperable.
 */
export async function prepararBaseDeVerificacion({ silencioso = false } = {}) {
  const destino = urlDeVerificacion();
  if (destino === '') {
    throw new Error('Falta DATABASE_URL (o VERIFY_DATABASE_URL).');
  }

  const nombre = nombreDe(destino);
  if (!nombre.endsWith('_verify')) {
    throw new Error(
      `La base de verificación debe terminar en "_verify", y se resolvió "${nombre}". ` +
        'Se corta: este script borra bases, y solo puede hacerlo sobre las suyas.',
    );
  }

  const decir = (texto) => {
    if (!silencioso) console.log(texto);
  };
  decir(`Base de verificación: ${nombre}`);

  const admin = new URL(destino);
  admin.pathname = '/postgres';
  const cliente = new pg.Client({ connectionString: admin.toString() });
  await cliente.connect();
  try {
    // `WITH (FORCE)` cierra las conexiones abiertas: sin eso, una sesión
    // olvidada de una corrida anterior impide el DROP y el mensaje no lo explica.
    await cliente.query(`DROP DATABASE IF EXISTS "${nombre}" WITH (FORCE)`);
  } finally {
    await cliente.end();
  }

  const entorno = { ...process.env, DATABASE_URL: destino };
  for (const [etiqueta, argumentos] of [
    ['crear', ['scripts/db-create.mjs']],
    ['migrar', ['scripts/migrate.mjs', 'up']],
    ['catálogo de comprobantes', ['scripts/seed-comprobante-types.mjs']],
    ['prompts', ['scripts/register-prompts.mjs']],
    ['normas', ['scripts/seed-norms.mjs']],
    ['alícuotas', ['scripts/seed-tax-rates.mjs']],
    ['plantillas de estados', ['scripts/seed-statement-templates.mjs']],
    // Como en desarrollo: DRAFT. Sembrarlas ACTIVE para poder ejercitar A-4,
    // A-8 y A-9 sería falsear el estado del sistema para que el tablero quede
    // verde, que es exactamente lo contrario de lo que este gate existe para
    // impedir. Esos tres quedan declarados VACUO_PERMITIDO con su motivo.
    ['reglas contables (DRAFT)', ['scripts/cargar-reglas-contables.mjs', '--aplicar']],
  ]) {
    const r = spawnSync(process.execPath, argumentos, { cwd: RAIZ, env: entorno, stdio: 'pipe' });
    if (r.status !== 0) {
      throw new Error(
        `Falló la preparación de la base de verificación en "${etiqueta}":\n` +
          String(r.stdout ?? '') +
          String(r.stderr ?? ''),
      );
    }
    decir(`  ✔ ${etiqueta}`);
  }

  return destino;
}

const invocadoDirectamente =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invocadoDirectamente) {
  try {
    await prepararBaseDeVerificacion();
    console.log('\nListo. La base de verificación está vacía de datos y lista para los fixtures.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
