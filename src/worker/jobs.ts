import { lt, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { rateLimit } from '@/db/auth-schema';
import { appRateLimit, idempotencyKey, workerHeartbeat } from '@/db/platform-schema';

export const WORKER_NAME = 'main';

export async function writeHeartbeat(db: Db, name = WORKER_NAME): Promise<void> {
  await db
    .insert(workerHeartbeat)
    .values({ name, beatAt: sql`now()` })
    .onConflictDoUpdate({ target: workerHeartbeat.name, set: { beatAt: sql`now()` } });
}

/** Remove stale rate-limit counters and expired idempotency records. Returns rows deleted. */
export async function housekeeping(
  db: Db,
): Promise<{ rateLimits: number; idempotency: number; appRateLimits: number }> {
  const oneDayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
  const rl = await db
    .delete(rateLimit)
    .where(lt(rateLimit.lastRequest, oneDayAgoMs))
    .returning({ id: rateLimit.id });
  const idem = await db
    .delete(idempotencyKey)
    .where(lt(idempotencyKey.createdAt, sql`now() - interval '7 days'`))
    .returning({ id: idempotencyKey.id });
  const app = await db
    .delete(appRateLimit)
    .where(lt(appRateLimit.windowStart, sql`now() - interval '1 day'`))
    .returning({ key: appRateLimit.key });
  return { rateLimits: rl.length, idempotency: idem.length, appRateLimits: app.length };
}
