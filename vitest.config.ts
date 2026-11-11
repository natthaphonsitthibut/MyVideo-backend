import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const lib = (name: string) => fileURLToPath(new URL(`./libs/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Nest needs legacy decorators + design-time metadata (same as tsconfig.base.json).
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  resolve: {
    alias: {
      '@myvideo/domain': lib('domain'),
      '@myvideo/contracts': lib('contracts'),
      '@myvideo/infra': lib('infra'),
    },
  },
  test: {
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['apps/*/src/**/*.test.ts', 'libs/*/src/**/*.test.ts'],
        },
      },
      {
        // Integration tests share one real test database → run files one at a time.
        extends: true,
        test: {
          name: 'int',
          include: ['apps/*/test/**/*.int.test.ts', 'libs/*/test/**/*.int.test.ts'],
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
