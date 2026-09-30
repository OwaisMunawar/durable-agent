import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './db.js';
import { toMicros } from './cost.js';
import { InvalidStateError, RunNotFoundError, UnknownPipelineError } from './errors.js';
import type { Pipeline } from './pipeline.js';
import { migrate } from './schema.js';
import { appendEvent, json, loadEvents, loadRun, loadStages, toSnapshot, type NewEvent, type RunRow } from './store.js';
import type { PendingApproval, RunEvent, RunSnapshot } from './types.js';
import { Worker, type WorkerOptions } from './worker.js';

/**
 * Any pipeline, regardless of its input type. Stage functions are
 * contravariant in their input, so `never` is the type every pipeline
 * is assignable to.
 */
export type AnyPipeline = Pipeline<never>;

/** Options for {@link createEngine}. */
export interface EngineOptions {
  db: Database;
  pipelines: AnyPipeline[];
  /** Called after each audit event is committed. Useful for logs and metrics. */
  onEvent?: (event: RunEvent) => void;
}

/** Options for {@link Engine.startRun}. */
export interface StartRunOptions {
  /**
   * Supply your own id to make starting idempotent: a second call with the
   * same id returns the existing run instead of creating another.
   */
  runId?: string;
  /** Stop the run cleanly, before the next stage, once spend reaches this. */
  budgetUsd?: number;
}

/** A reviewer's decision passed to {@link Engine.approve}. */
export interface ApprovalDecision {
  /** Replaces the proposal as the stage's output. Omit to accept it as-is. */
  value?: unknown;
  note?: string;
  by?: string;
}

/** A reviewer's decision passed to {@link Engine.reject}. */
export interface RejectionDecision {
  reason?: string;
  by?: string;
}

/** A run parked at a human-in-the-loop gate. */
export interface PendingApprovalSummary extends PendingApproval {
  runId: string;
  pipeline: string;
  costUsd: number;
  createdAt: Date;
}

/**
 * Entry point for the control plane: start runs, inspect them, resolve
 * approvals and create workers. Stateless apart from the database, so any
 * number of engines can share one.
 */
export class Engine {
  /** @internal */
  readonly db: Database;
  private readonly pipelines = new Map<string, AnyPipeline>();
  private readonly onEvent: ((event: RunEvent) => void) | undefined;

  constructor(options: EngineOptions) {
    this.db = options.db;
    this.onEvent = options.onEvent;
    for (const p of options.pipelines) {
      if (this.pipelines.has(p.name)) throw new Error(`pipeline "${p.name}" registered twice`);
      this.pipelines.set(p.name, p);
    }
  }

  /** Create or upgrade the tables and triggers. Safe to call on every boot. */
  async migrate(): Promise<void> {
    await migrate(this.db);
  }

  /** Names of the registered pipelines. */
  get pipelineNames(): string[] {
    return [...this.pipelines.keys()];
  }

  /** @internal */
  pipeline(name: string): AnyPipeline {
    const p = this.pipelines.get(name);
    if (!p) throw new UnknownPipelineError(name);
    return p;
  }

  /** Queue a run. It starts as soon as a worker for this pipeline polls. */
  async startRun(pipeline: string, input: unknown, options: StartRunOptions = {}): Promise<RunSnapshot> {
    this.pipeline(pipeline);
    const id = options.runId ?? randomUUID();
    const budget = options.budgetUsd === undefined ? null : toMicros(options.budgetUsd);

    await this.transaction(async (tx, emit) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into runs (id, pipeline, status, input, budget_micros)
         values ($1, $2, 'pending', $3::jsonb, $4)
         on conflict (id) do nothing
         returning id`,
        [id, pipeline, json(input ?? null), budget],
      );
      if (rows.length > 0) await emit(id, { type: 'created', data: { budgetUsd: options.budgetUsd ?? null } });
    });

    return this.getRun(id);
  }

  /** Current state of a run, including every committed stage output. */
  async getRun(runId: string): Promise<RunSnapshot> {
    const row = await loadRun(this.db, runId);
    if (!row) throw new RunNotFoundError(runId);
    return toSnapshot(row, await loadStages(this.db, runId));
  }

  /** The run's audit log, oldest first. */
  async events(runId: string): Promise<RunEvent[]> {
    return loadEvents(this.db, runId);
  }

  /** Runs waiting on a human decision, oldest first. */
  async listPendingApprovals(): Promise<PendingApprovalSummary[]> {
    const { rows } = await this.db.query<RunRow>(
      `select * from runs where status = 'awaiting_approval' order by created_at`,
    );
    return rows.flatMap((r) => {
      const s = toSnapshot(r, []);
      if (!s.pendingApproval) return [];
      return [{ ...s.pendingApproval, runId: s.id, pipeline: s.pipeline, costUsd: s.costUsd, createdAt: s.createdAt }];
    });
  }

  /**
   * Accept the pending proposal. The gated stage is marked completed with
   * the proposal (or `decision.value`) as its output and the run is queued
   * for the next stage.
   */
  async approve(runId: string, decision: ApprovalDecision = {}): Promise<RunSnapshot> {
    await this.transaction(async (tx, emit) => {
      const run = await this.lockAwaiting(tx, runId, 'approve');
      const edited = decision.value !== undefined;
      await tx.query(
        `update stage_results
            set status = 'completed',
                output = coalesce($3::jsonb, output),
                completed_at = now()
          where run_id = $1 and stage_index = $2`,
        [runId, run.current_stage, edited ? json(decision.value) : null],
      );
      await tx.query(
        `update runs
            set status = 'pending', current_stage = current_stage + 1,
                pending_approval = null, updated_at = now()
          where id = $1`,
        [runId],
      );
      await emit(runId, {
        type: 'approved',
        stage: run.pending_approval?.stage ?? null,
        data: { by: decision.by ?? null, note: decision.note ?? null, edited },
      });
    });
    return this.getRun(runId);
  }

  /** Decline the pending proposal. The run ends in `rejected`. */
  async reject(runId: string, decision: RejectionDecision = {}): Promise<RunSnapshot> {
    await this.transaction(async (tx, emit) => {
      const run = await this.lockAwaiting(tx, runId, 'reject');
      await tx.query(
        `update runs
            set status = 'rejected', pending_approval = null,
                error = $2, updated_at = now()
          where id = $1`,
        [runId, decision.reason ?? 'rejected'],
      );
      await emit(runId, {
        type: 'rejected',
        stage: run.pending_approval?.stage ?? null,
        data: { by: decision.by ?? null, reason: decision.reason ?? null },
      });
    });
    return this.getRun(runId);
  }

  /** Create a worker that executes runs of this engine's pipelines. */
  worker(options: WorkerOptions = {}): Worker {
    return new Worker(this, options);
  }

  /**
   * Run `fn` in a transaction and publish the events it appended only after
   * commit, so `onEvent` never reports something that was rolled back.
   * @internal
   */
  async transaction<T>(
    fn: (tx: Queryable, emit: (runId: string, event: NewEvent) => Promise<RunEvent>) => Promise<T>,
  ): Promise<T> {
    const written: RunEvent[] = [];
    const result = await this.db.transaction((tx) =>
      fn(tx, async (runId, event) => {
        const e = await appendEvent(tx, runId, event);
        written.push(e);
        return e;
      }),
    );
    if (this.onEvent) for (const e of written) this.onEvent(e);
    return result;
  }

  private async lockAwaiting(tx: Queryable, runId: string, action: string): Promise<RunRow> {
    const run = await loadRun(tx, runId, true);
    if (!run) throw new RunNotFoundError(runId);
    if (run.status !== 'awaiting_approval') throw new InvalidStateError(runId, run.status, action);
    return run;
  }
}

/** Create an {@link Engine}. */
export function createEngine(options: EngineOptions): Engine {
  return new Engine(options);
}
