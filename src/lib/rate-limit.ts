import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';

export type RateLimitResult = { allowed: boolean; count: number; retryAfterSeconds: number };

/**
 * Postgres-backed fixed-window rate limit (no Redis in R1). One atomic upsert increments the counter
 * for the current window, so concurrent requests are counted exactly. `key` should include the
 * action and the actor, e.g. `contact:203.0.113.9`.
 */
export async function hitRateLimit(
  db: DbOrTx,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const res = await db.execute<{ count: number; retry: string }>(sql`
    WITH w AS (
      SELECT to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}) * ${windowSeconds}) AS start
    ), up AS (
      INSERT INTO app_rate_limit (key, window_start, count)
      SELECT ${key}, w.start, 1 FROM w
      ON CONFLICT (key, window_start) DO UPDATE SET count = app_rate_limit.count + 1
      RETURNING count, window_start
    )
    SELECT up.count, ceil(extract(epoch FROM (up.window_start + make_interval(secs => ${windowSeconds}) - now())))::text AS retry
    FROM up
  `);
  const row = res.rows[0];
  if (!row) throw new Error('rate limit upsert returned no row');
  return {
    allowed: row.count <= limit,
    count: row.count,
    retryAfterSeconds: Math.max(1, Number(row.retry)),
  };
}
