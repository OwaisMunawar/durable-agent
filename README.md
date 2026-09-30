# durable-agent

Crash-safe, resumable LLM pipelines on Postgres. Kill a worker mid-call and another one picks up from the last committed stage, without re-running or re-billing the stages that already finished.

[![CI](https://github.com/OwaisMunawar/durable-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/OwaisMunawar/durable-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/types-strict-3178c6.svg)](tsconfig.json)

```text
$ npm run crash-demo

>> queued run e6b1b81e: extract -> draft -> [approval] -> finalize

[worker-a] claimed run e6b1b81e
[worker-a] extract   started    attempt 1
[worker-a] extract   committed   178 tok  $0.000200
[worker-a] draft     started    attempt 1

!! kill -9 39749  (worker-a was mid-call in "draft")
   postgres: status=running, lease=worker-a, committed=extract, cost=$0.000200

[worker-b] lease of worker-a expired, taking over
[worker-b] resumed at stage 2/3 (already committed: extract)
[worker-b] draft     started    attempt 2
[worker-b] draft     committed   316 tok  $0.000392
[worker-b] draft     paused for human approval, lease released

>> reviewer approves 7 user stories

[worker-b] finalize  committed   267 tok  $0.000116
[worker-b] run completed, total $0.000708

run total $0.000708 = sum of committed stages $0.000708  OK
```

Full transcript, including the audit log: [docs/crash-demo.txt](docs/crash-demo.txt). The script that produces it is [scripts/crash-demo.ts](scripts/crash-demo.ts) and runs in CI on every push.

## Why

The usual way to put an LLM workflow behind an API is to hold the request open while the model works. A four-step agent run takes minutes. During those minutes a deploy, an OOM kill, a spot instance reclaim or a dropped connection throws away every step that already finished, and you pay for those tokens again when the user retries. Nobody finds out which steps ran, what they cost, or who approved what.

durable-agent treats a run as a state machine stored in Postgres. Each stage's output and token cost are committed in one transaction before the next stage starts. Workers hold a lease on the run and renew it with a heartbeat. When a worker dies its lease lapses and any other worker continues from the last commit. Completed stages are never executed again, so they are never billed again.

If you already run Postgres, this adds no new infrastructure: no queue, no orchestrator, no workflow server.

## Features

- **Committed stages.** Output, token usage and the run cursor move in one transaction. A stage's result is recorded at most once.
- **Leases and takeover.** Workers claim runs with `SELECT ... FOR UPDATE SKIP LOCKED` and keep a heartbeat lease. A worker that loses its lease cannot commit: the commit transaction re-checks ownership under a row lock.
- **Idempotency keys.** Every stage gets `ctx.idempotencyKey` (`<runId>:<stageIndex>`), identical across retries and workers, and it is sent as the `Idempotency-Key` header on `ctx.generateText` calls. Use it for your own side effects too.
- **Human-in-the-loop gates.** Return `awaitApproval(proposal)` from a stage. The run parks in `awaiting_approval`, holding no worker and no connection, until `approve(runId, { value? })` or `reject(runId)` is called. The reviewer can edit the proposal.
- **Append-only audit log.** Every transition is written to `events`. A trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`, so the history cannot be rewritten by application code.
- **Cost metering and budgets.** Stages report usage (automatically through `ctx.generateText`), priced per model. Run totals are exact integer micro-dollar sums. `budgetUsd` stops a run cleanly before the next stage once spend reaches the limit.
- **Any model.** Stages call the [Vercel AI SDK](https://ai-sdk.dev) v7, so any provider it supports works. Tests use `MockLanguageModelV4`.
- **MCP server.** `start_run`, `get_run`, `list_pending_approvals`, `approve` and `reject` as MCP tools, so Claude Desktop or Cursor can drive pipelines and act as the reviewer.
- **Runs on `pg` or PGlite.** The engine talks to a four-method `Database` interface. PGlite gives you an in-process Postgres for tests and demos.

## Architecture

A run's lifecycle. Terminal states are never left.

```mermaid
stateDiagram-v2
    [*] --> pending: startRun()
    pending --> running: worker claims<br/>FOR UPDATE SKIP LOCKED
    running --> running: stage committed<br/>(output + cost + cursor, one tx)
    running --> running: lease expired,<br/>another worker claims
    running --> pending: worker.stop()<br/>releases between stages
    running --> awaiting_approval: stage returns awaitApproval()
    awaiting_approval --> pending: approve()
    awaiting_approval --> rejected: reject()
    running --> completed: last stage committed
    running --> failed: retries exhausted
    running --> budget_exceeded: spend >= budgetUsd
    completed --> [*]
    failed --> [*]
    rejected --> [*]
    budget_exceeded --> [*]
```

What happens when a worker is killed in the middle of a stage:

```mermaid
sequenceDiagram
    participant A as Worker A
    participant PG as Postgres
    participant B as Worker B
    A->>PG: claim run (SKIP LOCKED), lease_owner=A, lease 30s
    A->>PG: event started
    A->>A: stage "extract" (model call)
    A->>PG: BEGIN, check lease, insert stage_results[0], cost += c0, cursor = 1, COMMIT
    A->>A: stage "draft" (model call in flight)
    Note over A: kill -9, no heartbeat
    B->>PG: claim where status=running and lease_expires_at < now()
    PG-->>B: run at cursor 1
    B->>PG: events lease_expired (A), resumed (B)
    B->>B: stage "draft", same idempotency key
    B->>PG: BEGIN, check lease, insert stage_results[1], cost += c1, cursor = 2, COMMIT
    Note over A,B: If A were only paused and woke up now, its commit would<br/>fail the lease check and be rolled back.
```

Three tables: `runs` (one row per run: status, cursor, totals, lease), `stage_results` (one row per committed stage, primary key `(run_id, stage_index)`), and `events` (append-only). The design decisions and the alternatives I rejected are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```sh
git clone https://github.com/OwaisMunawar/durable-agent && cd durable-agent
npm install
npm run example        # brief -> user stories -> approval -> backlog, offline, in-memory Postgres
```

No API key or database needed: the example uses a deterministic demo model and PGlite. For the crash demo you need a real Postgres that two processes can share:

```sh
docker compose up -d   # postgres:16 on localhost:54329
npm run crash-demo
```

To run the example against a real model, set `AI_GATEWAY_API_KEY` (and optionally `MODEL`, default `openai/gpt-5-mini`) as in [.env.example](.env.example).

The package is not published to npm yet. To use it in another project, `npm run build` and `npm pack`, then install the tarball.

## API

```ts
import pg from 'pg';
import { openai } from '@ai-sdk/openai';
import { awaitApproval, createEngine, definePipeline, fromPg, stage } from 'durable-agent';

const triage = definePipeline<{ ticket: string }>({
  name: 'triage',
  pricing: { 'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2 } },
  stages: [
    stage('classify', async (ctx) => {
      const { text } = await ctx.generateText({
        model: openai('gpt-5-mini'),
        prompt: `Classify this support ticket: ${ctx.input.ticket}`,
      });
      return text; // committed, with its token cost, before the next stage starts
    }),
    stage('draft-reply', async (ctx) => {
      const { text } = await ctx.generateText({
        model: openai('gpt-5-mini'),
        prompt: `Write a reply for a "${String(ctx.outputs.classify)}" ticket: ${ctx.input.ticket}`,
      });
      return awaitApproval({ reply: text }); // parks the run until a human decides
    }),
    stage(
      'send',
      async (ctx) => {
        const { reply } = ctx.outputs['draft-reply'] as { reply: string };
        await mailer.send({ body: reply, idempotencyKey: ctx.idempotencyKey });
        return { sent: true };
      },
      { retries: 3 },
    ),
  ],
});

const engine = createEngine({
  db: fromPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })),
  pipelines: [triage],
});
await engine.migrate();

// Any process, any number of them.
engine.worker({ leaseMs: 30_000 }).start();

// Anywhere else: an API handler, a cron job, the MCP server.
const run = await engine.startRun('triage', { ticket: 'I was charged twice' }, { budgetUsd: 0.25 });
// ...once the run reaches the gate:
await engine.approve(run.id, { by: 'dana', value: { reply: 'Edited reply' } });
const done = await engine.getRun(run.id); // status, outputs, tokens, costUsd
const history = await engine.events(run.id); // the audit log
```

`@ai-sdk/openai` and `mailer` above are placeholders for your own provider and side effects. `ctx.generateText` has the exact signature of the AI SDK's `generateText` (tools, `Output.object()` and so on); it adds the idempotency header, the lease's abort signal and usage accounting. For calls it doesn't see, use `ctx.reportUsage({ inputTokens, outputTokens, modelId })` or `{ costUsd }`.

Errors are typed and carry a stable `code`: `UNKNOWN_PIPELINE`, `RUN_NOT_FOUND`, `INVALID_STATE`, `LEASE_LOST`, `STAGE_FAILED`, all subclasses of `DurableAgentError`.

For tests and single-process use, swap the pool for PGlite: `fromPGlite(await PGlite.create())`.

## MCP server

The CLI serves an engine over stdio and, with `--worker`, runs a worker in the same process. It uses `DATABASE_URL`, or an embedded PGlite database if that is unset.

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`), pointing at the example pipeline in a local checkout:

```json
{
  "mcpServers": {
    "durable-agent": {
      "command": "/absolute/path/to/durable-agent/node_modules/.bin/tsx",
      "args": [
        "/absolute/path/to/durable-agent/src/cli.ts",
        "mcp",
        "--pipelines",
        "/absolute/path/to/durable-agent/examples/brief-to-backlog/pipeline.ts",
        "--worker"
      ],
      "env": {
        "DATABASE_URL": "postgres://postgres:postgres@localhost:54329/durable_agent"
      }
    }
  }
}
```

For your own pipelines, build them to JavaScript and run the compiled CLI: `node dist/cli.js mcp --pipelines ./dist/my-pipelines.js --worker`. The module's default export (or a `pipelines` export) should be a pipeline or an array of them. To embed the server in your own process instead, use `createMcpServer(engine)` from `durable-agent/mcp` and connect it to any MCP transport.

Then ask the assistant something like "start a brief-to-backlog run for this brief, and show me the stories when it needs approval".

| Tool                     | What it does                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `start_run`              | Queue a run: `pipeline`, `input`, optional `budgetUsd`                  |
| `get_run`                | Status, stage outputs, tokens, cost; `includeEvents` adds the audit log |
| `list_pending_approvals` | Runs parked at a gate, with their proposals                             |
| `approve`                | Continue a run, optionally with an edited `value`                       |
| `reject`                 | End a run in `rejected` with a `reason`                                 |

## Quality

- **Tests run against real Postgres.** Every suite runs on in-process PGlite, and again on a `postgres:16` server when `TEST_DATABASE_URL` is set, which CI does: 73 tests with both backends, 39 on PGlite alone.
- **The failure modes are the test plan:** resume after a crash, no double billing, lease-expiry takeover, a zombie worker waking up after takeover, heartbeats protecting slow stages, five workers racing over twelve runs with no stage executed twice, approval and rejection, append-only enforcement, budget stops, retries.
- **Randomised crash testing.** A [fast-check](https://fast-check.dev) property generates pipelines and crash plans, kills workers at those points and checks the invariants: the run completes, each stage is committed once, the total equals the sum of stage costs, and there is one `lease_expired` per crash.
- **A real SIGKILL.** One test (and the crash demo in CI) kills a worker process with `SIGKILL` and resumes on another process.
- **Coverage gates.** 99% of lines in `src/` on the full run, with thresholds (90% lines, 85% branches) enforced in CI.
- **Strict everything.** `strict` + `noUncheckedIndexedAccess` TypeScript, `typescript-eslint` `strictTypeChecked`, Prettier, no `any` in the public API, TSDoc on every export.

```sh
npm test                                     # PGlite only, no setup
docker compose up -d
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/durable_agent npm run test:coverage
```

## Roadmap

- Publish to npm.
- `LISTEN/NOTIFY` wakeups so idle workers don't have to poll.
- Run cancellation and per-stage timeouts.
- Parallel branches (a DAG instead of a list of stages).
- Pipeline versioning, so a deploy that changes stages doesn't break runs that are already in flight.
- Retention for `events` via time partitioning, since rows can't be deleted.
- OpenTelemetry spans per stage.
- Streaming partial stage output to clients.

See [CHANGELOG.md](CHANGELOG.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

---

Built by [Owais Munawwar](https://github.com/OwaisMunawar) — available for React Native, AI and iOS work on [Upwork](https://www.upwork.com/freelancers/owaism11). The same pattern runs in production in [PM Agent](https://pm-agent-black.vercel.app).
