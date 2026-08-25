/**
 * Carga .env antes de los tests para que las suites de integración encuentren
 * DATABASE_URL. En CI la variable viene del entorno y este archivo no hace nada.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(raiz, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Los documentos que suben los tests van a un directorio propio, no al que use
// el desarrollador. Se fija acá y no en la suite porque `config` se evalúa al
// importarse, y los imports se elevan por encima de cualquier línea del test.
process.env.DOCUMENT_STORAGE_PATH = join(raiz, 'var', 'test-documents');
