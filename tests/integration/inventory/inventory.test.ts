import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventoryLevel, inventoryMovement } from '@/db/schema';
import type { AppError } from '@/lib/errors';
import { adjustStock, getAvailable, initStock } from '@/modules/inventory';
import { expectDbError, newTestDb, type TestDb } from '../../support/test-db';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const newVariant = () => crypto.randomUUID();

describe('inventory adjustments', () => {
  it('records an initial movement and exposes availability', async () => {
    const v = newVariant();
    await initStock(t.db, v, 12);
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 12, reserved: 0, available: 12 });
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, v));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      reason: 'initial',
      delta: 12,
      onHandBefore: 0,
      onHandAfter: 12,
    });
  });

  it('writes a movement with before/after for every adjustment', async () => {
    const v = newVariant();
    await initStock(t.db, v, 5);
    await adjustStock(t.db, { variantId: v, delta: -2, reason: 'adjustment', note: 'damaged' });
    await adjustStock(t.db, { variantId: v, delta: 10, reason: 'adjustment' });
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, v))
      .orderBy(inventoryMovement.createdAt);
    expect(moves.map((m) => [m.delta, m.onHandBefore, m.onHandAfter])).toEqual([
      [5, 0, 5],
      [-2, 5, 3],
      [10, 3, 13],
    ]);
  });

  it('refuses to take stock below zero or below reserved', async () => {
    const v = newVariant();
    await initStock(t.db, v, 3);
    await expect(
      adjustStock(t.db, { variantId: v, delta: -4, reason: 'adjustment' }),
    ).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
    });
    await t.db.update(inventoryLevel).set({ reserved: 2 }).where(eq(inventoryLevel.variantId, v));
    await expect(
      adjustStock(t.db, { variantId: v, delta: -2, reason: 'adjustment' }),
    ).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
    });
    await adjustStock(t.db, { variantId: v, delta: -1, reason: 'adjustment' });
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 2, reserved: 2, available: 0 });
  });

  it('answers NOT_FOUND for an unknown variant', async () => {
    await expect(
      adjustStock(t.db, { variantId: newVariant(), delta: 1, reason: 'adjustment' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('database CHECK constraints block negative or over-reserved rows even if code is bypassed', async () => {
    const v = newVariant();
    await initStock(t.db, v, 1);
    await expectDbError(
      t.db.update(inventoryLevel).set({ onHand: -1 }).where(eq(inventoryLevel.variantId, v)),
      /inventory_on_hand_nonneg|inventory_reserved_le_on_hand/,
    );
    await expectDbError(
      t.db.update(inventoryLevel).set({ reserved: 2 }).where(eq(inventoryLevel.variantId, v)),
      /inventory_reserved_le_on_hand/,
    );
  });

  it('stays consistent under 30 concurrent decrements of the last 10 units (foundation for INV-03)', async () => {
    const v = newVariant();
    await initStock(t.db, v, 10);
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        adjustStock(t.db, { variantId: v, delta: -1, reason: 'sale' }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toBe(10);
    expect(rejected).toHaveLength(20);
    expect(rejected.every((r) => (r.reason as AppError).code === 'OUT_OF_STOCK')).toBe(true);
    expect(await getAvailable(t.db, v)).toEqual({ onHand: 0, reserved: 0, available: 0 });
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, v));
    expect(moves.reduce((sum, m) => sum + m.delta, 0)).toBe(0);
  });
});
