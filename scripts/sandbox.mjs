#!/usr/bin/env node
/**
 * Sandbox de simulación (§34).
 *
 *   npm run sandbox:create   crea la base aislada, le aplica LAS MISMAS migraciones y la marca
 *   npm run sandbox:run      corre el escenario, previa prueba de aislamiento
 *   npm run sandbox:status   dice qué hay y si probaría ser un sandbox
 *
 * ## Por qué reejecuta el runner de producción en vez de tener el suyo
 *
 * `sandbox:create` invoca `scripts/db-create.mjs` y `scripts/migrate.mjs` con
 * `DATABASE_URL` apuntando al sandbox. No hay un segundo juego de migraciones ni
 * una versión simplificada del esquema.
 *
 * Un sandbox con esquema propio deriva. Al principio por poco —una constraint que
 * molestaba en una demo, un trigger que hacía lento el seed— y después lo
 * suficiente como para que "anduvo en el sandbox" deje de significar algo. La
 * única forma de que la simulación prediga producción es que corra sobre lo
 * mismo.
 *
 * ## Dónde está el candado
 *
 * En `@aai/sandbox`, y pregunta al revés de lo intuitivo: no comprueba que el
 * destino no sea producción, comprueba que **sí** sea un sandbox. Ver
 * `packages/sandbox/src/aislamiento.ts`.
 *
 * `create` es el único comando que legítimamente toca una base sin marca —es el
 * que la pone— así que tiene su propia guarda: se niega si la base ya existe, ya
 * tiene tablas y **no** está marcada. Esa combinación es exactamente el aspecto
 * que tiene una base de producción.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  PREFIJO_DE_BASE,
  SELLO_DEL_MARCADOR,
  explicarRechazo,
  simular,
  verificarAislamiento,
} from '@aai/sandbox';
import { escenarioDeDemostracion } from './sandbox-escenario.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

const SANDBOX_URL = process.env.SANDBOX_DATABASE_URL ?? '';
const PRODUCCION_URL = process.env.DATABASE_URL ?? '';

if (SANDBOX_URL === '') {
  console.error('Falta SANDBOX_DATABASE_URL.');
  console.error('');
  console.error('Es una variable aparte de DATABASE_URL a propósito. Un sandbox que se configura');
  console.error(`cambiando la misma variable se convierte en producción con un olvido. La base tiene`);
  console.error(`que llamarse "${PREFIJO_DE_BASE}algo", por ejemplo:`);
  console.error('');
  console.error('  SANDBOX_DATABASE_URL=postgres://usuario:clave@localhost:5432/sandbox_aai');
  process.exit(2);
}

const nombreDeBase = (url) => decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

const BASE_SANDBOX = nombreDeBase(SANDBOX_URL);
const BASE_PRODUCCION = PRODUCCION_URL === '' ? null : nombreDeBase(PRODUCCION_URL);

// ---------------------------------------------------------------------------
// Observación del destino
// ---------------------------------------------------------------------------

/**
 * Lee la marca. Cualquier error se traduce a "no hay marca".
 *
 * La tabla que no existe, la base que no acepta la conexión y el permiso
 * denegado significan lo mismo para este control: **no hay prueba**. Distinguirlos
 * acá sería abrir la puerta a un `catch` que decida que un caso es "benigno".
 */
async function huellaDelDestino() {
  let tieneMarca = false;
  let sello = null;

  const client = new pg.Client({ connectionString: SANDBOX_URL });
  try {
    await client.connect();
    const result = await client.query('SELECT sello FROM sandbox_marker LIMIT 1');
    if (result.rows.length > 0) {
      tieneMarca = true;
      sello = result.rows[0].sello ?? null;
    }
  } catch {
    tieneMarca = false;
  } finally {
    await client.end().catch(() => {});
  }

  return {
    nombreDeBase: BASE_SANDBOX,
    urlDestino: SANDBOX_URL,
    urlDeProduccion: PRODUCCION_URL === '' ? null : PRODUCCION_URL,
    nombreDeBaseDeProduccion: BASE_PRODUCCION,
    tieneMarcaDeSandbox: tieneMarca,
    selloDelMarcador: sello,
  };
}

/** ¿La base existe y ya tiene esquema? Es lo que `create` necesita saber. */
async function estadoPrevio() {
  const client = new pg.Client({ connectionString: SANDBOX_URL });
  try {
    await client.connect();
  } catch {
    return { existe: false, conTablas: false };
  }
  try {
    const tablas = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    return { existe: true, conTablas: (tablas.rows[0]?.n ?? 0) > 0 };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Corre un script del propio repositorio con `DATABASE_URL` apuntando al sandbox.
 *
 * La sustitución de la variable es local al proceso hijo: el entorno de esta
 * terminal no queda modificado, así que un comando posterior no hereda por
 * accidente el destino de simulación.
 */
function correr(script, args = []) {
  const resultado = spawnSync(process.execPath, [join(AQUI, script), ...args], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: SANDBOX_URL },
  });
  if (resultado.status !== 0) {
    throw new Error(`${script} terminó con código ${resultado.status}`);
  }
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function crear() {
  if (!BASE_SANDBOX.startsWith(PREFIJO_DE_BASE)) {
    console.error(`La base se llama "${BASE_SANDBOX}" y tiene que empezar con "${PREFIJO_DE_BASE}".`);
    process.exit(1);
  }
  if (BASE_PRODUCCION !== null && BASE_SANDBOX === BASE_PRODUCCION) {
    console.error(`SANDBOX_DATABASE_URL y DATABASE_URL apuntan a la misma base ("${BASE_SANDBOX}").`);
    process.exit(1);
  }

  const previo = await estadoPrevio();
  if (previo.conTablas) {
    const huella = await huellaDelDestino();
    if (!huella.tieneMarcaDeSandbox) {
      // Base que existe, tiene esquema y no está marcada. Es exactamente el
      // aspecto de una base de producción, y crear el sandbox encima la
      // marcaría — es decir, la volvería aceptable para escribir simulaciones.
      console.error(`La base "${BASE_SANDBOX}" ya tiene tablas y no está marcada como sandbox.`);
      console.error('');
      console.error('No se la marca. Una base con esquema y sin marca es indistinguible de');
      console.error('producción, y ponerle la marca ahora sería fabricar la prueba que este');
      console.error('control existe para exigir. Borrala a mano si de verdad es descartable.');
      process.exit(1);
    }
    console.log(`La base "${BASE_SANDBOX}" ya está marcada. Se aplican las migraciones pendientes.`);
  }

  correr('db-create.mjs');
  correr('migrate.mjs', ['up']);

  // La marca va DESPUÉS de las migraciones: si alguna falla, la base queda sin
  // marca y por lo tanto inutilizable para simular. Es el orden correcto — un
  // sandbox a medio migrar que igual acepta simulaciones miente sobre producción.
  const client = new pg.Client({ connectionString: SANDBOX_URL });
  await client.connect();
  try {
    const yaMarcada = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sandbox_marker'`,
    );

    if (yaMarcada.rows.length === 0) {
      const sql = await readFile(join(RAIZ, 'infrastructure', 'db', 'sandbox', '0001_marca_de_sandbox.sql'), 'utf8');
      await client.query(sql);
    }

    const tope = await client.query(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1',
    );

    await client.query(
      `INSERT INTO sandbox_marker (sello, migracion_tope, creado_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [SELLO_DEL_MARCADOR, tope.rows[0]?.name ?? '(ninguna)', process.env.USERNAME ?? process.env.USER ?? 'desconocido'],
    );

    console.log('');
    console.log(`Sandbox listo: ${BASE_SANDBOX} (hasta ${tope.rows[0]?.name ?? '?'}).`);
    console.log('Mismas migraciones que producción, más la marca que ninguna migración crea.');
  } finally {
    await client.end();
  }
}

async function estado() {
  const huella = await huellaDelDestino();
  const aislamiento = verificarAislamiento(huella);

  console.log(`Destino: ${BASE_SANDBOX}`);
  console.log(`Producción declarada: ${BASE_PRODUCCION ?? '(ninguna)'}`);
  console.log('');

  if (aislamiento.aislado) {
    console.log('✓ El destino prueba ser un sandbox. `npm run sandbox:run` puede correr.');
    return 0;
  }

  console.log(explicarRechazo(aislamiento));
  return 1;
}

async function ejecutar() {
  const aislamiento = verificarAislamiento(await huellaDelDestino());

  if (!aislamiento.aislado) {
    console.error(explicarRechazo(aislamiento));
    return 1;
  }

  const resultado = simular(escenarioDeDemostracion(), aislamiento);

  console.log(resultado.sello);
  console.log('');
  console.log(`Escenario: ${resultado.escenario}`);
  console.log(`Base:      ${resultado.base}`);
  console.log('');

  for (const paso of resultado.pasos) {
    console.log(`${paso.sinObservaciones ? '✓' : '✘'} ${paso.paso} — ${paso.titulo}`);
    for (const observacion of paso.observaciones) console.log(`    ${observacion}`);
  }

  console.log('');
  console.log(resultado.resumen);
  return 0;
}

const comando = process.argv[2] ?? 'run';
try {
  if (comando === 'create') {
    await crear();
  } else if (comando === 'status') {
    process.exitCode = await estado();
  } else if (comando === 'run') {
    process.exitCode = await ejecutar();
  } else {
    console.error(`Comando desconocido: ${comando}. Usá create, run o status.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
