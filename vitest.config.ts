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
    include: [
      'apps/*/src/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'libs/*/src/**/*.test.ts',
      'libs/*/test/**/*.test.ts',
    ],
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
