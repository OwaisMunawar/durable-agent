# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-09-30

First release.

### Added

- `definePipeline` / `stage` for ordered, named stages; stages may be sync or async.
- `createEngine` with `startRun` (optionally idempotent via `runId`), `getRun`, `events`, `listPendingApprovals`, `approve`, `reject` and `migrate`.
- `Worker` with `runOnce`, `drain`, `start` and `stop`. Claims use `FOR UPDATE SKIP LOCKED` and a heartbeat lease; commits are fenced by the lease.
- Per-stage commit of output, token usage and cost in one transaction; resume from the last committed stage after a crash.
- `ctx.generateText`: the AI SDK v7 `generateText` with the stage's idempotency key, abort signal and usage metering applied.
- Human approval gates via `awaitApproval(proposal)`, with optional reviewer edits.
- `budgetUsd` per run, checked between stages.
- Append-only `events` table enforced by triggers (UPDATE, DELETE and TRUNCATE rejected).
- Typed errors with stable codes: `UNKNOWN_PIPELINE`, `RUN_NOT_FOUND`, `INVALID_STATE`, `LEASE_LOST`, `STAGE_FAILED`.
- `fromPg` and `fromPGlite` database adapters.
- MCP server (`durable-agent/mcp`) with `start_run`, `get_run`, `list_pending_approvals`, `approve` and `reject`, and a `durable-agent mcp` stdio CLI.
- `examples/brief-to-backlog` and `scripts/crash-demo.ts`.

[Unreleased]: https://github.com/OwaisMunawar/durable-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OwaisMunawar/durable-agent/releases/tag/v0.1.0
