import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const RAIZ = fileURLToPath(new URL('.', import.meta.url));
const API_SRC = `${RAIZ}apps/api/src/`;

/**
 * DECISIÓN ARQUITECTÓNICA — los tests de integración pasan a ejercitar el
 * **código fuente** de la API, no su compilado.
 *
 * ## El problema
 *
 * `apps/api/package.json` exporta `./server` → `./dist/server.js`, así que
 * `buildServer()` en un test cargaba el JavaScript emitido. Consecuencia: los
 * 8.752 renglones de `apps/api/src` —los 80 endpoints, todo el SQL, todo el
 * manejo de errores— **no se podían medir**. La auditoría maestra lo marcó como
 * riesgo crítico: el 89,65 % que daba confianza describía los paquetes puros y
 * no el producto.
 *
 * Agregarlos al `include` sin más los mostraba en 0 %, que es peor que no
 * medirlos: dice que no están probados cuando sí lo están.
 *
 * ## Las tres salidas, y por qué esta
 *
 *   · **Seguir sobre `dist`.** Prueba el artefacto que se despliega, que es un
 *     argumento real. Pero deja sin medir el archivo más grande y más riesgoso
 *     del repositorio, y ahí vivía el 500-en-lugar-de-error-de-dominio que
 *     encontramos la semana pasada.
 *   · **Mapear la cobertura de `dist` a `src` por source maps.** Sería ideal y
 *     no funciona: el proveedor v8 no aplica el mapeo al filtro del `include`.
 *   · **Ejercitar `src`.** Es lo que hace este plugin.
 *
 * ## Qué se pierde, y con qué se compensa
 *
 * Los tests dejan de probar la salida de `tsc`. Se compensa con lo que el
 * pipeline ya hace: `typecheck` corre con `--build --force` sobre todo el árbol
 * antes que los tests, y el paso de migraciones ejecuta el `dist` recién
 * compilado. Una diferencia de comportamiento entre `src` y `dist` exigiría un
 * error del compilador, no de este repositorio.
 *
 * ## Por qué un plugin y no un alias
 *
 * El código de la API usa especificadores con extensión `.js` —lo exige
 * `verbatimModuleSyntax` con NodeNext—, así que `server.ts` importa
 * `./routes/accounts.js`, que en `src` no existe. Un alias global
 * `.js` → `.ts` arreglaría eso y **rompería todo lo demás**: reescribiría
 * también los imports internos de los paquetes, que sí deben resolver a `dist`.
 *
 * Este plugin mira `importer` y solo reescribe cuando quien importa está dentro
 * de `apps/api/src`. Es la diferencia entre una regla dirigida y una que se
 * aplica a todo por si acaso.
 */
function apiDesdeElFuente(): Plugin {
  return {
    name: 'aai-api-desde-el-fuente',
    enforce: 'pre',
    resolveId(source, importer) {
      // `@aai/api/loquesea` → el archivo fuente equivalente. Cubre `./server` y
      // los submódulos que los tests importan directamente, como el store de
      // credenciales: sin esto cargarían el `dist` y su cobertura volvería a
      // quedar sin medir, que es el defecto que este plugin vino a arreglar.
      if (source === '@aai/api') return `${API_SRC}index.ts`;
      if (source.startsWith('@aai/api/')) {
        return `${API_SRC}${source.slice('@aai/api/'.length)}.ts`;
      }

      // Solo los relativos, y solo si el que importa ya está en el fuente de la
      // API. Sin las dos condiciones esto sería el alias global que arriba se
      // descarta.
      if (importer !== undefined && importer.replace(/\\/g, '/').startsWith(API_SRC)) {
        if (source.startsWith('.') && source.endsWith('.js')) {
          return this.resolve(`${source.slice(0, -3)}.ts`, importer, { skipSelf: true });
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [apiDesdeElFuente()],
  test: {
    setupFiles: ['tests/setup-env.ts'],
    include: ['packages/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],

    /**
     * Los cinco segundos por defecto de vitest dejaron de alcanzar, y no porque
     * algo se haya vuelto lento.
     *
     * Lo que pasó: la suite creció a ochenta archivos que corren en paralelo, y
     * cada uno de integración da de alta usuarios con Argon2 —caro a propósito—
     * y hace el baile completo de MFA en su `beforeAll`. Con la CPU saturada, un
     * test que solo tarda 784 ms cuando corre aislado supera los cinco segundos
     * de reloj.
     *
     * Se midió antes de tocar esto, porque un timeout que se sube sin mirar es
     * la forma más común de tapar un defecto: `work_queue` —la consulta que
     * disparó el fallo, hoy unión de siete vistas— resuelve en **20 ms**. El
     * problema es contención de máquina, no una consulta pesada.
     *
     * Veinte segundos son veinticinco veces lo que tarda el test más lento
     * aislado: sigue cortando enseguida si algo se cuelga de verdad, que es lo
     * único que un timeout tiene que hacer.
     */
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // ACCOUNTING_ENGINE.md: el motor contable exige >= 95%. El umbral global
      // arranca más bajo y sube por paquete a medida que se implementan.
      //
      // Nota sobre lo que estos números miden y lo que no: los tests de
      // integración ejercitan la API, que importa los paquetes **compilados**
      // (`dist`), no `src`. Por eso `packages/db/src` aparece en 0% aunque cada
      // consulta pase por él en cada test de integración. La cobertura acá es de
      // los tests unitarios; la de integración se mide por criterio de salida,
      // no por porcentaje.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,

        /**
         * El borde HTTP: autenticación, contexto de empresa y catálogo de
         * errores. Lo atraviesa **cada** pedido, así que una rama sin ejercitar
         * acá es una rama que decide sobre todos.
         */
        'apps/api/src/http/**': {
          lines: 95,
          functions: 90,
          branches: 85,
        },

        /**
         * Los dos eslabones que esta fase volvió productivos.
         *
         * Son los que convierten una afirmación en un dato verificado —la
         * declaración profesional y la constatación contra ARCA— y por eso no
         * pueden volver a quedarse sin cobertura sin que el pipeline lo diga.
         * El umbral está en lo alcanzado menos un margen chico: subirlo más
         * exigiría tests del camino de error de la red, que hoy solo se puede
         * simular.
         */
        'apps/api/src/routes/afectaciones.ts': {
          lines: 85,
          functions: 95,
          branches: 75,
        },
        'apps/api/src/routes/comprobantes.ts': {
          lines: 85,
          functions: 95,
          branches: 75,
        },
        'packages/accounting-engine/src/**': {
          lines: 95,
          functions: 95,
          branches: 90,
        },
        // El motor de IVA se sostiene en sus negativas —no supone la alícuota,
        // no declara computable un crédito—, y una negativa que no se ejercita
        // en un test es una promesa. Mismo umbral que el motor contable.
        'packages/tax-engine/src/**': {
          lines: 95,
          functions: 95,
          branches: 90,
        },
        // La conciliación es donde un sistema contable miente más fácil: un
        // match plausible aprobado sin mirar deja los saldos cerrando y la
        // cuenta de un proveedor mal para siempre. Las tres reglas duras del
        // motor tienen que estar todas ejercitadas.
        // Los estados contables son afirmaciones sobre la situación patrimonial:
        // sus controles de cobertura son lo único que separa un balance correcto
        // de uno que cierra por casualidad.
        // Ramas en 88 y no en 90: quedan dos `?? 0n` defensivos que hoy son
        // inalcanzables —un guard anterior ya garantiza que el valor existe— y
        // contorsionar el código para eliminarlos lo dejaría peor de leer que el
        // punto de cobertura que se gana.
        'packages/financial-statements/src/**': {
          lines: 95,
          functions: 95,
          branches: 88,
        },
        // El motor de auditoría no usa IA: sus hallazgos son aritmética explicable
        // ante un tercero. Por eso se le puede exigir el mismo umbral que a los
        // demás motores determinísticos.
        'packages/audit-engine/src/**': {
          lines: 95,
          functions: 95,
          branches: 90,
        },
        'packages/bank-engine/src/**': {
          lines: 95,
          functions: 95,
          branches: 88,
        },
        // El candado del sandbox falla cerrado, y una rama del candado que no se
        // ejercita es una rama que nadie sabe de qué lado falla. Es el único
        // paquete donde el número no mide calidad de código sino cuántos caminos
        // hacia "sí, escribí" quedaron sin probar.
        'packages/sandbox/src/**': {
          lines: 95,
          functions: 95,
          branches: 90,
        },
      },
    },
  },
});
