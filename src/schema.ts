import type { Database } from './db.js';

// Money is stored as integer micro-dollars so run totals are exact sums of
// stage costs; floating point drift would make "no double billing" untestable.
// The script runs as one implicit transaction; the advisory lock keeps two
// workers booting at the same time from racing on the trigger DDL.
export const SCHEMA_SQL = /* sql */ `
select pg_advisory_xact_lock(4412020);

create table if not exists runs (
  id               uuid primary key,
  pipeline         text        not null,
  status           text        not null,
  input            jsonb       not null,
  output           jsonb,
  current_stage    integer     not null default 0,
  claims           integer     not null default 0,
  cost_micros      bigint      not null default 0,
  input_tokens     bigint      not null default 0,
  output_tokens    bigint      not null default 0,
  budget_micros    bigint,
  pending_approval jsonb,
  error            text,
  lease_owner      text,
  lease_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint runs_status_check check (status in (
    'pending', 'running', 'awaiting_approval',
    'completed', 'failed', 'rejected', 'budget_exceeded'
  ))
);

create index if not exists runs_claimable_idx
  on runs (created_at)
  where status in ('pending', 'running');

create table if not exists stage_results (
  run_id          uuid        not null references runs (id),
  stage_index     integer     not null,
  stage           text        not null,
  status          text        not null,
  output          jsonb,
  cost_micros     bigint      not null default 0,
  input_tokens    bigint      not null default 0,
  output_tokens   bigint      not null default 0,
  idempotency_key text        not null,
  worker_id       text        not null,
  completed_at    timestamptz not null default now(),
  primary key (run_id, stage_index),
  constraint stage_results_status_check check (status in ('completed', 'awaiting_approval'))
);

create table if not exists events (
  id         bigserial   primary key,
  run_id     uuid        not null references runs (id),
  type       text        not null,
  stage      text,
  worker_id  text,
  data       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_run_idx on events (run_id, id);

create or replace function durable_agent_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'events is append-only (% rejected)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists events_no_update_delete on events;
create trigger events_no_update_delete
  before update or delete on events
  for each row execute function durable_agent_events_append_only();

drop trigger if exists events_no_truncate on events;
create trigger events_no_truncate
  before truncate on events
  for each statement execute function durable_agent_events_append_only();
`;

export async function migrate(db: Database): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
