import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources (see the "@etp/source" export
// condition in each package.json), so tests never depend on a prior build.
const conditions = ['@etp/source'];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { conditions },
        ssr: { resolve: { conditions } },
        test: { name: 'shared', root: 'packages/shared', include: ['src/**/*.test.ts'] },
      },
      {
        resolve: { conditions },
        ssr: { resolve: { conditions } },
        test: { name: 'simulator', root: 'packages/simulator', include: ['src/**/*.test.ts'] },
      },
      {
        resolve: { conditions },
        ssr: { resolve: { conditions } },
        test: { name: 'api', root: 'packages/api', include: ['src/**/*.test.ts'] },
      },
      {
        resolve: { conditions },
        ssr: { resolve: { conditions } },
        test: {
          name: 'infra',
          root: 'packages/infra',
          include: ['{src,test}/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      // Lambda entry points and Powertools wiring are exercised by the deployed smoke test.
      exclude: [
        '**/*.test.ts',
        '**/test-helpers.ts',
        'packages/api/src/handlers/**',
        'packages/api/src/runtime.ts',
      ],
      reporter: ['text', 'lcov'],
      // NFR-6: 80 percent on shared, simulator, and api; Phase 2 sets 90 for shared.
      thresholds: {
        'packages/shared/src/**': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'packages/simulator/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'packages/api/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
});
