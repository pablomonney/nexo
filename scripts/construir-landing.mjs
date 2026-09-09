#!/usr/bin/env node
/**
 * Arma la landing para un hosting estático.
 *
 *   npm run landing:construir
 *   npm run landing:construir -- --contacto "mailto:hola@nexo.com.ar"
 *
 * ## Qué problema resuelve
 *
 * `apps/web/landing.html` no es una página estática: pide los precios a
 * `GET /planes` y sus botones llevan a `/consola`. Servida sola por un hosting
 * de archivos, la tabla de precios queda en «No se pudieron cargar los planes»
 * —para siempre, no un rato— y los tres botones dan 404. Medido el 2026-09-09
 * antes de escribir esto, sirviendo `apps/web` como archivos y nada más.
 *
 * Este script produce la versión que **sí** se puede publicar sin API detrás.
 *
 * ## El precio sigue teniendo una sola fuente
 *
 * La regla de la página es que ningún precio está escrito en el HTML, porque
 * dos fuentes de verdad sobre el precio terminan en un número en la página y
 * otro en la factura. Eso no se toca: los precios se leen **de la base** y se
 * escriben en `planes.json`, que es la misma respuesta que daría la API.
 *
 * Lo que cambia es que la copia tiene fecha, y la fecha se muestra en la
 * página. Un precio de hace tres meses sin decir de cuándo es sería justamente
 * la segunda verdad que la regla evita; con la fecha puesta, el que lo lee sabe
 * qué está mirando y el que despliega sabe cuándo rehacerlo.
 *
 * ## Los botones
 *
 * En modo presentación no hay consola, así que no se promete una prueba que no
 * se puede empezar. Con `--contacto` los botones invitan a escribir; sin él se
 * convierten en texto. **No se inventa una casilla de correo**: si no la
 * pasaste, no existe.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const ORIGEN = join(RAIZ, 'apps', 'web', 'landing.html');
// El nombre de la carpeta es el nombre del proyecto en el hosting, y por lo
// tanto parte del URL que se va a mostrar. "landing" no dice de quién es.
const DESTINO = join(RAIZ, 'var', 'nexo');

try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  // En CI las variables vienen del entorno.
}

const argumentos = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  argumentos.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '');
}
const contacto = argumentos.get('contacto') ?? '';

if (contacto !== '' && !/^(mailto:|https?:\/\/)/.test(contacto)) {
  console.error(`--contacto tiene que ser un "mailto:" o una URL. Recibí: ${contacto}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') {
  console.error('Falta DATABASE_URL: los precios salen de la base, no del HTML.');
  process.exit(1);
}

/**
 * La respuesta se le pide a la ruta de verdad, no a una consulta parecida.
 *
 * La primera versión de este script copiaba el SQL de `GET /planes`. Al
 * compararlo con el original difería en los nombres de dos columnas de fecha,
 * en el nombre de la clave del código y en el tipo del importe: la copia se
 * separó del original **antes de correr una sola vez**. Es exactamente la
 * segunda fuente de verdad que la regla de la página existe para evitar, movida
 * del HTML al script de construcción.
 *
 * Levantar Fastify en proceso y hacerle un `inject` cuesta un segundo y
 * garantiza que lo que se publica es byte por byte lo que serviría la API.
 */
const { initPool, closePool } = await import('@aai/db');
const { buildServer } = await import('@aai/api/server');

initPool(url);
const app = await buildServer();
await app.ready();

let respuesta;
try {
  respuesta = await app.inject({ method: 'GET', url: '/planes' });
} finally {
  await app.close();
  await closePool();
}

if (respuesta.statusCode !== 200) {
  console.error(`GET /planes contestó ${respuesta.statusCode}. No hay nada que publicar.`);
  process.exit(1);
}

const catalogo = respuesta.json();
const planes = catalogo.planes ?? [];

if (planes.length === 0) {
  console.error(
    'No hay planes DISPONIBLE en la base. Publicar una página de precios sin precios sería\n' +
      'peor que no publicarla: mejor corregir la base y volver a correr esto.',
  );
  process.exit(1);
}

const hoy = new Date().toISOString().slice(0, 10);

await rm(DESTINO, { recursive: true, force: true });
await mkdir(DESTINO, { recursive: true });

await writeFile(
  join(DESTINO, 'planes.json'),
  // Se guarda la respuesta entera y no solo los planes: la página lee
  // `datos.prueba.dias` para la nota, y recortar el objeto sería volver a
  // decidir acá qué necesita la página.
  JSON.stringify({ ...catalogo, tomadoEl: hoy }, null, 2),
);

// La página se copia entera y solo se le cambian los cuatro valores de la
// cabecera. Nada de reescribir el cuerpo: si mañana alguien edita la landing,
// esto sigue funcionando sin tocarlo.
let html = await readFile(ORIGEN, 'utf8');
const ajustes = {
  'nexo-modo': 'presentacion',
  'nexo-planes': 'planes.json',
  'nexo-contacto': contacto,
  'nexo-precios-al': hoy,
};
for (const [nombre, valor] of Object.entries(ajustes)) {
  const marca = new RegExp(`<meta name="${nombre}" content="[^"]*">`);
  // Se comprueba que **esté**, no que el texto haya cambiado: sin `--contacto`
  // el valor nuevo es igual al viejo —los dos vacíos— y comparar el antes con
  // el después daría «no lo encontré» sobre una etiqueta que está ahí.
  if (!marca.test(html)) {
    console.error(`No encontré el <meta name="${nombre}"> en la landing. ¿Se renombró?`);
    process.exit(1);
  }
  html = html.replace(marca, `<meta name="${nombre}" content="${valor}">`);
}

await writeFile(join(DESTINO, 'index.html'), html);

// `cleanUrls` para que no haga falta escribir `.html`, y sin reescrituras: es
// una sola página, y una regla que mande todo a index.html escondería un 404
// detrás de la portada.
await writeFile(
  join(DESTINO, 'vercel.json'),
  JSON.stringify({ $schema: 'https://openapi.vercel.sh/vercel.json', cleanUrls: true }, null, 2),
);

console.log(`Landing de presentación en ${DESTINO}`);
console.log(`  ${planes.length} plan(es), precios tomados el ${hoy}`);
console.log(
  contacto === ''
    ? '  Sin dirección de contacto: los botones quedan como texto.'
    : `  Los botones llevan a ${contacto}`,
);
console.log('\nPara publicarla:');
console.log(`  cd "${DESTINO}"`);
console.log('  npx vercel login      # una vez, con tu cuenta');
console.log('  npx vercel --prod --yes');
