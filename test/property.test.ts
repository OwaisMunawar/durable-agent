import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, definePipeline, stage, type Database } from '../src/index.js';
import { backends, deferred, setup, sleep, type Deferred } from './helpers.js';

// Randomised crash testing. For each generated case we build a pipeline,
// pick how many times each stage "crashes" (its worker hangs and its lease
// lapses, which is what a SIGKILL looks like from the database), then drive
// the run with fresh workers until it completes and check the invariants.

const LEASE_MS = 60;

describe.each(backends)('randomised crashes ($name)', (backend) => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await setup(backend, { pipelines: [] }));
  });
  afterAll(() => close());

  it('always completes with each stage committed and billed exactly once', async () => {
    let seq = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            crashes: fc.integer({ min: 0, max: 2 }),
            costMicros: fc.integer({ min: 0, max: 50_000 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (plan) => {
          const name = `prop-${seq++}`;
          const executions = plan.map(() => 0);
          const hangs: Deferred[] = [];
          let hung = 0;

          const pipeline = definePipeline({
            name,
            stages: plan.map((p, i) =>
              stage(`s${i}`, async (ctx) => {
                executions[i]!++;
                ctx.reportUsage({ costUsd: p.costMicros / 1e6, inputTokens: 1 });
                if (ctx.attempt <= p.crashes) {
                  const h = deferred();
                  hangs.push(h);
                  hung++;
                  await h.promise;
                }
                return i;
              }),
            ),
          });
          const engine = createEngine({ db, pipelines: [pipeline] });
          const run = await engine.startRun(name, {});
          const zombies: Promise<unknown>[] = [];

          for (let k = 0; k < 20; k++) {
            const before = hung;
            const w = engine.worker({ id: `${name}-w${k}`, leaseMs: LEASE_MS, heartbeatMs: 60_000 });
            const p = w.runOnce();
            // Either the worker finishes the run, or one of its stages hangs.
            let settled = false;
            const outcome = await Promise.race([
              p.then(() => 'done' as const),
              waitFor(() => settled || hung > before),
            ]);
            settled = true;
            if (outcome === 'done') break;
            zombies.push(p);
            await sleep(LEASE_MS + 30);
          }

          for (const h of hangs) h.resolve();
          await Promise.all(zombies);

          const snap = await engine.getRun(run.id);
          const events = await engine.events(run.id);
          const totalCrashes = plan.reduce((a, p) => a + p.crashes, 0);
          const expectedMicros = plan.reduce((a, p) => a + p.costMicros, 0);

          expect(snap.status).toBe('completed');
          expect(snap.stages.map((s) => s.index)).toEqual(plan.map((_, i) => i));
          expect(executions).toEqual(plan.map((p) => p.crashes + 1));
          expect(Math.round(snap.costUsd * 1e6)).toBe(expectedMicros);
          expect(Math.round(snap.stages.reduce((a, s) => a + s.costUsd, 0) * 1e6)).toBe(expectedMicros);
          expect(snap.inputTokens).toBe(plan.length);
          expect(events.filter((e) => e.type === 'stage_completed')).toHaveLength(plan.length);
          expect(events.filter((e) => e.type === 'lease_expired')).toHaveLength(totalCrashes);
          expect(events.at(-1)?.type).toBe('completed');
        },
      ),
      { numRuns: 12 },
    );
  }, 120_000);
});

async function waitFor(cond: () => boolean): Promise<'hung'> {
  while (!cond()) await sleep(5);
  return 'hung';
}
