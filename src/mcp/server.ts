import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import { DurableAgentError } from '../errors.js';

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  name?: string;
  version?: string;
}

/**
 * Expose an engine over the Model Context Protocol so an MCP client
 * (Claude Desktop, Cursor, ...) can start runs, inspect them and act as the
 * human in the loop. Connect it to any transport, e.g. `StdioServerTransport`.
 *
 * The server only writes to the database; pair it with a {@link Worker}
 * (the CLI's `--worker` flag does this) so queued runs actually execute.
 */
export function createMcpServer(engine: Engine, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: options.name ?? 'durable-agent', version: options.version ?? '0.1.0' });

  server.registerTool(
    'start_run',
    {
      title: 'Start run',
      description: `Queue a new pipeline run. Available pipelines: ${engine.pipelineNames.join(', ')}.`,
      inputSchema: {
        pipeline: z.string().describe('Pipeline name'),
        input: z.unknown().describe('Pipeline input, passed to the first stage as ctx.input'),
        budgetUsd: z.number().positive().optional().describe('Stop the run once spend reaches this many USD'),
      },
    },
    ({ pipeline, input, budgetUsd }) =>
      handle(() => engine.startRun(pipeline, input, budgetUsd === undefined ? {} : { budgetUsd })),
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description: 'Status, stage outputs, token usage, cost and (optionally) the audit log of a run.',
      inputSchema: {
        runId: z.string().describe('Run id returned by start_run'),
        includeEvents: z.boolean().optional().describe('Include the append-only event log'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ runId, includeEvents }) =>
      handle(async () => {
        const run = await engine.getRun(runId);
        return includeEvents ? { ...run, events: await engine.events(runId) } : run;
      }),
  );

  server.registerTool(
    'list_pending_approvals',
    {
      title: 'List pending approvals',
      description: 'Runs paused at a human approval gate, with the proposal awaiting review.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => handle(() => engine.listPendingApprovals()),
  );

  server.registerTool(
    'approve',
    {
      title: 'Approve',
      description: 'Approve the pending proposal of a run so it continues. Optionally replace the proposal.',
      inputSchema: {
        runId: z.string(),
        value: z.unknown().optional().describe('Edited proposal; omit to accept it unchanged'),
        note: z.string().optional(),
      },
    },
    ({ runId, value, note }) =>
      handle(() =>
        engine.approve(runId, {
          by: 'mcp',
          ...(value === undefined ? {} : { value }),
          ...(note === undefined ? {} : { note }),
        }),
      ),
  );

  server.registerTool(
    'reject',
    {
      title: 'Reject',
      description: 'Reject the pending proposal of a run. The run ends in status "rejected".',
      inputSchema: { runId: z.string(), reason: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    ({ runId, reason }) =>
      handle(() => engine.reject(runId, { by: 'mcp', ...(reason === undefined ? {} : { reason }) })),
  );

  return server;
}

async function handle(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Library errors are the caller's problem (bad id, wrong state) and are
    // reported to the model; anything else is a bug and should surface.
    if (err instanceof DurableAgentError) {
      return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
    }
    throw err;
  }
}
