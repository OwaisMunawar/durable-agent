import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Postgres-backed suites share one server; keep files sequential so the
    // concurrency tests measure our locking, not vitest's scheduler.
    fileParallelism: false,
  },
});
