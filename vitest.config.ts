import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup-env.ts'],
    include: ['packages/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
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
