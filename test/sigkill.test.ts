import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, fromPg, type Engine } from '../src/index.js';
import { slowPipeline } from './fixtures/slow-pipeline.js';
import { sleep } from './helpers.js';

// The in-process crash tests simulate a dead worker. This one kills a real
// process with SIGKILL, so it needs a Postgres server both processes can reach.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('SIGKILL of a worker process (postgres)', () => {
  const schema = `k_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: pg.Pool;
  let engine: Engine;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    engine = createEngine({ db: fromPg(pool), pipelines: [slowPipeline] });
    await engine.migrate();
  });

  afterAll(async () => {
    await pool.query(`drop schema ${schema} cascade`);
    await pool.end();
  });

  it('resumes on another process with no stage billed twice', async () => {
    const run = await engine.startRun('slow-steps', {});
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./fixtures/kill-target.ts', import.meta.url))],
      { env: { ...process.env, DATABASE_URL: url, SCHEMA: schema }, stdio: 'inherit' },
    );

    // Kill as soon as stage "b" is in flight.
    for (;;) {
      const events = await engine.events(run.id);
      if (events.some((e) => e.type === 'stage_started' && e.stage === 'b')) break;
      await sleep(10);
    }
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    const mid = await engine.getRun(run.id);
    expect(mid.status).toBe('running');
    expect(mid.stages.map((s) => s.name)).toEqual(['a']);

    await sleep(600); // child's lease lapses
    const done = (await engine.worker({ id: 'parent' }).runOnce())!;

    expect(done.status).toBe('completed');
    expect(done.stages.map((s) => s.output)).toEqual(['a:child', 'b:parent', 'c:parent']);
    expect(done.costUsd).toBeCloseTo(0.75, 10);
    expect(done.inputTokens).toBe(3000);
    const types = (await engine.events(run.id)).map((e) => e.type);
    expect(types).toContain('lease_expired');
  });
});
