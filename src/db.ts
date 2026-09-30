/**
 * Minimal database surface the engine needs. Both `pg` and PGlite satisfy it
 * through the adapters below, so the library never imports either driver.
 */
/** Anything that can run a parameterised query: a pool, a client or a transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** The storage surface the engine needs. Build one with {@link fromPg} or {@link fromPGlite}. */
export interface Database extends Queryable {
  /** Run several statements (no parameters), e.g. a migration script. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** Structural subset of `pg.Pool`. */
export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgClientLike>;
}

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
}

/** Structural subset of `PGlite`. */
export interface PGliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(
    fn: (tx: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>,
  ): Promise<T>;
}

/** Adapt a `pg.Pool`. Transactions check out a dedicated client. */
export function fromPg(pool: PgPoolLike): Database {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          async query<T>(sql: string, params?: unknown[]) {
            const res = await client.query(sql, params);
            return { rows: res.rows as T[] };
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        client.release();
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
          client.release();
        } catch {
          // Connection is unusable; tell the pool to discard it.
          client.release(true);
        }
        throw err;
      }
    },
  };
}

/** Adapt an in-process PGlite instance. Handy for tests, demos and single-process apps. */
export function fromPGlite(db: PGliteLike): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  };
}
