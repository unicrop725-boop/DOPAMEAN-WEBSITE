import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvent } from '@/db/platform-schema';
import { enqueueOutbox, relayOutbox } from '@/lib/outbox';
import { newTestDb, type TestDb } from '../../support/test-db';

const log = pino({ level: 'silent' });
let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

describe('transactional outbox', () => {
  it('is written atomically with the business change: rollback leaves no outbox row', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await enqueueOutbox(tx, { aggregate: 'order', type: 'rollback.test', payload: { n: 1 } });
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');
    const rows = await t.db.select().from(outboxEvent).where(eq(outboxEvent.type, 'rollback.test'));
    expect(rows).toHaveLength(0);
  });

  it('relays committed events once and marks them relayed', async () => {
    const seen: unknown[] = [];
    const handlers = { 'ok.test': async (p: unknown) => void seen.push(p) };
    await enqueueOutbox(t.db, { aggregate: 'x', type: 'ok.test', payload: { n: 1 } });
    await enqueueOutbox(t.db, { aggregate: 'x', type: 'ok.test', payload: { n: 2 } });
    expect(await relayOutbox(t.db, handlers, log)).toBe(2);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await relayOutbox(t.db, handlers, log)).toBe(0);
  });

  it('records failure, increments attempts and delays the retry instead of dropping the event', async () => {
    const id = await enqueueOutbox(t.db, { aggregate: 'x', type: 'fail.test', payload: {} });
    const delivered = await relayOutbox(
      t.db,
      {
        'fail.test': async () => {
          throw new Error('smtp down');
        },
      },
      log,
    );
    expect(delivered).toBe(0);
    const [row] = await t.db.select().from(outboxEvent).where(eq(outboxEvent.id, id));
    expect(row?.relayedAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe('smtp down');
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now() + 5_000);
  });

  it('never delivers an event twice when several relays run concurrently', async () => {
    const total = 40;
    for (let i = 0; i < total; i++) {
      await enqueueOutbox(t.db, { aggregate: 'c', type: 'concurrent.test', payload: { i } });
    }
    const counts = new Map<number, number>();
    const handlers = {
      'concurrent.test': async (p: unknown) => {
        const i = (p as { i: number }).i;
        counts.set(i, (counts.get(i) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    await Promise.all([1, 2, 3, 4].map(() => relayOutbox(t.db, handlers, log)));
    expect(counts.size).toBe(total);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });
});
