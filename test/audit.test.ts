import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definePipeline, stage, type Database, type Engine } from '../src/index.js';
import { backends, setup } from './helpers.js';

describe.each(backends)('append-only audit log ($name)', (backend) => {
  let engine: Engine;
  let db: Database;
  let close: () => Promise<void>;
  let runId: string;

  const pipeline = definePipeline({ name: 'audited', stages: [stage('only', async () => 'ok')] });

  beforeEach(async () => {
    ({ engine, db, close } = await setup(backend, { pipelines: [pipeline] }));
    runId = (await engine.startRun('audited', {})).id;
    await engine.worker().runOnce();
  });
  afterEach(() => close());

  it('rejects UPDATE on events', async () => {
    await expect(db.query(`update events set type = 'completed' where run_id = $1`, [runId])).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects DELETE and TRUNCATE on events', async () => {
    await expect(db.query('delete from events where run_id = $1', [runId])).rejects.toThrow(/append-only/);
    await expect(db.query('truncate events')).rejects.toThrow(/append-only/);
    expect((await engine.events(runId)).length).toBeGreaterThan(0);
  });

  it('still allows inserts, and ids increase monotonically', async () => {
    const events = await engine.events(runId);
    const ids = events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(events.at(-1)?.type).toBe('completed');
  });
});
