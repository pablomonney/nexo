#!/usr/bin/env node
/**
 * Relevamiento de habilitaciones de ARCA para un CUIT.
 *
 *   npm run arca:capabilities -- --cert ./cert.crt --key ./key.pem --cuit 30XXXXXXXX9 --company <uuid>
 *
 * Pregunta a WSAA, servicio por servicio, si este certificado tiene la
 * delegación. Guarda **solo lo que es una afirmación sobre la delegación**:
 * `HABILITADO` y `NO_DELEGADO`. Un `NO_VERIFICABLE` se informa y no se escribe —
 * una caída del organismo no dice nada sobre lo que el contribuyente delegó, y
 * escribirla como negativa deja el sistema creyendo para siempre que el servicio
 * no está.
 *
 * El certificado y la clave **no entran al repositorio**: el script los lee del
 * disco por ruta, igual que `arca-check.mjs`. Es la misma regla que rige desde
 * FASE 3a — este sistema no pide, no guarda y no usa la Clave Fiscal, y los
 * certificados viven donde el estudio los tenga.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  SERVICIOS_DEL_PRODUCTO,
  clasificarIntento,
  esPersistible,
  resumirRelevamiento,
} from '../packages/arca/dist/index.js';
import { WsaaAuthenticator } from '../packages/arca/dist/soap/wsaa.js';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key !== undefined) args.set(key, process.argv[i + 1]);
}

const environment = args.get('env') ?? process.env.ARCA_ENVIRONMENT ?? 'homologacion';
const certPath = args.get('cert');
const keyPath = args.get('key');
const cuit = args.get('cuit');
const companyId = args.get('company');

if (environment === 'mock') {
  console.error('Este relevamiento no tiene sentido con ARCA_ENVIRONMENT=mock: no hay nada que');
  console.error('relevar. Usá --env homologacion o --env produccion.');
  process.exit(1);
}

if (certPath === undefined || keyPath === undefined || cuit === undefined) {
  console.error('Faltan --cert, --key o --cuit.');
  console.error('');
  console.error('  npm run arca:capabilities -- \\');
  console.error('    --env homologacion --cert ./cert.crt --key ./key.pem --cuit 30XXXXXXXX9');
  console.error('');
  console.error('El certificado no entra al repositorio: el script lo lee de la ruta que le des.');
  process.exit(1);
}

console.log(`Ambiente: ${environment}`);
console.log(`CUIT: ${cuit}`);
console.log('');

const certificate = {
  cuit,
  environment,
  certificatePem: await readFile(certPath, 'utf8'),
  privateKeyPem: await readFile(keyPath, 'utf8'),
};

const authenticator = new WsaaAuthenticator({ environment });
const ahora = new Date().toISOString();
const habilitaciones = [];

for (const service of SERVICIOS_DEL_PRODUCTO) {
  process.stdout.write(`  ${service.padEnd(20)} `);
  let intento;
  try {
    await authenticator.login(certificate, service);
    intento = { service, ok: true, respuesta: null, fallaDeTransporte: false, sinCredencial: false };
  } catch (error) {
    const mensaje = error instanceof Error ? error.message : String(error);
    // La distinción que sostiene todo el módulo. Un error de red, un timeout o
    // un 5xx son problemas de disponibilidad; un rechazo de WSAA es una
    // afirmación sobre la delegación.
    const fallaDeTransporte = /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|5\d\d/i.test(
      mensaje,
    );
    intento = {
      service,
      ok: false,
      respuesta: mensaje.slice(0, 200),
      fallaDeTransporte,
      sinCredencial: false,
    };
  }

  const habilitacion = clasificarIntento(intento, ahora);
  habilitaciones.push(habilitacion);
  console.log(habilitacion.estado);
  if (habilitacion.estado !== 'HABILITADO') {
    console.log(`      ${habilitacion.detalle}`);
  }
}

const resumen = resumirRelevamiento(environment, habilitaciones);

console.log('');
console.log(
  `${resumen.habilitados} habilitado(s), ${resumen.noDelegados} no delegado(s), ${resumen.noVerificables} sin poder verificar.`,
);

if (resumen.consecuencias.length > 0) {
  console.log('');
  console.log('Qué significa esto para el producto:');
  for (const consecuencia of resumen.consecuencias) console.log(`  · ${consecuencia}`);
}

if (resumen.noVerificables > 0) {
  console.log('');
  console.log('Los NO_VERIFICABLE no se guardan. No es un olvido: una caída del organismo no dice');
  console.log('nada sobre las delegaciones del CUIT, y escribirla como negativa dejaría el sistema');
  console.log('creyendo para siempre que el servicio no está habilitado.');
}

if (companyId === undefined) {
  console.log('');
  console.log('Sin --company no se guarda nada. Pasá el uuid de la empresa para persistirlo.');
  process.exit(0);
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (DATABASE_URL === '') {
  console.log('');
  console.log('Sin DATABASE_URL no se guarda nada.');
  process.exit(0);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
let guardadas = 0;

try {
  for (const habilitacion of habilitaciones) {
    if (!esPersistible(habilitacion.estado)) continue;
    await client.query(
      `INSERT INTO company_arca_capabilities
         (company_id, environment, service, enabled, verified_at, notes, last_probe_result)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7)
       ON CONFLICT (company_id, environment, service) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             verified_at = EXCLUDED.verified_at,
             notes = EXCLUDED.notes,
             last_probe_result = EXCLUDED.last_probe_result`,
      [
        companyId,
        environment,
        habilitacion.service,
        habilitacion.estado === 'HABILITADO',
        habilitacion.verificadoEl,
        habilitacion.detalle,
        habilitacion.estado,
      ],
    );
    guardadas += 1;
  }

  console.log('');
  console.log(`${guardadas} habilitación(es) guardadas para la empresa ${companyId}.`);
  console.log('Valen 30 días: pasado ese plazo el sistema responde VENCIDO y vuelve a preguntar.');
} finally {
  await client.end();
}
