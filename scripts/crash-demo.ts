// npm run crash-demo   (needs Postgres: docker compose up -d)
//
// Starts a run of the brief-to-backlog pipeline on worker process A,
// SIGKILLs A while it is in the middle of a model call, starts worker
// process B, and shows B resuming from the last committed stage without
// re-running (or re-billing) the stages A already finished.
//
// The same file is the worker: `crash-demo.ts --worker <name>`.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { createEngine, fromPg, TERMINAL_STATUSES, type RunEvent } from '../src/index.js';
import { briefToBacklog } from '../examples/brief-to-backlog/pipeline.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/durable_agent';
const SCHEMA = 'crash_demo';
const LEASE_MS = 2_000;

const BRIEF = `Patients book, move and cancel appointments on their phone. Reception
gets a daily schedule and can block out time. SMS reminder 24h before.
Phone-number login. Monthly no-show report.`;

function connect(onEvent?: (e: RunEvent) => void) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });
  const engine = createEngine({ db: fromPg(pool), pipelines: [briefToBacklog], ...(onEvent ? { onEvent } : {}) });
  return { pool, engine };
}

const usd = (n: unknown) => (typeof n === 'number' ? `$${n.toFixed(6)}` : '');
const short = (id: string) => id.slice(0, 8);

// ---------------------------------------------------------------- worker mode

async function runWorker(name: string): Promise<void> {
  const print = (msg: string) => {
    console.log(`[${name}] ${msg}`);
  };
  const format = (e: RunEvent): string | undefined => {
    const stage = (e.stage ?? '').padEnd(9);
    switch (e.type) {
      case 'started':
        return `claimed run ${short(e.runId)}`;
      case 'lease_expired':
        return `lease of ${e.workerId ?? '?'} expired, taking over`;
      case 'resumed': {
        const from = Number(e.data.fromStage);
        const done = briefToBacklog.stages.slice(0, from).map((s) => s.name);
        return `resumed at stage ${from + 1}/${briefToBacklog.stages.length} (already committed: ${done.join(', ')})`;
      }
      case 'stage_started':
        return `${stage} started    attempt ${String(e.data.attempt)}`;
      case 'stage_completed': {
        const tokens = Number(e.data.inputTokens) + Number(e.data.outputTokens);
        return `${stage} committed  ${String(tokens).padStart(4)} tok  ${usd(e.data.costUsd)}`;
      }
      case 'awaiting_approval':
        return `${stage} paused for human approval, lease released`;
      case 'completed':
        return `run completed, total ${usd(e.data.costUsd)}`;
      default:
        return undefined;
    }
  };

  const { pool, engine } = connect((e) => {
    if (e.workerId !== name && e.type !== 'lease_expired') return;
    const line = format(e);
    if (line) print(line);
  });
  const worker = engine.worker({ id: name, leaseMs: LEASE_MS, heartbeatMs: 500 });

  print(`pid ${process.pid}, polling for work`);
  for (;;) {
    const snap = await worker.runOnce();
    if (snap && TERMINAL_STATUSES.includes(snap.status)) break;
    await sleep(250);
  }
  await pool.end();
}

// ----------------------------------------------------------- orchestrator mode

function startWorker(name: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', name], {
    env: { ...process.env, DEMO_LATENCY_MS: process.env.DEMO_LATENCY_MS ?? '1200' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}

async function waitForEvent(
  engine: ReturnType<typeof connect>['engine'],
  runId: string,
  match: (e: RunEvent) => boolean,
): Promise<RunEvent> {
  for (;;) {
    const hit = (await engine.events(runId)).find(match);
    if (hit) return hit;
    await sleep(25);
  }
}

async function orchestrate(): Promise<void> {
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await admin.end();

  const { pool, engine } = connect();
  await engine.migrate();

  const host = new URL(DATABASE_URL).host;
  console.log(`durable-agent crash demo  (postgres ${host}, lease ${LEASE_MS / 1000}s)\n`);

  const run = await engine.startRun('brief-to-backlog', { brief: BRIEF }, { budgetUsd: 0.5 });
  console.log(`>> queued run ${short(run.id)}: extract -> draft -> [approval] -> finalize\n`);

  const a = startWorker('worker-a');
  await waitForEvent(engine, run.id, (e) => e.type === 'stage_started' && e.stage === 'draft');
  await sleep(400); // let the model call get properly under way

  const pid = a.pid ?? 0;
  a.kill('SIGKILL');
  await new Promise((r) => a.once('exit', r));
  const mid = await engine.getRun(run.id);
  console.log(`\n!! kill -9 ${pid}  (worker-a was mid-call in "draft")`);
  console.log(
    `   postgres: status=${mid.status}, lease=${mid.leaseOwner ?? '-'}, ` +
      `committed=${mid.stages.map((s) => s.name).join(',') || 'none'}, cost=${usd(mid.costUsd)}\n`,
  );

  const b = startWorker('worker-b');
  await waitForEvent(engine, run.id, (e) => e.type === 'awaiting_approval');
  await sleep(100);
  const pending = await engine.getRun(run.id);
  const proposal = pending.pendingApproval?.proposal as { stories: unknown[] };
  console.log(`\n>> reviewer approves ${proposal.stories.length} user stories\n`);
  await engine.approve(run.id, { by: 'reviewer' });

  await new Promise((r) => b.once('exit', r));

  const final = await engine.getRun(run.id);
  const events = await engine.events(run.id);
  const attempts = (stage: string) => events.filter((e) => e.type === 'stage_started' && e.stage === stage).length;
  const sum = final.stages.reduce((acc, s) => acc + s.costUsd, 0);

  console.log('\nstage      committed by  attempts  tokens  cost');
  for (const s of final.stages) {
    console.log(
      `${s.name.padEnd(10)} ${s.workerId.padEnd(13)} ${String(attempts(s.name)).padEnd(9)} ` +
        `${String(s.inputTokens + s.outputTokens).padEnd(7)} ${usd(s.costUsd)}`,
    );
  }
  const ok = Math.round(sum * 1e6) === Math.round(final.costUsd * 1e6);
  console.log(`\nrun total ${usd(final.costUsd)} = sum of committed stages ${usd(sum)}  ${ok ? 'OK' : 'MISMATCH'}`);
  console.log(`"extract" ran once. The killed "draft" attempt was never committed, so it is not in the total.`);

  console.log('\naudit log (append-only):');
  for (const e of events) {
    console.log(`  #${String(e.id).padEnd(3)} ${e.type.padEnd(18)} ${(e.stage ?? '').padEnd(9)} ${e.workerId ?? ''}`);
  }

  await pool.end();
  if (!ok || final.status !== 'completed') process.exit(1);
}

const workerFlag = process.argv.indexOf('--worker');
if (workerFlag !== -1) await runWorker(process.argv[workerFlag + 1] ?? 'worker');
else await orchestrate();
