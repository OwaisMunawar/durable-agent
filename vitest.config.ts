import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Postgres-backed suites share one server; keep files sequential so the
    // concurrency tests measure our locking, not vitest's scheduler.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The CLI is a thin argv/stdio shell around createMcpServer, which is covered.
      exclude: ['src/cli.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
