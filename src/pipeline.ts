import type { generateText } from 'ai';
import type { Pricing, Usage } from './cost.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const AWAIT_APPROVAL = Symbol.for('durable-agent.awaitApproval');

export interface AwaitApproval<P = unknown> {
  readonly [AWAIT_APPROVAL]: true;
  readonly proposal: P;
}

/**
 * Return this from a stage to pause the run until a human calls
 * `engine.approve()` or `engine.reject()`. The proposal is persisted and, once
 * approved, becomes the stage's output (or the reviewer's edited value).
 */
export function awaitApproval<P>(proposal: P): AwaitApproval<P> {
  return { [AWAIT_APPROVAL]: true, proposal };
}

export function isAwaitApproval(value: unknown): value is AwaitApproval {
  return typeof value === 'object' && value !== null && AWAIT_APPROVAL in value;
}

export interface StageContext<I = unknown> {
  readonly runId: string;
  readonly pipeline: string;
  readonly stage: string;
  readonly stageIndex: number;
  readonly input: I;
  /** Outputs of every stage that already completed, keyed by stage name. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /**
   * Stable across retries and across workers: `${runId}:${stageIndex}`.
   * Pass it to anything with side effects so a resumed stage can dedupe.
   */
  readonly idempotencyKey: string;
  /** 1 on the first execution of this stage, higher after crashes or retries. */
  readonly attempt: number;
  readonly workerId: string;
  /** Aborted when this worker loses its lease. */
  readonly signal: AbortSignal;
  /** Record token usage for a call made outside `ctx.generateText`. */
  reportUsage(usage: Usage): void;
  /**
   * `generateText` from the AI SDK with the idempotency key, abort signal and
   * usage accounting wired in.
   */
  readonly generateText: typeof generateText;
}

/**
 * A stage body. Return the output (sync or async), or `awaitApproval(proposal)`
 * to pause for a human. Throwing triggers the stage's retry policy.
 */
export type StageFn<I = unknown, O = unknown> = (
  ctx: StageContext<I>,
) => O | AwaitApproval<O> | Promise<O | AwaitApproval<O>>;

export interface Stage<I = unknown, O = unknown> {
  name: string;
  run: StageFn<I, O>;
  /** Extra in-process attempts after a thrown error. Default 0. */
  retries?: number;
  /** Base delay for exponential backoff between retries. Default 250ms. */
  retryDelayMs?: number;
}

export interface Pipeline<I = unknown> {
  name: string;
  stages: Stage<I>[];
  /** Used to price usage reported without an explicit `costUsd`. */
  pricing?: Pricing;
}

export function stage<I = unknown, O = unknown>(
  name: string,
  run: StageFn<I, O>,
  options: Omit<Stage<I, O>, 'name' | 'run'> = {},
): Stage<I, O> {
  return { name, run, ...options };
}

export function definePipeline<I = unknown>(pipeline: Pipeline<I>): Pipeline<I> {
  if (!pipeline.name) throw new Error('pipeline needs a name');
  if (pipeline.stages.length === 0) throw new Error(`pipeline "${pipeline.name}" has no stages`);
  const seen = new Set<string>();
  for (const s of pipeline.stages) {
    if (seen.has(s.name)) throw new Error(`pipeline "${pipeline.name}" has duplicate stage "${s.name}"`);
    seen.add(s.name);
  }
  return pipeline;
}
