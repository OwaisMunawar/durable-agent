import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePipeline, priceUsage, stage, type Engine } from '../src/index.js';
import { backends, setup } from './helpers.js';

describe.each(backends)('cost limits and failures ($name)', (backend) => {
  let engine: Engine;
  let close: () => Promise<void>;
  let ran: string[];
  let flaky: number;

  const expensive = definePipeline({
    name: 'expensive',
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    stages: ['a', 'b', 'c', 'd'].map((name) =>
      stage(name, async (ctx) => {
        ran.push(name);
        ctx.reportUsage({ inputTokens: 100_000, outputTokens: 20_000 }); // $0.60
        return name;
      }),
    ),
  });

  const unreliable = definePipeline({
    name: 'unreliable',
    stages: [
      stage(
        'flaky',
        async (ctx) => {
          flaky++;
          ctx.reportUsage({ costUsd: 0.01 });
          if (flaky < 3) throw new Error(`boom ${flaky}`);
          return 'recovered';
        },
        { retries: 2, retryDelayMs: 1 },
      ),
      stage('broken', async (ctx) => {
        ctx.reportUsage({ costUsd: 0.001 });
        throw new Error('permanently broken');
      }),
    ],
  });

  beforeEach(async () => {
    ran = [];
    flaky = 0;
    ({ engine, close } = await setup(backend, { pipelines: [expensive, unreliable] }));
  });
  afterEach(() => close());

  it('stops cleanly before the next stage once the budget is spent', async () => {
    const run = await engine.startRun('expensive', {}, { budgetUsd: 1.0 });
    const done = (await engine.worker().runOnce())!;
    expect(done.status).toBe('budget_exceeded');
    expect(ran).toEqual(['a', 'b']);
    expect(done.costUsd).toBeCloseTo(1.2, 10);
    expect(done.budgetUsd).toBe(1);
    expect(done.currentStage).toBe(2);
    const last = (await engine.events(run.id)).at(-1);
    expect(last).toMatchObject({ type: 'budget_exceeded', stage: 'c' });
  });

  it('runs to completion when the budget is sufficient', async () => {
    const done = (await (async () => {
      await engine.startRun('expensive', {}, { budgetUsd: 10 });
      return engine.worker().runOnce();
    })())!;
    expect(done.status).toBe('completed');
    expect(done.costUsd).toBeCloseTo(2.4, 10);
  });

  it('retries a throwing stage, keeps the spend of failed attempts, then fails the run', async () => {
    const run = await engine.startRun('unreliable', {});
    const done = (await engine.worker().runOnce())!;
    expect(flaky).toBe(3);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/stage "broken" failed.*permanently broken/);
    expect(done.stages.map((s) => s.name)).toEqual(['flaky']);
    // 3 flaky attempts at $0.01 plus the broken stage's $0.001.
    expect(done.costUsd).toBeCloseTo(0.031, 10);
    const types = (await engine.events(run.id)).map((e) => e.type);
    expect(types.filter((t) => t === 'stage_retry')).toHaveLength(2);
    expect(types.at(-1)).toBe('failed');
  });
});

describe('priceUsage', () => {
  it('prefers an explicit cost, then a model table, then the default entry', () => {
    const table = { 'gpt-x': { inputPerMTok: 1, outputPerMTok: 2 }, default: { inputPerMTok: 10, outputPerMTok: 10 } };
    expect(priceUsage({ costUsd: 0.5, inputTokens: 1e6 }, table)).toBe(0.5);
    expect(priceUsage({ modelId: 'gpt-x', inputTokens: 1e6, outputTokens: 1e6 }, table)).toBe(3);
    expect(priceUsage({ modelId: 'other', inputTokens: 1e6 }, table)).toBe(10);
    expect(priceUsage({ inputTokens: 1e6 }, (u) => u.inputTokens / 1e6)).toBe(1);
    expect(priceUsage({ inputTokens: 1e6 }, undefined)).toBe(0);
    expect(priceUsage({ modelId: 'other', inputTokens: 1e6 }, { 'gpt-x': { inputPerMTok: 1, outputPerMTok: 1 } })).toBe(
      0,
    );
  });
});
