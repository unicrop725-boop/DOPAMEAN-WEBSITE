import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvent, inventoryLevel, inventoryMovement } from '@/db/schema';
import {
  countLowStockVariants,
  getVariantAdmin,
  listInventoryAdmin,
  setProductStatus,
  setVariantActive,
} from '@/modules/catalog';
import {
  adjustStockAdmin,
  getAvailable,
  listMovementsAdmin,
  reserveStock,
  setLowStockThresholdAdmin,
} from '@/modules/inventory';
import { newTestDb, type TestDb } from '../../support/test-db';
import { seedShop, type Shop } from '../../support/shop';
import {
  auditCount,
  breakAuditFor,
  manager,
  manager2faOff,
  owner,
  owner2faOff,
  support,
} from '../../support/admin';

let t: TestDb;
let shop: Shop;
beforeAll(async () => {
  t = await newTestDb();
  shop = await seedShop(t.db);
});
afterAll(async () => {
  await t.close();
});

const shirtM = () => shop.shirt.variantIds[1]!;
const audits = (id: string) => t.db.select().from(auditEvent).where(eq(auditEvent.entityId, id));

describe('adjustStockAdmin', () => {
  it('adds and removes stock, records movements and audits before/after with ip', async () => {
    const actor = manager();
    const r1 = await adjustStockAdmin(t.db, actor, {
      variantId: shirtM(),
      delta: 15,
      note: 'Restock from supplier',
    });
    expect(r1).toEqual({ onHand: 75, reserved: 0, available: 75 });
    const r2 = await adjustStockAdmin(t.db, actor, {
      variantId: shirtM(),
      delta: -5,
      reason: 'correction',
      note: 'Damaged in storage',
    });
    expect(r2.onHand).toBe(70);
    expect((await getAvailable(t.db, shirtM()))?.onHand).toBe(70);

    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, shirtM()));
    const last = moves.filter((m) => m.reason !== 'initial');
    expect(
      last.map((m) => [m.reason, m.delta, m.onHandBefore, m.onHandAfter, m.actorUserId]),
    ).toEqual(
      expect.arrayContaining([
        ['adjustment', 15, 60, 75, actor.userId],
        ['correction', -5, 75, 70, actor.userId],
      ]),
    );
    const a = (await audits(shirtM())).filter((x) => x.action === 'inventory.adjust');
    expect(a).toHaveLength(2);
    expect(a.find((x) => (x.after as { delta: number }).delta === 15)).toMatchObject({
      actorUserId: actor.userId,
      actorRole: 'manager',
      ip: '203.0.113.9',
      userAgent: 'vitest-admin',
      before: { onHand: 60 },
      after: { onHand: 75, delta: 15, reason: 'adjustment', note: 'Restock from supplier' },
    });
  });

  it('validates: non-zero whole delta, a reason note, a real variant', async () => {
    const before = await auditCount(t.db);
    for (const input of [
      { variantId: shirtM(), delta: 0, note: 'nothing' },
      { variantId: shirtM(), delta: 1.5, note: 'half' },
      { variantId: shirtM(), delta: 1, note: '' },
      { variantId: shirtM(), delta: 1, note: 'ab' },
      { variantId: shirtM(), delta: 1_000_000, note: 'too many' },
      { variantId: 'not-a-uuid', delta: 1, note: 'bad id' },
    ]) {
      await expect(adjustStockAdmin(t.db, owner(), input)).rejects.toThrow();
    }
    await expect(
      adjustStockAdmin(t.db, owner(), {
        variantId: '11111111-1111-4111-8111-111111111111',
        delta: 1,
        note: 'ghost variant',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await auditCount(t.db)).toBe(before);
  });

  it('can never take on-hand below the reserved quantity (stock cannot go below reserved)', async () => {
    const v = shop.shirt.variantIds[2]!; // L: 60 on hand
    await t.db.transaction((tx) =>
      reserveStock(tx, {
        refId: '22222222-2222-4222-8222-222222222222',
        items: [{ variantId: v, qty: 8 }],
        expiresAt: new Date(Date.now() + 600_000),
      }),
    );
    const before = await auditCount(t.db);
    await expect(
      adjustStockAdmin(t.db, owner(), { variantId: v, delta: -53, note: 'too aggressive' }),
    ).rejects.toMatchObject({ code: 'OUT_OF_STOCK', details: { reserved: 8 } });
    expect((await getAvailable(t.db, v))?.onHand).toBe(60);
    expect(await auditCount(t.db)).toBe(before);
    // exactly down to the reserved amount is fine
    const ok = await adjustStockAdmin(t.db, owner(), {
      variantId: v,
      delta: -52,
      note: 'down to reserved',
    });
    expect(ok).toEqual({ onHand: 8, reserved: 8, available: 0 });
  });

  it('rolls back the stock change and the movement when the audit write fails', async () => {
    const v = shop.shirt.variantIds[0]!;
    const restore = await breakAuditFor(t, 'inventory.adjust');
    try {
      await expect(
        adjustStockAdmin(t.db, owner(), { variantId: v, delta: 10, note: 'will roll back' }),
      ).rejects.toThrow();
    } finally {
      await restore();
    }
    expect((await getAvailable(t.db, v))?.onHand).toBe(60);
    const moves = await t.db
      .select()
      .from(inventoryMovement)
      .where(eq(inventoryMovement.variantId, v));
    expect(moves).toHaveLength(1); // only the initial one
  });

  it('is authorized on the server: support denied, no-2FA manager/owner refused, nothing written', async () => {
    const before = await auditCount(t.db);
    const input = { variantId: shirtM(), delta: 1, note: 'sneaky' };
    await expect(adjustStockAdmin(t.db, support(), input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(adjustStockAdmin(t.db, manager2faOff(), input)).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    await expect(adjustStockAdmin(t.db, owner2faOff(), input)).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
    expect(await auditCount(t.db)).toBe(before);
  });

  it('concurrent adjustments serialize correctly', async () => {
    const v = shop.tee.variantIds[0]!;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        adjustStockAdmin(t.db, owner(), { variantId: v, delta: 2, note: `parallel ${i}` }),
      ),
    );
    expect((await getAvailable(t.db, v))?.onHand).toBe(80);
  });
});

describe('low-stock threshold', () => {
  it('changes the threshold with an audit event; validates; support denied', async () => {
    const v = shop.scarce.variantIds[0]!;
    await setLowStockThresholdAdmin(t.db, manager(), { variantId: v, threshold: 3 });
    const [lvl] = await t.db.select().from(inventoryLevel).where(eq(inventoryLevel.variantId, v));
    expect(lvl?.lowStockThreshold).toBe(3);
    const a = (await audits(v)).find((x) => x.action === 'inventory.set_threshold')!;
    expect(a).toMatchObject({ before: { lowStockThreshold: 5 }, after: { lowStockThreshold: 3 } });
    await expect(
      setLowStockThresholdAdmin(t.db, owner(), { variantId: v, threshold: -1 }),
    ).rejects.toThrow();
    await expect(
      setLowStockThresholdAdmin(t.db, support(), { variantId: v, threshold: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('inventory reads', () => {
  it('movement history is newest first, paginated and requires inventory.edit', async () => {
    const v = shirtM();
    const page = await listMovementsAdmin(t.db, owner(), v, { pageSize: 2 });
    expect(page.pageSize).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.items[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
      page.items[1]!.createdAt.getTime(),
    );
    await expect(listMovementsAdmin(t.db, support(), v)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const capped = await listMovementsAdmin(t.db, owner(), v, { pageSize: 1000 });
    expect(capped.pageSize).toBe(100);
  });

  it('lists all variants with on hand / reserved / available / threshold and filters low stock', async () => {
    const all = await listInventoryAdmin(t.db, owner(), { pageSize: 100 });
    expect(all.total).toBe(5); // 3 shirt sizes + 1 tee + 1 scarf
    const scarf = all.items.find((i) => i.sku === 'last-scarf-One')!;
    expect(scarf).toMatchObject({ onHand: 1, reserved: 0, available: 1, threshold: 3, low: true });
    const reservedRow = all.items.find((i) => i.sku === 'oxford-shirt-L')!;
    expect(reservedRow).toMatchObject({ onHand: 8, reserved: 8, available: 0, low: true });
    const low = await listInventoryAdmin(t.db, owner(), { lowOnly: true });
    expect(low.items.every((i) => i.low)).toBe(true);
    expect(low.items.map((i) => i.sku).sort()).toEqual(['last-scarf-One', 'oxford-shirt-L']);
    const found = await listInventoryAdmin(t.db, owner(), { q: 'boxy' });
    expect(found.items.map((i) => i.sku)).toEqual(['boxy-tee-M']);
    await expect(listInventoryAdmin(t.db, support())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('getVariantAdmin returns the variant with its product name', async () => {
    const v = await getVariantAdmin(t.db, owner(), shop.scarce.variantIds[0]!);
    expect(v).toMatchObject({ sku: 'last-scarf-One', productName: 'Last Scarf', onHand: 1 });
    expect(await getVariantAdmin(t.db, owner(), 'nope')).toBeNull();
  });
});

describe('low stock has one definition shared by the dashboard count and the filter', () => {
  it('counts only active variants of non-archived products, and matches the filtered list', async () => {
    const lowList = await listInventoryAdmin(t.db, owner(), { lowOnly: true, pageSize: 100 });
    const count = await countLowStockVariants(t.db, owner());
    expect(count).toBe(lowList.total);
    expect(count).toBe(2); // last-scarf-One (1 <= 3) and oxford-shirt-L (0 available)

    // deactivating a variant or archiving its product takes it out of the low-stock numbers
    await setVariantActive(t.db, owner(), shop.shirt.variantIds[2]!, false);
    expect(await countLowStockVariants(t.db, owner())).toBe(1);
    await setProductStatus(t.db, owner(), shop.scarce.productId, 'archived');
    expect(await countLowStockVariants(t.db, owner())).toBe(0);
    expect((await listInventoryAdmin(t.db, owner(), { lowOnly: true })).total).toBe(0);
    // but the full list still shows them (with their real numbers)
    const all = await listInventoryAdmin(t.db, owner(), { pageSize: 100 });
    expect(all.items.find((i) => i.sku === 'last-scarf-One')).toMatchObject({
      available: 1,
      low: true,
    });
    await expect(countLowStockVariants(t.db, support())).resolves.toBe(0); // orders.view: support may see the tile
    await expect(countLowStockVariants(t.db, owner2faOff())).rejects.toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });
});
