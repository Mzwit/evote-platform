import pg from 'pg';
import { config } from './config.ts';

// bytea -> Buffer is pg's default. Parse bigint counts as numbers (safe below 2^53).
pg.types.setTypeParser(20, (v: string) => Number(v));

const make = (url: string) => new pg.Pool({ connectionString: url, max: config.db.poolSize, idleTimeoutMillis: 30000 });

// Each service uses ONLY its own pool, connected as a least-privilege role.
export const pools = {
  identity: make(config.db.identity),
  ballot: make(config.db.ballot),
  admin: make(config.db.admin),
};

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function closePools() {
  await Promise.all(Object.values(pools).map((p) => p.end()));
}
