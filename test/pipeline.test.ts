import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  definePipeline,
  stage,
  UnknownPipelineError,
  RunNotFoundError,
  type Engine,
  type RunEvent,
} from '../src/index.js';
import { backends, mockModel, setup } from './helpers.js';

const pricing = { inputPerMTok: 1, outputPerMTok: 2 };

describe.each(backends)('pipeline execution ($name)', (backend) => {
  let engine: Engine;
  let close: () => Promise<void>;
  const seen: RunEvent[] = [];
  const model = mockModel({ inputTokens: 100, outputTokens: 50 });

  const summarise = definePipeline<{ text: string }>({
    name: 'summarise',
    pricing,
    stages: [
      stage('upper', async (ctx) => ctx.input.text.toUpperCase()),
      stage('llm', async (ctx) => {
        const { text } = await ctx.generateText({ model, prompt: String(ctx.outputs.upper) });
        return { text, key: ctx.idempotencyKey };
      }),
      stage('count', async (ctx) => {
        // The previous stage's row is committed before this stage starts.
        const { rows } = await engine.db.query<{ n: number }>(
          'select count(*)::int as n from stage_results where run_id = $1',
          [ctx.runId],
        );
        return { committedBefore: rows[0]!.n };
      }),
    ],
  });

  beforeEach(async () => {
    seen.length = 0;
    ({ engine, close } = await setup(backend, { pipelines: [summarise], onEvent: (e) => seen.push(e) }));
  });
  afterEach(() => close());

  it('runs every stage in order and passes outputs forward', async () => {
    const run = await engine.startRun('summarise', { text: 'hello' });
    expect(run.status).toBe('pending');

    const done = await engine.worker({ id: 'w1' }).runOnce();
    expect(done?.status).toBe('completed');
    expect(done?.stages.map((s) => s.name)).toEqual(['upper', 'llm', 'count']);
    expect(done?.stages[0]?.output).toBe('HELLO');
    expect(done?.output).toEqual({ committedBefore: 2 });
  });

  it('meters tokens from ctx.generateText and prices them', async () => {
    const run = await engine.startRun('summarise', { text: 'hello' });
    const done = (await engine.worker().runOnce())!;
    const llm = done.stages[1]!;
    expect(llm.inputTokens).toBe(100);
    expect(llm.outputTokens).toBe(50);
    expect(llm.costUsd).toBeCloseTo(0.0002, 10);
    expect(done.costUsd).toBeCloseTo(0.0002, 10);
    expect(model.doGenerateCalls.at(-1)?.headers?.['idempotency-key']).toBe(`${run.id}:1`);
  });

  it('writes the audit trail and reports it through onEvent after commit', async () => {
    const run = await engine.startRun('summarise', { text: 'x' });
    await engine.worker({ id: 'w1' }).runOnce();
    const types = (await engine.events(run.id)).map((e) => e.type);
    expect(types).toEqual([
      'created',
      'started',
      'stage_started',
      'stage_completed',
      'stage_started',
      'stage_completed',
      'stage_started',
      'stage_completed',
      'completed',
    ]);
    expect(seen.map((e) => e.type)).toEqual(types);
  });

  it('treats startRun with an existing runId as idempotent', async () => {
    const id = '5f8a3c2e-1111-4a4a-9b9b-000000000001';
    await engine.startRun('summarise', { text: 'a' }, { runId: id });
    const again = await engine.startRun('summarise', { text: 'b' }, { runId: id });
    expect(again.input).toEqual({ text: 'a' });
    expect((await engine.events(id)).filter((e) => e.type === 'created')).toHaveLength(1);
  });

  it('returns null when there is nothing to claim', async () => {
    expect(await engine.worker().runOnce()).toBeNull();
  });

  it('migrate is idempotent', async () => {
    await engine.migrate();
    await engine.migrate();
    const run = await engine.startRun('summarise', { text: 'still works' });
    expect(run.id).toBeTruthy();
  });

  it('throws typed errors for unknown pipelines and runs', async () => {
    await expect(engine.startRun('nope', {})).rejects.toBeInstanceOf(UnknownPipelineError);
    await expect(engine.getRun('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    await expect(engine.getRun('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe('definePipeline', () => {
  it('rejects empty and duplicate-stage pipelines', () => {
    expect(() => definePipeline({ name: 'x', stages: [] })).toThrow(/no stages/);
    expect(() =>
      definePipeline({
        name: 'x',
        stages: [stage('a', async () => 1), stage('a', async () => 2)],
      }),
    ).toThrow(/duplicate stage/);
  });
});
