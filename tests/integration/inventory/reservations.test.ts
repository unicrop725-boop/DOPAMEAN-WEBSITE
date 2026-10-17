import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventoryMovement } from '@/db/schema';
import type { AppError } from '@/lib/errors';
import {
  commitReservations,
  expireDueReservations,
  getAvailable,
  initStock,
  listReservations,
  releaseReservations,
  reserveStock,
  restockSold,
} from '@/modules/inventory';
import { newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb(40);
});
afterAll(async () => {
  await t.close();
});

const id = () => crypto.randomUUID();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

describe('reservations', () => {
  it('holds stock: available drops, on_hand does not', async () => {
    const v = id();
    await initStock(t.db, v, 5);
    await t.db.transaction((tx) =>
      reserveStock(tx, {
        refId: id(),
        items: [{ variantId: v, qty: 3 }],
        expiresAt: inMinutes(15),
      }),
    );
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 5, reserved: 3, available: 2 });
  });

  it('refuses more than is available with OUT_OF_STOCK and names the variant', async () => {
    const v = id();
    await initStock(t.db, v, 2);
    await expect(
      t.db.transaction((tx) =>
        reserveStock(tx, {
          refId: id(),
          items: [{ variantId: v, qty: 3 }],
          expiresAt: inMinutes(15),
        }),
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_STOCK', details: { variantId: v } });
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 2, reserved: 0, available: 2 });
  });

  it('is all-or-nothing across lines: one short line leaves nothing reserved', async () => {
    const [a, b] = [id(), id()];
    await initStock(t.db, a, 10);
    await initStock(t.db, b, 1);
    const ref = id();
    await expect(
      t.db.transaction((tx) =>
        reserveStock(tx, {
          refId: ref,
          items: [
            { variantId: a, qty: 4 },
            { variantId: b, qty: 2 },
          ],
          expiresAt: inMinutes(15),
        }),
      ),
    ).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
    expect((await getAvailable(t.db, a))?.reserved).toBe(0);
    expect(await listReservations(t.db, ref)).toHaveLength(0);
  });

  it('INV-03: 20 concurrent checkouts for the last unit, exactly one succeeds', async () => {
    const v = id();
    await initStock(t.db, v, 1);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        t.db.transaction((tx) =>
          reserveStock(tx, {
            refId: id(),
            items: [{ variantId: v, qty: 1 }],
            expiresAt: inMinutes(15),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => (r.reason as AppError).code === 'OUT_OF_STOCK')).toBe(true);
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 1, reserved: 1, available: 0 });
  });

  it('INV-03: concurrent multi-item carts sharing items never oversell or deadlock', async () => {
    const [a, b] = [id(), id()];
    await initStock(t.db, a, 6);
    await initStock(t.db, b, 6);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        t.db.transaction((tx) =>
          reserveStock(tx, {
            refId: id(),
            // Opposite order on purpose: the code sorts rows so lock order is stable.
            items:
              i % 2
                ? [
                    { variantId: a, qty: 2 },
                    { variantId: b, qty: 2 },
                  ]
                : [
                    { variantId: b, qty: 2 },
                    { variantId: a, qty: 2 },
                  ],
            expiresAt: inMinutes(15),
          }),
        ),
      ),
    );
    const won = results.filter((r) => r.status === 'fulfilled').length;
    expect(won).toBe(3);
    expect(await getAvailable(t.db, a)).toEqual({ onHand: 6, reserved: 6, available: 0 });
    expect(await getAvailable(t.db, b)).toEqual({ onHand: 6, reserved: 6, available: 0 });
  });

  it('commit sells the held stock: on_hand and reserved both drop, with a sale movement', async () => {
    const v = id();
    const ref = id();
    await initStock(t.db, v, 5);
    await t.db.transaction((tx) =>
      reserveStock(tx, { refId: ref, items: [{ variantId: v, qty: 2 }], expiresAt: inMinutes(15) }),
    );
    const sold = await t.db.transaction((tx) => commitReservations(tx, ref));
    expect(sold).toEqual([{ variantId: v, qty: 2 }]);
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, v));
    expect(moves.find((m) => m.reason === 'sale')).toMatchObject({
      delta: -2,
      onHandBefore: 5,
      onHandAfter: 3,
      refType: 'order',
      refId: ref,
    });
    // Committing twice is harmless: nothing is held any more.
    expect(await t.db.transaction((tx) => commitReservations(tx, ref))).toEqual([]);
    expect((await getAvailable(t.db, v))?.onHand).toBe(3);
  });

  it('release returns the stock and is safe to repeat', async () => {
    const v = id();
    const ref = id();
    await initStock(t.db, v, 4);
    await t.db.transaction((tx) =>
      reserveStock(tx, { refId: ref, items: [{ variantId: v, qty: 4 }], expiresAt: inMinutes(15) }),
    );
    expect(await t.db.transaction((tx) => releaseReservations(tx, ref))).toBe(1);
    expect(await t.db.transaction((tx) => releaseReservations(tx, ref))).toBe(0);
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 4, reserved: 0, available: 4 });
  });

  it('restockSold puts cancelled units back on the shelf with a movement', async () => {
    const v = id();
    const ref = id();
    await initStock(t.db, v, 3);
    await t.db.transaction((tx) =>
      reserveStock(tx, { refId: ref, items: [{ variantId: v, qty: 2 }], expiresAt: inMinutes(15) }),
    );
    await t.db.transaction((tx) => commitReservations(tx, ref));
    await t.db.transaction((tx) => restockSold(tx, ref, [{ variantId: v, qty: 2 }]));
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, v));
    expect(moves.map((m) => m.reason).sort()).toEqual(['cancellation_restock', 'initial', 'sale']);
  });
});

describe('INV-10: reservations expire and a job releases them', () => {
  it('releases only the reservations whose time is up', async () => {
    const [v1, v2] = [id(), id()];
    const [overdue, fresh] = [id(), id()];
    await initStock(t.db, v1, 3);
    await initStock(t.db, v2, 3);
    await t.db.transaction((tx) =>
      reserveStock(tx, {
        refId: overdue,
        items: [{ variantId: v1, qty: 2 }],
        expiresAt: inMinutes(-1),
      }),
    );
    await t.db.transaction((tx) =>
      reserveStock(tx, {
        refId: fresh,
        items: [{ variantId: v2, qty: 2 }],
        expiresAt: inMinutes(15),
      }),
    );

    const expired = await expireDueReservations(t.db);
    expect(expired).toContain(overdue);
    expect(expired).not.toContain(fresh);
    expect(await getAvailable(t.db, v1)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    expect(await getAvailable(t.db, v2)).toEqual({ onHand: 3, reserved: 2, available: 1 });
    expect((await listReservations(t.db, overdue))[0]?.status).toBe('expired');
    expect((await listReservations(t.db, fresh))[0]?.status).toBe('held');
  });

  it('is idempotent: running the job again changes nothing', async () => {
    const before = await expireDueReservations(t.db);
    expect(before.every((r) => typeof r === 'string')).toBe(true);
    expect(await expireDueReservations(t.db)).toEqual([]);
  });

  it('a payment confirming at the same moment as expiry: stock is sold exactly once, never both', async () => {
    const v = id();
    const ref = id();
    await initStock(t.db, v, 2);
    await t.db.transaction((tx) =>
      reserveStock(tx, { refId: ref, items: [{ variantId: v, qty: 1 }], expiresAt: inMinutes(-1) }),
    );
    const [committed] = await Promise.all([
      t.db.transaction((tx) => commitReservations(tx, ref)),
      expireDueReservations(t.db),
    ]);
    const level = await getAvailable(t.db, v);
    if (committed.length === 1) {
      expect(level).toEqual({ onHand: 1, reserved: 0, available: 1 }); // sold
    } else {
      expect(level).toEqual({ onHand: 2, reserved: 0, available: 2 }); // expired first, nothing sold
    }
    expect(level!.reserved).toBe(0);
  });

  it('after expiry a commit finds nothing held, so the caller can re-reserve or refund', async () => {
    const v = id();
    const ref = id();
    await initStock(t.db, v, 2);
    await t.db.transaction((tx) =>
      reserveStock(tx, { refId: ref, items: [{ variantId: v, qty: 1 }], expiresAt: inMinutes(-1) }),
    );
    await expireDueReservations(t.db);
    expect(await t.db.transaction((tx) => commitReservations(tx, ref))).toEqual([]);
  });
});
