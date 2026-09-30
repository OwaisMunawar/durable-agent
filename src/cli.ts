#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { PGlite as PGliteClass } from '@electric-sql/pglite';
import pg from 'pg';
import { fromPGlite, fromPg, type Database } from './db.js';
import { createEngine, type AnyPipeline } from './engine.js';
import { createMcpServer } from './mcp/server.js';

const USAGE = `usage:
  durable-agent migrate
  durable-agent mcp --pipelines <module> [--worker] [--pglite <dir>]

Connects to DATABASE_URL. Without it, falls back to an embedded PGlite
database (in memory, or persisted to --pglite <dir>).

  --pipelines  module whose default export (or \`pipelines\` export) is a
               pipeline or an array of pipelines
  --worker     also run a worker in this process so queued runs execute`;

// stdout belongs to the MCP protocol; everything human-readable goes to stderr.
const log = (msg: string) => process.stderr.write(`[durable-agent] ${msg}\n`);

async function openDatabase(pgliteDir: string | undefined): Promise<{ db: Database; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    return { db: fromPg(pool), close: () => pool.end() };
  }
  let PGlite: typeof PGliteClass;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    throw new Error('DATABASE_URL is not set and @electric-sql/pglite is not installed');
  }
  log(`DATABASE_URL not set; using PGlite ${pgliteDir ? `at ${pgliteDir}` : 'in memory'}`);
  const client = await PGlite.create(pgliteDir);
  return { db: fromPGlite(client), close: () => client.close() };
}

function isPipeline(value: unknown): value is AnyPipeline {
  return typeof value === 'object' && value !== null && 'name' in value && 'stages' in value;
}

async function loadPipelines(path: string): Promise<AnyPipeline[]> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  const exported = mod.default ?? mod.pipelines ?? mod.pipeline;
  const list: unknown[] = Array.isArray(exported) ? exported : [exported];
  if (!list.every(isPipeline)) throw new Error(`${path} does not export a pipeline or an array of pipelines`);
  return list;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      pipelines: { type: 'string' },
      worker: { type: 'boolean', default: false },
      pglite: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(values.help ? 0 : 1);
  }

  const { db, close } = await openDatabase(values.pglite);

  if (command === 'migrate') {
    await createEngine({ db, pipelines: [] }).migrate();
    log('migrated');
    await close();
    return;
  }

  if (command !== 'mcp') throw new Error(`unknown command "${command}"\n${USAGE}`);
  if (!values.pipelines) throw new Error('--pipelines is required');

  const pipelines = await loadPipelines(values.pipelines);
  const engine = createEngine({ db, pipelines });
  await engine.migrate();

  const worker = values.worker
    ? engine.worker({
        pollIntervalMs: 500,
        onError: (err) => {
          log(`worker error: ${err instanceof Error ? err.message : String(err)}`);
        },
      })
    : undefined;
  worker?.start();

  const server = createMcpServer(engine);
  await server.connect(new StdioServerTransport());
  log(`serving ${engine.pipelineNames.join(', ')}${worker ? ` with worker ${worker.id}` : ''}`);

  const shutdown = async () => {
    await worker?.stop();
    await server.close();
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
