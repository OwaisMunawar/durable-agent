import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePipeline, stage, type Engine } from '../src/index.js';
import { backends, setup, sleep } from './helpers.js';

describe.each(backends)('concurrent workers ($name)', (backend) => {
  let engine: Engine;
  let close: () => Promise<void>;
  const executions = new Map<string, number>();

  const pipeline = definePipeline<{ i: number }>({
    name: 'fanout',
    stages: ['fetch', 'think', 'write'].map((name) =>
      stage(name, async (ctx) => {
        const key = `${ctx.runId}:${name}`;
        executions.set(key, (executions.get(key) ?? 0) + 1);
        ctx.reportUsage({ costUsd: 0.001 });
        await sleep(Math.random() * 15);
        return `${name}-${ctx.input.i}`;
      }),
    ),
  });

  beforeEach(async () => {
    executions.clear();
    ({ engine, close } = await setup(backend, { pipelines: [pipeline] }));
  });
  afterEach(() => close());

  it('executes every stage of every run exactly once across competing workers', async () => {
    const runs = await Promise.all(Array.from({ length: 12 }, (_, i) => engine.startRun('fanout', { i })));
    const workers = Array.from({ length: 5 }, (_, i) => engine.worker({ id: `w${i}` }));
    const driven = await Promise.all(workers.map((w) => w.drain()));

    expect(driven.reduce((a, b) => a + b, 0)).toBe(12);
    expect(executions.size).toBe(36);
    expect([...executions.values()].every((n) => n === 1)).toBe(true);

    for (const r of runs) {
      const snap = await engine.getRun(r.id);
      expect(snap.status).toBe('completed');
      expect(snap.costUsd).toBeCloseTo(0.003, 10);
      const completed = (await engine.events(r.id)).filter((e) => e.type === 'stage_completed');
      expect(completed).toHaveLength(3);
    }
  });

  it('start()/stop() background workers pick up runs queued later', async () => {
    const workers = Array.from({ length: 3 }, (_, i) => engine.worker({ id: `bg${i}`, pollIntervalMs: 20 }));
    for (const w of workers) w.start();
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => engine.startRun('fanout', { i })));

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snaps = await Promise.all(runs.map((r) => engine.getRun(r.id)));
      if (snaps.every((s) => s.status === 'completed')) break;
      await sleep(20);
    }
    await Promise.all(workers.map((w) => w.stop()));
    expect([...executions.values()].every((n) => n === 1)).toBe(true);
    expect(executions.size).toBe(18);
  });
});
