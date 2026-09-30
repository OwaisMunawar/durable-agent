# Contributing

Thanks for taking a look. Bug reports, especially ones that describe a sequence of crashes or races, are the most useful thing you can send.

## Setup

```sh
npm install
npm test                 # every suite on in-process PGlite, no services needed
```

To run the suites against a real server as well (CI does this):

```sh
docker compose up -d     # postgres:16 on localhost:54329
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/durable_agent npm run test:coverage
npm run crash-demo
```

Node 22 or newer.

## Before you open a pull request

```sh
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

- Behaviour changes need a test. If you touch claiming, leasing or committing, the test should fail without your change on both backends.
- Keep the invariants in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) true: a stage's result is recorded at most once, the run total is the sum of committed stage costs, and `events` is only ever inserted into. If a change needs to relax one of them, open an issue first.
- Schema changes must be additive and idempotent (`create ... if not exists`, `add column if not exists`), because `migrate()` runs on every boot.
- Public exports need TSDoc. No `any` in the public API.
- Coverage thresholds are enforced in CI (90% lines on `src/`).

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`, with a scope where it helps (`feat(mcp): ...`). Keep commits small enough to review one at a time, and explain the why in the body when it isn't obvious.

## Reporting a bug

Include the Postgres version (or PGlite), Node version, your lease and heartbeat settings, and the `events` rows for the affected run (`engine.events(runId)`). The audit log usually shows what happened.
