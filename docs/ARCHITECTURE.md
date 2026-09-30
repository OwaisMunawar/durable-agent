# Architecture

This document records how durable-agent works and why it works that way. Each decision is written as a short ADR: the context, what was decided, and what was considered and rejected.

## The model

A **pipeline** is an ordered list of named **stages**. A **run** is one execution of a pipeline with an input. The run's state lives in three tables:

| Table           | One row per              | Written by                                        |
| --------------- | ------------------------ | ------------------------------------------------- |
| `runs`          | run                      | claim, stage commit, approval, finish             |
| `stage_results` | committed stage of a run | stage commit (insert), approval (status + output) |
| `events`        | state transition         | every one of the above, in the same transaction   |

`runs.current_stage` is the cursor: the index of the next stage to execute. Everything before it has a row in `stage_results`.

### Run states

| From                | To                  | Trigger                                                            |
| ------------------- | ------------------- | ------------------------------------------------------------------ |
| (none)              | `pending`           | `startRun()`                                                       |
| `pending`           | `running`           | a worker claims it                                                 |
| `running`           | `running`           | a stage commits; or the lease expires and another worker claims it |
| `running`           | `pending`           | `worker.stop()` between stages                                     |
| `running`           | `awaiting_approval` | a stage returns `awaitApproval()`                                  |
| `awaiting_approval` | `pending`           | `approve()`                                                        |
| `awaiting_approval` | `rejected`          | `reject()`                                                         |
| `running`           | `completed`         | the last stage commits                                             |
| `running`           | `failed`            | a stage throws on every attempt                                    |
| `running`           | `budget_exceeded`   | spend has reached `budgetUsd` before the next stage                |

`completed`, `failed`, `rejected` and `budget_exceeded` are terminal.

## ADR 1: Postgres is the only moving part

**Context.** A crash-safe pipeline needs durable state, mutual exclusion between workers and crash detection. The usual answer is a queue (Redis, SQS) plus a state store, or a workflow engine (Temporal, Inngest).

**Decision.** Use Postgres for all three. Most teams building LLM features already run it, and keeping state, locks and history in one database means the state change and the audit record commit atomically.

**Rejected.**

- _Redis/SQS + a database._ Two systems means two sources of truth and a window where a message was acked but the state write failed (or the reverse). Closing it needs an outbox, which is Postgres again.
- _Temporal / Inngest._ Excellent, and the right choice once you need timers, signals, child workflows and replay at scale. They are also a cluster or a hosted service to adopt, plus a determinism model for workflow code. The goal here is the smaller problem: don't lose finished LLM work. A library over an existing database is a much easier yes.

## ADR 2: Claim with `FOR UPDATE SKIP LOCKED` and hold a lease, not an advisory lock

**Context.** Exactly one worker may execute a run's current stage. Stages are LLM calls and can take minutes.

**Decision.** A worker claims a run with one statement: select the oldest claimable row `FOR UPDATE SKIP LOCKED` and, in the same statement, set `lease_owner` and `lease_expires_at`. Claimable means `pending`, or `running` with an expired lease. The row lock is held only for the short claim transaction; after that, ownership is the lease, renewed by a heartbeat every `leaseMs / 3`.

**Rejected.**

- _Session advisory locks (`pg_advisory_lock`)._ These tie ownership to a database connection. A worker would have to hold a connection for the full length of every model call, so the pool becomes the concurrency limit. They don't work through PgBouncer in transaction mode. When a connection drops the lock silently vanishes, which is correct but invisible: nothing records who held it or when it was lost. A lease is a row. You can query it, show it in a UI and log its expiry as an event.
- _Holding the row lock for the whole stage._ Same connection-per-run problem, and a long transaction blocks vacuum.
- _`SELECT` then `UPDATE` without `SKIP LOCKED`._ Workers queue behind each other on the same row, and without a guard in the `UPDATE` two of them can both believe they won.

**Consequences.** Crash detection takes up to `leaseMs`. That is the trade-off you tune: a short lease means faster takeover and more heartbeat writes. A worker that is partitioned but still alive will carry on with a stage it no longer owns. ADR 3 makes sure it cannot record the result.

## ADR 3: One transaction per stage, fenced by the lease

**Context.** "Resume from the last completed stage" is only true if a stage is either fully recorded or not recorded at all, and if a worker that lost its lease can't record anything.

**Decision.** When a stage returns, one transaction:

1. re-reads the run row `FOR UPDATE` and checks `status = 'running' AND lease_owner = me`, otherwise rolls back with `LeaseLostError`;
2. inserts the `stage_results` row (primary key `(run_id, stage_index)`);
3. adds the stage's tokens and cost to the run and advances `current_stage`;
4. appends `stage_completed` to `events`.

A lease that has _expired but not been taken over_ still passes the check. That is safe: while we hold the row lock, nobody can claim the run, and nobody else can have started the stage without first changing `lease_owner`. Accepting the commit saves a stage that would otherwise be thrown away.

**Rejected.**

- _Commit the output, then update totals separately._ A crash between the two writes leaves an output with no cost, or a cost with no output.
- _Fencing tokens checked by an external system._ They matter when the protected resource is outside the database. Here the resource is the database row, and the row lock does the job.

The lease also drives an `AbortSignal` (`ctx.signal`). When the heartbeat finds the lease gone, the signal aborts, the in-flight `ctx.generateText` call is cancelled and the worker stops waiting for the stage.

## ADR 4: What "no double billing" means, exactly

This needs to be precise, because it is easy to overclaim.

**Guaranteed.** The run's recorded usage and cost include each stage exactly once. Stages before the cursor are never executed again on resume, so their model calls are never made again. `runs.cost_micros` is always the sum of `stage_results.cost_micros`, plus the spend of failed attempts when a run ends in `failed`. The property test checks this invariant under random crash plans.

**Not guaranteed.** The stage that was in flight when a worker died runs again: execution is _at least once_, recording is _exactly once_. The tokens the dead worker used were really spent at the provider. They are not in the run's total, because nothing committed them. The library can't get that money back. It can only keep the loss to one stage instead of the whole run.

**Idempotency keys.** Every stage has `ctx.idempotencyKey = <runId>:<stageIndex>`, the same across retries and workers, and `ctx.generateText` sends it as the `Idempotency-Key` header. Don't count on LLM providers deduplicating generation requests with it. The key is really for your own side effects (sending an email, creating a ticket, charging a card), so a stage that re-runs after a crash can check whether the effect already happened.

**In-process retries.** When a stage throws and has `retries` left, the tokens used by the failed attempts are kept and committed along with the successful attempt, because that spend was real.

## ADR 5: Money as integer micro-dollars

Costs are stored as `bigint` micro-USD and converted at the API boundary. With floats, "the run total equals the sum of stage costs" would only be approximately true, and the invariant tests would need tolerances that could hide a real double count. One micro-dollar is far below the price of a single token for any current model.

## ADR 6: Approval is persisted state, not an in-memory promise

**Decision.** `awaitApproval(proposal)` commits the stage with status `awaiting_approval`, stores the proposal on the run, releases the lease and ends the worker's turn. `approve()` marks the stage `completed` (with the proposal, or the reviewer's edited `value`), advances the cursor and puts the run back in `pending` for any worker to pick up.

**Rejected.** Keeping the worker waiting for a callback or webhook. Reviews take hours. A waiting worker holds a lease, blocks capacity and loses the proposal if it restarts. Stored as state, an approval survives deploys and can be granted from any process: an API handler, a CLI, or an MCP client.

The stage's model cost is committed when it pauses, so an approval never causes the proposal to be generated, or billed, a second time.

## ADR 7: Append-only is enforced by the database

**Decision.** Row-level `BEFORE UPDATE OR DELETE` and statement-level `BEFORE TRUNCATE` triggers on `events` raise an exception. Every event is inserted in the same transaction as the state change it describes, so the log and the state can't disagree.

**Rejected.** Append-only by convention, i.e. the library just never issues an `UPDATE`. That protects nothing from a buggy migration or a hurried manual fix. An audit log that can be edited isn't one.

**Consequences.** Retention needs a deliberate operation: time-partition the table and drop old partitions, or have the table owner disable the trigger explicitly. Partitioning support is on the roadmap. Foreign keys from `events` to `runs` don't cascade, so runs can't be deleted either, which is intended.

## ADR 8: Budgets are checked between stages

**Decision.** Before each stage starts, the worker compares the run's committed spend with `budgetUsd` and ends the run in `budget_exceeded` if it has been reached. The check uses committed numbers only.

**Rejected.** Estimating a stage's cost before running it (unreliable, since output length is unknown) and aborting mid-call (throws away paid work). So a run can overshoot its budget by at most one stage. To bound that, set a `maxOutputTokens` on the call itself.

## ADR 9: A four-method `Database` interface instead of a driver

The engine needs `query`, `exec` and `transaction`. `fromPg(pool)` and `fromPGlite(db)` adapt the two drivers structurally, so the library imports neither. The payoff is in testing: every suite runs on in-process PGlite with no setup, and again on a real Postgres 16 server in CI, where the concurrency tests actually exercise `SKIP LOCKED` across connections and one test `SIGKILL`s a real worker process.

## ADR 10: Polling, for now

Idle workers poll (default every second). A claim is an index scan on a partial index (`status in ('pending', 'running')`), so polling is cheap at the scale this is designed for. `LISTEN/NOTIFY` wakeups are on the roadmap. They would lower latency, but they need a dedicated connection per worker, and polling is still required as a fallback for lease expiry.
