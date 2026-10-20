#!/usr/bin/env node
/**
 * Le hace preguntas de verdad al asistente REAL y muestra, de cada una, qué herramientas usó, cuánto gastó y qué contestó.
 *
 *   node scripts/evaluacion-del-asistente/evaluar.mjs                             # las de preguntas.json
 *   node scripts/evaluacion-del-asistente/evaluar.mjs "¿Cuánto vendí este mes?"   # las que se pasen
 *
 * No juzga: lo que se mira es si contestó bien lo que tiene, si se negó a lo que no debe y si la redacción es profesional. El resultado queda en
 * `var/evaluacion/ultima-evaluacion.json`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { totp } from '@aai/shared';
import { BASE, CARPETA, RAIZ } from './comun.mjs';

const cuenta = JSON.parse(readFileSync(join(RAIZ, 'var', 'evaluacion', 'cuenta.json'), 'utf8'));
let cookie = '';
const pedir = async (metodo, ruta, cuerpo, extra = {}) => {
  const r = await fetch(BASE + ruta, { method: metodo, headers: { 'content-type': 'application/json', cookie, ...extra }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  for (const c of r.headers.getSetCookie?.() ?? []) if (c.startsWith('aai_session=')) cookie = c.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null) };
};

await pedir('POST', '/auth/login', { email: cuenta.email, password: cuenta.password });
const verificado = await pedir('POST', '/auth/mfa/verify', { code: totp(cuenta.mfa, Date.now()) });
if (verificado.status >= 400) {
  console.error('No se pudo verificar el segundo factor:', verificado.status);
  process.exit(1);
}
const cabecera = { 'x-company-id': cuenta.empresas[0].id };

const argumentos = process.argv.slice(2);
const preguntas = argumentos.length > 0 ? argumentos : JSON.parse(readFileSync(join(CARPETA, 'preguntas.json'), 'utf8'));
const resultados = [];
let entrada = 0;
let salida = 0;
for (const pregunta of preguntas) {
  const r = await pedir('POST', '/asistente/mensajes', { mensaje: pregunta }, cabecera);
  const j = r.json ?? {};
  const resp = j.respuesta ?? {};
  entrada += j.uso?.entrada ?? 0;
  salida += j.uso?.salida ?? 0;
  const herramientas = (resp.consultas ?? []).map((x) => x.nombre + (x.error ? '(error)' : '')).join(', ') || '—';
  console.log(`\n▶ ${pregunta}\n  [${r.status} ${j.estado ?? j.error ?? ''}] herramientas: ${herramientas}  tokens ${j.uso?.entrada ?? '-'}/${j.uso?.salida ?? '-'}`);
  console.log('  ' + (resp.texto ?? j.message ?? '').replace(/\n/g, '\n  '));
  resultados.push({ pregunta, status: r.status, estado: j.estado, consultas: resp.consultas, texto: resp.texto, propuestas: resp.propuestas });
}
writeFileSync(join(RAIZ, 'var', 'evaluacion', 'ultima-evaluacion.json'), JSON.stringify(resultados, null, 2));
console.log(`\nTOTAL tokens: entrada ${entrada}, salida ${salida}`);
