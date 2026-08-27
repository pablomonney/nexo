#!/usr/bin/env node
/**
 * Prepara la base de datos **de los tests**, que no es la de desarrollo.
 *
 *   npm run test:db          — la crea si falta, migra y siembra
 *   npm run test:db -- --reset  — la borra y la rehace desde cero
 *
 * ## Por qué existe
 *
 * Hasta el 2026-08-27 las suites de integración escribían en la misma base que
 * usaba el desarrollo, y **no podían limpiar**: los triggers `forbid_delete`
 * están puestos justamente para que nada se borre. El resultado medido ese día:
 * de 143 filas en `norms`, 126 se llamaban "Norma de prueba"; las 84 de
 * `accounting_rules` eran fixtures, sin una sola regla real. El registro
 * normativo —la tabla cuyo propósito entero es la trazabilidad a una fuente
 * oficial— era en un 88% ficción de tests.
 *
 * No era un problema de corrección: `resolverRegla()` busca por `ruleKey` y no
 * barre la tabla, y el intérprete de condiciones **lanza** ante un `conditions`
 * vacío en vez de dar por cierto. Los dos diseños fail-loud contuvieron el daño.
 * Pero cualquier lectura, reporte o conteo sobre esas tablas daba números falsos.
 *
 * ## La decisión: base aparte, no rollback
 *
 * La solución obvia —envolver cada test en `BEGIN`/`ROLLBACK`— **sería un
 * retroceso**. Este esquema usa `CONSTRAINT TRIGGER ... DEFERRABLE` para el
 * candado `Debe = Haber`, y esos triggers **solo disparan en el `COMMIT`**. Un
 * test que nunca confirma no ejercita el candado más importante del sistema, y
 * lo peor es que seguiría pasando: se volvería verde sin probar nada.
 *
 * Entonces los tests confirman de verdad, contra una base que es de ellos.
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
 * La URL de la base de tests.
 *
 * Se puede fijar con `TEST_DATABASE_URL`. Si no está, se deriva de
 * `DATABASE_URL` agregando el sufijo `_test`, que es lo bastante explícito como
 * para que nadie confunda una con otra al leer un log.
 */
export function urlDePruebas(env = process.env) {
  if (env['TEST_DATABASE_URL'] !== undefined && env['TEST_DATABASE_URL'] !== '') {
    return env['TEST_DATABASE_URL'];
  }
  const base = env['DATABASE_URL'];
  if (base === undefined || base === '') return '';

  const url = new URL(base);
  const nombre = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (nombre === '') return '';
  // Si ya termina en _test no se le agrega otro: correr el script dos veces no
  // debería producir `aai_test_test`.
  url.pathname = `/${nombre.endsWith('_test') ? nombre : `${nombre}_test`}`;
  return url.toString();
}

// El resto solo corre cuando se invoca como script, no al importarlo.
//
// Se comparan rutas resueltas y no cadenas: `import.meta.url` percent-codifica
// —el directorio de este proyecto tiene un espacio y aparece como `%20`—, así
// que un `endsWith` contra `process.argv[1]` no coincide nunca y el script se
// vuelve un no-op silencioso.
const invocadoDirectamente =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invocadoDirectamente) {
  const destino = urlDePruebas();
  if (destino === '') {
    console.error('Falta DATABASE_URL (o TEST_DATABASE_URL). Copiá .env.example a .env.');
    process.exit(2);
  }

  const nombre = decodeURIComponent(new URL(destino).pathname.replace(/^\//, ''));

  // Candado: este script borra bases. Que el nombre termine en `_test` no es una
  // convención, es la condición para poder tocarla. Un `--reset` apuntando por
  // error a la base de desarrollo sería irrecuperable.
  if (!nombre.endsWith('_test')) {
    console.error(`La base de tests debe llamarse algo terminado en "_test", y se resolvió "${nombre}".`);
    console.error('Se corta: este script tiene permiso para borrar, y solo sobre bases de prueba.');
    process.exit(2);
  }

  console.log(`Base de tests: ${nombre}`);

  if (process.argv.includes('--reset')) {
    const admin = new URL(destino);
    admin.pathname = '/postgres';
    const cliente = new pg.Client({ connectionString: admin.toString() });
    await cliente.connect();
    try {
      // `WITH (FORCE)` cierra las conexiones abiertas: sin eso, una sesión
      // olvidada de un test anterior impide el DROP y el mensaje no lo explica.
      await cliente.query(`DROP DATABASE IF EXISTS ${JSON.stringify(nombre).replace(/"/g, '"')} WITH (FORCE)`);
      console.log('  base anterior eliminada');
    } finally {
      await cliente.end();
    }
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
    // Las reglas entran como DRAFT, igual que en desarrollo. Sin esto, un
    // `--reset` dejaría la base sin la regla y la suite que la ejercita fallaría
    // por un motivo que no tiene nada que ver con lo que prueba.
    ['reglas contables (DRAFT)', ['scripts/cargar-reglas-contables.mjs', '--aplicar']],
  ]) {
    const r = spawnSync(process.execPath, argumentos, { cwd: RAIZ, env: entorno, stdio: 'pipe' });
    if (r.status !== 0) {
      console.error(`  ✘ ${etiqueta}`);
      console.error(String(r.stdout ?? '') + String(r.stderr ?? ''));
      process.exit(1);
    }
    console.log(`  ✔ ${etiqueta}`);
  }

  // La secuencia de la que salen los identificadores de fixture. Vive acá y no
  // en las migraciones porque es infraestructura de tests: el esquema de
  // producción no tiene por qué cargar con ella.
  const cliente = new pg.Client({ connectionString: destino });
  await cliente.connect();
  try {
    await cliente.query('CREATE SEQUENCE IF NOT EXISTS fixture_ids START 10000000 MAXVALUE 99999999 CYCLE');
    await cliente.query('GRANT USAGE ON SEQUENCE fixture_ids TO aai_app');
    console.log('  ✔ secuencia fixture_ids');
  } finally {
    await cliente.end();
  }

  console.log('\nListo. Las suites de integración van a usar esta base y no la de desarrollo.');
}
