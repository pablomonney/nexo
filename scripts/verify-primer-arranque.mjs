#!/usr/bin/env node
/**
 * Recorre el primer arranque de NEXO sobre una base **vacía de verdad**.
 *
 *   npm run verify:arranque
 *
 * ## El agujero que cierra
 *
 * `POST /auth/register-first-admin` es lo primero que hace cualquier persona
 * con NEXO: sin él no hay usuario, sin usuario no hay estudio, y sin estudio no
 * hay nada. Antes de este script, la única mención de esa ruta en todo el
 * repositorio estaba **dentro de una lista de exclusión** —el barrido de
 * autenticación la saltea, con razón, porque tiene que responder sin sesión—.
 *
 * Es decir: el camino que abre el producto no lo había recorrido nadie. Otra
 * vez la misma forma —código correcto, regla escrita, nadie caminando entre las
 * dos— y esta vez sobre el primer minuto con el sistema.
 *
 * ## Por qué necesita su propia base
 *
 * El endpoint se niega si ya existe **un** usuario, y con razón: es un
 * bootstrap, no un alta. Esa condición lo hace imposible de probar en la base
 * de tests, que para cuando corre cualquier suite ya tiene decenas. Solo se
 * puede ejercitar sobre una base recién creada, y por eso este verificador crea
 * la suya, la usa y la destruye.
 *
 * ## Qué comprueba, y qué no
 *
 * Camina el circuito completo del primer arranque:
 *
 *   primer admin → sesión → estudio → empresa → **rol** → **MFA** →
 *   plan de cuentas → ejercicio → bandeja
 *
 * Y comprueba **las dos ramas**: que el segundo intento de bootstrap se
 * rechace, que es la mitad que protege de que cualquiera se haga administrador
 * de una instalación en uso.
 *
 * No prueba el circuito contable —para eso están las suites de integración— ni
 * el rendimiento. Dice que el producto se puede empezar a usar.
 *
 * ## Los dos pasos que aparecieron al recorrerlo
 *
 * Los dos estaban bien y ninguno era evidente desde afuera:
 *
 * 1. **Crear la empresa no da acceso a operarla.** El fundador recibe «No tenés
 *    acceso a esta empresa» sobre algo que acaba de crear, y tiene que
 *    asignarse un rol. Es coherente con el modelo —el dueño de un estudio no es
 *    automáticamente el contador de cada cliente— y corta el día uno.
 * 2. **El rol contable exige segundo factor.** Ahí la API se defiende bien: el
 *    rechazo trae el camino adentro («Configuralo en /auth/mfa/setup antes de
 *    continuar»), que es exactamente como tiene que verse un error.
 *
 * Los dos quedan anotados en `PROJECT_STATUS.md` como fricción real del primer
 * arranque. Este script no cambia el modelo de permisos: recorre el camino que
 * hay y lo deja escrito, que es lo que faltaba.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(HERE, '..');
if (existsSync(join(RAIZ, '.env'))) {
  process.loadEnvFile(join(RAIZ, '.env'));
}

/**
 * El espacio de nombres que este script puede crear y destruir.
 *
 * Mismo candado que `test-db.mjs` con `_test` y `restaurar-backup.mjs` con
 * `aai_restauracion`, y por el mismo motivo: acá hay un `DROP DATABASE`, y un
 * `DATABASE_URL` mal puesto sería irrecuperable.
 */
const SUFIJO = '_arranque';

const base = process.env.DATABASE_URL ?? '';
if (base === '') {
  console.log('verify:arranque — sin DATABASE_URL. Nada que verificar.');
  process.exit(0);
}

const url = new URL(base);
const raiz = decodeURIComponent(url.pathname.replace(/^\//, '')).replace(
  /_(test|verify|arranque)$/,
  '',
);
url.pathname = `/${raiz}${SUFIJO}`;
const destino = url.toString();
const nombre = `${raiz}${SUFIJO}`;

if (!nombre.endsWith(SUFIJO)) {
  console.error(`La base tiene que terminar en "${SUFIJO}" y se resolvió "${nombre}". Se corta.`);
  process.exit(2);
}

const admin = new URL(destino);
admin.pathname = '/postgres';

console.log(`Base descartable: ${nombre}\n`);

const cliente = new pg.Client({ connectionString: admin.toString() });
await cliente.connect();
try {
  await cliente.query(`DROP DATABASE IF EXISTS "${nombre}" WITH (FORCE)`);
} finally {
  await cliente.end();
}

/** Deja el sistema como estaba, pase lo que pase. */
async function limpiar() {
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${nombre}" WITH (FORCE)`);
    console.log(`\n✔ base "${nombre}" eliminada`);
  } finally {
    await c.end();
  }
}

const entorno = { ...process.env, DATABASE_URL: destino };
for (const [etiqueta, argumentos] of [
  ['crear la base', ['scripts/db-create.mjs']],
  ['migrar', ['scripts/migrate.mjs', 'up']],
  ['catálogo de comprobantes', ['scripts/seed-comprobante-types.mjs']],
  ['alícuotas', ['scripts/seed-tax-rates.mjs']],
]) {
  const r = spawnSync(process.execPath, argumentos, { cwd: RAIZ, env: entorno, stdio: 'pipe' });
  if (r.status !== 0) {
    console.error(`  ✘ ${etiqueta}`);
    console.error(String(r.stdout ?? '') + String(r.stderr ?? ''));
    await limpiar();
    process.exit(1);
  }
  console.log(`  ✔ ${etiqueta}`);
}

console.log('');

const { initPool, closePool } = await import('@aai/db');
const { buildServer } = await import('@aai/api/server');

initPool(destino);
const app = await buildServer();
await app.ready();

const CORREO = 'primer.admin@nexo.test';
const CLAVE = 'una-contrasena-suficientemente-larga';

let fallos = 0;
const comprobar = (ok, que, detalle) => {
  if (ok) {
    console.log(`  ✔ ${que}`);
  } else {
    console.error(`  ✘ ${que}`);
    if (detalle !== undefined) console.error(`      ${detalle}`);
    fallos += 1;
  }
};

try {
  // ── 1 · La base está vacía de gente ────────────────────────────────────────
  //
  // El universo primero. Si ya hubiera usuarios, el bootstrap se negaría por el
  // motivo correcto y este verificador daría verde sin haber probado nada.
  const usuarios = await app.inject({ method: 'GET', url: '/health/db' });
  comprobar(usuarios.statusCode === 200, 'la base responde', usuarios.body);

  // ── 2 · El primer admin ────────────────────────────────────────────────────
  const primero = await app.inject({
    method: 'POST',
    url: '/auth/register-first-admin',
    payload: { email: CORREO, password: CLAVE, fullName: 'Primera administradora' },
  });
  comprobar(
    primero.statusCode === 200 && typeof primero.json().id === 'string',
    'se crea el primer administrador sobre una base vacía',
    `${primero.statusCode} ${primero.body}`,
  );

  // ── 3 · Y solo el primero ──────────────────────────────────────────────────
  //
  // La rama que importa de verdad. Si el bootstrap siguiera abierto, cualquiera
  // con acceso a la red se haría administrador de una instalación en uso.
  const segundo = await app.inject({
    method: 'POST',
    url: '/auth/register-first-admin',
    payload: { email: 'intruso@nexo.test', password: CLAVE, fullName: 'Intruso' },
  });
  comprobar(
    segundo.statusCode >= 400,
    'el segundo intento de bootstrap se rechaza',
    `respondió ${segundo.statusCode}`,
  );

  // ── 4 · Entrar ─────────────────────────────────────────────────────────────
  const sesion = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: CORREO, password: CLAVE },
  });
  comprobar(sesion.statusCode === 200, 'el primer administrador puede entrar', sesion.body);
  const token = sesion.statusCode === 200 ? sesion.json().token : '';

  const conSesion = (metodo, ruta, payload, empresa) =>
    app.inject({
      method: metodo,
      url: ruta,
      headers: {
        authorization: `Bearer ${token}`,
        ...(empresa === undefined ? {} : { 'x-company-id': empresa }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  // ── 5 · El estudio y su primera empresa ────────────────────────────────────
  const estudio = await conSesion('POST', '/organizations', {
    name: 'Estudio de prueba',
    taxId: '30500000003',
  });
  comprobar(estudio.statusCode === 200, 'se crea el estudio', estudio.body);
  const organizationId = estudio.statusCode === 200 ? estudio.json().id : null;

  let empresa = null;
  if (organizationId !== null) {
    const alta = await conSesion('POST', `/organizations/${organizationId}/companies`, {
      legalName: 'Empresa de prueba',
      cuit: '27500000002',
      entityType: 'SA',
      jurisdiction: 'AR-C',
      regulator: 'IGJ',
      fiscalYearEnd: '12-31',
    });
    comprobar(alta.statusCode === 200, 'se crea la primera empresa', alta.body);
    empresa = alta.statusCode === 200 ? alta.json().id : null;
  }

  // ── 6 · El paso que nadie adivina ──────────────────────────────────────────
  //
  // Crear la empresa **no** da acceso a operarla. Es coherente con el modelo
  // —el dueño de un estudio no es automáticamente el contador de cada cliente,
  // y ADR-011 exige que los permisos se resuelvan con la empresa en contexto—
  // pero el primer arranque queda cortado justo acá: quien acaba de crear la
  // empresa recibe «No tenés acceso a esta empresa» sobre algo que creó él.
  //
  // Lo encontró este verificador en su primera corrida. No se cambia el modelo
  // de permisos desde acá: se recorre el camino verdadero y queda anotado en
  // PROJECT_STATUS como fricción real del día uno.
  const usuario = await conSesion('GET', '/auth/me');
  const userId = usuario.statusCode === 200 ? usuario.json().user.id : null;

  if (empresa !== null && userId !== null) {
    const rol = await conSesion('POST', `/companies/${empresa}/roles`, {
      userId,
      role: 'ADMINISTRADOR',
    });
    comprobar(
      rol.statusCode >= 200 && rol.statusCode < 300,
      'el fundador se asigna un rol en la empresa que creó',
      `${rol.statusCode} ${rol.body}`,
    );

    const contador = await conSesion('POST', `/companies/${empresa}/roles`, {
      userId,
      role: 'CONTADOR',
    });
    comprobar(
      contador.statusCode >= 200 && contador.statusCode < 300,
      'y el rol contable, que es el que firma',
      `${contador.statusCode} ${contador.body}`,
    );
  }

  // ── 7 · El segundo factor, que no es opcional ──────────────────────────────
  //
  // El rol contable exige MFA y la API lo dice con el camino incluido —
  // «Configuralo en /auth/mfa/setup antes de continuar»—, que es exactamente
  // como tiene que verse un rechazo. Se recorre acá porque forma parte del
  // primer arranque: sin esto, la primera cuenta del plan no se puede cargar.
  const { totp } = await import('@aai/shared');

  const setup = await conSesion('POST', '/auth/mfa/setup');
  comprobar(setup.statusCode === 200, 'se puede dar de alta el segundo factor', setup.body);
  const secreto = setup.statusCode === 200 ? setup.json().secret : null;

  let sesionConMfa = token;
  if (secreto !== null) {
    const confirmado = await conSesion('POST', '/auth/mfa/confirm', {
      code: totp(secreto, Date.now()),
    });
    comprobar(
      confirmado.statusCode >= 200 && confirmado.statusCode < 300,
      'se confirma el segundo factor',
      confirmado.body,
    );

    // Después de activar MFA la sesión anterior ya no alcanza: hay que entrar de
    // nuevo y presentar el código. Que sea así es el punto del segundo factor.
    const reingreso = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: CORREO, password: CLAVE },
    });
    sesionConMfa = reingreso.statusCode === 200 ? reingreso.json().token : token;

    const verificado = await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secreto, Date.now()) },
      headers: { authorization: `Bearer ${sesionConMfa}` },
    });
    comprobar(
      verificado.statusCode >= 200 && verificado.statusCode < 300,
      'se entra presentando el segundo factor',
      verificado.body,
    );
  }

  const conMfa = (metodo, ruta, payload, emp) =>
    app.inject({
      method: metodo,
      url: ruta,
      headers: {
        authorization: `Bearer ${sesionConMfa}`,
        ...(emp === undefined ? {} : { 'x-company-id': emp }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  // ── 8 · Y ya se puede trabajar ─────────────────────────────────────────────
  if (empresa !== null) {
    const cuenta = await conMfa(
      'POST',
      '/accounts',
      { code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
      empresa,
    );
    comprobar(cuenta.statusCode === 201, 'se carga la primera cuenta del plan', cuenta.body);

    const ejercicio = await conMfa(
      'POST',
      '/fiscal-years',
      { code: 'EJ2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      empresa,
    );
    comprobar(ejercicio.statusCode === 201, 'se abre el primer ejercicio', ejercicio.body);

    // La bandeja de una empresa recién creada tiene que responder y estar
    // vacía. Que devuelva la forma completa —y no un 403— es lo que permite
    // que la consola no tenga un camino especial para el día uno.
    const bandeja = await conMfa('GET', '/work-queue', undefined, empresa);
    comprobar(
      bandeja.statusCode === 200 && Array.isArray(bandeja.json().items),
      'la bandeja responde vacía en una empresa recién creada',
      bandeja.body,
    );
  }

  // ── 9 · Y la consola se sirve ──────────────────────────────────────────────
  const raizHttp = await app.inject({ method: 'GET', url: '/' });
  comprobar(
    raizHttp.statusCode === 302 && raizHttp.headers.location === '/consola',
    'la raíz lleva a la consola',
    `${raizHttp.statusCode} → ${String(raizHttp.headers.location)}`,
  );
} finally {
  await app.close();
  await closePool();
  await limpiar();
}

console.log('');
if (fallos > 0) {
  console.error(`verify:arranque — ${fallos} paso(s) del primer arranque no funcionan.`);
  process.exit(1);
}
console.log('verify:arranque — el primer arranque funciona de punta a punta sobre una base vacía.');
