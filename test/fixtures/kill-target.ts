// Child process for sigkill.test.ts: runs one worker until the parent kills it.
import pg from 'pg';
import { createEngine, fromPg } from '../../src/index.js';
import { slowPipeline } from './slow-pipeline.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${process.env.SCHEMA}`,
});
const engine = createEngine({ db: fromPg(pool), pipelines: [slowPipeline] });
await engine.worker({ id: 'child', leaseMs: 500 }).runOnce();
await pool.end();
