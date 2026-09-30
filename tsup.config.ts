import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mcp: 'src/mcp/server.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: { entry: { index: 'src/index.ts', mcp: 'src/mcp/server.ts' } },
  clean: true,
  sourcemap: true,
  splitting: true,
});
