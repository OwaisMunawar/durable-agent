// npm run example
//
// Runs the pipeline end to end in one process: queue a run, work it until it
// pauses for approval, approve it (as a reviewer would via the API or the MCP
// server), then work it to completion. Uses DATABASE_URL when set, otherwise
// an in-memory PGlite database, so it needs no setup at all.
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { createEngine, fromPGlite, fromPg, type Database } from '../../src/index.js';
import { briefToBacklog, type BacklogItem, type Stories } from './pipeline.js';

const db: Database = process.env.DATABASE_URL
  ? fromPg(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
  : fromPGlite(await PGlite.create());

const engine = createEngine({
  db,
  pipelines: [briefToBacklog],
  onEvent: (e) => {
    const cost = typeof e.data.costUsd === 'number' ? `  $${e.data.costUsd.toFixed(6)}` : '';
    console.log(`  ${e.type.padEnd(18)} ${(e.stage ?? '').padEnd(9)}${cost}`);
  },
});
await engine.migrate();

const brief = await readFile(new URL('./brief.md', import.meta.url), 'utf8');
console.log(`brief-to-backlog${process.env.AI_GATEWAY_API_KEY ? '' : ' (demo model, no API key)'}\n`);
const run = await engine.startRun('brief-to-backlog', { brief }, { budgetUsd: 0.5 });

const worker = engine.worker({ id: 'example-worker' });
let snap = await worker.runOnce();

if (snap?.status === 'awaiting_approval') {
  const { stories } = snap.pendingApproval?.proposal as Stories;
  console.log(`\nawaiting approval: ${stories.length} user stories`);
  for (const s of stories) console.log(`  ${s.id}  ${s.story}`);
  console.log('\napproving as "product-owner"\n');
  await engine.approve(run.id, { by: 'product-owner', note: 'looks right' });
  snap = await worker.runOnce();
}

if (snap?.status !== 'completed') throw new Error(`run ended in ${snap?.status ?? 'unknown'}`);
console.log('\nbacklog');
for (const item of snap.output as BacklogItem[]) {
  console.log(`  ${String(item.rank).padStart(2)}. [${item.points}pt] ${item.id} ${item.story}`);
}
console.log(
  `\n${snap.stages.length} stages, ${snap.inputTokens + snap.outputTokens} tokens, $${snap.costUsd.toFixed(6)} total`,
);
process.exit(0);
