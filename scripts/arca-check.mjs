#!/usr/bin/env node
/**
 * Verificación de conectividad con ARCA.
 *
 * Es el único punto del sistema que necesita el certificado. Se ejecuta una vez,
 * a mano, el día que el trámite esté hecho — y responde con precisión en qué
 * paso está la configuración, en vez de dejar al equipo adivinando por qué una
 * validación fiscal devuelve NO_VERIFICABLE.
 *
 *   node scripts/arca-check.mjs --env homologacion --cert ./cert.crt --key ./key.pem --cuit 30xxxxxxxx9
 *   node scripts/arca-check.mjs --env homologacion --cert … --key … --cuit … --servicio wsfe,wscdc
 *
 * `--servicio` acepta una lista separada por comas. Por defecto prueba solo
 * `wscdc`. El permiso de WSAA es POR SERVICIO: un certificado autorizado para
 * constatar comprobantes no necesariamente puede emitirlos, y descubrirlo recién
 * al emitir cuesta una vuelta entera.
 *
 * Sin argumentos hace lo que puede sin credenciales: comprueba que los endpoints
 * respondan y que el servicio esté arriba.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(join(HERE, '..', '.env'));
} catch {
  // Sin .env se usan las variables del entorno.
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key !== undefined) args.set(key, process.argv[i + 1]);
}

const environment = args.get('env') ?? process.env.ARCA_ENVIRONMENT ?? 'homologacion';
if (environment === 'mock') {
  console.error('Este script no tiene sentido con ARCA_ENVIRONMENT=mock. Usá --env homologacion.');
  process.exit(2);
}

const { endpointsFor, SERVICE_NAMES } = await import('../packages/arca/dist/environment.js');
const { SoapArcaClient } = await import('../packages/arca/dist/soap/soap-client.js');
const { WsaaAuthenticator, loginConCache } = await import('../packages/arca/dist/soap/wsaa.js');
const { TicketCacheFs } = await import('../packages/arca/dist/ticket-cache-fs.js');
const { contarDeDondeSalio, directorioDeTickets } = await import('./cache-de-tickets.mjs');

const endpoints = endpointsFor(environment);
const ok = (label, detail = '') => console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);

console.log(`\nAmbiente: ${environment}`);
console.log(`  WSAA : ${endpoints.wsaa}`);
console.log(`  WSCDC: ${endpoints.wscdc}\n`);

// ── 1. ¿Responden los endpoints? ─────────────────────────────────────────────
console.log('1. Alcance de red');
for (const [name, url] of [['WSAA', endpoints.wsaa], ['WSCDC', endpoints.wscdc]]) {
  try {
    const response = await fetch(`${url}?WSDL`, { method: 'GET' });
    if (response.ok) ok(`${name} alcanzable`, `HTTP ${response.status}`);
    else fail(`${name} respondió ${response.status}`);
  } catch (error) {
    fail(`${name} inalcanzable`, error instanceof Error ? error.message : String(error));
  }
}

// ── 2. ¿Está arriba el servicio? ─────────────────────────────────────────────
console.log('\n2. Estado del servicio (Dummy)');
const probe = new SoapArcaClient({
  environment,
  credentials: { async getCertificate() { return null; } },
});
const estado = await probe.estadoServicio();
if (estado.disponible) ok('WSCDC operativo', `app=${estado.appServer} db=${estado.dbServer} auth=${estado.authServer}`);
else fail('WSCDC no operativo', `app=${estado.appServer} db=${estado.dbServer} auth=${estado.authServer}`);

// ── 3. Autenticación ─────────────────────────────────────────────────────────
const certPath = args.get('cert');
const keyPath = args.get('key');
const cuit = args.get('cuit');

console.log('\n3. Autenticación WSAA');
if (certPath === undefined || keyPath === undefined || cuit === undefined) {
  console.log('  – Sin --cert/--key/--cuit: se omite.');
  console.log('    El trámite está documentado en docs/api/arca-onboarding.md');
  process.exit(0);
}

let certificate;
try {
  certificate = {
    companyId: 'check',
    cuit,
    certificatePem: await readFile(certPath, 'utf8'),
    privateKeyPem: await readFile(keyPath, 'utf8'),
    notAfter: new Date(Date.now() + 86_400_000),
  };
  ok('Certificado y clave leídos');
} catch (error) {
  fail('No se pudieron leer los archivos', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

/**
 * Qué servicios verificar.
 *
 * El ticket de WSAA es **por servicio**: un certificado autorizado para `wscdc`
 * y no para `wsfe` obtiene ticket para constatar y falla al emitir. Hasta ahora
 * este script probaba solo `wscdc` y decía "la delegación funciona" — cierto
 * para constatar, y engañoso para cualquier otra cosa.
 *
 * Se prueban todos los pedidos y se informa **uno por uno**: que uno ande no
 * dice nada de los demás.
 */
const servicios =
  args.get('servicio') !== undefined
    ? args.get('servicio').split(',').map((s) => s.trim())
    : [SERVICE_NAMES.wscdc];

const authenticator = new WsaaAuthenticator({ endpoint: endpoints.wsaa });

/**
 * Este script comparte la caché con `comprobantes:generar`.
 *
 * Verificar la conexión no puede dejar sin ticket al comando que emite. El WSAA
 * da uno solo por CUIT y servicio, así que "comprobar que anda" y "usarlo" tienen
 * que hablar del mismo ticket o se pisan.
 */
const cacheTickets = new TicketCacheFs({
  directorio: directorioDeTickets(args),
  ambiente: environment,
  raizRepositorio: join(HERE, '..'),
});
console.log(`  caché de tickets: ${cacheTickets.directorio}`);

let algunoFallo = false;
/**
 * ¿Quedó alguna falla SIN causa identificada?
 *
 * La lista de sospechas de abajo es para cuando no sabemos. Imprimirla igual
 * cuando el servicio ya dijo exactamente qué pasa manda a revisar cuatro cosas
 * de las cuales tres están bien — que fue justo lo que hizo este script la
 * primera vez que se corrió con un certificado de verdad.
 */
let algunaSinLectura = false;

for (const servicio of servicios) {
  try {
    const obtenido = await loginConCache(authenticator, cacheTickets, certificate, servicio);
    ok(`Ticket para "${servicio}"`, contarDeDondeSalio(obtenido));
  } catch (error) {
    algunoFallo = true;
    if (error?.name !== 'WsaaFaultError' || error.lectura === null) algunaSinLectura = true;
    fail(`WSAA rechazó "${servicio}"`, error instanceof Error ? error.message : String(error));
  }
}

if (algunoFallo && algunaSinLectura) {
  console.log('\n  Causas habituales, en orden de frecuencia:');
  console.log('   · El certificado no está asociado a ESE servicio en particular');
  console.log('     → Administrador de Relaciones de Clave Fiscal (producción) o WSASS (homologación)');
  console.log('     El permiso es por servicio: tener wscdc no implica tener wsfe');
  console.log('   · El certificado es de producción y se está usando en homologación, o al revés');
  console.log('   · El reloj del equipo está desfasado respecto del organismo');
  console.log('   · El certificado venció');
}

if (algunoFallo) process.exit(1);

console.log(`\n  El certificado está emitido y autorizado para: ${servicios.join(', ')}.`);
console.log('  Eso NO dice nada sobre los servicios que no se probaron.');
