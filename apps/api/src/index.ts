import { closePool, initPool } from '@aai/db';
import { config } from './config.js';
import { buildServer } from './server.js';

initPool(config.databaseUrl);

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
