/** Machine-readable codes carried by every error this library throws. */
export type DurableAgentErrorCode =
  'UNKNOWN_PIPELINE' | 'RUN_NOT_FOUND' | 'INVALID_STATE' | 'LEASE_LOST' | 'STAGE_FAILED';

/** Base class for all errors thrown by durable-agent. */
export class DurableAgentError extends Error {
  /** Stable identifier; safe to branch on. */
  readonly code: DurableAgentErrorCode;

  constructor(code: DurableAgentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** `startRun` was called with a pipeline the engine was not given. */
export class UnknownPipelineError extends DurableAgentError {
  constructor(readonly pipeline: string) {
    super('UNKNOWN_PIPELINE', `unknown pipeline "${pipeline}"`);
  }
}

/** No run exists with the given id. */
export class RunNotFoundError extends DurableAgentError {
  constructor(readonly runId: string) {
    super('RUN_NOT_FOUND', `run ${runId} not found`);
  }
}

/** The run is not in a state that allows the requested transition. */
export class InvalidStateError extends DurableAgentError {
  constructor(
    readonly runId: string,
    readonly status: string,
    action: string,
  ) {
    super('INVALID_STATE', `cannot ${action} run ${runId} in status "${status}"`);
  }
}

/**
 * This worker's lease on the run expired and another worker (or a human
 * action) moved it on. The worker's in-flight result is discarded.
 */
export class LeaseLostError extends DurableAgentError {
  constructor(
    readonly runId: string,
    readonly workerId: string,
  ) {
    super('LEASE_LOST', `worker ${workerId} no longer holds the lease on run ${runId}`);
  }
}

/** A stage threw on every attempt; the run is marked `failed`. */
export class StageFailedError extends DurableAgentError {
  constructor(
    readonly runId: string,
    readonly stage: string,
    cause: unknown,
  ) {
    super('STAGE_FAILED', `stage "${stage}" failed on run ${runId}: ${errorMessage(cause)}`, { cause });
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
