import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePipeline, stage, type Engine } from '../src/index.js';
import { backends, deferred, setup, sleep, type Deferred } from './helpers.js';

// A worker whose heartbeat interval is longer than its lease behaves exactly
// like a process that was SIGKILLed mid-stage: its lease lapses while the
// stage is still "running". The hung stage lets us wake the zombie later and
// check that it cannot commit.

describe.each(backends)('crash recovery ($name)', (backend) => {
  let engine: Engine;
  let close: () => Promise<void>;
  let calls: Record<string, number>;
  let hang: Deferred | undefined;
  let keys: string[];

  const pipeline = definePipeline<{ n: number }>({
    name: 'crashy',
    stages: [
      stage('one', async (ctx) => {
        calls.one = (calls.one ?? 0) + 1;
        ctx.reportUsage({ costUsd: 0.01, inputTokens: 10, outputTokens: 5 });
        return ctx.input.n + 1;
      }),
      stage('two', async (ctx) => {
        calls.two = (calls.two ?? 0) + 1;
        keys.push(ctx.idempotencyKey);
        ctx.reportUsage({ costUsd: 0.02 });
        if (hang && ctx.attempt === 1) await hang.promise;
        return (ctx.outputs.one as number) * 10;
      }),
      stage('three', async (ctx) => {
        calls.three = (calls.three ?? 0) + 1;
        ctx.reportUsage({ costUsd: 0.04 });
        return { result: ctx.outputs.two };
      }),
    ],
  });

  let gate: Deferred;
  const slow = definePipeline({
    name: 'slow',
    stages: [
      stage('wait', async () => {
        await sleep(400);
        return 'done';
      }),
    ],
  });
  const stoppable = definePipeline({
    name: 'stoppable',
    stages: [
      stage('a', async () => {
        await gate.promise;
        return 1;
      }),
      stage('b', async () => 2),
    ],
  });

  beforeEach(async () => {
    gate = deferred();
    calls = {};
    keys = [];
    hang = undefined;
    ({ engine, close } = await setup(backend, { pipelines: [pipeline, slow, stoppable] }));
  });
  afterEach(async () => {
    hang?.resolve();
    await close();
  });

  async function crashDuringStageTwo(runId: string) {
    hang = deferred();
    const zombie = engine.worker({ id: 'zombie', leaseMs: 150, heartbeatMs: 60_000 });
    const zombieDone = zombie.runOnce();
    while (calls.two !== 1) await sleep(10);
    await sleep(200); // lease lapses
    const run = await engine.getRun(runId);
    expect(run.status).toBe('running');
    expect(run.leaseOwner).toBe('zombie');
    // Wrapped so the caller's await doesn't adopt the (still hung) promise.
    return { zombieDone };
  }

  it('resumes from the last committed stage without re-running earlier ones', async () => {
    const run = await engine.startRun('crashy', { n: 1 });
    const { zombieDone } = await crashDuringStageTwo(run.id);

    const done = await engine.worker({ id: 'rescuer' }).runOnce();
    expect(done?.status).toBe('completed');
    expect(done?.output).toEqual({ result: 20 });
    expect(calls).toEqual({ one: 1, two: 2, three: 1 });
    expect(done?.stages.map((s) => s.workerId)).toEqual(['zombie', 'rescuer', 'rescuer']);

    hang!.resolve();
    await zombieDone;
  });

  it('never double-bills: run cost equals the sum of committed stage costs', async () => {
    const run = await engine.startRun('crashy', { n: 1 });
    const { zombieDone } = await crashDuringStageTwo(run.id);
    await engine.worker({ id: 'rescuer' }).runOnce();
    hang!.resolve();
    await zombieDone;

    const final = await engine.getRun(run.id);
    const sum = final.stages.reduce((acc, s) => acc + s.costUsd, 0);
    expect(final.costUsd).toBeCloseTo(0.07, 10);
    expect(final.costUsd).toBeCloseTo(sum, 10);
    expect(final.inputTokens).toBe(10);
    expect(final.stages).toHaveLength(3);
  });

  it('records lease_expired and resumed when another worker takes over', async () => {
    const run = await engine.startRun('crashy', { n: 1 });
    const { zombieDone } = await crashDuringStageTwo(run.id);
    await engine.worker({ id: 'rescuer' }).runOnce();

    const events = await engine.events(run.id);
    const takeover = events.find((e) => e.type === 'lease_expired');
    expect(takeover).toMatchObject({ workerId: 'zombie', data: { takenOverBy: 'rescuer' } });
    expect(events.find((e) => e.type === 'resumed')).toMatchObject({ workerId: 'rescuer', data: { fromStage: 1 } });
    const starts = events.filter((e) => e.type === 'stage_started' && e.stage === 'two');
    expect(starts.map((e) => e.data.attempt)).toEqual([1, 2]);

    hang!.resolve();
    await zombieDone;
  });

  it('discards a zombie worker commit after its lease was taken', async () => {
    const run = await engine.startRun('crashy', { n: 1 });
    const { zombieDone } = await crashDuringStageTwo(run.id);

    // The rescuer claims but has not finished stage two yet when the zombie wakes.
    const rescuer = engine.worker({ id: 'rescuer' });
    const rescued = rescuer.runOnce();
    while ((await engine.getRun(run.id)).leaseOwner !== 'rescuer') await sleep(5);
    hang!.resolve();
    await zombieDone;
    await rescued;

    const final = await engine.getRun(run.id);
    expect(final.stages.find((s) => s.name === 'two')?.workerId).toBe('rescuer');
    expect(final.costUsd).toBeCloseTo(0.07, 10);
    const completedTwo = (await engine.events(run.id)).filter((e) => e.type === 'stage_completed' && e.stage === 'two');
    expect(completedTwo).toHaveLength(1);
  });

  it('keeps the same idempotency key for a stage across workers', async () => {
    const run = await engine.startRun('crashy', { n: 1 });
    const { zombieDone } = await crashDuringStageTwo(run.id);
    await engine.worker({ id: 'rescuer' }).runOnce();
    expect(keys).toEqual([`${run.id}:1`, `${run.id}:1`]);
    hang!.resolve();
    await zombieDone;
  });

  it('heartbeats keep a slow stage leased so nobody steals it', async () => {
    const run = await engine.startRun('slow', {});
    const owner = engine.worker({ id: 'owner', leaseMs: 150, heartbeatMs: 40, pipelines: ['slow'] });
    const owned = owner.runOnce();
    await sleep(250);
    expect(await engine.worker({ id: 'thief', pipelines: ['slow'] }).runOnce()).toBeNull();
    expect((await owned)?.status).toBe('completed');
    const types = (await engine.events(run.id)).map((e) => e.type);
    expect(types).not.toContain('lease_expired');
  });

  it('stop() releases a run between stages for another worker', async () => {
    const run = await engine.startRun('stoppable', {});
    const w = engine.worker({ id: 'first', pollIntervalMs: 10, pipelines: ['stoppable'] });
    w.start();
    while ((await engine.getRun(run.id)).status !== 'running') await sleep(5);
    const stopped = w.stop();
    gate.resolve();
    await stopped;

    const mid = await engine.getRun(run.id);
    expect(mid.status).toBe('pending');
    expect(mid.currentStage).toBe(1);
    const done = await engine.worker({ id: 'second' }).runOnce();
    expect(done?.status).toBe('completed');
    expect((await engine.events(run.id)).map((e) => e.type)).toContain('released');
  });
});
