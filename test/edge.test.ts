import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, definePipeline, stage, UnknownPipelineError, type Database, type Engine } from '../src/index.js';
import { backends, setup, sleep } from './helpers.js';

describe.each(backends)('edge cases ($name)', (backend) => {
  let engine: Engine;
  let db: Database;
  let close: () => Promise<void>;
  let sawAbort: boolean;

  const sync = definePipeline<{ fail?: 'error' | 'string' }>({
    name: 'sync',
    stages: [
      stage('plain', (ctx) => {
        if (ctx.input.fail === 'error') throw new Error('sync throw');
        if (ctx.input.fail === 'string') throw 'not an Error object'; // eslint-disable-line @typescript-eslint/only-throw-error
        return 'ok';
      }),
    ],
  });

  const long = definePipeline({
    name: 'long',
    stages: [
      stage('wait', async (ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          });
        });
        return 'never committed';
      }),
    ],
  });

  beforeEach(async () => {
    sawAbort = false;
    ({ engine, db, close } = await setup(backend, { pipelines: [sync, long] }));
  });
  afterEach(() => close());

  it('runs synchronous stages and records synchronous throws, including non-Error values', async () => {
    await engine.startRun('sync', {});
    expect((await engine.worker().runOnce())?.output).toBe('ok');

    await engine.startRun('sync', { fail: 'error' });
    expect((await engine.worker().runOnce())?.error).toMatch(/sync throw/);

    const r = await engine.startRun('sync', { fail: 'string' });
    expect((await engine.worker().runOnce())?.error).toMatch(/not an Error object/);
    const failed = (await engine.events(r.id)).at(-1);
    expect(failed).toMatchObject({ type: 'failed', data: { error: 'not an Error object' } });
  });

  it('aborts ctx.signal and commits nothing when the heartbeat finds the lease gone', async () => {
    const run = await engine.startRun('long', {});
    const w = engine.worker({ id: 'victim', leaseMs: 1_000, heartbeatMs: 20, pipelines: ['long'] });
    const done = w.runOnce();
    while ((await engine.getRun(run.id)).leaseOwner !== 'victim') await sleep(5);
    // Someone else (an operator, a split-brain peer) took the run.
    await db.query(`update runs set lease_owner = 'intruder' where id = $1`, [run.id]);

    const after = await done;
    expect(sawAbort).toBe(true);
    expect(after?.stages).toEqual([]);
    expect(after?.leaseOwner).toBe('intruder');
  });

  it('reject() without a reason records a default', async () => {
    const gated = definePipeline({
      name: 'gated-edge',
      stages: [stage('ask', async () => (await import('../src/index.js')).awaitApproval('proposal'))],
    });
    const e = createEngine({ db, pipelines: [gated] });
    const run = await e.startRun('gated-edge', undefined);
    expect(run.input).toBeNull();
    await e.worker().runOnce();
    const rejected = await e.reject(run.id);
    expect(rejected.error).toBe('rejected');
    expect((await e.events(run.id)).at(-1)?.data).toEqual({ by: null, reason: null });
  });

  it('reports background loop errors through onError and keeps polling', async () => {
    let armed = false;
    const flaky: Database = {
      ...db,
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => {
        if (armed) {
          armed = false;
          return Promise.reject(new Error('connection reset'));
        }
        return db.transaction(fn);
      },
    };
    const errors: unknown[] = [];
    const e = createEngine({ db: flaky, pipelines: [sync] });
    const run = await e.startRun('sync', {});
    armed = true; // the worker's first claim fails
    const w = e.worker({ pollIntervalMs: 10, onError: (err) => errors.push(err) });
    w.start();
    w.start(); // idempotent
    while ((await e.getRun(run.id)).status !== 'completed') await sleep(10);
    await w.stop();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/connection reset/);
  });

  it('validates configuration', () => {
    expect(() => createEngine({ db, pipelines: [sync, sync] })).toThrow(/registered twice/);
    expect(() => engine.worker({ pipelines: ['missing'] })).toThrow(UnknownPipelineError);
    expect(engine.pipelineNames).toEqual(['sync', 'long']);
  });
});
