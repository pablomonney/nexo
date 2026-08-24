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
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        'packages/accounting-engine/src/**': {
          lines: 95,
          functions: 95,
          branches: 90,
        },
      },
    },
  },
});
