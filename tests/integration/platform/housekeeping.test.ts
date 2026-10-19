import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rateLimit } from '@/db/auth-schema';
import { idempotencyKey, workerHeartbeat } from '@/db/platform-schema';
import { housekeeping, writeHeartbeat } from '@/worker/jobs';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('worker jobs', () => {
  it('housekeeping deletes only stale rate-limit and idempotency rows', async () => {
    const old = Date.now() - 2 * 24 * 3600 * 1000;
    await t.db.insert(rateLimit).values([
      { id: 'old', key: 'k-old', count: 3, lastRequest: old },
      { id: 'new', key: 'k-new', count: 1, lastRequest: Date.now() },
    ]);
    await t.db.insert(idempotencyKey).values([
      {
        scope: 's',
        key: 'old',
        requestHash: 'h',
        createdAt: sql`now() - interval '8 days'` as unknown as Date,
      },
      { scope: 's', key: 'new', requestHash: 'h' },
    ]);
    expect(await housekeeping(t.db)).toEqual({ rateLimits: 1, idempotency: 1, appRateLimits: 0 });
    const left = await t.db.select().from(rateLimit);
    expect(left.map((r) => r.id)).toEqual(['new']);
  });

  it('heartbeat upserts a single row per worker', async () => {
    await writeHeartbeat(t.db);
    await writeHeartbeat(t.db);
    const rows = await t.db.select().from(workerHeartbeat);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('main');
  });
});
