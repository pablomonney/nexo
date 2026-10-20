#!/usr/bin/env node
/**
 * Crea una cuenta de PRUEBA —un estudio con dos empresas y un contador con segundo factor— en la base de pruebas y deja sus credenciales en
 * `var/evaluacion/` (que git ignora).
 *
 *   node scripts/evaluacion-del-asistente/preparar.mjs        # con el servidor (servidor.mjs) ya levantado
 *
 * Los pasos siguientes están en `LEEME.md`: sembrar datos inventados en cada empresa y encender el asistente.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { totp } from '@aai/shared';
import pg from 'pg';
import { BASE, RAIZ, baseDePruebas, opcionesDeCliente } from './comun.mjs';

const salida = join(RAIZ, 'var', 'evaluacion');
mkdirSync(salida, { recursive: true });

const c = new pg.Client(opcionesDeCliente(baseDePruebas()));
await c.connect();
const s = Date.now().toString().slice(-8);
const clave = 'una-contrasena-suficientemente-larga';
const argon = await hash(clave, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const dv = (b) => {
  const p = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const r = 11 - (b.split('').reduce((a, d, i) => a + Number(d) * p[i], 0) % 11);
  return r === 11 ? 0 : r === 10 ? 9 : r;
};
const cuit = (prefijo) => {
  const b = (prefijo + s).slice(0, 10);
  return b + dv(b);
};
const email = `evaluacion-${s}@estudio.test`;
const uid = (await c.query('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, 'Evaluación del asistente', argon])).rows[0].id;
const org = (await c.query('SELECT create_organization($1,$2,$3) AS id', [`Estudio de evaluación ${s}`, cuit('30'), uid])).rows[0].id;
const empresas = [];
for (const [nombre, prefijo] of [['Comercial Norte SA', '27'], ['Servicios del Sur SRL', '23']]) {
  const id = (
    await c.query('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8) AS id', [uid, org, `${nombre} ${s}`, cuit(prefijo), nombre.endsWith('SRL') ? 'SRL' : 'SA', 'AR-C', 'IGJ', '12-31'])
  ).rows[0].id;
  for (const rol of ['CONTADOR', 'ADMINISTRADOR']) {
    await c.query('INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from) VALUES ($1,$2,(SELECT id FROM roles WHERE code = $3), CURRENT_DATE)', [uid, id, rol]);
  }
  empresas.push({ id, nombre: `${nombre} ${s}` });
}
await c.end();

// El segundo factor se da de alta por la API, como lo haría una persona.
const post = async (ruta, cuerpo, token) =>
  (await fetch(BASE + ruta, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(cuerpo ?? {}) })).json();
const token = (await post('/auth/login', { email, password: clave })).token;
const alta = await post('/auth/mfa/setup', {}, token);
await post('/auth/mfa/confirm', { code: totp(alta.secret, Date.now()) }, token);

writeFileSync(join(salida, 'credenciales.json'), JSON.stringify({ email, password: clave, mfa: alta.secret }));
writeFileSync(join(salida, 'cuenta.json'), JSON.stringify({ email, password: clave, mfa: alta.secret, empresas }, null, 2));
console.log(`Cuenta de prueba lista: ${email} · ${empresas.map((e) => e.nombre).join(' | ')}`);
