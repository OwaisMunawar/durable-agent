/**
 * Minimal database surface the engine needs. Both `pg` and PGlite satisfy it
 * through the adapters below, so the library never imports either driver.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

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

export function fromPGlite(db: PGliteLike): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
  };
}
