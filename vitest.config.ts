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
      },
    },
  },
});
