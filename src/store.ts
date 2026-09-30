import type { Queryable } from './db.js';
import { fromMicros } from './cost.js';
import type { EventType, PendingApproval, RunEvent, RunSnapshot, RunStatus, StageRecord } from './types.js';

// Internal: row shapes and the SQL shared by Engine and Worker. Nothing here
// is exported from the package entry point.

export interface RunRow {
  id: string;
  pipeline: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  current_stage: number;
  claims: number;
  cost_micros: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  budget_micros: string | number | null;
  pending_approval: PendingApproval | null;
  error: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface StageRow {
  run_id: string;
  stage_index: number;
  stage: string;
  status: 'completed' | 'awaiting_approval';
  output: unknown;
  cost_micros: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  idempotency_key: string;
  worker_id: string;
  completed_at: Date;
}

interface EventRow {
  id: string | number;
  run_id: string;
  type: EventType;
  stage: string | null;
  worker_id: string | null;
  data: Record<string, unknown>;
  created_at: Date;
}

/** jsonb parameters are always sent as text; `undefined` becomes SQL null. */
export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function toStage(row: StageRow): StageRecord {
  return {
    index: row.stage_index,
    name: row.stage,
    status: row.status,
    output: row.output,
    costUsd: fromMicros(row.cost_micros),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    idempotencyKey: row.idempotency_key,
    workerId: row.worker_id,
    completedAt: row.completed_at,
  };
}

export function toSnapshot(row: RunRow, stages: StageRecord[]): RunSnapshot {
  return {
    id: row.id,
    pipeline: row.pipeline,
    status: row.status,
    input: row.input,
    output: row.output,
    currentStage: row.current_stage,
    claims: row.claims,
    costUsd: fromMicros(row.cost_micros),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    budgetUsd: row.budget_micros === null ? null : fromMicros(row.budget_micros),
    pendingApproval: row.pending_approval,
    error: row.error,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stages,
  };
}

export function toEvent(row: EventRow): RunEvent {
  return {
    id: Number(row.id),
    runId: row.run_id,
    type: row.type,
    stage: row.stage,
    workerId: row.worker_id,
    data: row.data,
    createdAt: row.created_at,
  };
}

export async function loadStages(q: Queryable, runId: string): Promise<StageRecord[]> {
  const { rows } = await q.query<StageRow>('select * from stage_results where run_id = $1 order by stage_index', [
    runId,
  ]);
  return rows.map(toStage);
}

export async function loadRun(q: Queryable, runId: string, lock = false): Promise<RunRow | undefined> {
  const { rows } = await q.query<RunRow>(`select * from runs where id = $1${lock ? ' for update' : ''}`, [runId]);
  return rows[0];
}

export interface NewEvent {
  type: EventType;
  stage?: string | null;
  workerId?: string | null;
  data?: Record<string, unknown>;
}

export async function appendEvent(q: Queryable, runId: string, event: NewEvent): Promise<RunEvent> {
  const { rows } = await q.query<EventRow>(
    `insert into events (run_id, type, stage, worker_id, data)
     values ($1, $2, $3, $4, $5::jsonb)
     returning *`,
    [runId, event.type, event.stage ?? null, event.workerId ?? null, json(event.data ?? {})],
  );
  const row = rows[0];
  if (!row) throw new Error('insert into events returned no row');
  return toEvent(row);
}

export async function loadEvents(q: Queryable, runId: string): Promise<RunEvent[]> {
  const { rows } = await q.query<EventRow>('select * from events where run_id = $1 order by id', [runId]);
  return rows.map(toEvent);
}
