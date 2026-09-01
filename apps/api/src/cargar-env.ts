/**
 * Carga `.env` **antes** que cualquier módulo que lea `process.env`.
 *
 * ## Por qué es un módulo aparte y no dos líneas en `index.ts`
 *
 * Porque en ESM no habría funcionado, y el modo en que falla es silencioso. Los
 * `import` estáticos se resuelven y **se evalúan completos antes** de que corra
 * la primera línea del cuerpo del módulo que los declara. `index.ts` importa
 * `server.js`, que importa `config.js`, que lee `process.env` al evaluarse: para
 * cuando el cuerpo de `index.ts` empieza, la configuración ya está congelada.
 *
 * La primera versión intentó esquivarlo importando `config.js` de forma
 * dinámica. No alcanza: `server.js` seguía siendo estático y lo arrastraba
 * igual. El resultado fue `Falta la variable de entorno DATABASE_URL` con un
 * `.env` completo a un directorio de distancia.
 *
 * Lo que sí funciona es el orden de evaluación entre importaciones hermanas: se
 * evalúan en el orden en que están escritas. Con este módulo primero en la
 * lista, el `.env` está cargado antes de que `config.js` exista.
 *
 * Por eso el import de este archivo va **sin llaves y primero**, y por eso ese
 * orden no es cosmético.
 *
 * ## Por qué no se carga desde `config.ts`
 *
 * `config.ts` lo importan los tests y las suites de integración, que traen sus
 * variables del entorno. Leer un archivo desde ahí haría que un test tomara en
 * silencio la configuración de desarrollo —incluida la base— sin que se note.
 * El archivo pertenece al proceso que arranca, no al módulo que lee.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * De dónde salió la configuración, para poder decirlo en el arranque.
 *
 * `loadEnvFile` **no pisa** lo que ya está en el entorno, así que un
 * `DATABASE_URL=... npm start` sigue ganando. En producción no debería existir
 * ningún `.env` —las credenciales vienen del gestor de secretos (§27)— y por eso
 * su ausencia no es un error.
 */
export const origenEnv: string = (() => {
  let actual = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidato = join(actual, '.env');
    if (existsSync(candidato)) {
      process.loadEnvFile(candidato);
      return candidato;
    }
    const padre = dirname(actual);
    if (padre === actual) break;
    actual = padre;
  }
  return '(ninguno: se usan las variables del entorno)';
})();
