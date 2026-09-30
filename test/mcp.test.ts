import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awaitApproval, definePipeline, stage, type Engine, type RunSnapshot } from '../src/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import { backends, setup } from './helpers.js';

const review = definePipeline<{ text: string }>({
  name: 'review',
  stages: [
    stage('propose', (ctx) => awaitApproval({ text: ctx.input.text.trim() })),
    stage('apply', (ctx) => ({ applied: ctx.outputs.propose })),
  ],
});

describe.each(backends.slice(0, 1))('MCP server ($name)', (backend) => {
  let engine: Engine;
  let close: () => Promise<void>;
  let client: Client;

  beforeEach(async () => {
    ({ engine, close } = await setup(backend, { pipelines: [review] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(engine).connect(serverSide);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
  });
  afterEach(async () => {
    await client.close();
    await close();
  });

  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as { type: string; text: string }[];
    if (res.isError) throw new Error(content[0]?.text);
    return JSON.parse(content[0]!.text) as T;
  }

  it('lists the five tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'approve',
      'get_run',
      'list_pending_approvals',
      'reject',
      'start_run',
    ]);
  });

  it('drives a run through start, approval and completion', async () => {
    const started = await call<RunSnapshot>('start_run', { pipeline: 'review', input: { text: ' hi ' } });
    expect(started.status).toBe('pending');

    await engine.worker().runOnce();
    const pending = await call<{ runId: string; proposal: unknown }[]>('list_pending_approvals');
    expect(pending).toEqual([expect.objectContaining({ runId: started.id, proposal: { text: 'hi' } })]);

    await call('approve', { runId: started.id, value: { text: 'edited' }, note: 'lgtm' });
    await engine.worker().runOnce();

    const run = await call<RunSnapshot & { events: { type: string }[] }>('get_run', {
      runId: started.id,
      includeEvents: true,
    });
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ applied: { text: 'edited' } });
    expect(run.events.map((e) => e.type)).toContain('approved');
  });

  it('rejects through the reject tool and reports library errors as tool errors', async () => {
    const started = await call<RunSnapshot>('start_run', { pipeline: 'review', input: { text: 'x' } });
    await expect(call('approve', { runId: started.id })).rejects.toThrow(/INVALID_STATE/);
    await engine.worker().runOnce();
    const rejected = await call<RunSnapshot>('reject', { runId: started.id, reason: 'no' });
    expect(rejected.status).toBe('rejected');
    await expect(call('start_run', { pipeline: 'missing', input: {} })).rejects.toThrow(/UNKNOWN_PIPELINE/);
  });

  it('surfaces unexpected errors instead of reporting them as tool results', async () => {
    // Not a DurableAgentError: Postgres rejects the malformed uuid.
    await expect(call('get_run', { runId: 'not-a-uuid' })).rejects.toThrow(/uuid/);
  });
});
