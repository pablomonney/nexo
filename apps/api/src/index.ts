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
import { modosDeOperacion, verificarEsquema } from './arranque.js';
import { config } from './config.js';
import { buildServer } from './server.js';

initPool(config.databaseUrl);

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
  console.log(`  ${modo.nombre.padEnd(9)} ${modo.valor}${modo.real ? '' : '   · simulado o apagado'}`);
}
