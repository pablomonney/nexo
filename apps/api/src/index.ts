/**
 * El punto de entrada del servidor.
 *
 *   npm start          — compila y levanta
 *   npm run dev        — lo mismo, reiniciando ante cada cambio
 *
 * Antes de escuchar se corre el preflight de `arranque.ts`: si la base quedó
 * atrás de las migraciones, el proceso **no arranca**. Un servidor a medio
 * esquema no falla, que sería lo cómodo: anda a medias, y ese es el estado más
 * caro de diagnosticar.
 */

// ⚠ Este import va primero y sin llaves, y el orden no es cosmético: carga
// `.env` antes de que se evalúe `config.js`, que lo importa `server.js`. El
// motivo completo está en `cargar-env.ts`, incluido el intento anterior que no
// funcionaba y por qué fallaba en silencio.
import { origenEnv } from './cargar-env.js';
import { closePool, initPool } from '@aai/db';
import { modosDeOperacion, problemasDelRol, rolesDeLaBase, verificarEsquema } from './arranque.js';
import { verificarProveedor } from './ai/proveedor.js';
import { verificarProveedorDeCorreo } from './correo/fabrica.js';
import { verificarAmbienteDePagos, verificarProveedorDePagos } from './pagos/fabrica.js';
import { crearProveedorDeSecretos, verificarGestor } from './secrets/fabrica.js';
import { config } from './config.js';
import { buildServer } from './server.js';

initPool(config.databaseUrl);

// Un `AI_PROVIDER` desconocido no degrada en silencio: el sistema diría que
// tiene IA y no la tendría, y nadie iría a buscar por qué no hay sugerencias.
const proveedorInvalido = verificarProveedor(config.ai);
if (proveedorInvalido !== null) {
  console.error(`NEXO no arranca:\n\n  ✘ ${proveedorInvalido}\n`);
  await closePool();
  process.exit(1);
}

// Y lo mismo con el correo. Acá el silencio sería el más caro de los tres: un
// `EMAIL_PROVIDER` mal escrito no rompe nada visible —el alta contesta 200— y
// el síntoma es que los usuarios nunca confirman su cuenta. Nadie va a ir a
// leer `email_outbox` para descubrir por qué.
const correoInvalido = verificarProveedorDeCorreo(config.correo);
if (correoInvalido !== null) {
  console.error(`NEXO no arranca:\n\n  ✘ ${correoInvalido}\n`);
  await closePool();
  process.exit(1);
}

// Y con la pasarela de pagos. Un `PAYMENTS_PROVIDER` mal escrito produce un
// sistema que emite facturas durante meses sin que entre la plata, y el síntoma
// aparece en la conciliación bancaria, no en un log.
const pagosInvalidos = verificarProveedorDePagos(config.pagos);
if (pagosInvalidos !== null) {
  console.error(`NEXO no arranca:\n\n  ✘ ${pagosInvalidos}\n`);
  await closePool();
  process.exit(1);
}

// Y —lo más importante de las tres— que el ambiente declarado coincida con la
// credencial que hay.
//
// Mercado Pago usa la misma URL para prueba y producción, así que no existe
// ninguna barrera de red entre las dos. Declarar `sandbox` con un token real
// significa que cada prueba mueve plata de verdad, y nada lo delataría hasta
// que alguien mire un resumen de tarjeta.
const ambienteInvalido = await verificarAmbienteDePagos(config.pagos);
if (ambienteInvalido !== null) {
  console.error(`NEXO no arranca:\n\n  ✘ ${ambienteInvalido}\n`);
  await closePool();
  process.exit(1);
}

// Igual que con el proveedor de modelo: un gestor de secretos desconocido
// arrancaria sin secretos, y cada integracion fallaria por separado con un
// mensaje que se lee como «falta configurar esto» en vez de «el nombre del
// gestor esta mal escrito».
const gestorInvalido = verificarGestor(config.secrets.provider);
if (gestorInvalido !== null) {
  console.error(`NEXO no arranca:

  ✘ ${gestorInvalido}
`);
  await closePool();
  process.exit(1);
}

// Y se construye una vez acá: si el gestor está nombrado pero no implementado,
// que falle al arrancar y no en la primera operación que lo necesite.
try {
  crearProveedorDeSecretos('system:arranque');
} catch (error) {
  console.error(`NEXO no arranca:

  ✘ ${(error as Error).message}
`);
  await closePool();
  process.exit(1);
}

// Con qué rol se conecta a PostgreSQL. En producción, un rol que puede saltear
// RLS convierte el aislamiento entre empresas en una convención del código: no
// falla nada, no hay error, y una empresa ve los datos de otra.
const roles = await rolesDeLaBase();
const problemasDeRol = problemasDelRol(roles, config.isProduction);
if (problemasDeRol.length > 0) {
  console.error('NEXO no arranca:\n');
  for (const p of problemasDeRol) {
    console.error(`  ✘ ${p.que}`);
    console.error(`    → ${p.comoSeArregla}\n`);
  }
  await closePool();
  process.exit(1);
}

const problemas = await verificarEsquema();
if (problemas.length > 0) {
  console.error('NEXO no arranca:\n');
  for (const p of problemas) {
    console.error(`  ✘ ${p.que}`);
    console.error(`    → ${p.comoSeArregla}\n`);
  }
  await closePool();
  process.exit(1);
}

const app = await buildServer({ logger: true });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'apagando');
  await app.close();
  await closePool();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: '0.0.0.0' });

// El resumen va después de `listen` para que sea lo último que se lee: si algo
// falló, el error queda abajo y no sepultado por el banner.
//
// Los modos simulados o apagados se marcan porque de otro modo son invisibles.
// Alguien puede constatar un comprobante contra el mock de ARCA y creer que
// habló con el organismo.
console.log(`\nNEXO escuchando en :${config.port}`);
console.log(`  .env      ${origenEnv}`);
for (const modo of modosDeOperacion(config)) {
  // El detalle importa tanto como el `real`: «preparado, no conectado» y «sin
  // IA externa» son los dos `real: false`, y quien mira el banner necesita
  // saber cuál de los dos tiene delante.
  const marca = modo.real ? '' : '   · simulado o apagado';
  console.log(`  ${modo.nombre.padEnd(9)} ${modo.valor}${marca}`);
  if (modo.detalle !== undefined) console.log(`            ${modo.detalle}`);
}

// El rol de la base y el proxy se imprimen **siempre**, incluso cuando están
// bien. Los dos deciden cosas que no se ven desde afuera —si RLS se aplica y si
// el límite de intentos distingue a un cliente de otro— y de los dos hay una
// versión que funciona sin dar ningún síntoma cuando está mal puesta.
console.log(
  `  base      ${roles.sesion}` +
    (roles.sesion === roles.efectivo ? '' : ` → ${roles.efectivo} en cada transacción`) +
    (config.isProduction ? '' : roles.sesionEsSuperusuario ? '   · superusuario (solo dev)' : ''),
);
console.log(
  `  proxy     ${config.trustProxy ? 'de confianza: se lee X-Forwarded-For' : 'ninguno: se usa la conexión directa'}`,
);
if (config.buildId !== null) console.log(`  versión   ${config.buildId}`);
