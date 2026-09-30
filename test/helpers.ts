import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { MockLanguageModelV4 } from 'ai/test';
import pg from 'pg';
import { createEngine, fromPGlite, fromPg, type Database, type Engine, type EngineOptions } from '../src/index.js';

export interface TestDb {
  db: Database;
  close(): Promise<void>;
}

export interface Backend {
  name: string;
  create(): Promise<TestDb>;
}

// Booting PGlite takes seconds; creating a schema takes milliseconds. Each
// file shares one in-process database and every test gets a fresh schema.
// PGlite has a single session, so only one engine may be live at a time.
let shared: Promise<PGlite> | undefined;

function schemaName(): string {
  return `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

const pglite: Backend = {
  name: 'pglite',
  async create() {
    shared ??= PGlite.create();
    const client = await shared;
    const schema = schemaName();
    await client.exec(`create schema ${schema}; set search_path to ${schema}`);
    return {
      db: fromPGlite(client),
      async close() {
        await client.exec(`set search_path to public; drop schema ${schema} cascade`);
      },
    };
  },
};

function postgres(url: string): Backend {
  return {
    name: 'postgres',
    async create() {
      // One schema per test keeps tests isolated without truncating the
      // append-only events table (which the trigger would refuse anyway).
      const schema = schemaName();
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query(`create schema ${schema}`);
      await admin.end();
      const pool = new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
      return {
        db: fromPg(pool),
        async close() {
          await pool.end();
          const c = new pg.Client({ connectionString: url });
          await c.connect();
          await c.query(`drop schema ${schema} cascade`);
          await c.end();
        },
      };
    },
  };
}

/** PGlite always; real Postgres too when TEST_DATABASE_URL is set (CI does). */
export const backends: Backend[] = [pglite];
if (process.env.TEST_DATABASE_URL) backends.push(postgres(process.env.TEST_DATABASE_URL));

export async function setup(
  backend: Backend,
  options: Omit<EngineOptions, 'db'>,
): Promise<{ engine: Engine; db: Database; close: () => Promise<void> }> {
  const testDb = await backend.create();
  const engine = createEngine({ ...options, db: testDb.db });
  await engine.migrate();
  return { engine, db: testDb.db, close: () => testDb.close() };
}

/** A deterministic model that reports fixed usage and echoes the prompt. */
export function mockModel(
  opts: { inputTokens?: number; outputTokens?: number; reply?: (prompt: string) => string } = {},
) {
  return new MockLanguageModelV4({
    modelId: 'mock-model',
    doGenerate: async (call) => {
      const prompt = JSON.stringify(call.prompt);
      return {
        content: [{ type: 'text', text: opts.reply ? opts.reply(prompt) : `ok:${prompt.length}` }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: opts.inputTokens ?? 100,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: opts.outputTokens ?? 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

/** A promise you can resolve from the outside. */
export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
