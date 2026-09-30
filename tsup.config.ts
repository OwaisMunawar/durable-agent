import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mcp: 'src/mcp/server.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: {
    entry: { index: 'src/index.ts', mcp: 'src/mcp/server.ts' },
    // tsup's declaration build sets baseUrl, which TypeScript 6 flags as deprecated.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  clean: true,
  sourcemap: true,
  splitting: true,
});
