#!/usr/bin/env node
/**
 * Crea un usuario y una empresa VACÍA de prueba en la API aislada, para sembrar datos y recorrer la consola.
 *
 *   node scripts/servir-contra-pruebas.mjs                              # terminal 1 (puerto 3002, base *_test)
 *   node scripts/provisionar-usuario-visual.mjs <salida.json>           # terminal 2
 *
 * Escribe `{ email, password, mfa, cuit }` en `<salida.json>`, que tiene que quedar FUERA del repositorio: son
 * credenciales de una cuenta de prueba, pero credenciales. **No imprime la contraseña ni el secreto del segundo factor.**
 *
 * Todo entra por la API pública (alta autoservicio → verificación del correo → empresa → segundo factor). Lo único que
 * se lee de la base es el mensaje de verificación que la propia API dejó en `email_outbox` (el correo está en «ninguno»:
 * no sale nada al exterior), y sólo contra una base local cuyo nombre termina en `_test`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASE = 'http://localhost:3002';

const salida = process.argv[2];
if (!salida) {
  console.error('Uso: node scripts/provisionar-usuario-visual.mjs <salida.json>   (fuera del repositorio)');
  process.exit(2);
}
if (resolve(salida).startsWith(RAIZ)) {
  console.error('Me niego: el archivo de credenciales tiene que quedar FUERA del repositorio.');
  process.exit(2);
}

// ── Compuerta: la base de destino es local y de pruebas ──────────────────────────────────────────────────────
const env = readFileSync(join(RAIZ, '.env'), 'utf8').match(/^DATABASE_URL=(.*)$/mu)?.[1]?.trim();
if (!env) {
  console.error('No encuentro DATABASE_URL en .env');
  process.exit(2);
}
const destino = new URL(env.replace(/\/([^/?]+)(\?|$)/u, '/$1_test$2'));
if (!['localhost', '127.0.0.1'].includes(destino.hostname) || !destino.pathname.endsWith('_test')) {
  console.error(`Me niego: la base de destino (${destino.pathname}) no es local y de pruebas.`);
  process.exit(2);
}

let cookie = '';
async function pedir(metodo, ruta, cuerpo) {
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(cookie ? { cookie } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const nuevas = r.headers.getSetCookie?.() ?? [];
  if (nuevas.length > 0) {
    const jar = new Map(cookie.split('; ').filter(Boolean).map((p) => [p.split('=')[0], p]));
    for (const c of nuevas) jar.set(c.split('=')[0], c.split(';')[0]);
    cookie = [...jar.values()].join('; ');
  }
  const texto = await r.text();
  let datos = {};
  try {
    datos = JSON.parse(texto);
  } catch {
    /* sin cuerpo */
  }
  return { status: r.status, datos };
}

function totp(secretoBase32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretoBase32.replace(/=+$/u, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const clave = Buffer.from(bits.match(/.{8}/gu).filter((b) => b.length === 8).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', clave).update(contador).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

function cuitInventado() {
  const base = `30${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = [...base].reduce((a, d, i) => a + Number(d) * pesos[i], 0);
  const r = 11 - (suma % 11);
  return base + (r === 11 ? 0 : r === 10 ? 9 : r);
}

const salud = await pedir('GET', '/health/db');
if (salud.datos.status !== 'ok') {
  console.error('La API aislada no responde en el puerto 3002: levantarla con scripts/servir-contra-pruebas.mjs');
  process.exit(1);
}

const sufijo = Date.now().toString(36);
const email = `visual-${sufijo}@prueba.test`;
const password = `${randomBytes(18).toString('base64url')}aA1`;
const cuit = cuitInventado();

console.log(`base de destino: ${destino.pathname.slice(1)} en ${destino.hostname}`);
console.log('signup:', (await pedir('POST', '/auth/signup', { email, password, fullName: 'Usuario de verificación visual' })).status);

const db = new pg.Client({ connectionString: destino.toString() });
await db.connect();
try {
  const bandeja = await db.query(
    `SELECT cuerpo FROM email_outbox WHERE destinatario = $1 AND tipo = 'VERIFICACION_DE_ALTA' ORDER BY creado_el DESC LIMIT 1`,
    [email],
  );
  const token = /\n\n([A-Za-z0-9_-]{20,})\n/u.exec(bandeja.rows[0]?.cuerpo ?? '')?.[1];
  if (!token) throw new Error('no encuentro el mensaje de verificación en email_outbox');
  console.log('verificar-correo:', (await pedir('POST', '/auth/verificar-correo', { token })).status);
} finally {
  await db.end();
}

const login = await pedir('POST', '/auth/login', { email, password });
console.log('login:', login.status);
const onboarding = await pedir('POST', '/onboarding/empresa', {
  estudio: 'Estudio de prueba visual',
  razonSocial: 'Empresa de prueba visual SRL',
  cuit,
  tipoEntidad: 'SRL',
  jurisdiccion: 'AR-C',
  organismo: 'IGJ',
  cierreEjercicio: '12-31',
  plan: 'COMPLETO',
});
console.log('empresa:', onboarding.status);

const setup = await pedir('POST', '/auth/mfa/setup', {});
const mfa = setup.datos.secret;
if (!mfa) throw new Error(`no pude configurar el segundo factor (${setup.status}): ${JSON.stringify(setup.datos).slice(0, 200)}`);
console.log('mfa/confirm:', (await pedir('POST', '/auth/mfa/confirm', { code: totp(mfa) })).status);

writeFileSync(resolve(salida), JSON.stringify({ email, password, mfa, cuit }));
console.log(`credenciales guardadas en ${resolve(salida)} (no se imprimen). correo: ${email}`);
