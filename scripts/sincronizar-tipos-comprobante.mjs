#!/usr/bin/env node
/**
 * Sincroniza `arca_comprobante_types` contra `FEParamGetTiposCbte`.
 *
 *   npm run comprobantes:tipos -- --cert C:/ARCA/certificado.crt \
 *     --key C:/ARCA/privada.key --cuit 20452148324
 *   npm run comprobantes:tipos -- … --aplicar
 *
 * La semilla actual salió del manual archivado, que **enumera los códigos pero
 * no sus fechas de vigencia**. Por eso las filas viven con
 * `vigencia_verificada = false`: el sistema sabe qué significa el código 1, no
 * desde cuándo lo significa. El §6 depende de la segunda afirmación —
 * interpretar un comprobante de 2019 con la tabla de 2026 es exactamente lo que
 * prohíbe.
 *
 * ## Por qué esto NO pone `vigencia_verificada = true`
 *
 * Porque lee de **homologación**, y homologación es el ambiente de prueba del
 * organismo. Que ahí la tabla de parámetros coincida con la de producción es
 * plausible y no está escrito en ningún lado: no hay documento archivado que lo
 * afirme. Copiar esos datos y marcarlos "verificados contra el organismo" sería
 * convertir una suposición razonable en una cita, que es la única cosa que el
 * §30 prohíbe sin excepciones.
 *
 * Entonces: se traen las fechas, se guardan con la fuente y el ambiente
 * anotados, y la bandera **solo** se levanta si el ambiente es producción. Con
 * un certificado de producción, este mismo comando cierra el pendiente.
 *
 * Mientras tanto sirve para algo que no es menor: comparar lo que dice el manual
 * contra lo que devuelve el servicio, y mostrar en qué difieren.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import forge from 'node-forge';
import pg from 'pg';
import { SERVICE_NAMES, TicketCacheFs, WsaaAuthenticator, endpointsFor, loginConCache } from '@aai/arca';
import { ClienteWsfev1, verificarDestinoDeEmision, explicarRechazoEmision } from '@aai/arca-emision';

import { contarDeDondeSalio, directorioDeTickets } from './cache-de-tickets.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(join(AQUI, '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* sin .env se usan las variables del entorno */
}

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const clave = process.argv[i]?.replace(/^--/, '');
  if (clave !== undefined) args.set(clave, process.argv[i + 1]);
}
// `--aplicar` no lleva valor.
const aplicar = process.argv.includes('--aplicar');

const ambiente = args.get('env') ?? 'homologacion';
const certPath = args.get('cert');
const keyPath = args.get('key');
const cuit = args.get('cuit');

if (certPath === undefined || keyPath === undefined || cuit === undefined) {
  console.error('Faltan --cert, --key y --cuit.');
  process.exit(2);
}

// El certificado no puede estar adentro del repositorio: un `.key` commiteado
// no se des-commitea, queda en el historial.
for (const [etiqueta, ruta] of [['cert', certPath], ['key', keyPath]]) {
  const rel = resolve(ruta);
  if (rel.startsWith(RAIZ)) {
    console.error(`El archivo --${etiqueta} está dentro del repositorio (${rel}).`);
    console.error('Movelo afuera del árbol del proyecto.');
    process.exit(2);
  }
}

const endpoints = endpointsFor(ambiente);
const permiso = verificarDestinoDeEmision({
  ambiente,
  endpoint: endpoints.wsfev1,
  endpointWsaa: endpoints.wsaa,
});
if (!permiso.permitido) {
  console.error(explicarRechazoEmision(permiso));
  process.exit(2);
}

const certificatePem = readFileSync(certPath, 'utf8');
const privateKeyPem = readFileSync(keyPath, 'utf8');
const x509 = forge.pki.certificateFromPem(certificatePem);

console.log(`Ambiente: ${ambiente}`);
console.log(`  emisor del certificado: ${x509.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(', ')}`);

const cliente = new ClienteWsfev1({ permiso });

// FEDummy primero: no pide credenciales, y el ticket es escaso.
const estado = await cliente.dummy();
console.log(`  FEDummy → app ${estado.appServer} · db ${estado.dbServer} · auth ${estado.authServer}`);
if ([estado.appServer, estado.dbServer, estado.authServer].some((v) => v !== 'OK')) {
  console.error('El servicio no está sano. Una tabla de parámetros leída a medias es peor que ninguna.');
  process.exit(1);
}

const cacheTickets = new TicketCacheFs({
  directorio: directorioDeTickets(args),
  ambiente,
  raizRepositorio: RAIZ,
});

let obtenido;
try {
  obtenido = await loginConCache(
    new WsaaAuthenticator({ endpoint: endpoints.wsaa }),
    cacheTickets,
    { companyId: 'sincronizador-tipos', cuit, certificatePem, privateKeyPem, notAfter: x509.validity.notAfter },
    SERVICE_NAMES.wsfev1,
  );
} catch (error) {
  console.error('');
  console.error(`No se pudo autenticar: ${error.message}`);
  if (error?.code === 'ns1:coe.alreadyAuthenticated') {
    console.error(`  Caché: ${cacheTickets.directorio}`);
    console.error('  Si está vacía, el ticket vivo lo pidió algo que no lo guardó: hay que esperar.');
  }
  process.exit(1);
}
console.log(`  ${contarDeDondeSalio(obtenido)}`);

const auth = { Token: obtenido.ticket.token, Sign: obtenido.ticket.sign, Cuit: cuit };
const tipos = await cliente.tiposDeComprobante(auth);
console.log(`\nARCA devolvió ${tipos.length} tipos de comprobante.\n`);

// --- Comparación contra lo que ya está en la base ---------------------------
const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  console.error('Falta DATABASE_URL: no hay base contra la cual comparar.');
  process.exit(1);
}

const db = new pg.Client({ connectionString });
await db.connect();

const previos = new Map();
for (const fila of (
  await db.query(
    'SELECT codigo, descripcion, valid_from::text AS desde, valid_to::text AS hasta, vigencia_verificada FROM arca_comprobante_types',
  )
).rows) {
  previos.set(fila.codigo, fila);
}

/** `yyyyMMdd` → `yyyy-mm-dd`, o null si no tiene la forma esperada. */
function comoFecha(texto) {
  if (texto === null) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(texto.trim());
  return m === null ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

const nuevos = [];
const cambios = [];
const soloEnLaBase = new Set(previos.keys());

for (const t of tipos) {
  soloEnLaBase.delete(t.Id);
  const previo = previos.get(t.Id);
  const desde = comoFecha(t.FchDesde);
  const hasta = comoFecha(t.FchHasta);

  if (previo === undefined) {
    nuevos.push({ ...t, desde, hasta });
    continue;
  }
  if (previo.desde !== desde || previo.hasta !== hasta) {
    cambios.push({ ...t, desde, hasta, antesDesde: previo.desde, antesHasta: previo.hasta });
  }
}

console.log(`Códigos que ARCA tiene y la base no: ${nuevos.length}`);
for (const n of nuevos) console.log(`  + ${String(n.Id).padStart(3)} ${n.Desc} (${n.desde ?? '?'} → ${n.hasta ?? 'sin baja'})`);

console.log(`\nCódigos cuya vigencia cambia: ${cambios.length}`);
for (const c of cambios) {
  console.log(`  ~ ${String(c.Id).padStart(3)} ${c.Desc}`);
  console.log(`      antes: ${c.antesDesde ?? 'null'} → ${c.antesHasta ?? 'null'}`);
  console.log(`      ahora: ${c.desde ?? 'null'} → ${c.hasta ?? 'sin baja'}`);
}

// Un código que está en la base y NO en la respuesta no se borra ni se da de
// baja: puede ser un tipo que este CUIT no tiene habilitado, no un tipo
// derogado. Se informa y se deja quieto.
console.log(`\nCódigos en la base que ARCA no devolvió: ${soloEnLaBase.size}`);
if (soloEnLaBase.size > 0) {
  console.log(`  ${[...soloEnLaBase].sort((a, b) => a - b).join(', ')}`);
  console.log('  No se tocan. Que este CUIT no pueda emitirlos no significa que no existan.');
}

// --- Escritura --------------------------------------------------------------
const verificada = ambiente === 'produccion';
const fuente = `FEParamGetTiposCbte (${ambiente}) — ${new Date().toISOString().slice(0, 10)}`;

if (!aplicar) {
  console.log('\n─────────────────────────────────────────────────────────');
  console.log('Simulación. No se escribió nada. Agregá --aplicar para guardar.');
  console.log(`Al aplicar, las filas quedarían con vigencia_verificada = ${verificada}.`);
  if (!verificada) {
    console.log('');
    console.log('  Sigue en false porque esto se leyó de homologación, que es el ambiente');
    console.log('  de prueba del organismo. Ningún documento archivado dice que su tabla de');
    console.log('  parámetros coincida con la de producción, y suponerlo para después citarlo');
    console.log('  sería inventar una fuente. Con un certificado de producción, sube a true.');
  }
  await db.end();
  process.exit(0);
}

let escritos = 0;
try {
  await db.query('BEGIN');
  for (const t of tipos) {
    await db.query(
      `INSERT INTO arca_comprobante_types
         (codigo, descripcion, fuente, verification_level, valid_from, valid_to,
          vigencia_verificada, synced_at)
       VALUES ($1, $2, $3, 'V1', $4, $5, $6, now())
       ON CONFLICT (codigo) DO UPDATE
         SET descripcion = EXCLUDED.descripcion,
             fuente = EXCLUDED.fuente,
             valid_from = EXCLUDED.valid_from,
             valid_to = EXCLUDED.valid_to,
             vigencia_verificada = EXCLUDED.vigencia_verificada,
             synced_at = EXCLUDED.synced_at`,
      [t.Id, t.Desc, fuente, comoFecha(t.FchDesde), comoFecha(t.FchHasta), verificada],
    );
    escritos += 1;
  }
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK');
  await db.end();
  throw error;
}
await db.end();

console.log(`\n${escritos} filas escritas. Fuente: ${fuente}`);
console.log(`vigencia_verificada = ${verificada}`);
