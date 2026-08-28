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

/**
 * Los tests hablan con el ARCA simulado, siempre.
 *
 * Mismo argumento que el directorio de documentos y que la base: una suite no
 * puede depender de cómo tenga configurado el entorno quien la corre. Con
 * `ARCA_ENVIRONMENT=homologacion` en el `.env` local, el cliente real contesta
 * `NO_VERIFICABLE / SIN_CREDENCIAL` —que es lo correcto para él y lo hace de
 * forma visible— y las suites que esperan un resultado concreto pasan a depender
 * de una variable de entorno en vez de de su propio fixture.
 *
 * Se fija acá y no en cada suite por lo mismo de siempre: `config` se evalúa al
 * importarse, y cambiarlo en trece archivos deja el catorceavo hablándole a
 * homologación.
 */
process.env.ARCA_ENVIRONMENT = 'mock';

/**
 * La base de los tests tampoco es la del desarrollo.
 *
 * Mismo argumento que el directorio de documentos, y bastante más grave: las
 * suites de integración escriben filas que **no se pueden borrar** —los triggers
 * `forbid_delete` están puestos para eso—, así que todo lo que insertan queda.
 * El 2026-08-27 se midió el resultado: 126 de 143 filas de `norms` eran "Norma
 * de prueba", y las 84 de `accounting_rules` eran fixtures sin una sola regla
 * real. El registro normativo era en un 88% ficción de tests.
 *
 * Se redirige acá, en el `setupFile`, y no en cada suite: vitest lo ejecuta
 * antes de importar los archivos de test, así que `helpers/db.ts` —que lee
 * `DATABASE_URL` al cargarse— ya ve el valor correcto. Cambiarlo en trece
 * archivos habría dejado el catorceavo escribiendo en la base equivocada.
 *
 * Si no hay base de tests configurada **no se cae al desarrollo**: se deja
 * `DATABASE_URL` vacía y las suites de integración se saltean, que es lo que ya
 * hacen cuando no hay base. Es preferible no correrlas a correrlas ensuciando.
 */
const urlDePruebas = process.env.TEST_DATABASE_URL ?? derivarUrlDePruebas(process.env.DATABASE_URL);
process.env.DATABASE_URL = urlDePruebas ?? '';

function derivarUrlDePruebas(base: string | undefined): string | undefined {
  if (base === undefined || base === '') return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  const nombre = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (nombre === '') return undefined;
  url.pathname = `/${nombre.endsWith('_test') ? nombre : `${nombre}_test`}`;
  return url.toString();
}
