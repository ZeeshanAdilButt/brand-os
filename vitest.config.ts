import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const setupFile = fileURLToPath(new URL('./test/setup/no-network.ts', import.meta.url));

// Every project extends the root config so the network guard runs everywhere.
const project = (name: string, root: string, include: string[]) => ({
  extends: true as const,
  test: { name, root, include },
});

export default defineConfig({
  test: {
    setupFiles: [setupFile],
    passWithNoTests: true,
    // Every web test file opens its own embedded Postgres (a WASM engine). One worker per core ran a 20-core
    // machine with little free memory out of memory (a fatal V8 error), so the pool is capped.
    maxWorkers: 6,
    projects: [
      project('root', '.', ['test/**/*.test.ts']),
      ...['core', 'daemon', 'client', 'mcp', 'brand-mcp', 'cli'].map((pkg) =>
        project(pkg, `packages/${pkg}`, ['test/**/*.test.ts', 'src/**/*.test.ts']),
      ),
      // The Next.js app (apps/web). Component tests opt into jsdom with a per-file docblock.
      {
        extends: true as const,
        resolve: { alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) } },
        test: { name: 'web', root: 'apps/web', include: ['test/**/*.test.{ts,tsx}'], testTimeout: 30_000, hookTimeout: 60_000 },
      },
    ],
  },
});
