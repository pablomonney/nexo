/**
 * Carga .env antes de los tests para que las suites de integración encuentren
 * DATABASE_URL. En CI la variable viene del entorno y este archivo no hace nada.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
