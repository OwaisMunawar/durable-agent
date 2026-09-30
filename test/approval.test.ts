import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awaitApproval, definePipeline, InvalidStateError, stage, type Engine } from '../src/index.js';
import { backends, setup } from './helpers.js';

describe.each(backends)('human approval gate ($name)', (backend) => {
  let engine: Engine;
  let close: () => Promise<void>;
  let finalizeInput: unknown;

  const pipeline = definePipeline<{ topic: string }>({
    name: 'gated',
    stages: [
      stage('draft', async (ctx) => {
        ctx.reportUsage({ costUsd: 0.05 });
        return awaitApproval({ title: `About ${ctx.input.topic}` });
      }),
      stage('publish', async (ctx) => {
        finalizeInput = ctx.outputs.draft;
        return { published: ctx.outputs.draft };
      }),
    ],
  });

  beforeEach(async () => {
    finalizeInput = undefined;
    ({ engine, close } = await setup(backend, { pipelines: [pipeline] }));
  });
  afterEach(() => close());

  it('pauses in awaiting_approval with the proposal persisted and billed once', async () => {
    const run = await engine.startRun('gated', { topic: 'leases' });
    const paused = (await engine.worker().runOnce())!;

    expect(paused.status).toBe('awaiting_approval');
    expect(paused.leaseOwner).toBeNull();
    expect(paused.pendingApproval).toEqual({ stage: 'draft', stageIndex: 0, proposal: { title: 'About leases' } });
    expect(paused.costUsd).toBeCloseTo(0.05, 10);

    const pending = await engine.listPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ runId: run.id, pipeline: 'gated', stage: 'draft' });

    // Workers leave paused runs alone.
    expect(await engine.worker().runOnce()).toBeNull();
  });

  it('continues after approve() and hands the approved proposal to the next stage', async () => {
    const run = await engine.startRun('gated', { topic: 'leases' });
    await engine.worker().runOnce();
    const approved = await engine.approve(run.id, { by: 'owais', note: 'ship it' });
    expect(approved.status).toBe('pending');

    const done = (await engine.worker().runOnce())!;
    expect(done.status).toBe('completed');
    expect(finalizeInput).toEqual({ title: 'About leases' });
    expect(done.costUsd).toBeCloseTo(0.05, 10);
    expect(await engine.listPendingApprovals()).toEqual([]);

    const approvedEvent = (await engine.events(run.id)).find((e) => e.type === 'approved');
    expect(approvedEvent?.data).toEqual({ by: 'owais', note: 'ship it', edited: false });
  });

  it('lets the reviewer replace the proposal with an edited value', async () => {
    const run = await engine.startRun('gated', { topic: 'leases' });
    await engine.worker().runOnce();
    await engine.approve(run.id, { value: { title: 'Edited title' } });
    const done = (await engine.worker().runOnce())!;
    expect(finalizeInput).toEqual({ title: 'Edited title' });
    expect(done.stages[0]?.output).toEqual({ title: 'Edited title' });
  });

  it('ends the run on reject() without running later stages', async () => {
    const run = await engine.startRun('gated', { topic: 'leases' });
    await engine.worker().runOnce();
    const rejected = await engine.reject(run.id, { reason: 'off-topic', by: 'owais' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.error).toBe('off-topic');
    expect(await engine.worker().runOnce()).toBeNull();
    expect(finalizeInput).toBeUndefined();
    const types = (await engine.events(run.id)).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['awaiting_approval', 'rejected']);
  });

  it('refuses to approve or reject a run that is not waiting', async () => {
    const run = await engine.startRun('gated', { topic: 'leases' });
    await expect(engine.approve(run.id)).rejects.toBeInstanceOf(InvalidStateError);
    await engine.worker().runOnce();
    await engine.approve(run.id);
    await expect(engine.approve(run.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(engine.reject(run.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
