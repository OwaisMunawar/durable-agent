import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateText } from 'ai';
import type { Queryable } from './db.js';
import { UsageMeter } from './cost.js';
import type { AnyPipeline, Engine } from './engine.js';
import { LeaseLostError, StageFailedError, errorMessage } from './errors.js';
import { isAwaitApproval, type Stage, type StageContext } from './pipeline.js';
import { json, loadRun, loadStages, toSnapshot, type NewEvent, type RunRow } from './store.js';
import type { RunSnapshot } from './types.js';

/** Options for {@link Engine.worker}. */
export interface WorkerOptions {
  /** Shows up in the audit log and in lease columns. Defaults to `host:pid:random`. */
  id?: string;
  /** How long a claim is valid without a heartbeat. Default 30s. */
  leaseMs?: number;
  /** How often the lease is renewed while a stage runs. Default `leaseMs / 3`. */
  heartbeatMs?: number;
  /** Idle delay between polls in {@link Worker.start}. Default 1s. */
  pollIntervalMs?: number;
  /** Restrict this worker to a subset of the engine's pipelines. */
  pipelines?: string[];
  /** Called for errors the background loop swallows (e.g. a lost database connection). */
  onError?: (err: unknown) => void;
}

interface ClaimRow extends RunRow {
  prev_status: string;
  prev_owner: string | null;
}

/**
 * Claims runs and drives them stage by stage. Any number of workers, in any
 * number of processes, can share a database: claims use
 * `FOR UPDATE SKIP LOCKED`, and every commit re-checks the lease, so a
 * stage's result is recorded at most once.
 */
export class Worker {
  /** Identifier recorded in leases and events. */
  readonly id: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollIntervalMs: number;
  private readonly pipelineNames: string[];
  private readonly onError: (err: unknown) => void;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly engine: Engine,
    options: WorkerOptions = {},
  ) {
    this.id = options.id ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.floor(this.leaseMs / 3));
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.pipelineNames = options.pipelines ?? engine.pipelineNames;
    this.onError = options.onError ?? (() => {});
    for (const name of this.pipelineNames) engine.pipeline(name);
  }

  /**
   * Claim one run and drive it until it completes, pauses for approval,
   * stops on budget, fails, or this worker loses the lease.
   * Resolves to the run's state afterwards, or `null` if nothing was claimable.
   */
  async runOnce(): Promise<RunSnapshot | null> {
    const claimed = await this.claim();
    if (!claimed) return null;
    await this.drive(claimed);
    return this.engine.getRun(claimed.id);
  }

  /** Call {@link runOnce} until there is nothing left to claim. Returns how many runs were driven. */
  async drain(): Promise<number> {
    let n = 0;
    while (!this.stopping && (await this.runOnce())) n++;
    return n;
  }

  /** Poll for work in the background until {@link stop} is called. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = (async () => {
      while (!this.stopping) {
        try {
          if (await this.runOnce()) continue;
        } catch (err) {
          this.onError(err);
        }
        // stop() may have been called while runOnce() was in flight.
        if (this.isStopping()) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.pollIntervalMs);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
      }
    })();
  }

  /**
   * Stop polling. A run in progress finishes its current stage, is released
   * back to `pending` for another worker, and then this resolves.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async claim(): Promise<ClaimRow | undefined> {
    return this.engine.transaction(async (tx, emit) => {
      const { rows } = await tx.query<ClaimRow>(
        `with candidate as (
           select id, status as prev_status, lease_owner as prev_owner
             from runs
            where pipeline = any($1::text[])
              and (status = 'pending' or (status = 'running' and lease_expires_at < now()))
            order by created_at
            limit 1
            for update skip locked
         )
         update runs r
            set status = 'running',
                lease_owner = $2,
                lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
                claims = r.claims + 1,
                updated_at = now()
           from candidate c
          where r.id = c.id
         returning r.*, c.prev_status, c.prev_owner`,
        [this.pipelineNames, this.id, this.leaseMs],
      );
      const run = rows[0];
      if (!run) return undefined;

      if (run.prev_status === 'running') {
        // The previous owner stopped heartbeating: crashed, killed or partitioned.
        await emit(run.id, { type: 'lease_expired', workerId: run.prev_owner, data: { takenOverBy: this.id } });
      }
      await emit(run.id, {
        type: run.claims === 1 ? 'started' : 'resumed',
        workerId: this.id,
        data: { fromStage: run.current_stage },
      });
      return run;
    });
  }

  private async drive(run: ClaimRow): Promise<void> {
    const pipeline = this.engine.pipeline(run.pipeline);
    const lease = new AbortController();
    const heartbeat = setInterval(() => {
      this.renew(run.id).then(
        (held) => {
          if (!held) lease.abort(new LeaseLostError(run.id, this.id));
        },
        (err: unknown) => {
          this.onError(err);
        },
      );
    }, this.heartbeatMs);

    try {
      const outputs: Record<string, unknown> = {};
      for (const s of await loadStages(this.engine.db, run.id)) {
        if (s.status === 'completed') outputs[s.name] = s.output;
      }

      let costMicros = Number(run.cost_micros);
      const budgetMicros = run.budget_micros === null ? null : Number(run.budget_micros);

      for (const [i, stage] of pipeline.stages.entries()) {
        if (i < run.current_stage) continue;

        if (budgetMicros !== null && costMicros >= budgetMicros) {
          await this.finish(run.id, 'budget_exceeded', {
            type: 'budget_exceeded',
            stage: stage.name,
            data: { costUsd: costMicros / 1e6, budgetUsd: budgetMicros / 1e6 },
          });
          return;
        }
        if (this.stopping) {
          await this.release(run.id);
          return;
        }

        const outcome = await this.executeStage(run, pipeline, stage, i, outputs, lease.signal);
        if (outcome.kind === 'paused' || outcome.kind === 'failed') return;
        outputs[stage.name] = outcome.output;
        costMicros += outcome.costMicros;
      }

      const last = pipeline.stages.at(-1);
      await this.finish(run.id, 'completed', { type: 'completed' }, last ? outputs[last.name] : null);
    } catch (err) {
      // Losing the lease is an expected outcome, not a failure: another
      // worker owns the run now and will finish it.
      if (!(err instanceof LeaseLostError)) throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async executeStage(
    run: ClaimRow,
    pipeline: AnyPipeline,
    stage: Stage<never>,
    index: number,
    outputs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ kind: 'completed'; output: unknown; costMicros: number } | { kind: 'paused' } | { kind: 'failed' }> {
    const idempotencyKey = `${run.id}:${index}`;
    const attempt = await this.engine.transaction(async (tx, emit) => {
      const { rows } = await tx.query<{ n: string | number }>(
        `select count(*) as n from events where run_id = $1 and type = 'stage_started' and stage = $2`,
        [run.id, stage.name],
      );
      const n = Number(rows[0]?.n ?? 0) + 1;
      await emit(run.id, { type: 'stage_started', stage: stage.name, workerId: this.id, data: { attempt: n } });
      return n;
    });

    const meter = new UsageMeter(pipeline.pricing);
    const ctx: StageContext = {
      runId: run.id,
      pipeline: pipeline.name,
      stage: stage.name,
      stageIndex: index,
      input: run.input,
      outputs: { ...outputs },
      idempotencyKey,
      attempt,
      workerId: this.id,
      signal,
      reportUsage: (usage) => {
        meter.add(usage);
      },
      generateText: meteredGenerateText(idempotencyKey, signal, meter),
    };

    const retries = stage.retries ?? 0;
    let result: unknown;
    for (let tries = 0; ; tries++) {
      try {
        // Promise.resolve().then() turns a synchronous throw into a rejection.
        result = await abortable(
          Promise.resolve().then(() => stage.run(ctx as StageContext<never>)),
          signal,
        );
        break;
      } catch (err) {
        if (err instanceof LeaseLostError) throw err;
        if (signal.aborted) throw abortReason(signal);
        if (tries >= retries) {
          await this.fail(run.id, stage.name, meter, new StageFailedError(run.id, stage.name, err));
          return { kind: 'failed' };
        }
        await this.engine.transaction((_tx, emit) =>
          emit(run.id, {
            type: 'stage_retry',
            stage: stage.name,
            workerId: this.id,
            data: { error: errorMessage(err), retry: tries + 1 },
          }),
        );
        await sleep((stage.retryDelayMs ?? 250) * 2 ** tries);
      }
    }

    const paused = isAwaitApproval(result);
    const output = isAwaitApproval(result) ? result.proposal : result;

    // The commit point. Output, usage and the run's cursor move together or
    // not at all; if the lease was lost the whole transaction is discarded.
    await this.engine.transaction(async (tx, emit) => {
      await this.assertLease(tx, run.id);
      await tx.query(
        `insert into stage_results
           (run_id, stage_index, stage, status, output, cost_micros,
            input_tokens, output_tokens, idempotency_key, worker_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          run.id,
          index,
          stage.name,
          paused ? 'awaiting_approval' : 'completed',
          json(output ?? null),
          meter.costMicros,
          meter.inputTokens,
          meter.outputTokens,
          idempotencyKey,
          this.id,
        ],
      );
      await tx.query(
        `update runs
            set cost_micros = cost_micros + $2,
                input_tokens = input_tokens + $3,
                output_tokens = output_tokens + $4,
                current_stage = $5,
                status = $6,
                pending_approval = $7::jsonb,
                lease_owner = case when $6 = 'running' then lease_owner end,
                lease_expires_at = case when $6 = 'running'
                  then now() + make_interval(secs => $8::double precision / 1000) end,
                updated_at = now()
          where id = $1`,
        [
          run.id,
          meter.costMicros,
          meter.inputTokens,
          meter.outputTokens,
          paused ? index : index + 1,
          paused ? 'awaiting_approval' : 'running',
          paused ? json({ stage: stage.name, stageIndex: index, proposal: output ?? null }) : null,
          this.leaseMs,
        ],
      );
      const usage = {
        costUsd: meter.costMicros / 1e6,
        inputTokens: meter.inputTokens,
        outputTokens: meter.outputTokens,
      };
      await emit(run.id, {
        type: 'stage_completed',
        stage: stage.name,
        workerId: this.id,
        data: { attempt, ...usage },
      });
      if (paused) await emit(run.id, { type: 'awaiting_approval', stage: stage.name, workerId: this.id });
    });

    return paused ? { kind: 'paused' } : { kind: 'completed', output, costMicros: meter.costMicros };
  }

  private async assertLease(tx: Queryable, runId: string): Promise<void> {
    // Holding the row lock here serialises us against a concurrent claim.
    // An expired-but-untaken lease is still ours: nobody else can have
    // started the stage without first moving lease_owner.
    const row = await loadRun(tx, runId, true);
    if (!row || row.status !== 'running' || row.lease_owner !== this.id) {
      throw new LeaseLostError(runId, this.id);
    }
  }

  private async renew(runId: string): Promise<boolean> {
    const { rows } = await this.engine.db.query(
      `update runs
          set lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
        where id = $1 and lease_owner = $2 and status = 'running'
        returning id`,
      [runId, this.id, this.leaseMs],
    );
    return rows.length > 0;
  }

  private async finish(
    runId: string,
    status: 'completed' | 'budget_exceeded',
    event: NewEvent,
    output?: unknown,
  ): Promise<void> {
    await this.engine.transaction(async (tx, emit) => {
      await this.assertLease(tx, runId);
      const { rows } = await tx.query<RunRow>(
        `update runs
            set status = $2, output = $3::jsonb, lease_owner = null,
                lease_expires_at = null, updated_at = now()
          where id = $1
        returning *`,
        [runId, status, json(output ?? null)],
      );
      const row = rows[0];
      if (!row) throw new LeaseLostError(runId, this.id);
      const snap = toSnapshot(row, []);
      await emit(runId, {
        ...event,
        workerId: this.id,
        data: { costUsd: snap.costUsd, inputTokens: snap.inputTokens, outputTokens: snap.outputTokens, ...event.data },
      });
    });
  }

  private async fail(runId: string, stage: string, meter: UsageMeter, err: StageFailedError): Promise<void> {
    await this.engine.transaction(async (tx, emit) => {
      await this.assertLease(tx, runId);
      // Tokens spent on failed attempts were really spent; keep them on the run.
      await tx.query(
        `update runs
            set status = 'failed', error = $2,
                cost_micros = cost_micros + $3,
                input_tokens = input_tokens + $4,
                output_tokens = output_tokens + $5,
                lease_owner = null, lease_expires_at = null, updated_at = now()
          where id = $1`,
        [runId, err.message, meter.costMicros, meter.inputTokens, meter.outputTokens],
      );
      await emit(runId, {
        type: 'failed',
        stage,
        workerId: this.id,
        data: { error: errorMessage(err.cause), costUsd: meter.costMicros / 1e6 },
      });
    });
  }

  private async release(runId: string): Promise<void> {
    await this.engine.transaction(async (tx, emit) => {
      await this.assertLease(tx, runId);
      await tx.query(
        `update runs set status = 'pending', lease_owner = null, lease_expires_at = null, updated_at = now()
          where id = $1`,
        [runId],
      );
      await emit(runId, { type: 'released', workerId: this.id });
    });
  }
}

/**
 * `generateText` with the stage's idempotency key and abort signal applied
 * and its usage recorded. The cast keeps the SDK's generic signature (tools,
 * structured output) intact for callers; the wrapper itself only touches
 * options and usage, which are the same for every instantiation.
 */
function meteredGenerateText(idempotencyKey: string, signal: AbortSignal, meter: UsageMeter): typeof generateText {
  const wrapped = async (options: Parameters<typeof generateText>[0]) => {
    const result = await generateText({
      ...options,
      abortSignal: options.abortSignal ?? signal,
      headers: { 'Idempotency-Key': idempotencyKey, ...options.headers },
    });
    const model = options.model;
    meter.add({
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      modelId: typeof model === 'string' ? model : model.modelId,
    });
    return result;
  };
  return wrapped as typeof generateText;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** Reject as soon as `signal` aborts, even if `promise` never settles. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
