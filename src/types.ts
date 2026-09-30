/** Lifecycle of a run. See docs/ARCHITECTURE.md for the transition table. */
export type RunStatus =
  'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected' | 'budget_exceeded';

/** Statuses a run never leaves. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'rejected', 'budget_exceeded'];

/** Every row type written to the append-only `events` table. */
export type EventType =
  | 'created'
  | 'started'
  | 'resumed'
  | 'lease_expired'
  | 'released'
  | 'stage_started'
  | 'stage_retry'
  | 'stage_completed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'budget_exceeded'
  | 'failed'
  | 'completed';

/** One entry of a run's audit log. */
export interface RunEvent {
  id: number;
  runId: string;
  type: EventType;
  stage: string | null;
  workerId: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** A persisted stage output. Written once, in the same transaction that advances the run. */
export interface StageRecord {
  index: number;
  name: string;
  status: 'completed' | 'awaiting_approval';
  output: unknown;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  idempotencyKey: string;
  workerId: string;
  completedAt: Date;
}

/** What a stage proposed when it returned `awaitApproval()`. */
export interface PendingApproval {
  stage: string;
  stageIndex: number;
  proposal: unknown;
}

/** Point-in-time view of a run, its stage outputs and its totals. */
export interface RunSnapshot {
  id: string;
  pipeline: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  /** Index of the next stage to execute. */
  currentStage: number;
  /** How many times a worker has claimed this run. */
  claims: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  budgetUsd: number | null;
  pendingApproval: PendingApproval | null;
  error: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  stages: StageRecord[];
}
